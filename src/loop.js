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
  paramsPreviewMaxChars: 1000,
  softThreshold: 2,
  hardThreshold: 3,
  windowMs: 10 * 60 * 1000,
  maxEntries: 500,
  highRiskTools: ["exec", "apply_patch", "write", "edit"],
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
  cfg.handoffToolsAllow = Array.isArray(cfg.handoffToolsAllow)
    ? cfg.handoffToolsAllow.map((tool) => String(tool).trim()).filter(Boolean)
    : [...DEFAULT_CONFIG.handoffToolsAllow];
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
    idempotencyKey,
    message,
    toolsAllow: cfg.handoffToolsAllow,
    provider: model.provider,
    model: model.model
  };
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
