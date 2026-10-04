// The forwarder's internal relay hop for the Responses WebSocket protocol.
//
// The router's WebSocket edge connects here when a downstream Codex frame's
// model resolves to a websocket-transport provider; each request frame is
// leased from that provider's pool and every upstream frame is relayed back
// verbatim. This hop carries the protocol itself, so an incremental
// `previous_response_id` turn crosses the whole chain as incremental input --
// no full-body reconstruction anywhere between Codex and the provider.
//
// The hop is deliberately stateless: continuation ids are the provider's own,
// and the 409 recovery contract is enforced at the edge, which is the only
// place that can rebuild a full request. A forwarder restart kills the pooled
// provider sockets, and the next turn's 409 is recovered the same way.

import { secretEqual } from "./caller-auth.mjs";
import {
  RESPONSES_WEBSOCKET_BETA,
  WebSocketFrameParser,
  acceptUpgrade,
  closePayload,
  encodeFrame,
  rejectUpgrade,
  validWebSocketKey,
} from "./ws-frames.mjs";
import { sendFrameCollectFrames } from "./responses-ws-client.mjs";

const MAX_FRAME_BYTES = 128 * 1024 * 1024;
const RELAY_ROUTE = /^\/_ws\/providers\/([a-z0-9][a-z0-9._-]{1,127})$/;

function requestHasBeta(request) {
  return String(request.headers["openai-beta"] || "")
    .split(",")
    .map((value) => value.trim())
    .includes(RESPONSES_WEBSOCKET_BETA);
}

function bearerMatches(request, key) {
  const value = String(request.headers.authorization || "");
  const [scheme, ...rest] = value.trim().split(/[ \t]+/);
  return (
    scheme?.toLowerCase() === "bearer" &&
    rest.length === 1 &&
    typeof key === "string" &&
    key.length > 0 &&
    secretEqual(rest[0], key)
  );
}

export function handleProviderRelayUpgrade(request, socket, head, {
  internalKey,
  // poolFor(providerId) -> { acquire(signal) } | undefined
  poolFor,
}) {
  if (socket.destroyed) return;
  let requestUrl;
  try {
    requestUrl = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
  } catch {
    rejectUpgrade(socket, 400, "Invalid relay request URL.");
    return;
  }
  const match = RELAY_ROUTE.exec(requestUrl.pathname);
  if (!match) {
    rejectUpgrade(socket, 404, "Unsupported relay WebSocket route.");
    return;
  }
  if (!bearerMatches(request, internalKey)) {
    rejectUpgrade(socket, 401, "This relay hop requires its configured internal authentication.");
    return;
  }
  if (request.headers.origin || request.headers["sec-fetch-site"]) {
    rejectUpgrade(socket, 403, "Browser-originated WebSocket requests are not accepted.");
    return;
  }
  if (
    request.method !== "GET" ||
    String(request.headers.upgrade || "").toLowerCase() !== "websocket" ||
    !String(request.headers.connection || "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .includes("upgrade") ||
    request.headers["sec-websocket-version"] !== "13" ||
    !validWebSocketKey(request.headers["sec-websocket-key"])
  ) {
    rejectUpgrade(socket, 426, "A valid RFC 6455 WebSocket upgrade is required.", {
      "Sec-WebSocket-Version": "13",
    });
    return;
  }
  if (!requestHasBeta(request)) {
    rejectUpgrade(socket, 426, "This relay hop speaks the Responses WebSocket contract.", {
      "OpenAI-Beta": RESPONSES_WEBSOCKET_BETA,
    });
    return;
  }
  const pool = poolFor(match[1]);
  if (!pool) {
    rejectUpgrade(socket, 404, "No websocket-transport provider with that id.");
    return;
  }
  acceptUpgrade(request, socket);
  startRelayPeer({ socket, head, pool });
}

function startRelayPeer({ socket, head, pool }) {
  // The masked side faces the router edge; the pool's upstream connections
  // are the unmasked side handled by ResponsesWebSocketClient.
  let closed = false;
  let closeSent = false;
  let inFlight = undefined;
  const controller = new AbortController();
  const finish = () => {
    if (closed) return;
    closed = true;
    parser.stop();
    controller.abort(new Error("relay downstream closed"));
    socket.destroy();
  };
  const send = (opcode, payload) => {
    if (closed || socket.destroyed || !socket.writable) return false;
    return socket.write(encodeFrame(opcode, payload));
  };
  const sendJson = (value) => send(0x1, Buffer.from(JSON.stringify(value), "utf8"));
  const fail = (code, reason) => {
    if (closed) return;
    if (!closeSent) {
      closeSent = true;
      send(0x8, closePayload(code, reason));
    }
    socket.end();
    finish();
  };
  const parser = new WebSocketFrameParser({
    expectMasked: true,
    maxMessageBytes: MAX_FRAME_BYTES,
    onText: (text) => {
      // One frame at a time, the same contract the public edge enforces.
      if (inFlight) {
        fail(1008, "A relay request is already in flight.");
        return;
      }
      let frame;
      try {
        frame = JSON.parse(text);
      } catch {
        sendJson({
          type: "error",
          status: 400,
          error: { type: "invalid_request_error", message: "Relay frames must be valid JSON." },
        });
        return;
      }
      if (frame?.type !== "response.create") {
        sendJson({
          type: "error",
          status: 400,
          error: {
            type: "invalid_request_error",
            message: "Relay frames must have type response.create.",
          },
        });
        return;
      }
      inFlight = relayFrame(frame).finally(() => {
        inFlight = undefined;
      });
    },
    onBinary: () => fail(1003, "Binary relay frames are not supported."),
    onPing: (payload) => send(0xa, payload),
    onPong: () => {},
    onClose: ({ code, reason }) => {
      if (!closeSent) {
        closeSent = true;
        send(0x8, code === undefined ? Buffer.alloc(0) : closePayload(code, reason));
      }
      socket.end();
      finish();
    },
    onFail: (code, reason) => fail(code, reason),
  });
  socket.on("data", (chunk) => parser.feed(chunk));
  socket.on("error", () => finish());
  socket.on("close", () => finish());
  socket.on("end", () => finish());
  if (head?.length) parser.feed(head);
  socket.resume?.();

  async function relayFrame(frame) {
    let lease;
    try {
      lease = await pool.acquire(controller.signal);
    } catch (error) {
      sendJson({
        type: "error",
        status: 503,
        error: {
          type: "local_router_error",
          message: "The provider WebSocket pool could not serve the relay request.",
        },
      });
      return;
    }
    try {
      await sendFrameCollectFrames(lease.connection, frame, {
        signal: controller.signal,
        onFrame: (value) => sendJson(value),
      });
    } catch {
      // The upstream leg died mid-relay. The downstream socket stays usable:
      // the edge sees a synthesized 502 and its next full turn reopens.
      lease.connection.abort();
      sendJson({
        type: "error",
        status: 502,
        error: {
          type: "local_router_stream_failed",
          message: "The provider WebSocket stream ended before response.completed.",
        },
      });
    } finally {
      lease.release();
    }
  }
}
