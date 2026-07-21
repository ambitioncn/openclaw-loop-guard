import assert from "node:assert/strict";
import test from "node:test";
import {
  createFailureSignature,
  createGuardedToolResult,
  createLoopGuardState,
  normalizeConfig,
  shouldBlockRepeatedCall,
  shouldTreatResultAsFailure
} from "../src/loop.js";

test("normalizes config thresholds", () => {
  assert.deepEqual(
    normalizeConfig({ softThreshold: 3, hardThreshold: 2 }).hardThreshold,
    3
  );
  assert.equal(normalizeConfig({ blockRepeatedCalls: true }).blockRepeatedCalls, true);
  assert.equal(normalizeConfig({ blockRepeatedCalls: "true" }).blockRepeatedCalls, false);
  assert.equal(normalizeConfig({ pendingTimeoutMs: 0 }).pendingTimeoutMs, 0);
});

test("creates stable signatures without volatile ids", () => {
  const a = createFailureSignature({
    toolName: "exec",
    params: { cmd: "ls /root", toolCallId: "a" },
    error: "Permission denied"
  });
  const b = createFailureSignature({
    toolName: "exec",
    params: { cmd: "ls /root", toolCallId: "b" },
    error: "Permission denied"
  });
  assert.equal(a.key, b.key);
});

test("tracks repeated failures inside a window", () => {
  const state = createLoopGuardState({ windowMs: 1000 });
  const first = state.observeFailure({
    toolName: "exec",
    params: { cmd: "false" },
    error: "exit code 1"
  }, 1000);
  const second = state.observeFailure({
    toolName: "exec",
    params: { cmd: "false" },
    error: "exit code 1"
  }, 1100);
  assert.equal(first.count, 1);
  assert.equal(second.count, 2);
});

test("looks up prior failures before a new call by tool and params", () => {
  const state = createLoopGuardState({ windowMs: 1000 });
  state.observeFailure({
    toolName: "exec",
    params: { cmd: "false" },
    error: "exit code 1"
  }, 1000);
  const entry = state.getMostRecentFailureForCall({
    toolName: "exec",
    params: { cmd: "false" }
  }, 1100);
  assert.equal(entry.count, 1);
});

test("detects common textual failures", () => {
  assert.equal(
    shouldTreatResultAsFailure({
      result: { content: [{ type: "text", text: "Permission denied" }] }
    }),
    true
  );
});

test("wraps repeated failure results with model-visible guidance", () => {
  const result = createGuardedToolResult(
    { content: [{ type: "text", text: "Permission denied" }] },
    "change strategy",
    {
      count: 2,
      toolName: "exec",
      paramsHash: "abc",
      errorHash: "def",
      errorSummary: "Permission denied"
    }
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /change strategy/);
  assert.equal(result.details.loopGuard.count, 2);
});

test("does not hard-block repeated calls unless explicitly enabled", () => {
  const entry = { count: 3, toolName: "exec" };
  assert.equal(shouldBlockRepeatedCall(entry, { hardThreshold: 3 }, "exec"), false);
  assert.equal(
    shouldBlockRepeatedCall(entry, { blockRepeatedCalls: true, hardThreshold: 3 }, "exec"),
    true
  );
});

test("uses soft threshold for high-risk tools when hard blocking is enabled", () => {
  const entry = { count: 2, toolName: "exec" };
  assert.equal(
    shouldBlockRepeatedCall(
      entry,
      { blockRepeatedCalls: true, softThreshold: 2, hardThreshold: 4 },
      "exec"
    ),
    true
  );
});

test("records pending timeouts and blocks matching retries by default", () => {
  const state = createLoopGuardState({ pendingTimeoutMs: 50 });
  const entry = state.observePendingTimeout(
    {
      toolName: "exec",
      params: { cmd: "ssh host long-running-command" },
      timeoutMs: 50
    },
    1000
  );
  assert.equal(entry.pendingTimeout, true);
  assert.equal(
    shouldBlockRepeatedCall(entry, { blockRepeatedCalls: false, blockAfterPendingTimeout: true }),
    true
  );
  assert.equal(
    shouldBlockRepeatedCall(entry, { blockAfterPendingTimeout: false }),
    false
  );
});
