import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { userModelEntry } from "../src/user-models.mjs";
import { openPort } from "./port-pool.mjs";
import { goal, repeatedGoalHistory } from "./goal-continuation-fixtures.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CALLER_KEY = "test-goal-router-caller-key-with-sufficient-length";
const INTERNAL_KEY = "test-goal-router-internal-key-with-sufficient-length";

function json(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function waitForReady(base, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(child.testErrors());
    try { if ((await fetch(`${base}/models`)).ok) return; } catch { /* Not yet bound. */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Router did not become ready: ${child.testErrors()}`);
}

function usageEvents(stateDir) {
  const file = path.join(stateDir, "usage-events.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse) : [];
}

async function waitForUsageEvents(stateDir, count) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = usageEvents(stateDir);
    if (rows.length >= count) return rows;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Usage ledger did not record ${count} requests.`);
}

test("opt-in goal gate blocks before upstream, meters 400, and reset or unenabled traffic proceeds", async (t) => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "goal-router-"));
  const upstreamRequests = [];
  const upstream = http.createServer(async (request, response) => {
    if (request.method === "GET") { json(response, 200, { ok: true, credential_present: true }); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    upstreamRequests.push(payload);
    json(response, 200, {
      id: `resp_goal_${upstreamRequests.length}`, object: "response", status: "completed",
      output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "verified" }] }],
      usage: { input_tokens: 100, output_tokens: 1 },
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
  const entries = [true, false, undefined].map((flag, index) => ({
    ...userModelEntry({ providerId: "custom", upstreamId: `glm-5.3-goal-${index}`, priority: 900 + index,
      metadata: flag === undefined ? {} : { goalContinuationGuard: flag } }),
    endpoint: { baseUrl: `${upstreamBase}/v1`, protocol: "openai-responses", keyless: true },
  }));
  const modelsFile = path.join(stateDir, "user-models.json");
  writeFileSync(modelsFile, JSON.stringify({ version: 1, models: entries }));
  writeFileSync(path.join(stateDir, "enabled-providers.json"), JSON.stringify({ version: 1, providers: ["custom"] }));
  const port = await openPort();
  const base = callerBaseUrl(port, CALLER_KEY);
  const child = spawn(process.execPath, [path.join(root, "src/router.mjs")], {
    cwd: root,
    env: {
      ...process.env, CODEX_HOME: path.join(stateDir, "codex-home"),
      MODEL_ROUTER_STATE_DIR: stateDir, CODEX_ROUTER_STATE_DIR: stateDir,
      MODEL_ROUTER_USER_MODELS: modelsFile,
      CODEX_ROUTER_PORT: String(port), CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
      CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY, KIMI_INTERNAL_KEY: INTERNAL_KEY,
      CODEX_ROUTER_GATEWAY_BASE_URL: `${upstreamBase}/v1`, CODEX_NATIVE_BASE_URL: upstreamBase,
      CODEX_ROUTER_API_BASE_URL: `${upstreamBase}/v1`,
      CODEX_ROUTER_GATEWAY_HEALTH_URL: `${upstreamBase}/health`,
      CODEX_ROUTER_API_HEALTH_URL: `${upstreamBase}/health`,
      CODEX_ROUTER_OAUTH_HEALTH_URL: `${upstreamBase}/health`,
      CODEX_ROUTER_QUIET: "1", CODEX_ROUTER_SHOW_ALL_MODELS: "1",
      MODEL_ROUTER_NO_DISCOVERY: "0", CODEX_ROUTER_NO_DISCOVERY: "0",
    }, stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { errors += chunk; });
  child.testErrors = () => errors;
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
    }
    await new Promise((resolve) => upstream.close(resolve));
    rmSync(stateDir, { recursive: true, force: true });
  });
  await waitForReady(base, child);
  const options = {
    stream: false, instructions: "Preserve these developer instructions.",
    reasoning: { effort: "high" }, temperature: 0.4, max_output_tokens: 4096,
    parallel_tool_calls: true, tools: [{ type: "function", name: "read", parameters: { type: "object" } }],
    tool_choice: "auto",
  };
  const request = async (model, input) => fetch(`${base}/responses`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, ...options, input }),
  });
  const original = repeatedGoalHistory();
  const refused = await request(entries[0].slug, original);
  assert.equal(refused.status, 400);
  const refusal = await refused.json();
  assert.equal(refusal.error.type, "invalid_request_error");
  assert.equal(refusal.error.code, "router_goal_no_progress");
  assert.match(refusal.error.message, /three repeated replies/);
  assert.equal(upstreamRequests.length, 0, "a blocked request must not reach any provider");
  const rows = usageEvents(stateDir);
  assert.equal(rows.length, 1, "one local refusal produces one usage row");
  assert.equal(rows[0].status, 400);
  assert.equal(rows[0].model, entries[0].slug);
  assert.equal(rows[0].provider, "custom");
  assert.equal(rows[0].retries, undefined);
  assert.equal(rows[0].failoverFrom, undefined);
  assert.equal(rows[0].outputTokens, undefined);
  assert.equal(rows[0].inputTokens, undefined);
  assert.equal(rows[0].responseStartMs, undefined, "a local refusal has no upstream latency");

  const freshUser = structuredClone(original);
  freshUser.splice(-1, 0, { type: "message", role: "user", content: "Resume and inspect the saved result." });
  const freshDeveloper = structuredClone(original);
  freshDeveloper.splice(-1, 0, { type: "message", role: "developer", content: "Use the new acceptance criteria." });
  const toolResult = structuredClone(original);
  toolResult.splice(-1, 0, { type: "function_call", name: "read", call_id: "read-1", arguments: "{}" },
    { type: "function_call_output", call_id: "read-1", output: "New evidence" });
  const changedGoal = [...original.slice(0, -1), goal("Verify a different requested result.")];
  const missingGoal = [...original.slice(0, -1), goal("")];
  for (const input of [freshUser, freshDeveloper, toolResult, changedGoal, missingGoal]) {
    const response = await request(entries[0].slug, input);
    assert.equal(response.status, 200, await response.text());
    const forwarded = upstreamRequests.at(-1);
    assert.deepEqual(forwarded.input, input, "the guard must preserve the original transcript");
    assert.deepEqual(forwarded.reasoning, options.reasoning);
    assert.equal(forwarded.temperature, options.temperature);
    assert.equal(forwarded.max_output_tokens, options.max_output_tokens);
    assert.equal(forwarded.parallel_tool_calls, options.parallel_tool_calls);
    assert.deepEqual(forwarded.tools, options.tools);
    assert.equal(forwarded.instructions, options.instructions);
  }
  for (const model of [entries[1].slug, entries[2].slug, "gpt-goal-native-fixture"]) {
    const response = await request(model, original);
    assert.equal(response.status, 200, await response.text());
    assert.deepEqual(upstreamRequests.at(-1).input, original);
  }
  assert.equal(upstreamRequests.length, 8, "reset and unenabled requests each make exactly one upstream request");
  assert.equal((await waitForUsageEvents(stateDir, 9)).length, 9);
  const compaction = await fetch(`${base}/responses/compact`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: entries[0].slug, ...options, input: original }),
  });
  assert.equal(compaction.status, 200, await compaction.text());
  assert.equal(upstreamRequests.length, 9, "compaction must not be mistaken for automatic generation");
  assert.equal((await waitForUsageEvents(stateDir, 10)).length, 10);
});
