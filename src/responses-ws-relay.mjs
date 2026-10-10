// The forwarder's internal relay hop for the Responses WebSocket protocol.
//
// The router's WebSocket edge connects here when a downstream Codex frame's
// model belongs to a websocket-transport provider, so an incremental
// `previous_response_id` turn can cross the chain without a full-body
// reconstruction on every hop.
//
// Two invariants distinguish this from a naive frame pipe, both inherited from
// the transport review that rejected the first relay attempt:
//
// 1. **No frame bypasses the canonical pipeline.** Every `response.create` is
//    normalized exactly like the HTTP path -- model id translation, endpoint
//    policy, effort ladders, tool repair, image handling, identity stripping
//    -- before it reaches the provider. `previous_response_id` is the one
//    field normalization does not own; it passes through untouched so the
//    incremental contract survives.
// 2. **Continuation affinity is connection-local and honored.** The provider
//    keys continuation state per connection, so a hop holds ONE pooled
//    connection for its lifetime -- the connection that produced a response
//    id is the connection asked to continue it. A connection that dies
//    releases the lease; the next turn reopens fresh and the provider's 409
//    makes the client retry the full request, per the documented contract.
//    An unresolved `previous_response_id` is never sprayed across arbitrary
//    pooled connections.

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
  // poolFor(providerId, requestPath) -> { acquire(signal) } | undefined
  poolFor,
  // normalizeFrame(rawFrame) -> Promise<frame> -- the canonical pipeline,
  // injected so this module stays free of registry imports.
  normalizeFrame,
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
  // poolFor resolves the provider's confined target (and its pool identity),
  // so it is async on the forwarder side; a missing websocket-transport
  // provider answers 404 before the upgrade completes.
  Promise.resolve()
    .then(() => poolFor(match[1]))
    .then((pool) => {
      if (socket.destroyed) return;
      if (!pool) {
        rejectUpgrade(socket, 404, "No websocket-transport provider with that id.");
        return;
      }
      acceptUpgrade(request, socket);
      startRelayPeer({ socket, head, pool, normalizeFrame });
    })
    .catch(() => {
      if (!socket.destroyed) rejectUpgrade(socket, 503, "The relay hop could not resolve the provider.");
    });
}

function startRelayPeer({ socket, head, pool, normalizeFrame }) {
  // The masked side faces the router edge; the sticky upstream connection is
  // the unmasked side handled by ResponsesWebSocketClient.
  let closed = false;
  let closeSent = false;
  let inFlight = undefined;
  // Affinity: one leased connection for the hop's lifetime.
  let lease = undefined;
  const controller = new AbortController();
  const finish = () => {
    if (closed) return;
    closed = true;
    parser.stop();
    controller.abort(new Error("relay downstream closed"));
    socket.destroy();
    dropLease(false);
  };
  const dropLease = (poison) => {
    if (!lease) return;
    const held = lease;
    lease = undefined;
    if (poison) held.connection.abort();
    held.release();
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
  const sendErrorFrame = (status, error) => {
    sendJson({ type: "error", status, error });
  };
  const parser = new WebSocketFrameParser({
    expectMasked: true,
    maxMessageBytes: MAX_FRAME_BYTES,
    onText: (text) => {
      let frame;
      try {
        frame = JSON.parse(text);
      } catch {
        sendErrorFrame(400, {
          type: "invalid_request_error",
          message: "Relay frames must be valid JSON.",
        });
        return;
      }
      // Control frames act on the live connection and never queue.
      if (frame?.type === "response.interrupt") {
        if (lease && !lease.connection.closed) {
          void lease.connection.sendJson({
            type: "response.interrupt",
            ...(typeof frame.response_id === "string" && frame.response_id
              ? { response_id: frame.response_id }
              : {}),
            ...(typeof frame.discard_partial_items === "boolean"
              ? { discard_partial_items: frame.discard_partial_items }
              : {}),
          }).catch(() => {});
        }
        return;
      }
      if (frame?.type !== "response.create") {
        sendErrorFrame(400, {
          type: "invalid_request_error",
          message: "Relay frames must have type response.create.",
        });
        return;
      }
      if (inFlight) {
        fail(1008, "A relay request is already in flight.");
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
    // Canonical pipeline first: id translation, endpoint policy, effort and
    // tool repair, image handling. previous_response_id passes through.
    let normalized;
    try {
      normalized = await normalizeFrame(frame);
    } catch (error) {
      sendErrorFrame(Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
        ? error.status
        : 400, {
        type: error?.type || "invalid_request_error",
        ...(error?.code ? { code: String(error.code) } : {}),
        message: error?.message || "The relay request was rejected before the provider.",
      });
      return;
    }
    if (!lease || lease.connection.closed) {
      try {
        lease = await pool.acquire(controller.signal);
      } catch {
        sendErrorFrame(503, {
          type: "local_router_error",
          message: "The provider WebSocket pool could not serve the relay request.",
        });
        return;
      }
    }
    try {
      await sendFrameCollectFrames(lease.connection, normalized, {
        signal: controller.signal,
        onFrame: (value) => sendJson(value),
      });
    } catch {
      // The frame already left for the provider; a retry here could run the
      // turn twice. Surface 502, drop the sticky lease (its continuation
      // state is gone with the connection), and let the client's documented
      // full-request recovery handle the next turn on a fresh connection.
      dropLease(true);
      sendErrorFrame(502, {
        type: "local_router_stream_failed",
        message: "The provider WebSocket stream ended before response.completed.",
      });
    }
  }
}
