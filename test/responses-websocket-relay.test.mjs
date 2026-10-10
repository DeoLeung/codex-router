import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { authenticatedRoute } from "../src/caller-auth.mjs";
import { handleResponsesWebSocketUpgrade } from "../src/responses-websocket.mjs";
import { ResponsesWebSocketClient, sendFrameCollectFrames } from "../src/responses-ws-client.mjs";
import { userModelEntry } from "../src/user-models.mjs";
import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL_KEY = "relay-policy-test-internal-key-with-sufficient-length";
const CALLER_KEY = "relay-policy-test-caller-capability-0123456789ab";

function waitFor(predicate, timeoutMs = 4_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("condition timed out"));
      setTimeout(check, 10);
    };
    check();
  });
}

function frameReader(socket) {
  let buffer = Buffer.alloc(0);
  const frames = [];
  const waiters = [];
  const consume = () => {
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 0x0f;
      const masked = Boolean(buffer[1] & 0x80);
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const headerLength = offset + (masked ? 4 : 0);
      if (buffer.length < headerLength + length) return;
      const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
      const encoded = buffer.subarray(headerLength, headerLength + length);
      const payload = Buffer.allocUnsafe(length);
      for (let index = 0; index < length; index += 1) {
        payload[index] = encoded[index] ^ (mask ? mask[index & 3] : 0);
      }
      buffer = buffer.subarray(headerLength + length);
      const frame = { opcode, masked, payload };
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(frame);
      else frames.push(frame);
    }
  };
  socket.on("data", (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : Buffer.from(chunk);
    consume();
  });
  return {
    frames,
    next(timeoutMs = 4_000) {
      const frame = frames.shift();
      if (frame) return Promise.resolve(frame);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no frame arrived")), timeoutMs);
        waiters.push({
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
        });
      });
    },
  };
}

// A raw provider speaking the Responses WebSocket protocol: full control over
// the wire, so the tests assert exactly what crossed it. Tracks connection
// count so continuation affinity is observable.
async function startRawProvider() {
  const received = [];
  const continuations = new Map();
  const connections = [];
  const server = http.createServer((request, response) => {
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const sockets = new Set();
  server.on("upgrade", (request, socket, head) => {
    const accept = createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.on("error", () => {});
    connections.push(socket);
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const reader = frameReader(socket);
    void (async () => {
      while (true) {
        let frame;
        try {
          frame = await reader.next(30_000);
        } catch {
          return;
        }
        if (frame.opcode !== 0x1) continue;
        let request;
        try {
          request = JSON.parse(frame.payload.toString("utf8"));
        } catch {
          continue;
        }
        received.push(request);
        if (request.type !== "response.create") continue;
        const previous = request.previous_response_id
          ? continuations.get(request.previous_response_id)
          : undefined;
        const input = [
          ...(previous?.input ?? []),
          ...(previous?.output ?? []),
          ...request.input,
        ];
        const id = `resp_relay_${received.filter((r) => r.type === "response.create").length}`;
        const output = [
          { type: "message", role: "assistant", id: `msg_${id}`, content: [] },
        ];
        socket.write(unmasked(0x1, JSON.stringify({
          type: "response.created",
          response: { id, status: "in_progress" },
        })));
        socket.write(unmasked(0x1, JSON.stringify({
          type: "response.completed",
          response: {
            id,
            status: "completed",
            output,
            usage: { input_tokens: input.length * 10, output_tokens: 1, total_tokens: input.length * 10 + 1 },
          },
        })));
        continuations.clear();
        continuations.set(id, { input, output });
      }
    })();
  });
  return {
    server,
    port,
    received,
    connectionCount: () => connections.length,
    close() {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

function unmasked(opcode, payload) {
  const data = Buffer.from(payload || "", "utf8");
  if (data.length < 126) {
    return Buffer.concat([Buffer.from([0x80 | opcode, data.length]), data]);
  }
  if (data.length <= 0xffff) {
    const header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
    return Buffer.concat([header, data]);
  }
  const header = Buffer.allocUnsafe(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(data.length), 2);
  return Buffer.concat([header, data]);
}

function runForwarder(env) {
  const child = spawn(process.execPath, [path.join(root, "src", "api-forwarder.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_TARGET: "codex",
      MODEL_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
      MODEL_ROUTER_QUIET: "1",
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  child.testErrors = () => errors;
  return child;
}

async function waitForForwarder(port, child) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Forwarder exited early (${child.exitCode}): ${child.testErrors()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { Authorization: `Bearer ${INTERNAL_KEY}` },
      });
      if (response.ok) return;
    } catch {
      // Not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Forwarder did not become healthy: ${child.testErrors()}`);
}

// The router edge under test, wired the way router.mjs wires it: the hop
// lands on the spawned forwarder, and relay frames carry the gateway model id
// for the forwarder's canonical pipeline to translate.
async function startEdge({ forwarderPort, resolveRoute, internalResponses }) {
  const loopbackRequests = [];
  const server = http.createServer(async (request, response) => {
    const route = authenticatedRoute(new URL(request.url, "http://127.0.0.1").pathname, CALLER_KEY);
    if (route !== "/v1/responses") {
      response.writeHead(401).end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    loopbackRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    await internalResponses(request, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const edgeSockets = new Set();
  server.on("upgrade", (request, socket, head) => {
    edgeSockets.add(socket);
    socket.on("close", () => edgeSockets.delete(socket));
    handleResponsesWebSocketUpgrade(request, socket, head, {
      callerKey: CALLER_KEY,
      authenticateUpgrade: () => "/v1/responses",
      responsesUrl: `http://127.0.0.1:${port}/_codex-router/${CALLER_KEY}/v1/responses`,
      relayTransport: {
        resolveRoute,
        connectHop: (providerId, signal) => ResponsesWebSocketClient.connect(
          `ws://127.0.0.1:${forwarderPort}/_ws/providers/${providerId}`,
          { headers: { Authorization: `Bearer ${INTERNAL_KEY}` }, signal },
        ),
      },
    });
  });
  return {
    server,
    port,
    loopbackRequests,
    close() {
      for (const socket of edgeSockets) socket.destroy();
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

function sseResponse(response, events) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events) {
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  response.end();
}

async function connectCodex(port) {
  const client = await ResponsesWebSocketClient.connect(
    `ws://127.0.0.1:${port}/_codex-router/${CALLER_KEY}/v1/responses`,
    // The client's late-frame guard only admits response frames while a turn
    // is live, so turns are driven through sendFrameCollectFrames -- the same
    // lifecycle the router's own relay uses.
    { headers: { Authorization: `Bearer ${CALLER_KEY}` }, pingIntervalMs: 0 },
  );
  const frames = [];
  return {
    client,
    frames,
    // Drive one turn end to end; resolves at the terminal frame with every
    // relayed frame recorded in `frames`.
    turn(frame) {
      return sendFrameCollectFrames(client, frame, {
        onFrame: (value) => frames.push(value),
      });
    },
  };
}

const RELAY_SLUG = "mixed-ws/gpt-relay";
const RELAY_UPSTREAM = "gpt-relay-upstream";

async function spawnRelayStack(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ws-relay-policy-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const provider = await startRawProvider();
  t.after(() => provider.close());

  const model = userModelEntry({ providerId: "mixed-ws", upstreamId: RELAY_UPSTREAM, priority: 100 });
  writeFileSync(path.join(directory, "generic-providers.json"), `${JSON.stringify({
    version: 1,
    providers: [{
      id: "mixed-ws",
      displayName: "Relay Gateway",
      baseUrl: `http://127.0.0.1:${provider.port}/v1`,
      adapter: "openai-responses",
      transport: "websocket",
      allowPrivate: true,
      enabled: true,
    }],
  }, null, 2)}\n`);
  writeFileSync(path.join(directory, "user-models.json"), `${JSON.stringify({
    version: 1,
    models: [model],
  }, null, 2)}\n`);

  const forwarderPort = await openPort();
  const forwarder = runForwarder({
    MODEL_ROUTER_API_PORT: String(forwarderPort),
    MODEL_ROUTER_STATE_DIR: path.join(directory, "state"),
    MODEL_ROUTER_GENERIC_PROVIDERS: path.join(directory, "generic-providers.json"),
    MODEL_ROUTER_USER_MODELS: path.join(directory, "user-models.json"),
  });
  t.after(() => {
    if (forwarder.exitCode !== null) return;
    forwarder.kill("SIGTERM");
    return new Promise((resolve) => forwarder.once("exit", resolve));
  });
  await waitForForwarder(forwarderPort, forwarder);

  const edge = await startEdge({
    forwarderPort,
    resolveRoute: (requested) =>
      requested === RELAY_SLUG ? { providerId: "mixed-ws", gatewayModel: model.gatewayModel } : undefined,
    internalResponses: (request, response) => {
      sseResponse(response, [
        { type: "response.created", response: { id: "resp_loopback", status: "in_progress" } },
        { type: "response.completed", response: { id: "resp_loopback", status: "completed" } },
      ]);
    },
  });
  t.after(() => edge.close());
  return { provider, forwarder, edge, model };
}

test("relayed turns pass the canonical pipeline and keep continuation affinity", async (t) => {
  const { provider, edge, model } = await spawnRelayStack(t);
  const codex = await connectCodex(edge.port);
  t.after(() => codex.client.abort());

  const base = {
    model: RELAY_SLUG,
    instructions: "You are a terse test assistant.",
    tools: [],
    tool_choice: "auto",
    parallel_tool_calls: false,
    store: false,
    stream: true,
    client_metadata: { session_id: "sess-relay-1", thread_id: "thread-relay-1" },
  };

  const first = await codex.turn({
    type: "response.create",
    ...base,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "first" }] }],
  });
  assert.equal(first.type, "response.completed");
  const firstId = first.response.id;

  const second = await codex.turn({
    type: "response.create",
    ...base,
    previous_response_id: firstId,
    input: [{ type: "function_call_output", call_id: "call_1", output: "done" }],
  });
  assert.equal(second.type, "response.completed");

  const creates = provider.received.filter((frame) => frame.type === "response.create");
  assert.equal(creates.length, 2);
  // Canonical pipeline: the provider saw the upstream model id (slug and
  // gateway id both translated away) and no caller identity metadata.
  for (const create of creates) {
    assert.equal(create.model, RELAY_UPSTREAM);
    assert.equal(create.client_metadata, undefined);
  }
  // Incremental contract: the second frame names the first id and carries
  // only the suffix input.
  assert.equal(creates[1].previous_response_id, firstId);
  assert.equal(creates[1].input.length, 1);
  assert.equal(creates[1].input[0].call_id, "call_1");
  // Affinity: the provider's continuation state is connection-local, and both
  // turns rode one sticky connection even though the pool allows four.
  assert.equal(provider.connectionCount(), 1);
  // The loopback translation never ran for these turns.
  assert.equal(edge.loopbackRequests.length, 0);
  void model;
});

test("an unopenable hop falls back to the loopback translation for that frame", async (t) => {
  const deadPort = await openPort();
  const edge = await startEdge({
    forwarderPort: deadPort,
    resolveRoute: (requested) =>
      requested === RELAY_SLUG ? { providerId: "mixed-ws", gatewayModel: "mixed-ws-x" } : undefined,
    internalResponses: (request, response) => {
      sseResponse(response, [
        { type: "response.created", response: { id: "resp_fallback", status: "in_progress" } },
        { type: "response.completed", response: { id: "resp_fallback", status: "completed" } },
      ]);
    },
  });
  t.after(() => edge.close());
  const codex = await connectCodex(edge.port);
  t.after(() => codex.client.abort());
  const frame = await codex.turn({
    type: "response.create",
    model: RELAY_SLUG,
    input: [{ type: "message", role: "user", content: "hi" }],
    stream: true,
  });
  assert.equal(frame.type, "response.completed");
  assert.equal(frame.response.id, "resp_fallback");
  assert.equal(edge.loopbackRequests.length, 1);
});

test("frames for non-relay models keep the loopback translation path", async (t) => {
  const edge = await startEdge({
    forwarderPort: await openPort(),
    resolveRoute: () => undefined,
    internalResponses: (request, response) => {
      sseResponse(response, [
        { type: "response.created", response: { id: "resp_http", status: "in_progress" } },
        { type: "response.completed", response: { id: "resp_http", status: "completed" } },
      ]);
    },
  });
  t.after(() => edge.close());
  const codex = await connectCodex(edge.port);
  t.after(() => codex.client.abort());
  const frame = await codex.turn({
    type: "response.create",
    model: "some-http-model",
    input: [{ type: "message", role: "user", content: "hi" }],
    stream: true,
  });
  assert.equal(frame.type, "response.completed");
  assert.equal(frame.response.id, "resp_http");
  assert.equal(edge.loopbackRequests.length, 1);
});
