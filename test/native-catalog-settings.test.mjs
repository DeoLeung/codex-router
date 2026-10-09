import assert from "node:assert/strict";
import test from "node:test";
import {
  nativeCatalogPollIntervalMs,
  serviceNativeCatalogEnvironment,
} from "../src/native-catalog-settings.mjs";

const name = "CODEX_ROUTER_NATIVE_CATALOG_POLL_INTERVAL_MS";

test("native catalog cadence defaults to five minutes and accepts slower timer-safe values", () => {
  assert.equal(nativeCatalogPollIntervalMs({}), 300_000);
  for (const milliseconds of [300_000, 300_001, 3_600_000, 86_400_000, 2_147_483_647]) {
    assert.equal(nativeCatalogPollIntervalMs({ [name]: String(milliseconds) }), milliseconds);
  }
  assert.equal(nativeCatalogPollIntervalMs({ [name]: " 86400000 " }), 86_400_000);
});

test("invalid or overflowing intervals retain the default instead of scheduling rapid polling", () => {
  for (const value of ["", " ", "0", "-1", "1", "299999", "300000.5", "NaN", "Infinity", "bad", "0x493e0", "3e5", "2147483648", "9007199254740993", "86400000\nINJECT=1"]) {
    assert.equal(nativeCatalogPollIntervalMs({ [name]: value }), 300_000, value);
  }
});

test("service environment persists only an explicit normalized native polling override", () => {
  assert.deepEqual(serviceNativeCatalogEnvironment({}), {});
  assert.deepEqual(serviceNativeCatalogEnvironment({ [name]: " 86400000 " }), { [name]: "86400000" });
  assert.deepEqual(serviceNativeCatalogEnvironment({ [name]: "invalid;value" }), { [name]: "300000" });
  assert.deepEqual(serviceNativeCatalogEnvironment({ CODEX_ROUTER_ZAI_CODING_STREAM_STALL_MS: "90000" }), {});
});
