#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const verifyOnly = process.argv.includes("--verify");
const root =
  process.env.OPENCLAW_DIST ||
  path.join(
    process.env.HOME || "",
    ".openclaw",
    "npm",
    "lib",
    "node_modules",
    "openclaw",
    "dist"
  );
const files = fs
  .readdirSync(root)
  .filter((name) => /^selection-.*\.js$/.test(name))
  .map((name) => path.join(root, name))
  .filter((file) => fs.readFileSync(file, "utf8").includes("embedded run agent end"));

if (files.length !== 1) {
  throw new Error(`expected exactly one selection bundle in ${root}, found ${files.length}`);
}

const file = files[0];
const original = fs.readFileSync(file, "utf8");
const importBefore = "d as runAgentEndSideEffects";
const importAfter = "u as awaitAgentEndSideEffects";
const callBefore = "if (!beforeAgentFinalizeRevisionReason) runAgentEndSideEffects({";
const callAfter =
  "if (!beforeAgentFinalizeRevisionReason && !promptError) await awaitAgentEndSideEffects({";
const terminalBefore = `\tconst runBeforeTerminalDelivery = () => {
\t\tconst result = ctx.params.onBeforeTerminalDelivery?.({
\t\t\tmessages: evt?.messages ?? [],
\t\t\twillRetry: evt?.willRetry === true,
\t\t\t...lastAssistant ? { lastAssistant } : {},
\t\t\tassistantTexts: ctx.state.assistantTexts,
\t\t\thasAssistantVisibleText,
\t\t\tisError,
\t\t\tincompleteTerminalAssistant,
\t\t\thadDeterministicSideEffect: hadBeforeFinalizeSideEffect
\t\t});
\t\tif (isPromiseLike(result)) return result;
\t\treturn result;
\t};`;
const terminalAfter = `\tconst runBeforeTerminalDelivery = () => {
\t\tconst runConfiguredTerminalDelivery = () => ctx.params.onBeforeTerminalDelivery?.({
\t\t\tmessages: evt?.messages ?? [],
\t\t\twillRetry: evt?.willRetry === true,
\t\t\t...lastAssistant ? { lastAssistant } : {},
\t\t\tassistantTexts: ctx.state.assistantTexts,
\t\t\thasAssistantVisibleText,
\t\t\tisError,
\t\t\tincompleteTerminalAssistant,
\t\t\thadDeterministicSideEffect: hadBeforeFinalizeSideEffect
\t\t});
\t\tif (!isError) return runConfiguredTerminalDelivery();
\t\tconst hookRunnerEnd = getGlobalHookRunner();
\t\tif (!hookRunnerEnd?.hasHooks("agent_end")) return runConfiguredTerminalDelivery();
\t\tconst hookResult = hookRunnerEnd.runAgentEnd({
\t\t\tmessages: evt?.messages ?? [],
\t\t\tsuccess: false,
\t\t\terror: lifecycleErrorText ?? "LLM request failed."
\t\t}, {
\t\t\trunId: ctx.params.runId,
\t\t\tagentId: ctx.params.agentId,
\t\t\tsessionKey: ctx.params.sessionKey,
\t\t\tsessionId: ctx.params.sessionId
\t\t});
\t\tif (isPromiseLike(hookResult)) {
\t\t\treturn Promise.resolve(hookResult).then(runConfiguredTerminalDelivery);
\t\t}
\t\treturn runConfiguredTerminalDelivery();
\t};`;
const importPatched = original.includes(importAfter);
const callPatched = original.includes(callAfter);
const terminalPatched = original.includes("const runConfiguredTerminalDelivery = () =>");
const fullyPatched = importPatched && callPatched && terminalPatched;

if (verifyOnly) {
  console.log(
    JSON.stringify(
      { file, patched: fullyPatched, importPatched, callPatched, terminalPatched },
      null,
      2
    )
  );
  process.exit(fullyPatched ? 0 : 1);
}
if (fullyPatched) {
  console.log(`already patched: ${file}`);
  process.exit(0);
}
if (
  !original.includes(importBefore) ||
  !original.includes(callBefore) ||
  !original.includes(terminalBefore)
) {
  throw new Error("OpenClaw bundle did not match the expected 2026.7.1-2 patch points");
}

const updated = original
  .replace(importBefore, importAfter)
  .replace(callBefore, callAfter)
  .replace(terminalBefore, terminalAfter);
const backup = `${file}.bak-loop-guard-awaited-agent-end-${Date.now()}`;

fs.copyFileSync(file, backup);
fs.writeFileSync(file, updated);
console.log(`patched: ${file}`);
console.log(`backup: ${backup}`);
