#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const dist =
  process.argv[2] ||
  path.join(process.env.HOME || process.cwd(), ".openclaw/npm/lib/node_modules/openclaw/dist");

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
}

function patchText(file, patches) {
  let text = fs.readFileSync(file, "utf8");
  let changed = false;
  for (const patch of patches) {
    if (patch.already && text.includes(patch.already)) continue;
    if (!text.includes(patch.needle)) throw new Error(`expected patch target not found in ${file}: ${patch.label}`);
    text = text.replace(patch.needle, patch.replacement);
    changed = true;
  }
  if (!changed) return { file, status: "already-patched" };
  const backup = `${file}.bak-loop-guard-approval-grant-${timestamp()}`;
  fs.copyFileSync(file, backup);
  fs.writeFileSync(file, text);
  return { file, backup, status: "patched" };
}

function findOne(pattern, label) {
  const names = fs.readdirSync(dist).filter((name) => pattern.test(name));
  if (names.length === 0) throw new Error(`No ${label} file found in ${dist}`);
  return path.join(dist, names[0]);
}

function findOneContaining(pattern, label, needle) {
  const matches = fs
    .readdirSync(dist)
    .filter((name) => pattern.test(name))
    .map((name) => path.join(dist, name))
    .filter((file) => fs.readFileSync(file, "utf8").includes(needle));
  if (matches.length === 0) throw new Error(`No ${label} file containing ${needle} found in ${dist}`);
  return matches[0];
}

if (!fs.existsSync(dist)) throw new Error(`OpenClaw dist directory not found: ${dist}`);

const serverPluginsFile = findOne(/^server-plugins-.*\.js$/, "server plugins");
const schemaFile = findOne(/^schema-.*\.js$/, "schema");
const agentFile = findOneContaining(/^agent-.*\.js$/, "agent gateway", "execApprovalFollowupElevatedDefaults");
const attemptFile = findOneContaining(/^attempt-execution-.*\.js$/, "attempt execution", "function runAgentAttempt");
const embeddedFile = findOneContaining(/^embedded-agent-.*\.js$/, "embedded agent", "async function runEmbeddedAgent");
const runAttemptFile = findOneContaining(/^run-attempt-.*\.js$/, "Codex run attempt", "async function runCodexAppServerAttempt");
const subagentAnnounceFile = findOneContaining(
  /^subagent-announce-.*\.js$/,
  "subagent announce delivery",
  "Active requester session could not be woken for subagent completion"
);

const results = [];

results.push(
  patchText(serverPluginsFile, [
    {
      label: "forward approvalGrant from plugin subagent runtime",
      needle: `\t\t\t\t...Array.isArray(params.toolsAllow) && { toolsAllow: params.toolsAllow },
\t\t\t\t...params.extraSystemPrompt && { extraSystemPrompt: params.extraSystemPrompt },`,
      replacement: `\t\t\t\t...Array.isArray(params.toolsAllow) && { toolsAllow: params.toolsAllow },
\t\t\t\t...params.approvalGrant && typeof params.approvalGrant === "object" && { approvalGrant: params.approvalGrant },
\t\t\t\t...params.extraSystemPrompt && { extraSystemPrompt: params.extraSystemPrompt },`,
      already: `...params.approvalGrant && typeof params.approvalGrant === "object" && { approvalGrant: params.approvalGrant },`
    },
    {
      label: "forward completion fields from plugin subagent runtime",
      needle: `\t\t\t\t...params.extraSystemPrompt && { extraSystemPrompt: params.extraSystemPrompt },
\t\t\t\t...params.lane && { lane: params.lane },`,
      replacement: `\t\t\t\t...params.extraSystemPrompt && { extraSystemPrompt: params.extraSystemPrompt },
\t\t\t\t...typeof params.requesterSessionKey === "string" && params.requesterSessionKey.trim() && { requesterSessionKey: params.requesterSessionKey.trim() },
\t\t\t\t...typeof params.expectsCompletionMessage === "boolean" && { expectsCompletionMessage: params.expectsCompletionMessage },
\t\t\t\t...params.lane && { lane: params.lane },`,
      already: `...typeof params.requesterSessionKey === "string" && params.requesterSessionKey.trim() && { requesterSessionKey: params.requesterSessionKey.trim() },`
    }
  ])
);

results.push(
  patchText(schemaFile, [
    {
      label: "allow internal approvalGrant in agent params",
      needle: `\ttoolsAllow: Type.Optional(Type.Array(Type.String())),
\tto: Type.Optional(Type.String()),`,
      replacement: `\ttoolsAllow: Type.Optional(Type.Array(Type.String())),
\tapprovalGrant: Type.Optional(Type.Unknown()),
\tto: Type.Optional(Type.String()),`,
      already: `approvalGrant: Type.Optional(Type.Unknown()),`
    },
    {
      label: "allow internal plugin subagent completion fields in agent params",
      needle: `\tapprovalGrant: Type.Optional(Type.Unknown()),
\tto: Type.Optional(Type.String()),`,
      replacement: `\tapprovalGrant: Type.Optional(Type.Unknown()),
\trequesterSessionKey: Type.Optional(Type.String()),
\texpectsCompletionMessage: Type.Optional(Type.Boolean()),
\tto: Type.Optional(Type.String()),`,
      already: `requesterSessionKey: Type.Optional(Type.String()),`
    }
  ])
);

results.push(
  patchText(agentFile, [
    {
      label: "register plugin subagent requester session",
      needle: `\tconst ownerSessionKey = resolveAgentMainSessionKey({
\t\tcfg: params.cfg,
\t\tagentId: resolveAgentIdFromSessionKey(childSessionKey)
\t});
\tconst { registerSubagentRun } = await import("`,
      replacement: `\tconst ownerSessionKey = resolveAgentMainSessionKey({
\t\tcfg: params.cfg,
\t\tagentId: resolveAgentIdFromSessionKey(childSessionKey)
\t});
\tconst requesterSessionKey = normalizeOptionalString(params.requesterSessionKey) || ownerSessionKey;
\tconst { registerSubagentRun } = await import("`,
      already: `const requesterSessionKey = normalizeOptionalString(params.requesterSessionKey) || ownerSessionKey;`
    },
    {
      label: "use requester session for plugin subagent completion owner",
      needle: `\t\tcontrollerSessionKey: ownerSessionKey,
\t\trequesterSessionKey: ownerSessionKey,`,
      replacement: `\t\tcontrollerSessionKey: ownerSessionKey,
\t\trequesterSessionKey,`,
      already: `\t\tcontrollerSessionKey: ownerSessionKey,
\t\trequesterSessionKey,`
    },
    {
      label: "register plugin subagent completion expectation",
      needle: `\t\texpectsCompletionMessage: false,
\t\tspawnMode: "run"`,
      replacement: `\t\texpectsCompletionMessage: params.expectsCompletionMessage === true,
\t\tspawnMode: "run"`,
      already: `expectsCompletionMessage: params.expectsCompletionMessage === true,`
    },
    {
      label: "bind approvalGrant to plugin_subagent gateway runs",
      needle: `\t\t\t\t\tconst execApprovalFollowupElevatedDefaults = execApprovalFollowupRuntimeHandoff?.bashElevated;
\t\t\t\t\tdispatchAgentRunFromGateway({`,
      replacement: `\t\t\t\t\tconst execApprovalFollowupElevatedDefaults = execApprovalFollowupRuntimeHandoff?.bashElevated;
\t\t\t\t\tconst pluginSubagentApprovalGrant = client?.internal?.agentRunTracking === "plugin_subagent" && normalizeOptionalString(client?.internal?.pluginRuntimeOwnerId) ? request.approvalGrant : void 0;
\t\t\t\t\tdispatchAgentRunFromGateway({`,
      already: `const pluginSubagentApprovalGrant = client?.internal?.agentRunTracking === "plugin_subagent"`
    },
    {
      label: "forward bound approvalGrant into ingress opts",
      needle: `\t\t\t\t\t\t\t...execApprovalFollowupElevatedDefaults ? { bashElevated: execApprovalFollowupElevatedDefaults } : {},
\t\t\t\t\t\t\tgroupId: resolvedGroupId,`,
      replacement: `\t\t\t\t\t\t\t...execApprovalFollowupElevatedDefaults ? { bashElevated: execApprovalFollowupElevatedDefaults } : {},
\t\t\t\t\t\t\t...pluginSubagentApprovalGrant ? { approvalGrant: pluginSubagentApprovalGrant } : {},
\t\t\t\t\t\t\tgroupId: resolvedGroupId,`,
      already: `...pluginSubagentApprovalGrant ? { approvalGrant: pluginSubagentApprovalGrant } : {},`
    },
    {
      label: "forward plugin subagent completion fields into registry",
      needle: `\t\t\t\t\tpluginId: normalizeOptionalString(client?.internal?.pluginRuntimeOwnerId)
\t\t\t\t});`,
      replacement: `\t\t\t\t\tpluginId: normalizeOptionalString(client?.internal?.pluginRuntimeOwnerId),
\t\t\t\t\trequesterSessionKey: request.requesterSessionKey,
\t\t\t\t\texpectsCompletionMessage: request.expectsCompletionMessage
\t\t\t\t});`,
      already: `requesterSessionKey: request.requesterSessionKey,`
    }
  ])
);

results.push(
  patchText(attemptFile, [
    {
      label: "forward approvalGrant from opts into embedded runtime",
      needle: `\t\ttoolsAllow: params.opts.toolsAllow,
\t\tinternalEvents: params.opts.internalEvents,`,
      replacement: `\t\ttoolsAllow: params.opts.toolsAllow,
\t\tapprovalGrant: params.opts.approvalGrant,
\t\tinternalEvents: params.opts.internalEvents,`,
      already: `approvalGrant: params.opts.approvalGrant,`
    }
  ])
);

results.push(
  patchText(embeddedFile, [
    {
      label: "forward approvalGrant into harness attempt params",
      needle: `\t\t\t\t\t\ttoolsAllow: params.toolsAllow,
\t\t\t\t\t\tdisableMessageTool: params.disableMessageTool,`,
      replacement: `\t\t\t\t\t\ttoolsAllow: params.toolsAllow,
\t\t\t\t\t\tapprovalGrant: params.approvalGrant,
\t\t\t\t\t\tdisableMessageTool: params.disableMessageTool,`,
      already: `approvalGrant: params.approvalGrant,`
    }
  ])
);

results.push(
  patchText(runAttemptFile, [
    {
      label: "add per-run inherited approval grant helpers",
      needle: `function shouldAwaitCodexAgentEndHook(params) {`,
      replacement: `function isActiveInheritedApprovalGrant(grant) {
\tif (!grant || typeof grant !== "object") return false;
\tif (grant.kind !== "loop_guard_inherited_approval") return false;
\tif (grant.approvalPolicy !== "never" || grant.sandbox !== "danger-full-access") return false;
\tconst expiresAt = typeof grant.expiresAt === "string" ? Date.parse(grant.expiresAt) : NaN;
\treturn Number.isFinite(expiresAt) && expiresAt > Date.now();
}
function applyInheritedApprovalGrantToCodexAppServer(appServer, grant) {
\tif (!isActiveInheritedApprovalGrant(grant)) return appServer;
\treturn {
\t\t...appServer,
\t\tapprovalPolicy: "never",
\t\tapprovalPolicySource: "approvalGrant",
\t\tsandbox: "danger-full-access",
\t\tapprovalsReviewer: "user"
\t};
}
function shouldAwaitCodexAgentEndHook(params) {`,
      already: `function applyInheritedApprovalGrantToCodexAppServer(appServer, grant)`
    },
    {
      label: "apply approvalGrant after first Codex app-server policy resolution",
      needle: `\tif (configuredAppServer.approvalPolicy === "never" && appServer.approvalPolicy === "untrusted") log.info("codex app-server approval policy promoted for OpenClaw tool policy", {`,
      replacement: `\tappServer = applyInheritedApprovalGrantToCodexAppServer(appServer, params.approvalGrant);
\tif (configuredAppServer.approvalPolicy === "never" && appServer.approvalPolicy === "untrusted") log.info("codex app-server approval policy promoted for OpenClaw tool policy", {`,
      already: `appServer = applyInheritedApprovalGrantToCodexAppServer(appServer, params.approvalGrant);`
    },
    {
      label: "apply approvalGrant after second Codex app-server policy resolution",
      needle: `\tpluginAppServer = appServer;`,
      replacement: `\tappServer = applyInheritedApprovalGrantToCodexAppServer(appServer, params.approvalGrant);
\tpluginAppServer = appServer;`,
      already: `appServer = applyInheritedApprovalGrantToCodexAppServer(appServer, params.approvalGrant);
\tpluginAppServer = appServer;`
    }
  ])
);

results.push(
  patchText(subagentAnnounceFile, [
    {
      label: "downgrade expected no-active-run completion wake fallback",
      needle: `\t\t\tactiveRequesterWakeFailed = true;
\t\t\tdefaultRuntime.log(\`[warn] Active requester session could not be woken for subagent completion; falling back to requester-agent handoff: \${formatQueueWakeFailureError("active requester session could not be woken", wakeOutcome)}\`);
\t\t}`,
      replacement: `\t\t\tactiveRequesterWakeFailed = true;
\t\t\tconst requesterWakeFallbackMessage = \`Active requester session could not be woken for subagent completion; falling back to requester-agent handoff: \${formatQueueWakeFailureError("active requester session could not be woken", wakeOutcome)}\`;
\t\t\tdefaultRuntime.log(wakeOutcome.reason === "no_active_run" ? \`[subagent] \${requesterWakeFallbackMessage}\` : \`[warn] \${requesterWakeFallbackMessage}\`);
\t\t}`,
      already: `wakeOutcome.reason === "no_active_run" ? \`[subagent] \${requesterWakeFallbackMessage}\``
    }
  ])
);

console.log(JSON.stringify(results, null, 2));
