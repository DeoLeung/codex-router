import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { appConnectorPolicy, serviceAppConnectorEnvironment } from "../src/app-connector-policy.mjs";
import { mergeCodexAppTools } from "../src/codex-app-tools.mjs";
import { bridgeCustomTools, buildNamespaceLookups, flattenNamespaceTools,
  flattenToolChoice, flattenToolSearchHistory, rewriteNamespaceResponsePayload,
  ToolSearchHistoryCapacityError } from "../src/namespace-relay.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const settingName = "CODEX_ROUTER_APP_CONNECTORS";
const namespace = "mcp__codex_apps__gmail";
const chosenName = `${namespace}__search`;

function withSetting(value, callback) {
  const prior = process.env[settingName];
  if (value === undefined) delete process.env[settingName];
  else process.env[settingName] = value;
  try { return callback(); }
  finally {
    if (prior === undefined) delete process.env[settingName];
    else process.env[settingName] = prior;
  }
}

test("service connector settings preserve runtime policy without launcher metacharacters", () => {
  for (const [raw, expected] of [[undefined, undefined], ["", undefined], ["   ", undefined],
    ["none", "none"], ["all", "all"], [" GMail, none, Gmail , Airtable ", "gmail,airtable"],
    ["gmail,ALL", "all"], ["unknown-connector", "unknown-connector"]]) {
    const environment = { [settingName]: raw };
    const serialized = serviceAppConnectorEnvironment(environment);
    assert.equal(serialized[settingName], expected);
    assert.equal(appConnectorPolicy(serialized).withhold, appConnectorPolicy(environment).withhold);
    if (appConnectorPolicy(environment).withhold) {
      assert.deepEqual([...appConnectorPolicy(serialized).eager], [...appConnectorPolicy(environment).eager]);
    }
  }
  for (const raw of ["gmail\nset INJECTED=1", "gmail&command", "gmail%EXPAND%", "gmail\"", "gmail|command", "gmail<file", "gmail;command"]) {
    assert.throws(() => serviceAppConnectorEnvironment({ [settingName]: raw }), /connector identifiers/);
  }
});

const choices = [
  { type: "function", name: chosenName },
  { type: "function", namespace, name: "search" },
  { type: "function", namespace, function: { name: "search" } },
  { type: "allowed_tools", mode: "required", tools: [{ type: "function", namespace, name: "search" }] },
];
for (const [label, input] of [["array", []], ["string", "hello"], ["absent", undefined]]) {
  test(`connector choice restoration preserves ${label} input and enforces its tool budget`, () => {
    withSetting("none", () => {
      for (const toolChoice of choices) {
        const flattened = flattenNamespaceTools([
          { type: "function", name: "shell", parameters: { type: "object" } },
          { type: "namespace", name: namespace, tools: [
            { type: "function", name: "search", inputSchema: { type: "object" } },
            { type: "function", name: "unused", inputSchema: { type: "object" } },
          ] },
        ]);
        assert.deepEqual(flattened.tools.map(tool => tool.name), ["shell"]);
        const restored = flattenToolSearchHistory(input, flattened.tools, flattened.namespaces,
          { toolChoice, maxTools: 2 });
        assert.equal(restored.input, input);
        assert.deepEqual(restored.tools.map(tool => tool.name), ["shell", chosenName]);
        const choice = flattenToolChoice(toolChoice, flattened.namespaces);
        const reference = choice.type === "allowed_tools" ? choice.tools[0] : choice;
        assert.equal(reference.function?.name ?? reference.name, chosenName);
        assert.equal(reference.namespace, undefined);
        assert.throws(() => flattenToolSearchHistory(input, flattened.tools, flattened.namespaces,
          { toolChoice, maxTools: 1 }), error => {
          assert.ok(error instanceof ToolSearchHistoryCapacityError);
          assert.equal(error.available, 0);
          assert.equal(error.required, 1);
          return true;
        });
      }
    });
  });
}

test("namespaced custom tools remain callable through deferral and connector withholding", () => {
  for (const policy of [undefined, "none"]) {
    withSetting(policy, () => {
      const flattened = flattenNamespaceTools([
        { type: "tool_search", execution: "client", parameters: { type: "object" } },
        { type: "namespace", name: namespace, defer_loading: true, tools: [
          { type: "custom", name: "raw", defer_loading: true, description: "Pass raw input." },
          { type: "function", name: "unused", inputSchema: { type: "object" } },
        ] },
      ]);
      const custom = flattened.tools.find(tool => tool.type === "custom");
      assert.ok(custom);
      assert.equal(custom.name, `${namespace}__raw`);
      assert.equal(custom.defer_loading, undefined);
      assert.equal(flattened.tools.some(tool => tool.name === `${namespace}__unused`), false);
      const bridged = bridgeCustomTools(flattened.tools, [], flattened.namespaces,
        undefined, [custom.name]);
      const callable = bridged.tools.find(tool => tool.name === custom.name);
      assert.equal(callable.type, "function");
      const restored = rewriteNamespaceResponsePayload({ output: [{ type: "function_call",
        name: callable.name, call_id: "raw-1", arguments: JSON.stringify({ input: "raw bytes\n☃" }) }] },
      buildNamespaceLookups(flattened.namespaces));
      assert.deepEqual(restored.output[0], { type: "custom_tool_call", namespace,
        name: "raw", call_id: "raw-1", input: "raw bytes\n☃" });
    });
  }
});

test("snapshot expansion preserves namespace deferral for unknown client functions", () => {
  withSetting("all", () => {
    const clientTools = [
      { type: "tool_search", execution: "client", parameters: { type: "object" } },
      { type: "namespace", name: "codex_app", defer_loading: true, tools: [
        { type: "function", name: "navigate_to_codex_page", inputSchema: { type: "object", properties: {} } },
        { type: "function", name: "future_client_tool", inputSchema: { type: "object", properties: {} } },
      ] },
    ];
    const original = structuredClone(clientTools);
    const merged = mergeCodexAppTools(clientTools);
    assert.deepEqual(clientTools, original, "snapshot expansion does not mutate client registrations");
    const flattened = flattenNamespaceTools(merged.tools);
    assert.ok(flattened.tools.some(tool => tool.name === "codex_app__navigate_to_codex_page"));
    assert.ok(!flattened.tools.some(tool => tool.name === "codex_app__future_client_tool"));
    const restored = flattenToolSearchHistory("hello", flattened.tools, flattened.namespaces,
      { toolChoice: { type: "function", namespace: "codex_app", name: "future_client_tool" } });
    const callable = restored.tools.find(tool => tool.name === "codex_app__future_client_tool");
    assert.ok(callable);
    assert.equal(callable.defer_loading, undefined);
    assert.deepEqual(callable.parameters, original[1].tools[1].inputSchema);
  });
});

test("every service platform carries only safe canonical connector settings", () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "connector-service-render-"));
  try {
    for (const platform of ["linux", "macos", "windows"]) {
      for (const [raw, expected] of [[undefined, undefined], ["none", "none"], [" GMail , AIRTABLE ", "gmail,airtable"], ["all", "all"]]) {
        const environment = { ...process.env, HOME: temporary, CODEX_HOME: path.join(temporary, "codex"),
          MODEL_ROUTER_STATE_DIR: path.join(temporary, "state"), XDG_CONFIG_HOME: path.join(temporary, "xdg"),
          [settingName]: raw };
        const rendered = spawnSync(process.execPath, [`src/service-${platform}.mjs`, "render"],
          { cwd: root, env: environment, encoding: "utf8", timeout: 10_000, windowsHide: true });
        assert.equal(rendered.status, 0, rendered.stderr);
        const line = platform === "linux" ? `Environment="${settingName}=${expected}"`
          : platform === "macos" ? `<key>${settingName}</key>\n    <string>${expected}</string>`
            : `set "${settingName}=${expected}"`;
        if (expected === undefined) assert.equal(rendered.stdout.includes(settingName), false);
        else assert.ok(rendered.stdout.includes(line), platform);
        environment[settingName] = "gmail\nset INJECTED=1";
        const rejected = spawnSync(process.execPath, [`src/service-${platform}.mjs`, "render"],
          { cwd: root, env: environment, encoding: "utf8", timeout: 10_000, windowsHide: true });
        assert.notEqual(rejected.status, 0);
        assert.equal(rejected.stdout, "");
        assert.match(rejected.stderr, /connector identifiers/);
      }
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
