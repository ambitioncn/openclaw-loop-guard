import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  createApprovedHandoffRequest,
  createHandoffRequest,
  createGuardedToolResult,
  createLoopGuardState,
  createStateRecorder,
  defaultStatePath,
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
        const runParams = {
          sessionKey: request.sessionKey,
          message: request.message,
          provider: request.provider,
          model: request.model,
          toolsAllow: request.toolsAllow,
          lightContext: true,
          deliver: false,
          idempotencyKey: request.idempotencyKey
        };
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
            const fallbackResult = await api.runtime.subagent.run({
              sessionKey: request.sessionKey,
              message: `${request.message}\n\nNote: the requested executor model override (${cfg.executorModel}) was rejected by OpenClaw policy, so this fallback handoff is running on the session default model.`,
              toolsAllow: request.toolsAllow,
              lightContext: true,
              deliver: false,
              idempotencyKey: `${request.idempotencyKey}:default-model-fallback`
            });
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
          blockReason: `${withExecutorHint(entry.pendingTimeout ? cfg.pendingMessage : cfg.hardMessage, cfg)} Signature: ${entry.toolName} params=${entry.paramsHash} error=${entry.errorHash}.${handoff ? ` Handoff started: ${handoff.sessionKey} run=${handoff.runId || "unknown"}${handoff.modelOverrideRejected ? " (executor model override rejected; default model fallback)" : ""}.` : ""}`
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
        const handoff = await maybeStartHandoff(action, entry, {
          runtime: ctx.runtime,
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
          sessionKey: ctx.sessionKey,
          runId: ctx.runId,
          toolCallId: event.toolCallId
        });

        return {
          result: createGuardedToolResult(
            event.result,
            `${withExecutorHint(entry.count >= cfg.hardThreshold ? cfg.hardMessage : cfg.softMessage, cfg)}${handoff ? `\n\nLoop Guard started an executor handoff: ${handoff.sessionKey} run=${handoff.runId || "unknown"}${handoff.modelOverrideRejected ? " (executor model override rejected; default model fallback)" : ""}.` : ""}`,
            entry
          )
        };
      },
      { runtimes: ["openclaw", "codex"] }
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
        if (action === "approve") {
          const cfg = refreshConfig();
          if (!api.runtime?.subagent?.run) {
            return { text: "Loop Guard approval failed: subagent runtime is unavailable." };
          }
          const approval = parseApproveArgs(rawArgs, cfg.approvedHandoffToolsAllow);
          const event = findHandoffEvent(
            readRecentEvents(cfg.statePath || defaultStatePath()),
            approval.selector
          );
          if (!event) {
            return {
              text: `Loop Guard approval failed: no matching handoff-started event found for ${approval.selector}.`
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
            const runParams = {
              sessionKey: request.sessionKey,
              message: request.message,
              provider: request.provider,
              model: request.model,
              toolsAllow: request.toolsAllow,
              lightContext: true,
              deliver: false,
              idempotencyKey: request.idempotencyKey
            };
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
        return {
          text: `Loop Guard: ${config.enabled ? "enabled" : "disabled"}; tracked failures=${snapshot.length}; soft=${config.softThreshold}; hard=${config.hardThreshold}.`
        };
      }
    });
  }
});
