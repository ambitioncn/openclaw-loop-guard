# OpenClaw Loop Guard

OpenClaw Loop Guard is a failover plugin for local-model deployments. It detects repeated tool loops, circuit-breaker aborts, and terminal provider/model failures, then hands the original task and bounded recovery context to a configured cloud executor.

Its success condition is not merely “the loop stopped”: the cloud executor should resume the original user task with a different strategy and return a user-ready result to the source conversation.

## What It Does

- Observes tool failures with `after_tool_call`.
- Rewrites repeated failure results with `agentToolResultMiddleware`.
- Records high-risk tool calls that do not return before `pendingTimeoutMs`.
- Optionally blocks unproductive repeat calls with `before_tool_call`.
- Groups known policy/path restriction failures across changing parameters.
- Detects successful high-risk tool calls that repeat without visible progress and injects a model-visible stop/rethink warning.
- Normalizes empty paginated `read` calls so changing offsets cannot evade no-progress detection.
- Recognizes OpenClaw's native loop circuit-breaker result and immediately creates a failover handoff.
- Can observe model/session-level agent failures such as `stopReason=length` or context overflow and hand them off to the configured executor.
- Can opt in to provider-level `model_call_ended` failure takeover when Loop Guard owns escalation instead of native model fallback.
- Builds a bounded, redacted recovery packet from the source session: original task, recent context, completed progress, and failure evidence.
- Stores lightweight audit events outside the session transcript.
- Provides a `/loop-guard` command for status and reset.
- Can start a configured executor subagent when repeated failures or hung calls indicate that the driver is stuck.
- Provides `/loop-guard e2e completion` for a clean slash-command acceptance test of handoff completion delivery.

## MVP Policy

The first implementation is deliberately small:

- First failure: return normally.
- Second matching failure: tell the model to choose another strategy.
- Third matching failure: can block the same call when `blockRepeatedCalls` is enabled.
- High-risk tools can be blocked at the soft threshold when hard blocking is enabled.
- A high-risk tool call that exceeds `pendingTimeoutMs` is treated as a stuck call; the same call is blocked on retry by default.
- Successful high-risk tool calls can also be tracked as no-progress loops. By default, the fourth repeated success for the same normalized tool arguments is rewritten with guidance to stop repeating, produce a result, change strategy, or ask for human input.
- Model roles are configurable with `driverModel`, `executorModel`, and `executorRuntime`; the plugin never hard-codes Qwen, GPT, or Claude.
- Automatic handoff is opt-in with `handoffEnabled`; when enabled, Loop Guard starts a plugin-owned subagent run using `executorModel` and records the handoff session/run ids.
- Agent-level failure handoff is separately opt-in with `handoffOnAgentFailure`; it is useful when the driver hits output length, context overflow, or non-deliverable terminal turn failures instead of a normal tool failure.
- Handoff prompts include a bounded, redacted preview of the failed tool arguments so the executor can work from the actual failed call instead of guessing from hashes.
- Handoff passes `handoffToolsAllow` through to the plugin-owned subagent. The default is `[]`, so background handoffs run in no-tool diagnostic mode instead of relying only on prompt wording.
- Handoff runs request completion delivery back to the source session, so executor results can be merged into the original conversation instead of only living in the background session.
- When a handoff starts, Loop Guard adds a human-facing approval hint to the guarded tool result. It includes the exact `/loop-guard approve latest ...` command, executor session/run, approved tools, write roots, risky-operation status, and the 10 minute grant lifetime.
- Approved handoff resume is available with `/loop-guard approve latest`. It reuses the last handoff session and sends an explicitly approved `toolsAllow` list, defaulting to `approvedHandoffToolsAllow`.
- Approved handoff resume also includes scope rules: write roots, exec timeout requirements, and risky-operation patterns. A human approval is enough to authorize risky operations by default.
- Pending handoffs have an approval age limit (`approvedHandoffMaxAgeMs`, default 30 minutes) so old background tasks are not resumed accidentally.

Hard blocking is disabled by default while the plugin is being proven on real OpenClaw sessions.
With the default config, repeated failures are still rewritten with model-visible guidance.

Failure identity is based on:

- tool name
- normalized argument hash
- error/result summary hash

Volatile ids such as `toolCallId`, `runId`, `turnId`, and timestamps are ignored.

No-progress identity is based on tool name plus normalized arguments. It deliberately does not inspect private screenshots or large artifacts; it watches for the repeated action shape and warns the model once repeated successful calls stop producing a final answer or a new strategy.

## Install

From a checkout:

```bash
openclaw plugins install ./openclaw-loop-guard --link
```

Enable it explicitly in `openclaw.json` if your OpenClaw install requires plugin entries for trusted surfaces:

```json
{
  "plugins": {
    "entries": {
      "loop-guard": {
        "enabled": true,
        "config": {
          "enabled": true,
          "blockRepeatedCalls": false,
          "blockAfterPendingTimeout": true,
          "pendingTimeoutMs": 180000,
          "driverModel": "qwen-local/qwen36-uncensored-llamacpp",
          "executorModel": "openai/gpt-5.5",
          "executorRuntime": "codex",
          "handoffEnabled": true,
          "handoffOnSoftWarn": true,
          "handoffOnBlock": true,
          "handoffOnAgentFailure": false,
          "handoffOnModelCallFailure": false,
          "handoffToolsAllow": [],
          "approvedHandoffToolsAllow": ["read", "exec", "bash", "apply_patch"],
          "approvedHandoffWriteRoots": [],
          "approvedHandoffAllowRiskyOperations": true,
          "approvedHandoffMaxAgeMs": 1800000,
          "approvedHandoffRequireExecTimeout": true,
          "approvedHandoffRiskyPatterns": ["ssh", "systemctl", "sudo", "rm", "git push", "npm publish", "secrets"],
          "paramsPreviewMaxChars": 1000,
          "softThreshold": 2,
          "hardThreshold": 3,
          "noProgressDetectionEnabled": true,
          "noProgressSoftThreshold": 4,
          "noProgressHardThreshold": 6,
          "noProgressTools": ["exec", "bash", "process", "image", "read"],
          "windowMs": 600000,
          "highRiskTools": ["exec", "bash", "apply_patch", "write", "edit"]
        },
        "subagent": {
          "allowModelOverride": true,
          "allowedModels": ["openai/gpt-5.5"]
        }
      }
    }
  }
}
```

Restart the gateway after install or config changes.

`executorModel` should use the canonical `provider/model` form. OpenClaw only honors subagent model overrides when the plugin entry opts in with `subagent.allowModelOverride`.

If OpenClaw rejects the per-run model override despite that policy, Loop Guard falls back to starting the handoff subagent on the session default model and records `modelOverrideRejected: true` in the audit event.

## Commands

```text
/loop-guard
/loop-guard reset
/loop-guard e2e completion
/loop-guard e2e completion wait=30s
/loop-guard approve latest
/loop-guard approve latest tools=read,exec,bash,apply_patch
/loop-guard approve latest tools=read,exec,bash,apply_patch roots=/path/to/repo
/loop-guard approve latest tools=read,exec,bash roots=/path/to/repo confirm=safe
```

`/loop-guard` shows plugin status, the most recent `handoff-started` audit event, its lifecycle state, and the approval command when that handoff is still pending.

`e2e completion` starts a controlled no-tool executor handoff from the current slash-command session and requests completion delivery back to that same source session. The command response includes a unique marker, requester session, executor session, and executor run. The executor completion report should start with `LOOP_GUARD_E2E_COMPLETION_OK <marker>`. Add `wait=30s` or another bounded duration to wait for terminal run status before the command returns.

`approve` looks up the most recent pending `handoff-started` audit event and continues that same executor session with approved tools. A selector can replace `latest`; it matches the handoff session key, run id, source run id, tool name, params hash, or error hash. Already approved, failed, completed, or expired handoffs are skipped so stale tasks are not re-approved accidentally.

For Codex executors, Loop Guard expands approved `exec` to include `bash`, because Codex exposes shell execution as `bash`.

By default, write-capable tools are not enough to authorize writes. The approval must provide `roots=...` or config must set `approvedHandoffWriteRoots`. `exec` approvals tell the executor to use explicit timeouts/bounds. Risky patterns such as SSH, service restarts, deletes, pushes, publishing, and secret/auth changes are allowed once the human approves the handoff. Use `confirm=safe` for a one-off approval that should still deny risky operations.

## Development

```bash
npm test
npm run check
```

## OpenClaw Core Hot Patches

Some OpenClaw releases do not emit an awaited plugin failure hook on every terminal provider path and do not carry all plugin-subagent fields Loop Guard needs. This repo includes targeted, version/shape-guarded dist patches:

```bash
node scripts/patch-openclaw-awaited-agent-end.cjs
node scripts/patch-openclaw-awaited-agent-end.cjs --verify
node scripts/patch-openclaw-subagent-approval-grant.cjs
node scripts/patch-openclaw-subagent-approval-grant.cjs --verify
```

The awaited-agent-end patch emits the typed `agent_end` hook exactly once from the terminal provider-failure path. The approval patch forwards `approvalGrant`, `requesterSessionKey`, and `expectsCompletionMessage`; applies active inherited approvals to Codex app-server runs; downgrades expected `no_active_run` completion wake fallback logging; and makes plugin completion labels unique. Restart the OpenClaw gateway after applying a patch.

## Verified Acceptance

The Feishu slash-command completion path was verified on `nickv100` with OpenClaw `2026.6.11`:

```text
/loop-guard e2e completion wait=30s
```

Observed acceptance signal:

- Feishu received the command and dispatched it to the source direct-message session.
- Loop Guard recorded a `slash-e2e` handoff with a unique `loop-guard-e2e-*` marker.
- The executor returned `LOOP_GUARD_E2E_COMPLETION_OK <marker>`.
- The executor report confirmed `requesterSessionKey present: yes` and `expectsCompletionMessage present: yes`.
- The completion report landed back in the original source session as a `delivery-mirror` assistant message.
- The expected `no_active_run` wake fallback is logged as `[subagent]` instead of `[warn]`.
- Plugin completion session labels are made unique by the hot patch, avoiding repeated `plugin:loop-guard` label collisions.

## Verified Cloud Takeover

On OpenClaw `2026.7.1-2`, a forced local-provider failure was verified end to end:

- the terminal failure emitted one `agent-failure` event;
- Loop Guard started exactly one handoff;
- the handoff ran on `openai/gpt-5.5`;
- the executor recovered the original arithmetic task and returned `TAKEOVER_OK 323`.

## Current Limits

- Session quarantine and restart-recovery suppression are not included; Loop Guard relies on OpenClaw's native circuit breaker to stop the active loop.
- Provider failures that occur before OpenClaw emits a plugin hook require the awaited-agent-end core patch on affected releases.
- Do not enable `handoffOnModelCallFailure` while OpenClaw native model fallback also owns escalation, or two takeover paths may race.
- Plugin-owned subagent completion delivery may need the approval-grant hot patch on affected OpenClaw releases.
- Handoff currently produces a diagnostic report by default because `handoffToolsAllow` defaults to `[]`. Set a narrow allow-list only when that executor run has been explicitly approved for tool execution.
- Approved handoff resume sends explicit scope rules to the executor session, but OpenClaw 2026.6.11 does not yet enforce per-directory write roots or per-command policy at the tool runtime layer. Treat this as guarded delegation plus audit, not a kernel-level sandbox.
- Argument previews are best-effort redacted and truncated; set `paramsPreviewMaxChars` to `0` for no params preview.
- On OpenClaw 2026.6.11, gateway-scoped plugin calls can still reject per-run subagent model overrides even when the plugin entry is allowlisted; Loop Guard records that policy rejection and uses default-model fallback instead.

## Next Work

- Upstream the terminal-failure lifecycle and plugin-subagent hot patches into OpenClaw core.
- Add session quarantine and restart-recovery suppression for repeatedly failing source sessions.
