# OpenClaw Loop Guard v0.1.3

This release improves Loop Guard coverage for real-world stuck sessions:

- Adds optional `agent_end` failure detection with `handoffOnAgentFailure`.
- Detects model/session-level failures such as `stopReason=length`, output-limit failures, and `non_deliverable_terminal_turn`.
- Starts an executor handoff for agent-level failures when enabled, while avoiding recursive handoffs from Loop Guard-owned executor sessions.
- Improves failure text detection for shell output that reports `no such file or directory` or `command not found`.
- Adds Chinese failure phrase detection, including `没有那个文件或目录` and `未找到命令`, so localized shell output can still count toward repeated-failure protection.
- Adds regression coverage for agent-level failures and Chinese failure text detection.

Validation:

- `npm test` passed, 30/30.
- `npm run check` passed.
- Verified on `nickv100` with OpenClaw `2026.6.11`.
