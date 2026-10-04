// Connection lifecycle for upstream Responses WebSocket transports.
//
// The wire protocol allows no multiplexing: one connection carries one
// in-flight request at a time (the peer enforces this with a queue cap of 2
// and strict ordering). A pool therefore leases whole connections, and the
// lease IS the concurrency unit -- a second concurrent turn opens a second
// connection rather than interleaving frames on the first.

import { ResponsesWebSocketClient } from "./responses-ws-client.mjs";

const DEFAULT_MAX_CONNECTIONS = 4;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_EVICT_MS = 120_000;

class Lease {
  constructor(connection, release) {
    this.connection = connection;
    this.released = false;
    this.release = () => {
      if (this.released) return;
      this.released = true;
      release(connection);
    };
  }
}

export class ProviderWebSocketPool {
  // `connect()` opens one ResponsesWebSocketClient; `healthy(connection)` is
  // consulted after each release so a pool can discard a connection whose
  // turn failed mid-stream instead of handing it to the next waiter.
  constructor({
    connect,
    healthy = (connection) => !connection.closed,
    maxConnections = DEFAULT_MAX_CONNECTIONS,
    acquireTimeoutMs = DEFAULT_ACQUIRE_TIMEOUT_MS,
    idleEvictMs = DEFAULT_IDLE_EVICT_MS,
    now = Date.now,
  } = {}) {
    this.connect = connect;
    this.healthy = healthy;
    this.maxConnections = maxConnections;
    this.acquireTimeoutMs = acquireTimeoutMs;
    this.idleEvictMs = idleEvictMs;
    this.now = now;
    this.idle = [];
    this.leased = new Set();
    this.opening = 0;
    this.waiters = [];
    this.closed = false;
    this.evictTimer = undefined;
  }

  scheduleEviction() {
    if (this.evictTimer || this.idleEvictMs === Infinity) return;
    this.evictTimer = setTimeout(() => {
      this.evictTimer = undefined;
      const threshold = this.now() - this.idleEvictMs;
      while (this.idle.length && this.idle[0].idleSince <= threshold) {
        const { connection } = this.idle.shift();
        connection.close(1000, "idle");
      }
      if (this.idle.length || this.leased.size) this.scheduleEviction();
    }, this.idleEvictMs);
    this.evictTimer.unref?.();
  }

  async acquire(signal) {
    if (this.closed) throw new Error("Provider WebSocket pool is closed.");
    while (this.idle.length) {
      const entry = this.idle.shift();
      const connection = entry.connection;
      if (this.healthy(connection)) {
        connection.idleRef(false);
        this.leased.add(connection);
        return new Lease(connection, (released) => this.release(released));
      }
      connection.close(1000, "unhealthy");
    }
    if (this.leased.size + this.opening < this.maxConnections) {
      this.opening += 1;
      let connection;
      try {
        connection = await this.connect(signal);
      } finally {
        this.opening -= 1;
      }
      this.leased.add(connection);
      this.pumpWaiters();
      return new Lease(connection, (released) => this.release(released));
    }
    // At capacity: wait for a release, or fail over to HTTP rather than
    // queueing a turn behind an unbounded line of Codex requests.
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        const error = new Error("Provider WebSocket pool is at capacity.");
        error.fallbackToHttp = true;
        reject(error);
      }, this.acquireTimeoutMs);
      timer.unref?.();
      const waiter = {
        resolve: (connection) => {
          clearTimeout(timer);
          resolve(new Lease(connection, (released) => this.release(released)));
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.waiters.push(waiter);
    });
  }

  pumpWaiters() {
    while (this.waiters.length && this.idle.length) {
      const entry = this.idle.shift();
      if (!this.healthy(entry.connection)) {
        entry.connection.close(1000, "unhealthy");
        continue;
      }
      const waiter = this.waiters.shift();
      entry.connection.idleRef(false);
      this.leased.add(entry.connection);
      waiter.resolve(entry.connection);
    }
  }

  release(connection) {
    this.leased.delete(connection);
    if (this.closed || !this.healthy(connection)) {
      connection.close(1000, this.closed ? "pool closed" : "unhealthy");
      this.pumpWaiters();
      return;
    }
    connection.idleRef(true);
    this.idle.push({ connection, idleSince: this.now() });
    this.scheduleEviction();
    this.pumpWaiters();
  }

  closeAll() {
    this.closed = true;
    clearTimeout(this.evictTimer);
    this.evictTimer = undefined;
    for (const { connection } of this.idle) connection.close(1000, "pool closed");
    this.idle = [];
    for (const connection of this.leased) connection.abort();
    this.leased.clear();
    for (const waiter of this.waiters.splice(0)) {
      const error = new Error("Provider WebSocket pool closed.");
      error.fallbackToHttp = true;
      waiter.reject(error);
    }
  }
}

const registry = new Map();

// One pool per provider id, created lazily by the forwarder. `resolveProvider`
// returns `{ wsTarget: async (signal) => { url, headers, lookup } }` so the
// target is re-resolved per connection: descriptor edits and credential
// rotation take effect on the next connection, not the next process.
export function providerPoolRegistry({ resolveProvider }) {
  return {
    poolFor(providerId) {
      const existing = registry.get(providerId);
      if (existing) return existing;
      const provider = resolveProvider(providerId);
      if (!provider) return undefined;
      const pool = new ProviderWebSocketPool({
        connect: async (signal) => {
          const target = await provider.wsTarget(signal);
          return ResponsesWebSocketClient.connect(target.url, {
            headers: target.headers,
            signal,
            lookup: target.lookup,
          });
        },
      });
      registry.set(providerId, pool);
      return pool;
    },
    closeAll() {
      for (const pool of registry.values()) pool.closeAll();
      registry.clear();
    },
  };
}
