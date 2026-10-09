// Polling cadence is independent of account-cache freshness. Keep the shipped
// five-minute cadence unless the operator explicitly chooses a slower one.
export const DEFAULT_NATIVE_CATALOG_POLL_INTERVAL_MS = 5 * 60_000;
export const MAX_NATIVE_CATALOG_POLL_INTERVAL_MS = 2 ** 31 - 1;
const POLL_INTERVAL_ENV = "CODEX_ROUTER_NATIVE_CATALOG_POLL_INTERVAL_MS";

export function nativeCatalogPollIntervalMs(environment = process.env) {
  const value = String(environment[POLL_INTERVAL_ENV] ?? "").trim();
  if (!/^\d+$/.test(value)) return DEFAULT_NATIVE_CATALOG_POLL_INTERVAL_MS;
  const milliseconds = Number(value);
  // Node turns an overflowing interval into 1 ms; reject it rather than
  // accidentally hammering the account endpoint or drift comparison.
  return Number.isSafeInteger(milliseconds) &&
    milliseconds >= DEFAULT_NATIVE_CATALOG_POLL_INTERVAL_MS &&
    milliseconds <= MAX_NATIVE_CATALOG_POLL_INTERVAL_MS
    ? milliseconds
    : DEFAULT_NATIVE_CATALOG_POLL_INTERVAL_MS;
}

export function serviceNativeCatalogEnvironment(environment = process.env) {
  if (!Object.hasOwn(environment, POLL_INTERVAL_ENV)) return {};
  return { [POLL_INTERVAL_ENV]: String(nativeCatalogPollIntervalMs(environment)) };
}
