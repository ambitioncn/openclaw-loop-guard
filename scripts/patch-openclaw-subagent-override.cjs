#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const dist =
  process.argv[2] ||
  path.join(process.env.HOME || process.cwd(), ".openclaw/npm/lib/node_modules/openclaw/dist");

const firstNeedle = `if (overrideRequested && !allowOverride && !hasRequestScopeClient) {
\t\t\t\tconst fallbackAuth = authorizeFallbackModelOverride({
\t\t\t\t\tpluginId: scope?.pluginId,
\t\t\t\t\tprovider: params.provider,
\t\t\t\t\tmodel: params.model
\t\t\t\t});
\t\t\t\tif (!fallbackAuth.allowed) throw new Error(fallbackAuth.reason);
\t\t\t\tallowOverride = true;
\t\t\t\tallowSyntheticModelOverride = true;
\t\t\t}`;

const firstReplacement = `if (overrideRequested && !allowOverride) {
\t\t\t\tconst fallbackAuth = authorizeFallbackModelOverride({
\t\t\t\t\tpluginId: scope?.pluginId,
\t\t\t\t\tprovider: params.provider,
\t\t\t\t\tmodel: params.model
\t\t\t\t});
\t\t\t\tif (fallbackAuth.allowed) {
\t\t\t\t\tallowOverride = true;
\t\t\t\t\tallowSyntheticModelOverride = true;
\t\t\t\t} else if (!hasRequestScopeClient) {
\t\t\t\t\tthrow new Error(fallbackAuth.reason);
\t\t\t\t}
\t\t\t}`;

const secondNeedle = `\t\t\t}, {
\t\t\t\tallowSyntheticModelOverride,
\t\t\t\tagentRunTracking: "plugin_subagent",`;

const secondReplacement = `\t\t\t}, {
\t\t\t\tallowSyntheticModelOverride,
\t\t\t\t...allowSyntheticModelOverride ? { forceSyntheticClient: true } : {},
\t\t\t\tagentRunTracking: "plugin_subagent",`;

const thirdNeedle = `\t\t\t\t...allowOverride && params.model && { model: params.model },
\t\t\t\t...params.extraSystemPrompt && { extraSystemPrompt: params.extraSystemPrompt },`;

const thirdReplacement = `\t\t\t\t...allowOverride && params.model && { model: params.model },
\t\t\t\t...Array.isArray(params.toolsAllow) && { toolsAllow: params.toolsAllow },
\t\t\t\t...params.extraSystemPrompt && { extraSystemPrompt: params.extraSystemPrompt },`;

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
}

function patchFile(file) {
  let text = fs.readFileSync(file, "utf8");
  if (!text.includes("provider/model override is not authorized for this plugin subagent run.")) {
    return null;
  }

  const alreadyFirst = text.includes("if (fallbackAuth.allowed) {\n\t\t\t\t\tallowOverride = true;");
  const alreadySecond = text.includes(
    'forceSyntheticClient: true } : {},\n\t\t\t\tagentRunTracking: "plugin_subagent"'
  );
  const alreadyThird = text.includes("...Array.isArray(params.toolsAllow) && { toolsAllow: params.toolsAllow },");

  if (!alreadyFirst) {
    if (!text.includes(firstNeedle)) {
      throw new Error(`expected first override block not found in ${file}`);
    }
    text = text.replace(firstNeedle, firstReplacement);
  }

  if (!alreadySecond) {
    if (!text.includes(secondNeedle)) {
      throw new Error(`expected dispatch options block not found in ${file}`);
    }
    text = text.replace(secondNeedle, secondReplacement);
  }

  if (!alreadyThird) {
    if (!text.includes(thirdNeedle)) {
      throw new Error(`expected agent params block not found in ${file}`);
    }
    text = text.replace(thirdNeedle, thirdReplacement);
  }

  if (alreadyFirst && alreadySecond && alreadyThird) {
    return { file, status: "already-patched" };
  }

  const backup = `${file}.bak-loop-guard-subagent-override-${timestamp()}`;
  fs.copyFileSync(file, backup);
  fs.writeFileSync(file, text);
  return { file, backup, status: "patched" };
}

function patchSchemaFile(file) {
  let text = fs.readFileSync(file, "utf8");
  if (!text.includes("const AgentParamsSchema = Type.Object({")) return null;
  const schemaNeedle = `\tmodel: Type.Optional(Type.String()),
\tto: Type.Optional(Type.String()),`;
  const schemaReplacement = `\tmodel: Type.Optional(Type.String()),
\ttoolsAllow: Type.Optional(Type.Array(Type.String())),
\tto: Type.Optional(Type.String()),`;
  const alreadyPatched = text.includes("toolsAllow: Type.Optional(Type.Array(Type.String())),");
  if (alreadyPatched) return { file, status: "already-patched" };
  if (!text.includes(schemaNeedle)) {
    throw new Error(`expected AgentParamsSchema model/to block not found in ${file}`);
  }
  const backup = `${file}.bak-loop-guard-agent-tools-allow-${timestamp()}`;
  fs.copyFileSync(file, backup);
  fs.writeFileSync(file, text.replace(schemaNeedle, schemaReplacement));
  return { file, backup, status: "patched" };
}

if (!fs.existsSync(dist)) {
  throw new Error(`OpenClaw dist directory not found: ${dist}`);
}

const results = fs
  .readdirSync(dist)
  .filter((name) => /^server-plugins-.*\.js$/.test(name))
  .map((name) => patchFile(path.join(dist, name)))
  .filter(Boolean);

const schemaResults = fs
  .readdirSync(dist)
  .filter((name) => /^schema-.*\.js$/.test(name))
  .map((name) => patchSchemaFile(path.join(dist, name)))
  .filter(Boolean);

if (results.length === 0 && schemaResults.length === 0) {
  throw new Error(`No OpenClaw dist files containing the subagent override gate or AgentParamsSchema were found in ${dist}`);
}

console.log(JSON.stringify([...results, ...schemaResults], null, 2));
