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
const INTERNAL_KEY = "interrupt-test-internal-key-with-sufficient-length";
const CALLER_KEY = "interrupt-test-caller-capability-0123456789";

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

function unmaskedFrame(opcode, payload) {
  const data = Buffer.from(payload || "", "utf8");
  return Buffer.concat([Buffer.from([0x80 | opcode, data.length]), data]);
}

// The edge under test, wired the way router.mjs wires it.
async function startEdge({ resolveRoute, internalResponses }) {
  const server = http.createServer(async (request, response) => {
    const route = authenticatedRoute(new URL(request.url, "http://127.0.0.1").pathname, CALLER_KEY);
    if (route !== "/v1/responses") {
      response.writeHead(401).end();
      return;
    }
    await internalResponses(request, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const sockets = new Set();
  server.on("upgrade", (request, socket, head) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    handleResponsesWebSocketUpgrade(request, socket, head, {
      callerKey: CALLER_KEY,
      authenticateUpgrade: () => "/v1/responses",
      responsesUrl: `http://127.0.0.1:${port}/_codex-router/${CALLER_KEY}/v1/responses`,
      relayTransport: {
        resolveRoute,
        connectHop: (providerId, signal) => ResponsesWebSocketClient.connect(
          `ws://127.0.0.1:${startEdge.forwarderPort}/_ws/providers/${providerId}`,
          { headers: { Authorization: `Bearer ${INTERNAL_KEY}` }, signal },
        ),
      },
    });
  });
  return {
    server,
    port,
    close() {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

// A Codex-side client that records every frame and can await a given type.
async function connectCodex(edgePort) {
  const client = await ResponsesWebSocketClient.connect(
    `ws://127.0.0.1:${edgePort}/_codex-router/${CALLER_KEY}/v1/responses`,
    { headers: { Authorization: `Bearer ${CALLER_KEY}` } },
  );
  const frames = [];
  client.onJson = (value) => {
    frames.push(value);
  };
  let cursor = 0;
  return {
    client,
    frames,
    nextFrame(predicate = () => true, timeoutMs = 5_000) {
      const scanFrom = () => {
        const index = frames.findIndex(predicate, cursor);
        if (index !== -1) {
          cursor = index + 1;
          return frames[index];
        }
        return undefined;
      };
      const immediate = scanFrom();
      if (immediate) return Promise.resolve(immediate);
      return waitFor(() => Boolean(scanFrom()), timeoutMs).then(() => scanFrom());
    },
  };
}

function frameTypes(frames) {
  return frames.map((frame) => frame?.type);
}

test("an interrupt frame cancels the loopback turn without an error frame", async (t) => {
  let internalAborted = false;
  const edge = await startEdge({
    resolveRoute: () => undefined,
    internalResponses: (request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`event: response.created\ndata: ${JSON.stringify({
        type: "response.created",
        response: { id: "resp_hold", status: "in_progress" },
      })}\n\n`);
      // Hold the stream open; the interrupt must abort it.
      request.on("close", () => {
        internalAborted = true;
      });
    },
  });
  t.after(() => edge.close());
  const codex = await connectCodex(edge.port);
  t.after(() => codex.client.abort());

  await codex.client.sendJson({
    type: "response.create",
    model: "hold-model",
    input: [{ type: "message", role: "user", content: "hi" }],
    stream: true,
  });
   await codex.nextFrame((frame) => frame?.type === "response.created");
  await codex.client.sendJson({
    type: "response.interrupt",
    response_id: "resp_hold",
    discard_partial_items: false,
  });
  await codex.nextFrame((frame) => frame?.type === "response.cancelled");
  await waitFor(() => internalAborted);
  assert.equal(internalAborted, true);
  // No synthetic router error may follow the requested cancellation.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(
    frameTypes(codex.frames).includes("error"),
    false,
    `unexpected error frame: ${JSON.stringify(codex.frames.filter((f) => f?.type === "error"))}`,
  );

});

test("the socket stays usable for a normal turn after an interrupt", async (t) => {
  let holding = false;
  const completed = [];
  const edge = await startEdge({
    resolveRoute: () => undefined,
    internalResponses: (request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (!holding) {
        holding = true;
        response.write(`event: response.created\ndata: ${JSON.stringify({
          type: "response.created",
          response: { id: "resp_hold2", status: "in_progress" },
        })}\n\n`);
        return;
      }
      for (const event of [
        { type: "response.created", response: { id: "resp_done", status: "in_progress" } },
        { type: "response.completed", response: { id: "resp_done", status: "completed" } },
      ]) {
        response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      completed.push(true);
      response.end();
    },
  });
  t.after(() => edge.close());
  const codex = await connectCodex(edge.port);
  t.after(() => codex.client.abort());

  await codex.client.sendJson({
    type: "response.create",
    model: "hold-model",
    input: [{ type: "message", role: "user", content: "hold" }],
    stream: true,
  });
   await codex.nextFrame((frame) => frame?.type === "response.created");
  await codex.client.sendJson({ type: "response.interrupt", response_id: "resp_hold2" });
  await codex.nextFrame((frame) => frame?.type === "response.cancelled");

  await codex.client.sendJson({
    type: "response.create",
    model: "hold-model",
    input: [{ type: "message", role: "user", content: "next" }],
    stream: true,
  });
  const terminal = await codex.nextFrame((frame) =>
    frame?.type === "response.completed" || frame?.type === "error");
  assert.equal(terminal.type, "response.completed");
  assert.equal(completed.length, 1);
});

test("an interrupt during a relayed turn reaches the provider as a frame", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ws-interrupt-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  // A raw provider that streams created and holds the turn open.
  const received = [];
  const provider = http.createServer((request, response) => {
    response.writeHead(404).end();
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const providerPort = provider.address().port;
  const providerSockets = new Set();
  provider.on("upgrade", (request, socket, head) => {
    const accept = createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    if (head?.length) socket.emit("data", head);
    providerSockets.add(socket);
    // Post-teardown EPIPE arrives on the error event, not the write call.
    socket.on("error", () => {});
    socket.on("close", () => providerSockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : Buffer.from(chunk);
      // Client frames arrive masked and may use the extended-length forms.
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 0x0f;
        if (opcode !== 0x1) {
          buffer = buffer.subarray(buffer.length);
          return;
        }
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
        try {
          received.push(JSON.parse(payload.toString("utf8")));
        } catch {
          // Ignore non-JSON noise from the harness.
        }
      }
    });
    // Hold: emit created for any create frame; never complete.
    let holdStopped = false;
    const holdInterval = setInterval(() => {
      if (holdStopped) return;
      if (received.some((frame) => frame?.type === "response.interrupt")) {
        holdStopped = true;
        return;
      }
      const creates = received.filter((frame) => frame?.type === "response.create");
      if (creates.length && !socket.destroyed && socket.writable) {
        try {
          socket.write(unmaskedFrame(0x1, JSON.stringify({
            type: "response.created",
            response: { id: "resp_relay_hold", status: "in_progress" },
          })));
        } catch {
          // The interrupt tore the connection down mid-write.
        }
      }
    }, 50);
    socket.on("close", () => clearInterval(holdInterval));
  });
  t.after(() => {
    for (const socket of providerSockets) socket.destroy();
    provider.closeAllConnections();
    return new Promise((resolve) => provider.close(resolve));
  });

  const model = userModelEntry({ providerId: "mixed-ws", upstreamId: "gpt-hold", priority: 100 });
  writeFileSync(path.join(directory, "generic-providers.json"), JSON.stringify({
    version: 1,
    providers: [{
      id: "mixed-ws",
      displayName: "Hold Gateway",
      baseUrl: `http://127.0.0.1:${providerPort}/v1`,
      adapter: "openai-responses",
      transport: "websocket",
      allowPrivate: true,
      enabled: true,
    }],
  }));
  writeFileSync(path.join(directory, "user-models.json"), JSON.stringify({ version: 1, models: [model] }));

  const forwarderPort = await openPort();
  const forwarder = spawn(process.execPath, [path.join(root, "src", "api-forwarder.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_TARGET: "codex",
      MODEL_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
      MODEL_ROUTER_QUIET: "1",
      MODEL_ROUTER_API_PORT: String(forwarderPort),
      MODEL_ROUTER_STATE_DIR: path.join(directory, "state"),
      MODEL_ROUTER_GENERIC_PROVIDERS: path.join(directory, "generic-providers.json"),
      MODEL_ROUTER_USER_MODELS: path.join(directory, "user-models.json"),
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  t.after(() => {
    if (forwarder.exitCode !== null) return;
    forwarder.kill("SIGTERM");
    return new Promise((resolve) => forwarder.once("exit", resolve));
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${forwarderPort}/health`, {
        headers: { Authorization: `Bearer ${INTERNAL_KEY}` },
      });
      if (response.ok) break;
    } catch {
      // Not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const edge = await startEdge({
    resolveRoute: (requested) => (requested === "mixed-ws/gpt-hold" ? { providerId: "mixed-ws" } : undefined),
    internalResponses: (request, response) => {
      response.writeHead(500).end();
    },
  });
  t.after(() => edge.close());
  startEdge.forwarderPort = forwarderPort;

  const codex = await connectCodex(edge.port);
  t.after(() => codex.client.abort());

  await codex.client.sendJson({
    type: "response.create",
    model: "mixed-ws/gpt-hold",
    input: [{ type: "message", role: "user", content: "hold" }],
    stream: true,
  });
  await codex.nextFrame((frame) => frame?.type === "response.created");
  await codex.client.sendJson({
    type: "response.interrupt",
    response_id: "resp_relay_hold",
    discard_partial_items: true,
  });
  await codex.nextFrame((frame) => frame?.type === "response.cancelled");
  await waitFor(() => received.some((frame) => frame?.type === "response.interrupt"));
  const interrupt = received.find((frame) => frame?.type === "response.interrupt");
  assert.equal(interrupt.response_id, "resp_relay_hold");
  assert.equal(interrupt.discard_partial_items, true);
  // The requested cancellation never surfaces as a router error.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(frameTypes(codex.frames).includes("error"), false);
});
