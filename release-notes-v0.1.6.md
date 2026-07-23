# Loop Guard v0.1.6

Adds conservative no-progress detection for successful tool-call loops.

## Changes

- Tracks repeated successful high-risk tool calls by normalized tool name and arguments.
- Rewrites the repeated success result with model-visible guidance once `noProgressSoftThreshold` is reached.
- Allows no-progress events to trigger the same executor handoff path as repeated failures when handoff is enabled.
- Adds config:
  - `noProgressDetectionEnabled`
  - `noProgressSoftThreshold`
  - `noProgressHardThreshold`
  - `noProgressTools`
  - `noProgressMessage`
- Adds regression tests for repeated successful command detection and no-progress result wrapping.

## Why

Some loops do not fail at the tool layer. A driver can repeatedly run the same successful command, observe no new information, and keep the chat blocked. This release catches that action-shape loop and nudges the model to stop, summarize, change strategy, or ask for human input.
