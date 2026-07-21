import assert from "node:assert/strict";
import test from "node:test";
import {
  createHandoffRequest,
  createFailureSignature,
  createGuardedToolResult,
  createLoopGuardState,
  createParamsPreview,
  normalizeConfig,
  shouldBlockRepeatedCall,
  shouldStartHandoff,
  shouldTreatResultAsFailure,
  splitModelRef,
  withExecutorHint
} from "../src/loop.js";

test("normalizes config thresholds", () => {
  assert.deepEqual(
    normalizeConfig({ softThreshold: 3, hardThreshold: 2 }).hardThreshold,
    3
  );
  assert.equal(normalizeConfig({ blockRepeatedCalls: true }).blockRepeatedCalls, true);
  assert.equal(normalizeConfig({ blockRepeatedCalls: "true" }).blockRepeatedCalls, false);
  assert.equal(normalizeConfig({ pendingTimeoutMs: 0 }).pendingTimeoutMs, 0);
  assert.equal(normalizeConfig({ driverModel: " qwen ", executorModel: " gpt " }).driverModel, "qwen");
  assert.equal(normalizeConfig({ handoffEnabled: true }).handoffEnabled, true);
  assert.equal(normalizeConfig({ paramsPreviewMaxChars: 120 }).paramsPreviewMaxChars, 120);
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

test("adds redacted bounded params previews to failures", () => {
  const preview = createParamsPreview(
    {
      cmd: "curl -H 'Authorization: Bearer sk-secret1234567890' https://example.test",
      token: "npm_secret1234567890",
      toolCallId: "volatile"
    },
    120
  );
  assert.match(preview, /"token":"\[redacted\]"/);
  assert.doesNotMatch(preview, /sk-secret1234567890/);
  assert.doesNotMatch(preview, /npm_secret1234567890/);

  const state = createLoopGuardState({ paramsPreviewMaxChars: 20 });
  const entry = state.observeFailure({
    toolName: "exec",
    params: { cmd: "definitely_missing_command --with-long-argument" },
    error: "not found"
  });
  assert.match(entry.paramsPreview, /truncated/);
  assert.ok(entry.paramsPreview.length <= 35);
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

test("adds configured driver and executor roles to strategy messages", () => {
  const message = withExecutorHint("change strategy", {
    driverModel: "qwen-local/qwen36",
    executorModel: "openai/gpt-5.5",
    executorRuntime: "codex"
  });
  assert.match(message, /driver=qwen-local\/qwen36/);
  assert.match(message, /executor=openai\/gpt-5\.5/);
  assert.match(message, /executorRuntime=codex/);
});

test("requires explicit handoff enablement and executor model", () => {
  const entry = {
    key: "exec:a:b",
    count: 2,
    toolName: "exec",
    paramsHash: "a",
    errorHash: "b",
    errorSummary: "not found"
  };
  assert.equal(shouldStartHandoff("warn", entry, { executorModel: "openai/gpt-5.5" }), false);
  assert.equal(shouldStartHandoff("warn", entry, { handoffEnabled: true }), false);
  assert.equal(
    shouldStartHandoff("warn", entry, { handoffEnabled: true, executorModel: "openai/gpt-5.5" }),
    true
  );
  assert.equal(
    shouldStartHandoff("warn", entry, {
      handoffEnabled: true,
      executorModel: "openai/gpt-5.5",
      handoffOnSoftWarn: false
    }),
    false
  );
});

test("builds subagent handoff request from configured executor", () => {
  const entry = {
    key: "exec:a:b",
    count: 2,
    toolName: "exec",
    paramsHash: "a",
    errorHash: "b",
    errorSummary: "not found"
  };
  assert.deepEqual(splitModelRef("openai/gpt-5.5"), {
    provider: "openai",
    model: "gpt-5.5"
  });
  const request = createHandoffRequest({
    trigger: "warn",
    entry,
    config: {
      handoffEnabled: true,
      driverModel: "qwen-local/qwen36",
      executorModel: "openai/gpt-5.5",
      executorRuntime: "codex"
    },
    context: {
      agentId: "main",
      sessionKey: "agent:main:feishu:direct:user",
      runId: "run-1"
    }
  });
  assert.equal(request.provider, "openai");
  assert.equal(request.model, "gpt-5.5");
  assert.match(request.sessionKey, /^agent:main:subagent:loop-guard-/);
  assert.match(request.message, /Executor instructions/);
  assert.match(request.message, /Do not call tools/);
  assert.match(request.message, /approval/);
  assert.match(request.idempotencyKey, /loop-guard:warn:/);
});

test("includes sanitized params preview in handoff request", () => {
  const entry = {
    key: "exec:a:b",
    count: 2,
    toolName: "exec",
    paramsHash: "a",
    errorHash: "b",
    errorSummary: "not found",
    paramsPreview: '{"cmd":"definitely_missing_command","token":"[redacted]"}'
  };
  const request = createHandoffRequest({
    trigger: "warn",
    entry,
    config: { handoffEnabled: true, executorModel: "openai/gpt-5.5" },
    context: { agentId: "main" }
  });
  assert.match(request.message, /sanitized params preview/);
  assert.match(request.message, /definitely_missing_command/);
  assert.match(request.message, /"token":"\[redacted\]"/);
});
