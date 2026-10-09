import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { userModelEntry } from "../src/user-models.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("curation preserves only an explicitly supplied goal guard flag", () => {
  const base = { providerId: "custom", upstreamId: "glm-5.3", priority: 1 };
  assert.equal(userModelEntry(base).goalContinuationGuard, undefined);
  for (const flag of [true, false]) {
    assert.equal(userModelEntry({ ...base, metadata: { goalContinuationGuard: flag } }).goalContinuationGuard, flag);
  }
});

test("registry accepts optional boolean goal guard metadata and rejects other types", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "goal-registry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const registryPath = path.join(dir, "registry.json");
  const entry = { ...userModelEntry({ providerId: "custom", upstreamId: "glm-5.3", priority: 1 }),
    endpoint: { baseUrl: "http://127.0.0.1:9999/v1", keyless: true } };
  const load = (flag) => {
    const model = flag === undefined ? entry : { ...entry, goalContinuationGuard: flag };
    writeFileSync(registryPath, JSON.stringify({ version: 1, providers: [{ id: "custom", displayName: "Custom",
      kind: "openai-compatible", ownedBy: "custom", authMode: "per-model", perModelEndpoint: true }], models: [model] }));
    return spawnSync(process.execPath, ["--input-type=module", "-e",
      "const { MODEL_BY_SLUG } = await import('./src/model-registry.mjs'); console.log(JSON.stringify(MODEL_BY_SLUG.get('custom/glm-5.3')));"], {
      cwd: root, encoding: "utf8", env: { ...process.env, MODEL_ROUTER_REGISTRY: registryPath,
        MODEL_ROUTER_STATE_DIR: dir, CODEX_HOME: path.join(dir, "codex"),
        MODEL_ROUTER_USER_MODELS: path.join(dir, "absent.json") },
    });
  };
  for (const flag of [undefined, true, false]) {
    const result = load(flag);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).goalContinuationGuard, flag);
  }
  for (const flag of ["true", 1, null, {}]) {
    const result = load(flag);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid goalContinuationGuard flag/);
  }
});
