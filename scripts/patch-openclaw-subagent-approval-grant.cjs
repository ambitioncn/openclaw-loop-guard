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
    }
  ])
);

results.push(
  patchText(agentFile, [
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
\t\t\t\t\t\tcleanupBundleMcpOnRunEnd: params.cleanupBundleMcpOnRunEnd,`,
      replacement: `\t\t\t\t\t\ttoolsAllow: params.toolsAllow,
\t\t\t\t\t\tapprovalGrant: params.approvalGrant,
\t\t\t\t\t\tcleanupBundleMcpOnRunEnd: params.cleanupBundleMcpOnRunEnd,`,
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

console.log(JSON.stringify(results, null, 2));
