# OpenClaw Loop Guard v0.1.0

First stable GitHub release of OpenClaw Loop Guard.

## Highlights

- Detects repeated tool failures and gives model-visible guidance before the agent keeps retrying the same failed action.
- Tracks high-risk pending tool calls and can block matching retries after timeout.
- Adds `/loop-guard` status/reset commands and `/loop-guard approve latest` for human-approved executor handoff resume.
- Supports plugin-owned executor subagent handoff with configurable executor model/runtime.
- Requests handoff completion delivery back to the source session.
- Includes Feishu slash-command E2E acceptance command: `/loop-guard e2e completion wait=30s`.
- Includes a targeted OpenClaw `2026.6.x` dist hot patch helper for `approvalGrant`, `requesterSessionKey`, `expectsCompletionMessage`, expected completion wake fallback log cleanup, and unique plugin completion labels.

## Verification

- `npm test` passed: 29/29 tests.
- `npm run check` passed.
- Real Feishu slash-command completion E2E was verified on `nickv100` with OpenClaw `2026.6.11`.

## Notes

- Hard blocking is disabled by default; repeated failures are still rewritten with guidance.
- Handoff execution is opt-in via `handoffEnabled`.
- On OpenClaw `2026.6.11`, completion delivery and per-run approval grant support require the bundled hot patch script until the upstream OpenClaw core PR is merged and released.

