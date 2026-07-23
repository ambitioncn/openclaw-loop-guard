# OpenClaw Loop Guard v0.1.4

This release closes the agent-failure gap for context overflow prechecks:

- Detects agent turns that fail with `Context overflow: prompt too large for the model`.
- Classifies those failures as `context_overflow` from the `agent_end` hook.
- Allows `handoffOnAgentFailure` to start an executor handoff after exhausted overflow recovery.
- Adds regression coverage for precheck context overflow failures.

Validation:

- `npm test` passed.
- `npm run check` passed.
- Verified on `nickv100` with OpenClaw `2026.6.11`.
