import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildApprovedHandoffScopeRules,
  createApprovedHandoffRequest,
  createCompletionE2eRequest,
  createApprovalPrompt,
  createHandoffRequest,
  createFailureSignature,
  createGuardedToolResult,
  createLoopGuardState,
  createNoProgressSignature,
  createNoProgressToolResult,
  createParamsPreview,
  createStatusMessage,
  createSubagentRunParams,
  createAgentFailureContext,
  detectAgentTurnFailure,
  findHandoffEvent,
  getHandoffLifecycle,
  isCircuitBreakerResult,
  normalizeNoProgressParams,
  normalizePolicyFailure,
  normalizeApprovedToolAllowList,
  normalizeConfig,
  parseApproveArgs,
  readRecentSessionContext,
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
  assert.deepEqual(normalizeConfig({ handoffToolsAllow: [" read ", 1, ""] }).handoffToolsAllow, [
    "read",
    "1"
  ]);
  assert.deepEqual(normalizeConfig({ approvedHandoffToolsAllow: [" read ", "read", ""] }).approvedHandoffToolsAllow, [
    "read"
  ]);
  assert.deepEqual(normalizeConfig({ approvedHandoffWriteRoots: [" /repo ", "/repo", ""] }).approvedHandoffWriteRoots, [
    "/repo"
  ]);
  assert.equal(normalizeConfig({}).approvedHandoffAllowRiskyOperations, true);
  assert.equal(normalizeConfig({ handoffOnAgentFailure: true }).handoffOnAgentFailure, true);
  assert.equal(normalizeConfig({ handoffOnAgentFailure: "true" }).handoffOnAgentFailure, false);
  assert.equal(normalizeConfig({}).approvedHandoffMaxAgeMs, 1800000);
  assert.equal(normalizeConfig({ approvedHandoffMaxAgeMs: 0 }).approvedHandoffMaxAgeMs, 0);
  assert.equal(normalizeConfig({ approvedHandoffAllowRiskyOperations: false }).approvedHandoffAllowRiskyOperations, false);
  assert.equal(normalizeConfig({ approvedHandoffRequireExecTimeout: false }).approvedHandoffRequireExecTimeout, false);
  assert.equal(normalizeConfig({ paramsPreviewMaxChars: 120 }).paramsPreviewMaxChars, 120);
  assert.equal(normalizeConfig({}).noProgressDetectionEnabled, true);
  assert.equal(normalizeConfig({ noProgressDetectionEnabled: false }).noProgressDetectionEnabled, false);
  assert.equal(normalizeConfig({ noProgressSoftThreshold: 5, noProgressHardThreshold: 3 }).noProgressHardThreshold, 5);
  assert.deepEqual(normalizeConfig({ noProgressTools: [" exec ", "image", ""] }).noProgressTools, [
    "exec",
    "image"
  ]);
});

test("detects model-level agent turn failures", () => {
  assert.deepEqual(
    detectAgentTurnFailure({
      success: false,
      messages: [{ role: "assistant", stopReason: "length", content: [] }]
    }),
    {
      kind: "model_output_length",
      stopReason: "length",
      errorSummary: "agent turn hit model output length limit"
    }
  );

  assert.deepEqual(
    detectAgentTurnFailure({
      success: false,
      error: "non_deliverable_terminal_turn"
    }),
    {
      kind: "non_deliverable_terminal_turn",
      stopReason: "unknown",
      errorSummary: "agent turn ended as non_deliverable_terminal_turn"
    }
  );

  assert.deepEqual(
    detectAgentTurnFailure({
      success: false,
      error: "Context overflow: prompt too large for the model (precheck)."
    }),
    {
      kind: "context_overflow",
      stopReason: "unknown",
      errorSummary: "agent turn hit model context window limit"
    }
  );

  assert.deepEqual(
    detectAgentTurnFailure({
      success: false,
      error: "Tool loop detected: global circuit breaker triggered"
    }),
    {
      kind: "tool_loop_circuit_breaker",
      stopReason: "unknown",
      errorSummary: "agent run was aborted by tool-loop circuit breaker"
    }
  );

  assert.deepEqual(
    detectAgentTurnFailure({
      success: false,
      error: "compaction_loop_persisted"
    }),
    {
      kind: "tool_loop_circuit_breaker",
      stopReason: "unknown",
      errorSummary: "agent run was aborted by tool-loop circuit breaker"
    }
  );

  assert.deepEqual(
    detectAgentTurnFailure({
      success: false,
      error:
        "LLM request failed: provider rejected the request schema or tool payload. " +
        "Automatic parser generation failed: JSON schema conversion failed"
    }),
    {
      kind: "local_model_tool_schema",
      stopReason: "unknown",
      errorSummary: "local model could not accept the tool schema or tool payload"
    }
  );

  assert.deepEqual(
    detectAgentTurnFailure({
      success: false,
      error: "LLM request failed: network connection error."
    }),
    {
      kind: "provider_terminal_failure",
      stopReason: "unknown",
      errorSummary: "agent turn ended after a terminal model provider failure"
    }
  );

  assert.equal(detectAgentTurnFailure({ success: true, messages: [] }), undefined);
});

test("builds a bounded recent context for cloud failover", () => {
  const context = createAgentFailureContext({
    messages: [
      { role: "user", content: [{ type: "text", text: "Fix the APK install loop" }] },
      { role: "assistant", content: [{ type: "text", text: "I will inspect the logs." }] },
      {
        role: "tool",
        name: "exec",
        content: [{ type: "text", text: "Authorization: Bearer sk-secret1234567890" }]
      }
    ]
  });
  assert.match(context, /user: Fix the APK install loop/);
  assert.match(context, /assistant: I will inspect the logs/);
  assert.match(context, /tool\(exec\): Authorization: Bearer \[redacted\]/);
  assert.doesNotMatch(context, /sk-secret1234567890/);
});

test("reads a bounded source session tail for cloud failover", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "loop-guard-session-"));
  const sessionDir = path.join(home, ".openclaw", "agents", "main", "sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, "session-1.jsonl"),
    [
      JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "Finish the build" }] }
      }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "Running tests" }] }
      })
    ].join("\n")
  );
  const context = readRecentSessionContext({
    home,
    agentId: "main",
    sessionId: "session-1"
  });
  assert.match(context, /user: Finish the build/);
  assert.match(context, /assistant: Running tests/);
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

test("tracks repeated successful calls as no-progress signals", () => {
  const state = createLoopGuardState({ windowMs: 1000 });
  const params = {
    command:
      "adb shell \"am start -a android.intent.action.VIEW -d 'exp://192.168.50.238:8081' host.exp.exponent\" && sleep 10 && adb shell screencap -p /sdcard/screen.png"
  };
  const first = state.observeNoProgress({ toolName: "exec", params }, 1000);
  const second = state.observeNoProgress({ toolName: "exec", params }, 1100);

  assert.equal(first.count, 1);
  assert.equal(second.count, 2);
  assert.equal(second.noProgress, true);
  assert.equal(second.errorSummary, "successful tool call repeated without visible progress");

  const signature = createNoProgressSignature({ toolName: "exec", params });
  assert.equal(signature.key, first.key);
});

test("groups policy failures across changing params", () => {
  const state = createLoopGuardState({ windowMs: 1000 });
  const first = state.observeFailure({
    toolName: "write",
    params: { path: "/tmp/a.js", content: "one" },
    error: "Memory flush writes are restricted to memory/2026-07-23.md; use that path only."
  }, 1000);
  const second = state.observeFailure({
    toolName: "write",
    params: { path: "/tmp/b.js", content: "two" },
    error: '{ "status": "error", "tool": "write", "error": "Memory flush writes are restricted to memory/2026-07-23.md; use that path only." }'
  }, 1100);

  assert.equal(first.key, second.key);
  assert.equal(second.count, 2);
  assert.equal(second.errorSummary, "Memory flush writes are restricted to memory/YYYY-MM-DD.md; use that path only.");
  assert.deepEqual(normalizePolicyFailure("Local media path is not under an allowed directory: /tmp/x.png"), {
    kind: "media_path_not_allowed",
    errorSummary: "Local media path is not under an allowed directory."
  });
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
  assert.equal(
    shouldTreatResultAsFailure({
      result: {
        content: [
          {
            type: "text",
            text: "grep: /home/nick/apps/cardvault-api/app/server.js: 没有那个文件或目录"
          }
        ]
      }
    }),
    true
  );
  assert.equal(
    shouldTreatResultAsFailure({
      result: { content: [{ type: "text", text: "/bin/bash: foo: 未找到命令" }] }
    }),
    true
  );
});

test("detects OpenClaw critical loop breaker results", () => {
  assert.equal(
    isCircuitBreakerResult({
      content: [
        {
          type: "text",
          text:
            "CRITICAL: Called exec with identical arguments and identical outcomes 10 times. " +
            "Session execution blocked to prevent runaway loops."
        }
      ]
    }),
    true
  );
  assert.equal(
    isCircuitBreakerResult({
      content: [{ type: "text", text: "Loop warning: exec called 6 times" }]
    }),
    false
  );
});

test("groups empty read pagination as no-progress on the same file", () => {
  const first = createNoProgressSignature({
    toolName: "read",
    params: { path: "/tmp/apk-verify.txt", limit: 10, offset: 1600 },
    result: { content: [{ type: "text", text: "" }] }
  });
  const second = createNoProgressSignature({
    toolName: "read",
    params: { path: "/tmp/apk-verify.txt", limit: 10, offset: 1605 },
    result: { content: [{ type: "text", text: "" }] }
  });
  const contentful = createNoProgressSignature({
    toolName: "read",
    params: { path: "/tmp/apk-verify.txt", limit: 10, offset: 1605 },
    result: { content: [{ type: "text", text: "line" }] }
  });

  assert.equal(first.paramsHash, second.paramsHash);
  assert.notEqual(first.paramsHash, contentful.paramsHash);
  assert.deepEqual(
    normalizeNoProgressParams({
      toolName: "read",
      params: { path: "/tmp/apk-verify.txt", limit: 10, offset: 1600 },
      result: { content: [{ type: "text", text: "" }] }
    }),
    { path: "/tmp/apk-verify.txt", emptyResult: true }
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

test("wraps repeated successful calls with no-progress guidance", () => {
  const result = createNoProgressToolResult(
    { content: [{ type: "text", text: "Starting: Intent..." }] },
    "stop repeating",
    {
      count: 4,
      toolName: "exec",
      paramsHash: "abc",
      errorHash: "def"
    }
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /stop repeating/);
  assert.match(result.content[0].text, /No-progress signature/);
  assert.equal(result.details.loopGuard.action, "no-progress");
  assert.equal(result.details.loopGuard.count, 4);
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
  assert.equal(
    shouldStartHandoff("agent-failure", entry, {
      handoffEnabled: true,
      executorModel: "openai/gpt-5.5"
    }),
    false
  );
  assert.equal(
    shouldStartHandoff("agent-failure", entry, {
      handoffEnabled: true,
      executorModel: "openai/gpt-5.5",
      handoffOnAgentFailure: true
    }),
    true
  );
  assert.equal(
    shouldStartHandoff("circuit-breaker", entry, {
      handoffEnabled: true,
      executorModel: "openai/gpt-5.5",
      handoffOnAgentFailure: true
    }),
    true
  );
  assert.equal(
    shouldStartHandoff("model-call-failure", entry, {
      handoffEnabled: true,
      executorModel: "openai/gpt-5.5",
      handoffOnModelCallFailure: true
    }),
    true
  );
  assert.equal(
    shouldStartHandoff("no-progress", entry, {
      handoffEnabled: true,
      executorModel: "openai/gpt-5.5"
    }),
    true
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
  assert.equal(request.requesterSessionKey, "agent:main:feishu:direct:user");
  assert.equal(request.expectsCompletionMessage, true);
  assert.deepEqual(request.toolsAllow, []);
  assert.match(request.message, /Executor instructions/);
  assert.match(request.message, /toolsAllow=\[\]/);
  assert.match(request.message, /permission/);
  assert.match(request.idempotencyKey, /loop-guard:warn:/);
});

test("passes completion delivery fields to subagent runs", () => {
  const request = createHandoffRequest({
    trigger: "warn",
    entry: {
      key: "exec:a:b",
      count: 2,
      toolName: "exec",
      paramsHash: "a",
      errorHash: "b",
      errorSummary: "not found"
    },
    config: { handoffEnabled: true, executorModel: "openai/gpt-5.5" },
    context: {
      agentId: "main",
      sessionKey: "agent:main:feishu:direct:user",
      runId: "run-1"
    }
  });
  const params = createSubagentRunParams(request);
  assert.equal(params.sessionKey, request.sessionKey);
  assert.equal(params.requesterSessionKey, "agent:main:feishu:direct:user");
  assert.equal(params.expectsCompletionMessage, true);
  assert.equal(params.deliver, false);
  assert.equal(params.lightContext, true);
});

test("builds slash-command completion e2e handoff request", () => {
  const request = createCompletionE2eRequest({
    config: {
      handoffEnabled: true,
      executorModel: "openai/gpt-5.5",
      handoffToolsAllow: ["read"]
    },
    context: {
      agentId: "main",
      sessionKey: "agent:main:feishu:direct:user"
    },
    marker: "loop-guard-e2e-test"
  });
  assert.equal(request.marker, "loop-guard-e2e-test");
  assert.equal(request.requesterSessionKey, "agent:main:feishu:direct:user");
  assert.equal(request.expectsCompletionMessage, true);
  assert.deepEqual(request.toolsAllow, []);
  assert.match(request.idempotencyKey, /loop-guard:slash-e2e:/);
  assert.match(request.message, /LOOP_GUARD_E2E_COMPLETION_OK loop-guard-e2e-test/);
  assert.match(request.message, /requesterSessionKey: agent:main:feishu:direct:user/);
  assert.match(request.message, /expectsCompletionMessage: true/);
  assert.match(request.message, /Do not call tools/);
  assert.equal(request.e2eEntry.toolName, "loop-guard-e2e");
});

test("builds handoff prompt for explicitly allowed tools", () => {
  const entry = {
    key: "exec:a:b",
    count: 2,
    toolName: "exec",
    paramsHash: "a",
    errorHash: "b",
    errorSummary: "not found"
  };
  const request = createHandoffRequest({
    trigger: "warn",
    entry,
    config: {
      handoffEnabled: true,
      executorModel: "openai/gpt-5.5",
      handoffToolsAllow: ["read", "apply_patch"]
    },
    context: { agentId: "main" }
  });
  assert.deepEqual(request.toolsAllow, ["read", "apply_patch"]);
  assert.match(request.message, /only these tools: read, apply_patch/);
  assert.match(request.message, /pre-approved/);
});

test("circuit-breaker handoff tells executor to recover the parent task", () => {
  const request = createHandoffRequest({
    trigger: "circuit-breaker",
    entry: {
      key: "exec:a:b",
      count: 10,
      toolName: "exec",
      paramsHash: "a",
      errorHash: "b",
      errorSummary: "Session execution blocked to prevent runaway loops"
    },
    config: {
      handoffEnabled: true,
      executorModel: "openai/gpt-5.5",
      handoffToolsAllow: ["read", "exec"]
    },
    context: {
      agentId: "main",
      sessionKey: "agent:main:feishu:direct:user",
      recentContext: [
        "user: Build the requested artifact",
        "assistant: Completed setup and started verification",
        "tool(exec): Session execution blocked to prevent runaway loops"
      ].join("\n")
    }
  });
  assert.match(request.message, /primary objective: complete the original user's task/i);
  assert.match(request.message, /failover recovery packet/i);
  assert.match(request.message, /preserve work already completed/i);
  assert.match(request.message, /Build the requested artifact/);
  assert.match(request.message, /finish the original user task/i);
});

test("builds a human approval prompt for executor handoff", () => {
  const prompt = createApprovalPrompt({
    handoff: {
      sessionKey: "agent:main:subagent:loop-guard-source-a-b",
      runId: "run-2"
    },
    config: {
      executorModel: "openai/gpt-5.5",
      approvedHandoffToolsAllow: ["read", "exec", "apply_patch"],
      approvedHandoffWriteRoots: ["/repo"]
    },
    entry: {
      toolName: "exec",
      paramsHash: "a",
      errorHash: "b"
    }
  });
  assert.match(prompt, /Human approval needed/);
  assert.match(prompt, /\/loop-guard approve latest tools=read,exec,bash,apply_patch roots=\/repo/);
  assert.match(prompt, /Executor handoff: agent:main:subagent:loop-guard-source-a-b run=run-2/);
  assert.match(prompt, /Approval grant lifetime after approval: 10 minutes/);
  assert.match(prompt, /can be approved for 30 minutes after it starts/);
  assert.match(prompt, /Original failure: exec params=a error=b/);
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

test("parses approve command args with default and explicit tools", () => {
  assert.deepEqual(parseApproveArgs("approve latest", ["read", "exec"]), {
    selector: "latest",
    toolsAllow: ["read", "exec", "bash"],
    writeRoots: [],
    confirmRisky: true
  });
  assert.deepEqual(parseApproveArgs("approve abc123 tools=read,apply_patch,read roots=/repo,/tmp confirm=safe", ["exec"]), {
    selector: "abc123",
    toolsAllow: ["read", "apply_patch"],
    writeRoots: ["/repo", "/tmp"],
    confirmRisky: false
  });
});

test("finds latest and selected handoff events", () => {
  const events = [
    { action: "observe", paramsHash: "first" },
    { action: "handoff-started", handoffSessionKey: "agent:main:subagent:old", paramsHash: "aaa" },
    { action: "handoff-started", handoffSessionKey: "agent:main:subagent:new", paramsHash: "bbb" }
  ];
  assert.equal(findHandoffEvent(events, "latest").paramsHash, "bbb");
  assert.equal(findHandoffEvent(events, "old").paramsHash, "aaa");
  assert.equal(findHandoffEvent(events, "missing"), undefined);
});

test("handoff lifecycle tracks approved and completed states", () => {
  const first = {
    action: "handoff-started",
    handoffSessionKey: "agent:main:subagent:first",
    handoffRunId: "run-1",
    paramsHash: "aaa"
  };
  const second = {
    action: "handoff-started",
    handoffSessionKey: "agent:main:subagent:second",
    handoffRunId: "run-2",
    paramsHash: "bbb"
  };
  const events = [
    first,
    {
      action: "handoff-approved-started",
      handoffSessionKey: "agent:main:subagent:first",
      sourceHandoffRunId: "run-1"
    },
    {
      action: "handoff-completed",
      handoffSessionKey: "agent:main:subagent:first"
    },
    second
  ];
  assert.equal(getHandoffLifecycle(events, first).status, "completed");
  assert.equal(getHandoffLifecycle(events, second).status, "pending");
  assert.equal(findHandoffEvent(events, "latest", { requirePending: true }), second);
  assert.equal(findHandoffEvent(events, "first", { requirePending: true }), undefined);
});

test("handoff lifecycle marks old pending handoffs stale", () => {
  const event = {
    action: "handoff-started",
    handoffSessionKey: "agent:main:subagent:old",
    handoffRunId: "run-1",
    paramsHash: "aaa",
    at: "2026-07-22T00:00:00.000Z"
  };
  const events = [event];
  assert.equal(
    getHandoffLifecycle(events, event, {
      now: Date.parse("2026-07-22T00:31:00.000Z"),
      maxAgeMs: 30 * 60 * 1000
    }).status,
    "stale"
  );
  assert.equal(
    findHandoffEvent(events, "latest", {
      requirePending: true,
      now: Date.parse("2026-07-22T00:31:00.000Z"),
      maxAgeMs: 30 * 60 * 1000
    }),
    undefined
  );
});

test("status message includes latest handoff and approval command", () => {
  const message = createStatusMessage({
    config: {
      enabled: true,
      handoffEnabled: true,
      executorModel: "openai/gpt-5.5",
      approvedHandoffToolsAllow: ["read", "exec"],
      approvedHandoffWriteRoots: ["/repo"]
    },
    snapshot: [{ key: "exec:a:b" }],
    events: [
      {
        action: "handoff-started",
        handoffSessionKey: "agent:main:subagent:loop-guard-source-a-b",
        handoffRunId: "run-2",
        trigger: "warn",
        toolName: "exec",
        paramsHash: "a",
        errorHash: "b"
      }
    ]
  });
  assert.match(message, /tracked failures=1/);
  assert.match(message, /Handoff: enabled; executor=openai\/gpt-5\.5/);
  assert.match(message, /Latest handoff:/);
  assert.match(message, /\/loop-guard approve latest tools=read,exec,bash roots=\/repo/);
});

test("status message does not suggest approval for completed latest handoff", () => {
  const message = createStatusMessage({
    config: {
      enabled: true,
      handoffEnabled: true,
      executorModel: "openai/gpt-5.5",
      approvedHandoffToolsAllow: ["read", "exec"]
    },
    events: [
      {
        action: "handoff-started",
        handoffSessionKey: "agent:main:subagent:loop-guard-source-a-b",
        handoffRunId: "run-2",
        trigger: "warn",
        toolName: "exec",
        paramsHash: "a",
        errorHash: "b"
      },
      {
        action: "handoff-completed",
        handoffSessionKey: "agent:main:subagent:loop-guard-source-a-b"
      }
    ]
  });
  assert.match(message, /status: completed/);
  assert.match(message, /will not re-approve/);
  assert.doesNotMatch(message, /Human approval needed/);
});

test("builds approved handoff request for the same session with approved tools", () => {
  const request = createApprovedHandoffRequest({
    event: {
      action: "handoff-started",
      handoffSessionKey: "agent:main:subagent:loop-guard-source-a-b",
      executorModel: "openai/gpt-5.5",
      trigger: "warn",
      agentId: "main",
      sessionKey: "agent:main:feishu:direct:user",
      runId: "run-1",
      toolName: "exec",
      paramsHash: "a",
      errorHash: "b",
      count: 2,
      errorSummary: "not found",
      paramsPreview: "{\"cmd\":\"missing\"}"
    },
    config: { executorModel: "openai/gpt-5.5" },
    toolsAllow: ["read", "exec", "apply_patch"],
    writeRoots: ["/repo"]
  });
  assert.equal(request.sessionKey, "agent:main:subagent:loop-guard-source-a-b");
  assert.equal(request.provider, "openai");
  assert.equal(request.model, "gpt-5.5");
  assert.equal(request.requesterSessionKey, "agent:main:feishu:direct:user");
  assert.equal(request.expectsCompletionMessage, true);
  assert.deepEqual(request.toolsAllow, ["read", "exec", "bash", "apply_patch"]);
  assert.deepEqual(request.writeRoots, ["/repo"]);
  assert.equal(request.approvalGrant.kind, "loop_guard_inherited_approval");
  assert.equal(request.approvalGrant.approvalPolicy, "never");
  assert.equal(request.approvalGrant.sandbox, "danger-full-access");
  assert.deepEqual(request.approvalGrant.toolsAllow, ["read", "exec", "bash", "apply_patch"]);
  assert.deepEqual(request.approvalGrant.writeRoots, ["/repo"]);
  assert.equal(request.approvalGrant.sourceRunId, "run-1");
  assert.match(request.idempotencyKey, /^loop-guard:approve:/);
  assert.match(request.message, /Approval received/i);
  assert.match(request.message, /Approved tools: read, exec, bash, apply_patch/);
  assert.match(request.message, /Approved write roots: \/repo/);
  assert.match(request.message, /Risky operations approved by this approval: yes/);
  assert.match(request.message, /Every exec command must be non-interactive and include an explicit timeout/);
  assert.match(request.message, /Writes are approved only under these roots: \/repo/);
  assert.match(request.message, /"cmd":"missing"/);
});

test("scope rules forbid writes and risky operations without explicit scope", () => {
  const rules = buildApprovedHandoffScopeRules({
    allowedTools: ["read", "exec", "apply_patch"],
    riskyPatterns: ["ssh", "systemctl"],
    confirmRisky: false
  }).join("\n");
  assert.match(rules, /No write root was approved/);
  assert.match(rules, /Every exec command/);
  assert.match(rules, /need separate approval/);
  assert.match(rules, /ssh, systemctl/);
});

test("safe approvals do not create an inherited execution grant", () => {
  const request = createApprovedHandoffRequest({
    event: {
      action: "handoff-started",
      handoffSessionKey: "agent:main:subagent:loop-guard-source-a-b",
      executorModel: "openai/gpt-5.5",
      toolName: "exec",
      paramsHash: "a",
      errorHash: "b"
    },
    config: { executorModel: "openai/gpt-5.5" },
    toolsAllow: ["read", "exec"],
    confirmRisky: false
  });
  assert.equal(request.confirmRisky, false);
  assert.equal(request.approvalGrant, undefined);
});

test("approved handoff can allow risky operations by default", () => {
  const rules = buildApprovedHandoffScopeRules({
    allowedTools: ["exec"],
    riskyPatterns: ["ssh", "systemctl"],
    confirmRisky: true
  }).join("\n");
  assert.match(rules, /approved by this approval/);
  assert.doesNotMatch(rules, /need separate approval/);
});

test("approved exec allow-list also exposes codex bash tool", () => {
  assert.deepEqual(normalizeApprovedToolAllowList(["read", "exec", "apply_patch"]), [
    "read",
    "exec",
    "bash",
    "apply_patch"
  ]);
  assert.deepEqual(normalizeApprovedToolAllowList(["bash", "read"]), ["bash", "read"]);
});
