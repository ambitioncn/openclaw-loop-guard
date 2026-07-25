# Loop Guard v0.2.0

Turns Loop Guard from a repeat-failure warning plugin into a local-to-cloud task failover bridge.

## Changes

- Recognizes OpenClaw native circuit-breaker aborts and starts a cloud handoff.
- Builds bounded, redacted recovery context from the source session so the executor can finish the original task instead of merely diagnosing the failure.
- Detects terminal provider failures, local-model tool-schema incompatibility, model output limits, context overflow, and persistent tool loops.
- Adds opt-in `model_call_ended` takeover for installations where Loop Guard owns escalation.
- Normalizes empty paginated `read` calls by path so changing offsets cannot evade no-progress detection.
- Adds an idempotent, version/shape-guarded OpenClaw core patch for awaited terminal `agent_end` dispatch.
- Expands regression coverage to 38 tests.

## Verified

A forced local-provider failure on OpenClaw `2026.7.1-2` produced exactly one failure event and one cloud handoff. The handoff ran on `openai/gpt-5.5`, recovered the original task, and returned `TAKEOVER_OK 323`.

## Upgrade Note

Keep `handoffOnModelCallFailure=false` when OpenClaw native model fallback owns escalation. Enable it only when Loop Guard is the single takeover owner.
