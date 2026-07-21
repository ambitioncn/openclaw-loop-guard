import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_CONFIG = {
  enabled: true,
  blockRepeatedCalls: false,
  blockAfterPendingTimeout: true,
  pendingTimeoutMs: 180 * 1000,
  driverModel: "",
  executorModel: "",
  executorRuntime: "codex",
  handoffEnabled: false,
  handoffOnSoftWarn: true,
  handoffOnBlock: true,
  handoffSessionPrefix: "loop-guard",
  handoffToolsAllow: [],
  approvedHandoffToolsAllow: ["read", "exec", "bash", "apply_patch"],
  approvedHandoffWriteRoots: [],
  approvedHandoffAllowRiskyOperations: true,
  approvedHandoffMaxAgeMs: 30 * 60 * 1000,
  approvedHandoffRequireExecTimeout: true,
  approvedHandoffRiskyPatterns: [
    "ssh",
    "scp",
    "rsync",
    "systemctl",
    "service",
    "sudo",
    "rm",
    "mv",
    "git push",
    "npm publish",
    "openclaw update",
    "models auth",
    "secrets"
  ],
  paramsPreviewMaxChars: 1000,
  softThreshold: 2,
  hardThreshold: 3,
  windowMs: 10 * 60 * 1000,
  maxEntries: 500,
  highRiskTools: ["exec", "bash", "apply_patch", "write", "edit"],
  softMessage:
    "Loop Guard: this tool call has failed repeatedly with the same error. Do not retry the same call. Choose a different strategy, change the command/arguments, ask for missing permission, or escalate to a more reliable executor.",
  hardMessage:
    "Loop Guard blocked this tool call because it repeated the same known failure. Stop retrying this exact call and choose a different approach.",
  pendingMessage:
    "Loop Guard blocked this tool call because the same call previously appeared to hang without returning. Use a timeout, change the command/arguments, check the tool runner, or use a different executor."
};

const VOLATILE_KEYS = new Set([
  "toolCallId",
  "callId",
  "requestId",
  "runId",
  "turnId",
  "timestamp",
  "time",
  "nonce"
]);

export function normalizeConfig(input = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(isObject(input) ? input : {}) };
  cfg.enabled = cfg.enabled !== false;
  cfg.blockRepeatedCalls = cfg.blockRepeatedCalls === true;
  cfg.blockAfterPendingTimeout = cfg.blockAfterPendingTimeout !== false;
  cfg.pendingTimeoutMs = nonNegativeInt(cfg.pendingTimeoutMs, DEFAULT_CONFIG.pendingTimeoutMs);
  cfg.driverModel = String(cfg.driverModel || "").trim();
  cfg.executorModel = String(cfg.executorModel || "").trim();
  cfg.executorRuntime = String(cfg.executorRuntime || DEFAULT_CONFIG.executorRuntime).trim();
  cfg.handoffEnabled = cfg.handoffEnabled === true;
  cfg.handoffOnSoftWarn = cfg.handoffOnSoftWarn !== false;
  cfg.handoffOnBlock = cfg.handoffOnBlock !== false;
  cfg.handoffSessionPrefix = normalizeSessionSegment(
    cfg.handoffSessionPrefix || DEFAULT_CONFIG.handoffSessionPrefix
  );
  cfg.handoffToolsAllow = normalizeToolAllowList(
    cfg.handoffToolsAllow,
    DEFAULT_CONFIG.handoffToolsAllow
  );
  cfg.approvedHandoffToolsAllow = normalizeToolAllowList(
    cfg.approvedHandoffToolsAllow,
    DEFAULT_CONFIG.approvedHandoffToolsAllow
  );
  cfg.approvedHandoffWriteRoots = normalizeStringList(
    cfg.approvedHandoffWriteRoots,
    DEFAULT_CONFIG.approvedHandoffWriteRoots
  );
  cfg.approvedHandoffAllowRiskyOperations = cfg.approvedHandoffAllowRiskyOperations !== false;
  cfg.approvedHandoffMaxAgeMs = nonNegativeInt(
    cfg.approvedHandoffMaxAgeMs,
    DEFAULT_CONFIG.approvedHandoffMaxAgeMs
  );
  cfg.approvedHandoffRequireExecTimeout = cfg.approvedHandoffRequireExecTimeout !== false;
  cfg.approvedHandoffRiskyPatterns = normalizeStringList(
    cfg.approvedHandoffRiskyPatterns,
    DEFAULT_CONFIG.approvedHandoffRiskyPatterns
  );
  cfg.paramsPreviewMaxChars = nonNegativeInt(
    cfg.paramsPreviewMaxChars,
    DEFAULT_CONFIG.paramsPreviewMaxChars
  );
  cfg.softThreshold = positiveInt(cfg.softThreshold, DEFAULT_CONFIG.softThreshold);
  cfg.hardThreshold = Math.max(
    cfg.softThreshold,
    positiveInt(cfg.hardThreshold, DEFAULT_CONFIG.hardThreshold)
  );
  cfg.windowMs = positiveInt(cfg.windowMs, DEFAULT_CONFIG.windowMs);
  cfg.maxEntries = positiveInt(cfg.maxEntries, DEFAULT_CONFIG.maxEntries);
  cfg.highRiskTools = Array.isArray(cfg.highRiskTools)
    ? cfg.highRiskTools.map(String).filter(Boolean)
    : [...DEFAULT_CONFIG.highRiskTools];
  cfg.softMessage = String(cfg.softMessage || DEFAULT_CONFIG.softMessage);
  cfg.hardMessage = String(cfg.hardMessage || DEFAULT_CONFIG.hardMessage);
  cfg.pendingMessage = String(cfg.pendingMessage || DEFAULT_CONFIG.pendingMessage);
  return cfg;
}

export function createLoopGuardState(config = {}) {
  const cfg = normalizeConfig(config);
  const entries = new Map();
  const callIndex = new Map();
  const observationIds = new Set();

  function sweep(now = Date.now()) {
    for (const [key, entry] of entries) {
      if (now - entry.lastSeenAt > cfg.windowMs) {
        entries.delete(key);
        const callEntries = callIndex.get(entry.callKey);
        callEntries?.delete(key);
        if (callEntries?.size === 0) callIndex.delete(entry.callKey);
      }
    }
    while (entries.size > cfg.maxEntries) {
      const oldest = [...entries.entries()].sort(
        (a, b) => a[1].lastSeenAt - b[1].lastSeenAt
      )[0];
      if (!oldest) break;
      entries.delete(oldest[0]);
      const callEntries = callIndex.get(oldest[1].callKey);
      callEntries?.delete(oldest[0]);
      if (callEntries?.size === 0) callIndex.delete(oldest[1].callKey);
    }
  }

  function observeFailure(input, now = Date.now()) {
    sweep(now);
    const signature = createFailureSignature({
      ...input,
      paramsPreviewMaxChars: cfg.paramsPreviewMaxChars
    });
    const observationId = input.observationId ? `${signature.key}:${String(input.observationId)}` : "";
    if (observationId && observationIds.has(observationId)) {
      const existing = entries.get(signature.key);
      return existing ? { ...existing } : { ...signature, count: 0, firstSeenAt: now, lastSeenAt: now };
    }
    const entry = entries.get(signature.key) ?? {
      ...signature,
      count: 0,
      firstSeenAt: now,
      lastSeenAt: now
    };
    entry.count += 1;
    entry.lastSeenAt = now;
    entries.set(signature.key, entry);
    const callEntries = callIndex.get(signature.callKey) ?? new Set();
    callEntries.add(signature.key);
    callIndex.set(signature.callKey, callEntries);
    if (observationId) observationIds.add(observationId);
    return { ...entry };
  }

  function observePendingTimeout(input, now = Date.now()) {
    const entry = observeFailure(
      {
        ...input,
        error: `Tool call did not return within ${positiveInt(input.timeoutMs, cfg.pendingTimeoutMs)}ms`
      },
      now
    );
    const stored = entries.get(entry.key);
    if (stored) stored.pendingTimeout = true;
    return { ...entry, pendingTimeout: true };
  }

  function getFailure(input, now = Date.now()) {
    sweep(now);
    const signature = createFailureSignature({
      ...input,
      paramsPreviewMaxChars: cfg.paramsPreviewMaxChars
    });
    const entry = entries.get(signature.key);
    return entry ? { ...entry } : undefined;
  }

  function getMostRecentFailureForCall(input, now = Date.now()) {
    sweep(now);
    const callKey = createToolCallKey(input);
    const keys = callIndex.get(callKey);
    if (!keys) return undefined;
    const candidates = [...keys]
      .map((key) => entries.get(key))
      .filter(Boolean)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    return candidates[0] ? { ...candidates[0] } : undefined;
  }

  function clear() {
    entries.clear();
    callIndex.clear();
    observationIds.clear();
  }

  function snapshot() {
    return [...entries.values()].map((entry) => ({ ...entry }));
  }

  return {
    observeFailure,
    observePendingTimeout,
    getFailure,
    getMostRecentFailureForCall,
    clear,
    snapshot
  };
}

export function createFailureSignature({
  toolName,
  params,
  args,
  result,
  error,
  paramsPreviewMaxChars = DEFAULT_CONFIG.paramsPreviewMaxChars
}) {
  const normalizedParams = normalizeValue(params ?? args ?? {});
  const errorText = summarizeErrorText(error ?? extractResultText(result));
  const paramsHash = sha256(stableStringify(normalizedParams)).slice(0, 16);
  const errorHash = sha256(errorText).slice(0, 16);
  const normalizedToolName = String(toolName || "unknown");
  const callKey = createToolCallKey({ toolName: normalizedToolName, params: normalizedParams });
  const paramsPreview = createParamsPreview(normalizedParams, paramsPreviewMaxChars);
  return {
    key: `${normalizedToolName}:${paramsHash}:${errorHash}`,
    callKey,
    toolName: normalizedToolName,
    paramsHash,
    errorHash,
    errorSummary: errorText,
    paramsPreview
  };
}

export function createToolCallKey({ toolName, params, args }) {
  const normalizedToolName = String(toolName || "unknown");
  const normalizedParams = normalizeValue(params ?? args ?? {});
  return `${normalizedToolName}:${sha256(stableStringify(normalizedParams)).slice(0, 16)}`;
}

export function shouldTreatResultAsFailure({ isError, error, result }) {
  if (isError === true) return true;
  if (typeof error === "string" && error.trim()) return true;
  const text = extractResultText(result).toLowerCase();
  return /\b(error|failed|failure|permission denied|denied|timeout|timed out|not found|exit code [1-9])\b/.test(
    text
  );
}

export function createGuardedToolResult(originalResult, message, entry) {
  const content = [
    {
      type: "text",
      text: `${message}\n\nRepeated failure signature: ${entry.toolName} params=${entry.paramsHash} error=${entry.errorHash}. Previous attempts in window: ${entry.count}. Error summary: ${entry.errorSummary}`
    }
  ];
  return {
    ...(isObject(originalResult) ? originalResult : {}),
    isError: true,
    content,
    details: {
      ...(isObject(originalResult?.details) ? originalResult.details : {}),
      loopGuard: {
        action: "warn",
        count: entry.count,
        toolName: entry.toolName,
        paramsHash: entry.paramsHash,
        errorHash: entry.errorHash
      }
    }
  };
}

export function withExecutorHint(message, config) {
  const cfg = normalizeConfig(config);
  if (!cfg.driverModel && !cfg.executorModel) return message;
  const parts = [];
  if (cfg.driverModel) parts.push(`driver=${cfg.driverModel}`);
  if (cfg.executorModel) parts.push(`executor=${cfg.executorModel}`);
  if (cfg.executorRuntime) parts.push(`executorRuntime=${cfg.executorRuntime}`);
  return `${message}\n\nConfigured model roles: ${parts.join(", ")}. If the driver is stuck, hand tool execution to the configured executor instead of repeating the same call.`;
}

export function createApprovalPrompt({ handoff, config, entry }) {
  if (!handoff?.sessionKey) return "";
  const cfg = normalizeConfig(config);
  const tools = normalizeApprovedToolAllowList(cfg.approvedHandoffToolsAllow);
  const roots = normalizeStringList(cfg.approvedHandoffWriteRoots);
  const approveCommand = [
    "/loop-guard approve latest",
    tools.length > 0 ? `tools=${tools.join(",")}` : "",
    roots.length > 0 ? `roots=${roots.join(",")}` : "",
    cfg.approvedHandoffAllowRiskyOperations ? "" : "confirm=safe"
  ]
    .filter(Boolean)
    .join(" ");
  const risky = cfg.approvedHandoffAllowRiskyOperations ? "yes" : "no";
  return [
    "Human approval needed to let the executor continue this task with tools.",
    "",
    `Approve command: ${approveCommand}`,
    `Executor handoff: ${handoff.sessionKey} run=${handoff.runId || "unknown"}`,
    `Executor model: ${cfg.executorModel || "session default"}`,
    `Approved tools if sent: ${tools.length > 0 ? tools.join(", ") : "none"}`,
    `Approved write roots if sent: ${roots.length > 0 ? roots.join(", ") : "none"}`,
    `Risky operations included if sent: ${risky}`,
    "Approval grant lifetime after approval: 10 minutes",
    cfg.approvedHandoffMaxAgeMs > 0
      ? `This handoff can be approved for ${Math.round(cfg.approvedHandoffMaxAgeMs / 60000)} minutes after it starts`
      : "This handoff has no pre-approval age limit",
    entry
      ? `Original failure: ${entry.toolName} params=${entry.paramsHash} error=${entry.errorHash}`
      : "",
    "",
    "Only ask the human to send this command if continuing the same failed task is still useful. If the task changed or the scope is unclear, ask for a fresh approval instead."
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function createStatusMessage({ config, snapshot = [], events = [] }) {
  const cfg = normalizeConfig(config);
  const latestHandoff = findHandoffEvent(events, "latest");
  const lifecycle = latestHandoff
    ? getHandoffLifecycle(events, latestHandoff, {
        maxAgeMs: cfg.approvedHandoffMaxAgeMs
      })
    : undefined;
  const lines = [
    `Loop Guard: ${cfg.enabled ? "enabled" : "disabled"}; tracked failures=${snapshot.length}; soft=${cfg.softThreshold}; hard=${cfg.hardThreshold}.`,
    `Handoff: ${cfg.handoffEnabled ? "enabled" : "disabled"}; executor=${cfg.executorModel || "unset"}; runtime=${cfg.executorRuntime || "unset"}.`
  ];
  if (!latestHandoff) {
    lines.push("Latest handoff: none.");
    return lines.join("\n");
  }
  lines.push(
    "",
    "Latest handoff:",
    `- session: ${latestHandoff.handoffSessionKey || "unknown"}`,
    `- run: ${latestHandoff.handoffRunId || "unknown"}`,
    `- trigger: ${latestHandoff.trigger || "unknown"}`,
    `- tool: ${latestHandoff.toolName || "unknown"}`,
    `- status: ${lifecycle?.status || "unknown"}`,
    `- failure: params=${latestHandoff.paramsHash || "unknown"} error=${latestHandoff.errorHash || "unknown"}`,
    lifecycle?.status === "pending"
      ? ""
      : `Latest handoff is not pending; /loop-guard approve latest will not re-approve it.`
  );
  if (lifecycle?.status === "pending") {
    lines.push(
      "",
      createApprovalPrompt({
        handoff: {
          sessionKey: latestHandoff.handoffSessionKey,
          runId: latestHandoff.handoffRunId
        },
        config: cfg,
        entry: latestHandoff
      })
    );
  }
  return lines.filter(Boolean).join("\n");
}

export function shouldStartHandoff(trigger, entry, config) {
  const cfg = normalizeConfig(config);
  if (!cfg.enabled || !cfg.handoffEnabled || !cfg.executorModel || !entry) return false;
  if (trigger === "block") return cfg.handoffOnBlock;
  if (trigger === "warn" || trigger === "warn-hard") return cfg.handoffOnSoftWarn;
  if (trigger === "pending-timeout") return cfg.handoffOnBlock;
  return false;
}

export function splitModelRef(modelRef) {
  const value = String(modelRef || "").trim();
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return { model: value };
  return {
    provider: value.slice(0, slash),
    model: value.slice(slash + 1)
  };
}

export function createHandoffRequest({ trigger, entry, config, context = {} }) {
  const cfg = normalizeConfig(config);
  const agentId = normalizeSessionSegment(context.agentId || "main");
  const sourceSession = normalizeSessionSegment(context.sessionKey || context.sessionId || "session");
  const sessionKey = `agent:${agentId}:subagent:${cfg.handoffSessionPrefix}-${sourceSession}-${entry.paramsHash}-${entry.errorHash}`;
  const model = splitModelRef(cfg.executorModel);
  const idempotencyKey = `loop-guard:${trigger}:${sessionKey}:${entry.key}`;
  const toolMode =
    cfg.handoffToolsAllow.length === 0
      ? [
          "- Core should expose no tools to this run (`toolsAllow=[]`). Do not call tools.",
          "- Use the sanitized params preview and error summary as the evidence. Do not go hunting through unrelated repositories.",
          "- Do not retry the original operation, even with a changed command. The parent agent already proved the failure.",
          "- Return a concise handoff report with: likely cause, why repeating is unproductive, and the next safe action for the parent agent or human.",
          "- If the next safe action needs live tool execution or permission, say so directly instead of attempting it."
        ]
      : [
          `- Core should expose only these tools: ${cfg.handoffToolsAllow.join(", ")}.`,
          "- Stay inside the failed call's working directory or the explicitly provided path. Do not inspect unrelated repositories.",
          "- Do not repeat the exact same failing tool call. Change the strategy, add a timeout, or inspect only the minimum evidence needed.",
          "- Treat writes, package installs, service restarts, SSH mutations, secret changes, and deletes as needing explicit approval unless the handoff request says they are pre-approved.",
          "- Return the concrete result, the diff/commands used when applicable, and the next safe action."
        ];
  const message = [
    "Loop Guard is handing off a stuck or repeated tool-execution problem.",
    "",
    `Trigger: ${trigger}`,
    `Source agent: ${context.agentId || "unknown"}`,
    `Source session: ${context.sessionKey || context.sessionId || "unknown"}`,
    `Source run: ${context.runId || "unknown"}`,
    `Driver model: ${cfg.driverModel || "unspecified"}`,
    `Executor model: ${cfg.executorModel}`,
    `Executor runtime: ${cfg.executorRuntime || "unspecified"}`,
    "",
    "Failure signature:",
    `- tool: ${entry.toolName}`,
    `- paramsHash: ${entry.paramsHash}`,
    `- errorHash: ${entry.errorHash}`,
    `- attempts in window: ${entry.count}`,
    `- error summary: ${entry.errorSummary}`,
    entry.paramsPreview ? "- sanitized params preview:" : "",
    entry.paramsPreview ? "```json" : "",
    entry.paramsPreview || "",
    entry.paramsPreview ? "```" : "",
    "",
    "Executor instructions:",
    ...toolMode
  ].join("\n");
  return {
    sessionKey,
    requesterSessionKey: context.sessionKey || context.sessionId,
    expectsCompletionMessage: true,
    idempotencyKey,
    message,
    toolsAllow: cfg.handoffToolsAllow,
    provider: model.provider,
    model: model.model
  };
}

export function createCompletionE2eRequest({ config, context = {}, marker = "" }) {
  const cfg = normalizeConfig(config);
  const safeMarker =
    String(marker || `loop-guard-e2e-${new Date().toISOString()}`)
      .trim()
      .replace(/[^a-zA-Z0-9_.:-]/g, "-")
      .slice(0, 120) || "loop-guard-e2e";
  const entry = createFailureSignature({
    toolName: "loop-guard-e2e",
    params: {
      marker: safeMarker,
      command: "/loop-guard e2e completion",
      sourceSession: context.sessionKey || context.sessionId || "unknown"
    },
    error:
      "Controlled slash-command completion delivery acceptance test. No real tool failure occurred.",
    paramsPreviewMaxChars: cfg.paramsPreviewMaxChars
  });
  const request = createHandoffRequest({
    trigger: "slash-e2e",
    entry: {
      ...entry,
      count: 1,
      errorSummary:
        "Controlled slash-command completion delivery acceptance test. No real tool failure occurred."
    },
    config: {
      ...cfg,
      handoffToolsAllow: []
    },
    context
  });
  return {
    ...request,
    marker: safeMarker,
    e2eEntry: entry,
    message: [
      request.message,
      "",
      "Slash command E2E acceptance instructions:",
      `- This is a controlled Loop Guard completion-delivery test with marker ${safeMarker}.`,
      `- requesterSessionKey: ${request.requesterSessionKey || "missing"}`,
      `- expectsCompletionMessage: ${request.expectsCompletionMessage === true ? "true" : "false"}`,
      "- Do not call tools.",
      "- Do not ask follow-up questions.",
      `- Return exactly one concise completion report that starts with: LOOP_GUARD_E2E_COMPLETION_OK ${safeMarker}`,
      "- Include whether requesterSessionKey and expectsCompletionMessage were present in the request text."
    ].join("\n")
  };
}

export function createSubagentRunParams(request, overrides = {}) {
  return {
    sessionKey: request.sessionKey,
    requesterSessionKey: request.requesterSessionKey,
    expectsCompletionMessage: request.expectsCompletionMessage,
    message: request.message,
    provider: request.provider,
    model: request.model,
    toolsAllow: request.toolsAllow,
    approvalGrant: request.approvalGrant,
    lightContext: true,
    deliver: false,
    idempotencyKey: request.idempotencyKey,
    ...overrides
  };
}

export function parseApproveArgs(args, defaultTools = DEFAULT_CONFIG.approvedHandoffToolsAllow) {
  const tokens = String(args || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens[0]?.toLowerCase() === "approve") tokens.shift();

  let selector = "latest";
  const tools = [];
  const writeRoots = [];
  let confirmRisky = true;
  for (const token of tokens) {
    const toolsMatch = token.match(/^tools=(.*)$/i);
    if (toolsMatch) {
      tools.push(...toolsMatch[1].split(","));
      continue;
    }
    const rootsMatch = token.match(/^(?:roots|writeRoots)=(.*)$/i);
    if (rootsMatch) {
      writeRoots.push(...rootsMatch[1].split(","));
      continue;
    }
    const confirmMatch = token.match(/^confirm=(.*)$/i);
    if (confirmMatch) {
      confirmRisky = !/^(safe|no|none|false)$/i.test(confirmMatch[1]);
      continue;
    }
    if (token.toLowerCase() === "latest") {
      selector = "latest";
      continue;
    }
    selector = token;
  }

  return {
    selector,
    toolsAllow: normalizeApprovedToolAllowList(tools.length > 0 ? tools : defaultTools),
    writeRoots: normalizeStringList(writeRoots),
    confirmRisky
  };
}

export function readRecentEvents(statePath, limit = 200) {
  if (!statePath || !fs.existsSync(statePath)) return [];
  const lines = fs.readFileSync(statePath, "utf8").trim().split(/\n+/).filter(Boolean);
  return lines
    .slice(-positiveInt(limit, 200))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .filter(Boolean);
}

export function findHandoffEvent(events, selector = "latest", options = {}) {
  const normalizedSelector = String(selector || "latest").trim();
  const candidates = [...events].reverse().filter((event) => event?.action === "handoff-started");
  const filtered = options.requirePending
    ? candidates.filter(
        (event) =>
          getHandoffLifecycle(events, event, {
            now: options.now,
            maxAgeMs: options.maxAgeMs
          }).status === "pending"
      )
    : candidates;
  if (normalizedSelector === "latest") return filtered[0];
  return filtered.find((event) => {
    const fields = [
      event.handoffSessionKey,
      event.handoffRunId,
      event.paramsHash,
      event.errorHash,
      event.toolName,
      event.sessionKey,
      event.runId
    ];
    return fields.some((field) => String(field || "").includes(normalizedSelector));
  });
}

export function getHandoffLifecycle(events, handoffEvent, options = {}) {
  if (!handoffEvent) return { status: "unknown" };
  const startIndex = events.indexOf(handoffEvent);
  const related = events
    .slice(startIndex >= 0 ? startIndex + 1 : 0)
    .filter((event) => isRelatedHandoffEvent(event, handoffEvent));
  const latest = related[related.length - 1];
  if (!latest) {
    const stale = isStaleHandoff(handoffEvent, options);
    return {
      status: stale ? "stale" : "pending",
      stale
    };
  }
  const statusByAction = {
    "handoff-approved-started": "approved",
    "handoff-approved-failed": "approval_failed",
    "handoff-completed": "completed",
    "handoff-failed": "failed"
  };
  return {
    status: statusByAction[latest.action] || "pending",
    latestAction: latest.action,
    latestAt: latest.at
  };
}

function isStaleHandoff(handoffEvent, { now = Date.now(), maxAgeMs = DEFAULT_CONFIG.approvedHandoffMaxAgeMs } = {}) {
  const ageLimit = nonNegativeInt(maxAgeMs, DEFAULT_CONFIG.approvedHandoffMaxAgeMs);
  if (ageLimit <= 0) return false;
  const startedAt = parseEventTime(handoffEvent);
  if (!Number.isFinite(startedAt)) return false;
  return now - startedAt > ageLimit;
}

function parseEventTime(event) {
  const value = event?.at || event?.timestamp || event?.time;
  if (!value) return NaN;
  const parsed = typeof value === "number" ? value : Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function isRelatedHandoffEvent(event, handoffEvent) {
  if (!event || event === handoffEvent) return false;
  const sessionKey = handoffEvent.handoffSessionKey;
  const runId = handoffEvent.handoffRunId;
  return (
    (sessionKey && event.handoffSessionKey === sessionKey) ||
    (runId && event.sourceHandoffRunId === runId) ||
    (runId && event.handoffRunId === runId)
  );
}

export function createApprovedHandoffRequest({
  event,
  config,
  toolsAllow,
  writeRoots,
  confirmRisky = true,
  approvedAt = Date.now()
}) {
  const cfg = normalizeConfig(config);
  const modelRef = cfg.executorModel || event?.executorModel || "";
  const model = splitModelRef(modelRef);
  const sessionKey = event?.handoffSessionKey || "";
  const allowedTools = normalizeApprovedToolAllowList(toolsAllow, cfg.approvedHandoffToolsAllow);
  const approvedWriteRoots = normalizeStringList(
    writeRoots && writeRoots.length > 0 ? writeRoots : cfg.approvedHandoffWriteRoots
  );
  const riskyApproved = confirmRisky && cfg.approvedHandoffAllowRiskyOperations;
  if (!sessionKey) throw new Error("Missing handoff session key.");
  if (allowedTools.length === 0) throw new Error("Approval requires at least one allowed tool.");
  const scopeRules = buildApprovedHandoffScopeRules({
    allowedTools,
    writeRoots: approvedWriteRoots,
    requireExecTimeout: cfg.approvedHandoffRequireExecTimeout,
    riskyPatterns: cfg.approvedHandoffRiskyPatterns,
    confirmRisky: riskyApproved
  });
  const approvalId = new Date(approvedAt).toISOString().replace(/[:.]/g, "-");
  const idempotencyKey = `loop-guard:approve:${sessionKey}:${event.paramsHash || "params"}:${event.errorHash || "error"}:${approvalId}`;
  const approvalGrant = riskyApproved
    ? {
        kind: "loop_guard_inherited_approval",
        grantId: idempotencyKey,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        approvalsReviewer: "user",
        expiresAt: new Date(approvedAt + 10 * 60 * 1000).toISOString(),
        toolsAllow: allowedTools,
        writeRoots: approvedWriteRoots,
        sourceHandoffRunId: event.handoffRunId,
        sourceRunId: event.runId,
        sourceSessionKey: event.sessionKey || event.sessionId,
        sourceToolName: event.toolName,
        sourceParamsHash: event.paramsHash,
        sourceErrorHash: event.errorHash
      }
    : undefined;
  const message = [
    "Loop Guard approval received. Continue the existing handoff session with explicitly approved tools.",
    "",
    `Approved tools: ${allowedTools.join(", ")}`,
    `Approved write roots: ${approvedWriteRoots.length > 0 ? approvedWriteRoots.join(", ") : "none"}`,
    `Risky operations approved by this approval: ${riskyApproved ? "yes" : "no"}`,
    `Executor model: ${modelRef || "session default"}`,
    `Original trigger: ${event.trigger || "unknown"}`,
    `Source agent: ${event.agentId || "unknown"}`,
    `Source session: ${event.sessionKey || event.sessionId || "unknown"}`,
    `Source run: ${event.runId || "unknown"}`,
    "",
    "Original failure signature:",
    `- tool: ${event.toolName || "unknown"}`,
    `- paramsHash: ${event.paramsHash || "unknown"}`,
    `- errorHash: ${event.errorHash || "unknown"}`,
    `- attempts in window: ${event.count || "unknown"}`,
    `- error summary: ${event.errorSummary || ""}`,
    event.paramsPreview ? "- sanitized params preview:" : "",
    event.paramsPreview ? "```json" : "",
    event.paramsPreview || "",
    event.paramsPreview ? "```" : "",
    "",
    "Execution rules:",
    ...scopeRules,
    "- Return a concise summary of actions taken, files changed, commands run, and remaining risk."
  ].join("\n");
  return {
    sessionKey,
    requesterSessionKey: event.sessionKey || event.sessionId,
    expectsCompletionMessage: true,
    idempotencyKey,
    message,
    toolsAllow: allowedTools,
    writeRoots: approvedWriteRoots,
    confirmRisky: riskyApproved,
    approvalGrant,
    provider: model.provider,
    model: model.model
  };
}

export function buildApprovedHandoffScopeRules({
  allowedTools,
  writeRoots = [],
  requireExecTimeout = true,
  riskyPatterns = DEFAULT_CONFIG.approvedHandoffRiskyPatterns,
  confirmRisky = false
}) {
  const tools = normalizeToolAllowList(allowedTools);
  const roots = normalizeStringList(writeRoots);
  const risky = normalizeStringList(riskyPatterns);
  const rules = [
    "- Use only the approved tools listed above.",
    "- Stay within the original failed task and its working directory/path evidence.",
    "- Do not repeat the exact same failing call. Change strategy or inspect the minimum needed evidence."
  ];
  if (tools.includes("exec")) {
    rules.push(
      requireExecTimeout
        ? "- Every exec command must be non-interactive and include an explicit timeout or equivalent bounded execution guard."
        : "- Exec commands must be non-interactive and bounded."
    );
  }
  if (tools.includes("apply_patch") || tools.includes("write") || tools.includes("edit")) {
    if (roots.length > 0) {
      rules.push(`- Writes are approved only under these roots: ${roots.join(", ")}.`);
      rules.push("- Before writing, verify the target path is inside an approved root.");
    } else {
      rules.push("- No write root was approved. Do not write files, even if a write-capable tool is exposed.");
    }
  }
  if (risky.length > 0) {
    rules.push(
      confirmRisky
        ? `- Risky operation patterns are approved by this approval: ${risky.join(", ")}. Still keep them minimal.`
        : `- These risky operations need separate approval and must not be executed in this run: ${risky.join(", ")}.`
    );
  }
  rules.push("- If another approval is needed, stop and say exactly what needs approval.");
  return rules;
}

export function shouldBlockRepeatedCall(entry, config, toolName = entry?.toolName) {
  if (!entry) return false;
  const cfg = normalizeConfig(config);
  if (entry.pendingTimeout) return cfg.blockAfterPendingTimeout;
  if (!cfg.blockRepeatedCalls) return false;
  const normalizedToolName = String(toolName || entry.toolName || "unknown");
  const threshold = cfg.highRiskTools.includes(normalizedToolName)
    ? Math.min(cfg.softThreshold, cfg.hardThreshold)
    : cfg.hardThreshold;
  return entry.count >= threshold;
}

export function normalizeToolAllowList(value, fallback = []) {
  const source = Array.isArray(value) ? value : fallback;
  const seen = new Set();
  const out = [];
  for (const item of source || []) {
    const tool = String(item || "").trim();
    if (!tool || seen.has(tool)) continue;
    seen.add(tool);
    out.push(tool);
  }
  return out;
}

export function normalizeApprovedToolAllowList(value, fallback = []) {
  const tools = normalizeToolAllowList(value, fallback);
  if (tools.includes("exec") && !tools.includes("bash")) tools.splice(tools.indexOf("exec") + 1, 0, "bash");
  return tools;
}

export function normalizeStringList(value, fallback = []) {
  const source = Array.isArray(value) ? value : fallback;
  const seen = new Set();
  const out = [];
  for (const item of source || []) {
    const normalized = String(item || "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function createStateRecorder({ statePath, logger } = {}) {
  if (!statePath) {
    return { record() {} };
  }
  return {
    record(event) {
      try {
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        fs.appendFileSync(statePath, `${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`);
      } catch (error) {
        logger?.warn?.(`loop-guard: failed to write state: ${String(error)}`);
      }
    }
  };
}

export function defaultStatePath() {
  const home = process.env.HOME || process.cwd();
  return path.join(home, ".openclaw", "state", "loop-guard", "events.jsonl");
}

export function extractResultText(result) {
  if (typeof result === "string") return result;
  if (!isObject(result)) return "";
  const chunks = [];
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (typeof item === "string") chunks.push(item);
      else if (isObject(item) && typeof item.text === "string") chunks.push(item.text);
      else if (isObject(item)) chunks.push(JSON.stringify(item));
    }
  }
  if (typeof result.error === "string") chunks.push(result.error);
  if (typeof result.stderr === "string") chunks.push(result.stderr);
  if (chunks.length === 0) chunks.push(JSON.stringify(result));
  return chunks.join("\n");
}

function summarizeErrorText(text) {
  const compact = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  return compact.slice(0, 500);
}

export function createParamsPreview(params, maxChars = DEFAULT_CONFIG.paramsPreviewMaxChars) {
  const limit = nonNegativeInt(maxChars, DEFAULT_CONFIG.paramsPreviewMaxChars);
  if (limit <= 0) return "";
  const text = stableStringify(redactSensitiveValue(params));
  return text.length > limit ? `${text.slice(0, limit)}... [truncated]` : text;
}

function redactSensitiveValue(value, key = "") {
  if (Array.isArray(value)) return value.map((item) => redactSensitiveValue(item));
  if (isObject(value)) {
    const out = {};
    for (const childKey of Object.keys(value).sort()) {
      if (isSensitiveKey(childKey)) out[childKey] = "[redacted]";
      else out[childKey] = redactSensitiveValue(value[childKey], childKey);
    }
    return out;
  }
  if (typeof value !== "string") return value;
  if (isSensitiveKey(key)) return "[redacted]";
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, "$1 [redacted]")
    .replace(/\b(npm_[A-Za-z0-9_-]{12,})\b/g, "[redacted]")
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{12,})\b/g, "[redacted]")
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[redacted]");
}

function isSensitiveKey(key) {
  return /(api[-_]?key|authorization|cookie|password|secret|token)/i.test(String(key || ""));
}

function normalizeValue(value) {
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (!isObject(value)) return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (VOLATILE_KEYS.has(key)) continue;
    out[key] = normalizeValue(value[key]);
  }
  return out;
}

function normalizeSessionSegment(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return normalized || "session";
}

function stableStringify(value) {
  return JSON.stringify(normalizeValue(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function nonNegativeInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
