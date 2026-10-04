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
import { ResponsesWebSocketClient } from "../src/responses-ws-client.mjs";
import { userModelEntry } from "../src/user-models.mjs";
import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL_KEY = "relay-test-internal-key-with-sufficient-length";
const CALLER_KEY = "relay-test-caller-capability-0123456789abcdef";

function waitFor(predicate, timeoutMs = 3_000) {
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

// The shared encoder handles the 126/127 extended-length forms; a hand-rolled
// single-byte length corrupts any frame past 125 bytes (the completed frame
// with its output and usage easily exceeds that).
import { encodeFrame } from "../src/ws-frames.mjs";
function unmaskedFrame(opcode, payload) {
  return encodeFrame(opcode, Buffer.from(payload || "", "utf8"));
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
      if (buffer.length < offset + (masked ? 4 : 0) + length) return;
      const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
      const encoded = buffer.subarray(offset + (masked ? 4 : 0), offset + (masked ? 4 : 0) + length);
      const payload = Buffer.allocUnsafe(length);
      for (let index = 0; index < length; index += 1) {
        payload[index] = encoded[index] ^ (mask ? mask[index & 3] : 0);
      }
      buffer = buffer.subarray(offset + (masked ? 4 : 0) + length);
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
    next(timeoutMs = 3_000) {
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
// the frames, so the test asserts exactly what crossed the wire. Continuation
// handling mirrors the contract: a previous_response_id frame is concatenated
// against the stored baseline, and every completed turn becomes the new one.
async function startRawProvider() {
  const received = [];
  const continuations = new Map();
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
        const request = JSON.parse(frame.payload.toString("utf8"));
        received.push(request);
        const previous = request.previous_response_id
          ? continuations.get(request.previous_response_id)
          : undefined;
        const input = [
          ...(previous?.input ?? []),
          ...(previous?.output ?? []),
          ...request.input,
        ];
        const id = `resp_relay_${received.length}`;
        const output = [
          { type: "message", role: "assistant", id: `msg_${received.length}`, content: [] },
        ];
        socket.write(
          unmaskedFrame(0x1, JSON.stringify({
            type: "response.created",
            response: { id, status: "in_progress" },
          })),
        );
        socket.write(
          unmaskedFrame(0x1, JSON.stringify({
            type: "response.completed",
            response: {
              id,
              status: "completed",
              output,
              usage: { input_tokens: input.length * 10, output_tokens: 1, total_tokens: input.length * 10 + 1 },
            },
          })),
        );
        continuations.clear();
        continuations.set(id, { input, output });
      }
    })();
  });
  return {
    server,
    port,
    received,
    close() {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
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

// The router edge under test, wired exactly like router.mjs wires it.
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

test("incremental turns relay end to end without reconstructing the body", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ws-relay-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const provider = await startRawProvider();
  t.after(() => provider.close());

  const model = userModelEntry({ providerId: "mixed-ws", upstreamId: "gpt-relay", priority: 100 });
  const providersFile = path.join(directory, "generic-providers.json");
  const userModelsFile = path.join(directory, "user-models.json");
  writeFileSync(providersFile, `${JSON.stringify({
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
  writeFileSync(userModelsFile, `${JSON.stringify({ version: 1, models: [model] }, null, 2)}\n`);

  const forwarderPort = await openPort();
  const forwarder = runForwarder({
    MODEL_ROUTER_API_PORT: String(forwarderPort),
    MODEL_ROUTER_STATE_DIR: path.join(directory, "state"),
    MODEL_ROUTER_GENERIC_PROVIDERS: providersFile,
    MODEL_ROUTER_USER_MODELS: userModelsFile,
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
      requested === "mixed-ws/gpt-relay" ? { providerId: "mixed-ws" } : undefined,
    internalResponses: (request, response) => {
      sseResponse(response, [
        { type: "response.created", response: { id: "resp_loopback", status: "in_progress" } },
        { type: "response.completed", response: { id: "resp_loopback", status: "completed" } },
      ]);
    },
  });
  t.after(() => edge.close());

  const codex = await ResponsesWebSocketClient.connect(
    `ws://127.0.0.1:${edge.port}/_codex-router/${CALLER_KEY}/v1/responses`,
    { headers: { Authorization: `Bearer ${CALLER_KEY}` } },
  );
  t.after(() => codex.abort());

  const collectFrames = () => {
    const frames = [];
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no terminal frame")), 5_000);
      codex.onJson = (value) => {
        frames.push(value);
        if (
          value?.type === "response.completed" ||
          ["error", "response.failed", "response.incomplete"].includes(value?.type)
        ) {
          clearTimeout(timer);
          resolve(frames);
        }
      };
    });
  };

  // Turn 1: full input rides the relay.
  const firstPromise = collectFrames();
  await codex.sendJson({
    type: "response.create",
    model: "mixed-ws/gpt-relay",
    input: [{ type: "message", role: "user", content: "first" }],
    stream: true,
  });
  const firstFrames = await firstPromise;
  assert.equal(firstFrames.at(-1).type, "response.completed");
  const firstId = firstFrames.at(-1).response.id;

  // Turn 2: only the new input -- the headline assertion of the relay.
  const secondPromise = collectFrames();
  await codex.sendJson({
    type: "response.create",
    model: "mixed-ws/gpt-relay",
    previous_response_id: firstId,
    input: [{ type: "function_call_output", call_id: "call_1", output: "done" }],
    stream: true,
  });
  const secondFrames = await secondPromise;
  assert.equal(secondFrames.at(-1).type, "response.completed");

  assert.equal(provider.received.length, 2);
  assert.equal(provider.received[0].previous_response_id, undefined);
  assert.equal(provider.received[0].input.length, 1);
  // The second frame crossed every hop as-is: previous id + suffix input only.
  assert.equal(provider.received[1].previous_response_id, firstId);
  assert.equal(provider.received[1].input.length, 1);
  assert.equal(provider.received[1].input[0].call_id, "call_1");
  // The loopback translation path never ran for these turns.
  assert.equal(edge.loopbackRequests.length, 0);
});

test("frames for non-relay models keep the loopback translation path", async (t) => {
  const internalRequests = [];
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
  void internalRequests;
  t.after(() => edge.close());
  const codex = await ResponsesWebSocketClient.connect(
    `ws://127.0.0.1:${edge.port}/_codex-router/${CALLER_KEY}/v1/responses`,
    { headers: { Authorization: `Bearer ${CALLER_KEY}` } },
  );
  t.after(() => codex.abort());
  const frames = [];
  await codex.sendJson({
    type: "response.create",
    model: "some-http-model",
    input: [{ type: "message", role: "user", content: "hi" }],
    stream: true,
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no terminal frame")), 5_000);
    codex.onJson = (value) => {
      frames.push(value);
      if (value?.type === "response.completed") {
        clearTimeout(timer);
        resolve();
      }
    };
  });
  assert.equal(frames.at(-1).response.id, "resp_http");
  assert.equal(edge.loopbackRequests.length, 1);
});

test("an unopenable hop falls back to the loopback translation for that frame", async (t) => {
  // No forwarder at that port: connectHop refuses.
  const deadPort = await openPort();
  const edge = await startEdge({
    forwarderPort: deadPort,
    resolveRoute: (requested) =>
      requested === "mixed-ws/gpt-relay" ? { providerId: "mixed-ws" } : undefined,
    internalResponses: (request, response) => {
      sseResponse(response, [
        { type: "response.created", response: { id: "resp_fallback", status: "in_progress" } },
        { type: "response.completed", response: { id: "resp_fallback", status: "completed" } },
      ]);
    },
  });
  t.after(() => edge.close());
  const codex = await ResponsesWebSocketClient.connect(
    `ws://127.0.0.1:${edge.port}/_codex-router/${CALLER_KEY}/v1/responses`,
    { headers: { Authorization: `Bearer ${CALLER_KEY}` } },
  );
  t.after(() => codex.abort());
  const frames = [];
  await codex.sendJson({
    type: "response.create",
    model: "mixed-ws/gpt-relay",
    input: [{ type: "message", role: "user", content: "hi" }],
    stream: true,
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no terminal frame")), 8_000);
    codex.onJson = (value) => {
      frames.push(value);
      if (value?.type === "response.completed") {
        clearTimeout(timer);
        resolve();
      }
    };
  });
  assert.equal(frames.at(-1).response.id, "resp_fallback");
  assert.equal(edge.loopbackRequests.length, 1);
});
