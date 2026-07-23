import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  createApprovedHandoffRequest,
  createCompletionE2eRequest,
  createApprovalPrompt,
  createHandoffRequest,
  createGuardedToolResult,
  createLoopGuardState,
  createSubagentRunParams,
  createStatusMessage,
  createStateRecorder,
  defaultStatePath,
  detectAgentTurnFailure,
  findHandoffEvent,
  normalizeConfig,
  parseApproveArgs,
  readRecentEvents,
  shouldBlockRepeatedCall,
  shouldStartHandoff,
  shouldTreatResultAsFailure,
  withExecutorHint
} from "./loop.js";

function resolveRuntimeConfig(api) {
  const current = api.runtime?.config?.current?.();
  const live = current?.plugins?.entries?.["loop-guard"]?.config;
  return normalizeConfig(live ?? api.pluginConfig ?? {});
}

function resolveAgentId(ctx) {
  const direct = String(ctx.agentId || "").trim();
  if (direct) return direct;
  const sessionKey = String(ctx.sessionKey || "").trim();
  const match = sessionKey.match(/^agent:([^:]+)/);
  return match?.[1] || "main";
}

function parseWaitMs(rawArgs) {
  const token = String(rawArgs || "")
    .split(/\s+/)
    .find((part) => /^wait=/i.test(part));
  if (!token) return 0;
  const value = token.replace(/^wait=/i, "").trim();
  const match = value.match(/^(\d+)(ms|s|m)?$/i);
  if (!match) return 0;
  const amount = Number.parseInt(match[1], 10);
  const unit = (match[2] || "ms").toLowerCase();
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  if (unit === "m") return amount * 60 * 1000;
  if (unit === "s") return amount * 1000;
  return amount;
}

function isLoopGuardHandoffSession(ctx = {}) {
  const sessionKey = String(ctx.sessionKey || ctx.sessionId || "");
  return /:subagent:loop-guard(?:-|:|$)/.test(sessionKey);
}

export default definePluginEntry({
  id: "loop-guard",
  name: "Loop Guard",
  description: "Detects repeated OpenClaw tool failures and blocks unproductive retry loops.",
  register(api) {
    let config = resolveRuntimeConfig(api);
    const state = createLoopGuardState(config);
    const pendingTimers = new Map();
    const handoffKeys = new Set();
    const recorder = createStateRecorder({
      statePath: config.statePath || defaultStatePath(),
      logger: api.logger
    });

    const refreshConfig = () => {
      config = resolveRuntimeConfig(api);
      return config;
    };

    const createHandoffContext = (base, entry, cfg) => {
      if (base.sessionKey || base.sessionId) return base;
      const related = readRecentEvents(cfg.statePath || defaultStatePath())
        .reverse()
        .find(
          (event) =>
            event?.action === "observe" &&
            event.callKey &&
            event.callKey === entry.callKey &&
            (event.sessionKey || event.sessionId)
        );
      if (!related) return base;
      return {
        ...base,
        agentId: base.agentId || related.agentId,
        sessionId: base.sessionId || related.sessionId,
        sessionKey: base.sessionKey || related.sessionKey,
        runId: base.runId || related.runId
      };
    };

    const clearPendingTimer = (toolCallId) => {
      if (!toolCallId) return;
      const timer = pendingTimers.get(toolCallId);
      if (!timer) return;
      clearTimeout(timer);
      pendingTimers.delete(toolCallId);
    };

    const trackPendingCall = (event, ctx, cfg) => {
      if (!event.toolCallId) return;
      if (cfg.pendingTimeoutMs <= 0) return;
      if (!cfg.highRiskTools.includes(String(event.toolName || ""))) return;
      clearPendingTimer(event.toolCallId);
      const timer = setTimeout(() => {
        pendingTimers.delete(event.toolCallId);
        const entry = state.observePendingTimeout({
          toolName: event.toolName,
          params: event.params,
          timeoutMs: cfg.pendingTimeoutMs,
          observationId: event.toolCallId
        });
        recorder.record({
          action: "pending-timeout",
          runtime: "hook",
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
          sessionKey: ctx.sessionKey,
          runId: event.runId ?? ctx.runId,
          toolCallId: event.toolCallId,
          ...entry
        });
        recorder.record({
          action: "handoff-skipped",
          reason: "pending-timeout timer has no gateway request scope",
          trigger: "pending-timeout",
          runtime: "hook",
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
          sessionKey: ctx.sessionKey,
          runId: event.runId ?? ctx.runId,
          toolCallId: event.toolCallId,
          ...entry
        });
      }, cfg.pendingTimeoutMs);
      timer.unref?.();
      pendingTimers.set(event.toolCallId, timer);
    };

    const maybeStartHandoff = async (trigger, entry, context) => {
      const cfg = refreshConfig();
      if (!shouldStartHandoff(trigger, entry, cfg)) return undefined;
      if (!api.runtime?.subagent?.run) {
        recorder.record({ action: "handoff-unavailable", trigger, ...context, ...entry });
        return undefined;
      }
      const request = createHandoffRequest({ trigger, entry, config: cfg, context });
      if (handoffKeys.has(request.idempotencyKey)) return undefined;
      handoffKeys.add(request.idempotencyKey);
      try {
        const runParams = createSubagentRunParams(request);
        const result = await api.runtime.subagent.run(runParams);
        recorder.record({
          action: "handoff-started",
          trigger,
          handoffRunId: result?.runId,
          handoffSessionKey: request.sessionKey,
          executorModel: cfg.executorModel,
          executorRuntime: cfg.executorRuntime,
          ...context,
          ...entry
        });
        return {
          runId: result?.runId,
          sessionKey: request.sessionKey
        };
      } catch (error) {
        const message = String(error?.message || error);
        if (/override is not authorized|not trusted|not allowlisted/i.test(message)) {
          try {
            const fallbackResult = await api.runtime.subagent.run(createSubagentRunParams(request, {
              message: `${request.message}\n\nNote: the requested executor model override (${cfg.executorModel}) was rejected by OpenClaw policy, so this fallback handoff is running on the session default model.`,
              idempotencyKey: `${request.idempotencyKey}:default-model-fallback`
            }));
            recorder.record({
              action: "handoff-started",
              trigger,
              handoffRunId: fallbackResult?.runId,
              handoffSessionKey: request.sessionKey,
              executorModel: cfg.executorModel,
              executorRuntime: cfg.executorRuntime,
              modelOverrideRejected: true,
              overrideError: message,
              ...context,
              ...entry
            });
            return {
              runId: fallbackResult?.runId,
              sessionKey: request.sessionKey,
              modelOverrideRejected: true
            };
          } catch (fallbackError) {
            handoffKeys.delete(request.idempotencyKey);
            recorder.record({
              action: "handoff-failed",
              trigger,
              handoffSessionKey: request.sessionKey,
              error: String(fallbackError?.message || fallbackError),
              overrideError: message,
              ...context,
              ...entry
            });
            api.logger?.warn?.(
              `loop-guard: fallback handoff failed: ${String(fallbackError?.message || fallbackError)}`
            );
            return undefined;
          }
        }
        recorder.record({
          action: "handoff-failed",
          trigger,
          handoffSessionKey: request.sessionKey,
          error: message,
          ...context,
          ...entry
        });
        handoffKeys.delete(request.idempotencyKey);
        api.logger?.warn?.(`loop-guard: handoff failed: ${message}`);
        return undefined;
      }
    };

    api.on(
      "after_tool_call",
      async (event, ctx) => {
        clearPendingTimer(event.toolCallId);
        const cfg = refreshConfig();
        if (!cfg.enabled) return;
        if (!shouldTreatResultAsFailure(event)) return;

        const entry = state.observeFailure({
          toolName: event.toolName,
          params: event.params,
          result: event.result,
          error: event.error,
          observationId: event.toolCallId
        });

        recorder.record({
          action: "observe",
          runtime: "hook",
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
          sessionKey: ctx.sessionKey,
          runId: event.runId ?? ctx.runId,
          toolCallId: event.toolCallId,
          ...entry
        });
      },
      { priority: 90, timeoutMs: 2000 }
    );

    api.on(
      "before_tool_call",
      async (event, ctx) => {
        const cfg = refreshConfig();
        if (!cfg.enabled) return;
        const entry = state.getMostRecentFailureForCall({
          toolName: event.toolName,
          params: event.params
        });
        if (!entry) return;

        if (!shouldBlockRepeatedCall(entry, cfg, event.toolName)) return;

        recorder.record({
          action: "block",
          runtime: "hook",
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
          sessionKey: ctx.sessionKey,
          runId: event.runId ?? ctx.runId,
          toolCallId: event.toolCallId,
          ...entry
        });
        const handoff = await maybeStartHandoff("block", entry, {
          runtime: "hook",
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
          sessionKey: ctx.sessionKey,
          runId: event.runId ?? ctx.runId,
          toolCallId: event.toolCallId
        });

        return {
          block: true,
          blockReason: `${withExecutorHint(entry.pendingTimeout ? cfg.pendingMessage : cfg.hardMessage, cfg)} Signature: ${entry.toolName} params=${entry.paramsHash} error=${entry.errorHash}.${handoff ? ` Handoff started: ${handoff.sessionKey} run=${handoff.runId || "unknown"}${handoff.modelOverrideRejected ? " (executor model override rejected; default model fallback)" : ""}.\n\n${createApprovalPrompt({ handoff, config: cfg, entry })}` : ""}`
        };
      },
      { priority: 95, timeoutMs: 2000 }
    );

    api.on(
      "before_tool_call",
      async (event, ctx) => {
        const cfg = refreshConfig();
        if (!cfg.enabled) return;
        trackPendingCall(event, ctx, cfg);
      },
      { priority: 10, timeoutMs: 1000 }
    );

    api.registerAgentToolResultMiddleware(
      async (event, ctx) => {
        const cfg = refreshConfig();
        if (!cfg.enabled) return;
        if (!shouldTreatResultAsFailure(event)) return;

        const entry = state.observeFailure({
          toolName: event.toolName,
          params: event.args,
          result: event.result,
          observationId: event.toolCallId
        });

        if (entry.count < cfg.softThreshold) return;

        const action = entry.count >= cfg.hardThreshold ? "warn-hard" : "warn";
        recorder.record({
          action,
          runtime: ctx.runtime,
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
          sessionKey: ctx.sessionKey,
          runId: ctx.runId,
          toolCallId: event.toolCallId,
          ...entry
        });
        const handoffContext = createHandoffContext({
          runtime: ctx.runtime,
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
          sessionKey: ctx.sessionKey,
          runId: ctx.runId,
          toolCallId: event.toolCallId
        }, entry, cfg);
        const handoff = await maybeStartHandoff(action, entry, handoffContext);

        return {
          result: createGuardedToolResult(
            event.result,
            `${withExecutorHint(entry.count >= cfg.hardThreshold ? cfg.hardMessage : cfg.softMessage, cfg)}${handoff ? `\n\nLoop Guard started an executor handoff: ${handoff.sessionKey} run=${handoff.runId || "unknown"}${handoff.modelOverrideRejected ? " (executor model override rejected; default model fallback)" : ""}.\n\n${createApprovalPrompt({ handoff, config: cfg, entry })}` : ""}`,
            entry
          )
        };
      },
      { runtimes: ["openclaw", "codex"] }
    );

    api.on(
      "agent_end",
      async (event, ctx) => {
        const cfg = refreshConfig();
        if (!cfg.enabled || !cfg.handoffOnAgentFailure) return;
        if (isLoopGuardHandoffSession(ctx)) return;
        const failure = detectAgentTurnFailure(event);
        if (!failure) return;

        const entry = state.observeFailure({
          toolName: "agent_end",
          params: {
            failureKind: failure.kind,
            stopReason: failure.stopReason,
            provider: ctx.provider || event.provider || "",
            model: ctx.model || event.model || ""
          },
          error: failure.errorSummary,
          observationId: event.runId || ctx.runId
        });

        recorder.record({
          action: "agent-failure",
          runtime: "hook",
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
          sessionKey: ctx.sessionKey,
          runId: event.runId ?? ctx.runId,
          failureKind: failure.kind,
          stopReason: failure.stopReason,
          eventError: event.error,
          ...entry
        });

        await maybeStartHandoff("agent-failure", entry, {
          runtime: "hook",
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
          sessionKey: ctx.sessionKey,
          runId: event.runId ?? ctx.runId
        });
      },
      { priority: 80, timeoutMs: 5000 }
    );

    api.registerCommand?.({
      name: "loop-guard",
      description: "Inspect, reset, or approve Loop Guard handoffs.",
      acceptsArgs: true,
      handler: async (ctx) => {
        const rawArgs = (ctx.args || "status").trim();
        const action = rawArgs.split(/\s+/, 1)[0]?.toLowerCase() || "status";
        if (action === "reset" || action === "clear") {
          state.clear();
          return { text: "Loop Guard state cleared." };
        }
        if (action === "e2e" || action === "selftest") {
          const [, target = "completion"] = rawArgs.split(/\s+/);
          if (target.toLowerCase() !== "completion") {
            return {
              text: "Loop Guard E2E usage: /loop-guard e2e completion"
            };
          }
          const cfg = refreshConfig();
          if (!cfg.executorModel) {
            return {
              text: "Loop Guard E2E failed: executorModel is not configured."
            };
          }
          if (!api.runtime?.subagent?.run) {
            return { text: "Loop Guard E2E failed: subagent runtime is unavailable." };
          }
          const marker = `loop-guard-e2e-${new Date().toISOString().replace(/[:.]/g, "-")}`;
          const context = {
            runtime: "slash-command",
            agentId: resolveAgentId(ctx),
            sessionId: ctx.sessionId,
            sessionKey: ctx.sessionKey,
            runId: `slash-command:${marker}`
          };
          try {
            const request = createCompletionE2eRequest({
              config: cfg,
              context,
              marker
            });
            const result = await api.runtime.subagent.run(createSubagentRunParams(request));
            recorder.record({
              action: "handoff-started",
              trigger: "slash-e2e",
              runtime: context.runtime,
              agentId: context.agentId,
              sessionId: context.sessionId,
              sessionKey: context.sessionKey,
              runId: context.runId,
              handoffRunId: result?.runId,
              handoffSessionKey: request.sessionKey,
              executorModel: cfg.executorModel,
              executorRuntime: cfg.executorRuntime,
              toolName: "loop-guard-e2e",
              paramsHash: request.e2eEntry?.paramsHash,
              errorHash: request.e2eEntry?.errorHash,
              errorSummary: request.e2eEntry?.errorSummary,
              paramsPreview: request.e2eEntry?.paramsPreview,
              marker
            });
            const waitMs = parseWaitMs(rawArgs);
            let waitStatus = "";
            if (waitMs > 0 && api.runtime.subagent.waitForRun && result?.runId) {
              const waitResult = await api.runtime.subagent.waitForRun({
                runId: result.runId,
                timeoutMs: waitMs
              });
              waitStatus = `\nWait result: ${waitResult.status}${waitResult.error ? ` (${waitResult.error})` : ""}.`;
            }
            return {
              text: [
                "Loop Guard E2E completion test started.",
                `Marker: ${marker}`,
                `Requester session: ${request.requesterSessionKey || "unknown"}`,
                `Executor session: ${request.sessionKey}`,
                `Executor run: ${result?.runId || "unknown"}`,
                "Completion delivery requested: yes",
                waitStatus.trim()
              ]
                .filter(Boolean)
                .join("\n")
            };
          } catch (error) {
            const message = String(error?.message || error);
            recorder.record({
              action: "handoff-failed",
              trigger: "slash-e2e",
              runtime: context.runtime,
              agentId: context.agentId,
              sessionId: context.sessionId,
              sessionKey: context.sessionKey,
              runId: context.runId,
              error: message,
              marker
            });
            return { text: `Loop Guard E2E failed: ${message}` };
          }
        }
        if (action === "approve") {
          const cfg = refreshConfig();
          if (!api.runtime?.subagent?.run) {
            return { text: "Loop Guard approval failed: subagent runtime is unavailable." };
          }
          const approval = parseApproveArgs(rawArgs, cfg.approvedHandoffToolsAllow);
          const event = findHandoffEvent(
            readRecentEvents(cfg.statePath || defaultStatePath()),
            approval.selector,
            { requirePending: true, maxAgeMs: cfg.approvedHandoffMaxAgeMs }
          );
          if (!event) {
            return {
              text: `Loop Guard approval failed: no pending handoff-started event found for ${approval.selector}. Run /loop-guard to inspect the latest handoff state.`
            };
          }
          try {
            const request = createApprovedHandoffRequest({
              event,
              config: cfg,
              toolsAllow: approval.toolsAllow,
              writeRoots: approval.writeRoots,
              confirmRisky: approval.confirmRisky
            });
            const runParams = createSubagentRunParams(request);
            const result = await api.runtime.subagent.run(runParams);
            recorder.record({
              action: "handoff-approved-started",
              handoffRunId: result?.runId,
              handoffSessionKey: request.sessionKey,
              executorModel: cfg.executorModel,
              executorRuntime: cfg.executorRuntime,
              approvedToolsAllow: request.toolsAllow,
              approvedWriteRoots: request.writeRoots,
              approvedConfirmRisky: request.confirmRisky,
              approvedGrantId: request.approvalGrant?.grantId,
              approvedGrantExpiresAt: request.approvalGrant?.expiresAt,
              approvedSelector: approval.selector,
              sourceHandoffRunId: event.handoffRunId,
              toolName: event.toolName,
              paramsHash: event.paramsHash,
              errorHash: event.errorHash
            });
            return {
              text: `Loop Guard approved handoff: ${request.sessionKey} run=${result?.runId || "unknown"} tools=${request.toolsAllow.join(", ")}.`
            };
          } catch (error) {
            const message = String(error?.message || error);
            recorder.record({
              action: "handoff-approved-failed",
              approvedSelector: approval.selector,
              handoffSessionKey: event.handoffSessionKey,
              error: message
            });
            return { text: `Loop Guard approval failed: ${message}` };
          }
        }
        const snapshot = state.snapshot();
        const cfg = refreshConfig();
        return {
          text: createStatusMessage({
            config: cfg,
            snapshot,
            events: readRecentEvents(cfg.statePath || defaultStatePath())
          })
        };
      }
    });
  }
});
