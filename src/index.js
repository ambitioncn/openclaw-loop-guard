import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  createGuardedToolResult,
  createLoopGuardState,
  createStateRecorder,
  defaultStatePath,
  normalizeConfig,
  shouldBlockRepeatedCall,
  shouldTreatResultAsFailure
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
    const recorder = createStateRecorder({
      statePath: config.statePath || defaultStatePath(),
      logger: api.logger
    });

    const refreshConfig = () => {
      config = resolveRuntimeConfig(api);
      return config;
    };

    api.on(
      "after_tool_call",
      async (event, ctx) => {
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

        return {
          block: true,
          blockReason: `${cfg.hardMessage} Signature: ${entry.toolName} params=${entry.paramsHash} error=${entry.errorHash}.`
        };
      },
      { priority: 95, timeoutMs: 2000 }
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

        recorder.record({
          action: entry.count >= cfg.hardThreshold ? "warn-hard" : "warn",
          runtime: ctx.runtime,
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
          sessionKey: ctx.sessionKey,
          runId: ctx.runId,
          toolCallId: event.toolCallId,
          ...entry
        });

        return {
          result: createGuardedToolResult(
            event.result,
            entry.count >= cfg.hardThreshold ? cfg.hardMessage : cfg.softMessage,
            entry
          )
        };
      },
      { runtimes: ["openclaw", "codex"] }
    );

    api.registerCommand?.({
      name: "loop-guard",
      description: "Inspect or reset Loop Guard state.",
      acceptsArgs: true,
      handler: async (ctx) => {
        const action = (ctx.args || "status").trim().toLowerCase();
        if (action === "reset" || action === "clear") {
          state.clear();
          return { text: "Loop Guard state cleared." };
        }
        const snapshot = state.snapshot();
        return {
          text: `Loop Guard: ${config.enabled ? "enabled" : "disabled"}; tracked failures=${snapshot.length}; soft=${config.softThreshold}; hard=${config.hardThreshold}.`
        };
      }
    });
  }
});
