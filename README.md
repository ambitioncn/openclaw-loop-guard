# OpenClaw Loop Guard

OpenClaw Loop Guard is a plugin that detects repeated tool failures and stops an agent from retrying the same failing action forever.

It is intended for local-model deployments where a capable reasoning model is used as the front-stage brain, while risky tool execution can be guarded, redirected, or escalated.

## What It Does

- Observes tool failures with `after_tool_call`.
- Rewrites repeated failure results with `agentToolResultMiddleware`.
- Records high-risk tool calls that do not return before `pendingTimeoutMs`.
- Optionally blocks unproductive repeat calls with `before_tool_call`.
- Stores lightweight audit events outside the session transcript.
- Provides a `/loop-guard` command for status and reset.

## MVP Policy

The first implementation is deliberately small:

- First failure: return normally.
- Second matching failure: tell the model to choose another strategy.
- Third matching failure: can block the same call when `blockRepeatedCalls` is enabled.
- High-risk tools can be blocked at the soft threshold when hard blocking is enabled.
- A high-risk tool call that exceeds `pendingTimeoutMs` is treated as a stuck call; the same call is blocked on retry by default.

Hard blocking is disabled by default while the plugin is being proven on real OpenClaw sessions.
With the default config, repeated failures are still rewritten with model-visible guidance.

Failure identity is based on:

- tool name
- normalized argument hash
- error/result summary hash

Volatile ids such as `toolCallId`, `runId`, `turnId`, and timestamps are ignored.

## Install

From a checkout:

```bash
openclaw plugins install ./openclaw-loop-guard --link --force
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
          "softThreshold": 2,
          "hardThreshold": 3,
          "windowMs": 600000,
          "highRiskTools": ["exec", "apply_patch", "write", "edit"]
        }
      }
    }
  }
}
```

Restart the gateway after install or config changes.

## Commands

```text
/loop-guard
/loop-guard reset
```

## Development

```bash
npm test
npm run check
```

## Current Limits

- This MVP does not kill stuck sessions.
- This MVP does not automatically spawn a GPT/Codex executor yet.
- Escalation should be added as a second phase after the hook behavior is proven on real OpenClaw sessions.
