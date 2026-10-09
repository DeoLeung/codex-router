import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { NATIVE_ACCOUNT_CATALOG_TTL_MS } from "../src/native-account-catalog.mjs";
import { watchNativeCatalog } from "../src/native-catalog-drift.mjs";

test("native catalog watcher refreshes periodically without overlapping passes", async () => {
  let tick;
  let release;
  let calls = 0;
  const stop = watchNativeCatalog({
    environment: {},
    clear(timer) { assert.equal(timer, 1); },
    interval(callback, delay) {
      tick = callback;
      assert.equal(delay, NATIVE_ACCOUNT_CATALOG_TTL_MS);
      return 1;
    },
    republish() {
      calls += 1;
      return new Promise((resolve) => { release = resolve; });
    },
  });

  const first = tick();
  await tick();
  assert.equal(calls, 1);
  release();
  await first;
  const second = tick();
  assert.equal(calls, 2);
  release();
  await second;
  stop();
});

test("a daily polling override preserves immediate startup, serial passes, and timer disposal", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let calls = 0;
  let release;
  const day = 86_400_000;
  const stop = watchNativeCatalog({
    environment: { CODEX_ROUTER_NATIVE_CATALOG_POLL_INTERVAL_MS: String(day) },
    immediate: true,
    republish() {
      calls += 1;
      return new Promise((resolve) => { release = resolve; });
    },
  });
  try {
    assert.equal(calls, 1, "startup remains immediate with a slow periodic cadence");
    t.mock.timers.tick(day);
    assert.equal(calls, 1, "the first daily tick cannot overlap startup");
    release(false);
    await Promise.resolve();
    t.mock.timers.tick(NATIVE_ACCOUNT_CATALOG_TTL_MS);
    assert.equal(calls, 1, "cache TTL does not set the polling cadence");
    t.mock.timers.tick(day - NATIVE_ACCOUNT_CATALOG_TTL_MS - 1);
    assert.equal(calls, 1);
    t.mock.timers.tick(1);
    assert.equal(calls, 2, "a completed pass permits the next daily tick");
    release(false);
    await Promise.resolve();
    stop();
    t.mock.timers.tick(day);
    assert.equal(calls, 2, "a disposed daily timer schedules no more passes");
    assert.equal(NATIVE_ACCOUNT_CATALOG_TTL_MS, 300_000);
  } finally {
    stop();
    release?.(false);
  }
});

test("native catalog watcher recovers after synchronous and asynchronous failures", async () => {
  let tick;
  let calls = 0;
  const messages = [];
  const stop = watchNativeCatalog({
    interval(callback) { tick = callback; return 1; },
    clear() {},
    log(message) { messages.push(message); },
    republish() {
      calls += 1;
      if (calls === 1) throw new Error("offline");
      if (calls === 2) return Promise.reject(new Error("temporary failure"));
      return Promise.resolve(false);
    },
  });
  try {
    await tick();
    await tick();
    await tick();
    assert.equal(calls, 3, "a failed refresh must not block later intervals");
    assert.deepEqual(messages, [
      "[codex-router] Native catalog refresh failed: offline",
      "[codex-router] Native catalog refresh failed: temporary failure",
    ]);
  } finally {
    stop();
  }
});

test("initial refresh shares the periodic guard and stopping prevents queued work", async () => {
  let tick;
  let release;
  let calls = 0;
  let cleared = false;
  const stop = watchNativeCatalog({
    immediate: true,
    interval(callback) { tick = callback; return 1; },
    clear() { cleared = true; },
    republish() {
      calls += 1;
      return new Promise((resolve) => { release = resolve; });
    },
  });
  try {
    assert.equal(calls, 1, "startup refresh starts immediately");
    await tick();
    assert.equal(calls, 1, "an interval must not overlap the startup pass");
    stop();
    release(false);
    await Promise.resolve();
    await tick();
    assert.equal(cleared, true);
    assert.equal(calls, 1, "a callback queued before stop must not refresh");
  } finally {
    stop();
    release?.(false);
  }
});

test("stopping an idle watcher prevents an already queued callback", async () => {
  let tick;
  let calls = 0;
  const stop = watchNativeCatalog({
    interval(callback) { tick = callback; return 1; },
    clear() {},
    republish: async () => { calls += 1; },
  });
  stop();
  await tick();
  assert.equal(calls, 0);
});

test("the background watcher does not keep a finished process alive", () => {
  const moduleUrl = new URL("../src/native-catalog-drift.mjs", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval",
    `import { watchNativeCatalog } from ${JSON.stringify(moduleUrl)};\n`
      + "watchNativeCatalog({ republish: async () => false });\n",
  ], { encoding: "utf8", windowsHide: true, timeout: 5_000 });
  assert.equal(result.error, undefined, "watcher held the process open");
  assert.equal(result.status, 0, result.stderr);
});
