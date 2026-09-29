/**
 * Realtime gateway internals, split from server.mjs so tests can run them
 * against a fake Postgres client.
 *
 * createListener() keeps one Postgres connection LISTENing on the
 * election_events channel. It reconnects with backoff when that connection
 * errors, ends, or fails a periodic health query, and reports each change of
 * liveness so the gateway can tell clients to refetch whatever they missed.
 *
 * createGateway() is the HTTP + WebSocket side. Every client is anonymous
 * until it subscribes, so the gateway limits what one can cost: small frames
 * only, an Origin allowlist, connection caps per IP and overall, a frame rate
 * limit, a deadline to subscribe, and a signed ticket when required.
 *
 * Protocol (JSON text frames):
 *   client -> { type:'subscribe', election:'<uuid>', ticket?:'<signed ticket>' }
 *           | { type:'ping' }
 *   server -> { type:'subscribed', election, live }
 *           | { type:'event', event, data }        event 'resync' means refetch
 *           | { type:'status', live }              live=false: events may be lost
 *           | { type:'pong', live }
 *           | { type:'error', code }
 */
import http from "node:http";
import { WebSocketServer } from "ws";
import { NOTIFY_CHANNEL, verifyTicket } from "../../lib/realtime.js";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DEFAULTS = Object.freeze({
  maxPayload: 4096,
  // Voters at one venue often share a single public IP behind the venue's
  // NAT, so the per-IP cap has to be well above the size of a large meeting.
  maxConnectionsPerIp: 500,
  maxConnections: 20_000,
  subscribeTimeoutMs: 10_000,
  heartbeatMs: 30_000,
  rateWindowMs: 10_000,
  maxFramesPerWindow: 30,
});

/** Close codes the client understands. */
export const CLOSE = Object.freeze({
  BAD_FRAME: 1008,
  UNSUPPORTED: 1003,
  SHUTDOWN: 1001,
  BAD_TICKET: 4401,
  SUBSCRIBE_TIMEOUT: 4408,
  RATE_LIMIT: 4429,
});

/** "https://a.example, https://b.example" -> Set, or null when empty. */
export function parseOrigins(value) {
  if (!value) return null;
  const list = String(value)
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, "").toLowerCase())
    .filter(Boolean);
  return list.length ? new Set(list) : null;
}

/**
 * Browsers always send Origin on a WebSocket handshake, so a browser page on
 * another site is rejected here. A client with no Origin is not a browser and
 * could send any Origin it liked, so the check does not apply to it; tickets
 * cover that case.
 */
export function originAllowed(origin, allowed) {
  if (!allowed) return true;
  if (!origin) return true;
  return allowed.has(String(origin).replace(/\/+$/, "").toLowerCase());
}

/** The client's IP. With trustProxy, the last X-Forwarded-For hop (added by our proxy). */
export function clientIp(req, trustProxy = false) {
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff.trim()) {
      const hops = xff.split(",").map((s) => s.trim()).filter(Boolean);
      if (hops.length) return hops[hops.length - 1];
    }
  }
  return req.socket?.remoteAddress || "unknown";
}

/**
 * Parses one client frame. Returns a normalised message or { error }.
 * The election id is validated and lowercased, so nothing unvalidated is
 * stored or echoed back.
 */
export function parseClientFrame(raw) {
  let msg;
  try {
    msg = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
  } catch {
    return { error: "invalid JSON" };
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return { error: "invalid frame" };
  if (msg.type === "ping") return { type: "ping" };
  if (msg.type === "subscribe") {
    if (typeof msg.election !== "string" || !UUID_RE.test(msg.election)) {
      return { error: "invalid election id" };
    }
    if (msg.ticket !== undefined && msg.ticket !== null && typeof msg.ticket !== "string") {
      return { error: "invalid ticket" };
    }
    return { type: "subscribe", election: msg.election.toLowerCase(), ticket: msg.ticket || null };
  }
  return { error: "unknown frame type" };
}

/* ───────────────────────── Postgres LISTEN ───────────────────────── */

/**
 * createClient: () => pg.Client-like (connect, query, end, on).
 * onPayload(payloadString): called for each NOTIFY on the channel.
 * onLiveChange(live, { first }): called when LISTEN comes up or goes down.
 *   first is true only for the first time it comes up.
 */
export function createListener({
  createClient,
  channel = NOTIFY_CHANNEL,
  onPayload,
  onLiveChange,
  log = console,
  healthIntervalMs = 30_000,
  healthTimeoutMs = 5_000,
  minRetryMs = 1_000,
  maxRetryMs = 10_000,
}) {
  let current = null; // { client, dead }
  let live = false;
  let everLive = false;
  let stopped = false;
  let retryTimer = null;
  let healthTimer = null;
  let backoff = minRetryMs;
  let firstAttempt = null; // { resolve, reject } while start() is pending

  function setLive(value) {
    if (live === value) return;
    live = value;
    const first = value && !everLive;
    if (value) everLive = true;
    try {
      onLiveChange?.(value, { first });
    } catch (err) {
      log.error("[realtime] onLiveChange threw:", err);
    }
  }

  function scheduleRetry() {
    if (stopped || retryTimer) return;
    const delay = backoff;
    backoff = Math.min(backoff * 2, maxRetryMs);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay);
    retryTimer.unref?.();
  }

  function markDead(conn, err) {
    if (conn.dead) return;
    conn.dead = true;
    if (current === conn) {
      current = null;
      clearInterval(healthTimer);
      healthTimer = null;
    }
    if (!stopped) log.error("[realtime] LISTEN connection lost:", err?.message || err);
    Promise.resolve()
      .then(() => conn.client.end())
      .catch(() => {});
    setLive(false);
    if (firstAttempt) {
      const p = firstAttempt;
      firstAttempt = null;
      p.reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    scheduleRetry();
  }

  async function healthCheck(conn) {
    if (conn.dead) return;
    let timer;
    try {
      await Promise.race([
        conn.client.query("SELECT 1"),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("health query timed out")), healthTimeoutMs);
        }),
      ]);
    } catch (err) {
      markDead(conn, err);
    } finally {
      clearTimeout(timer);
    }
  }

  async function connect() {
    if (stopped) return;
    const client = createClient();
    const conn = { client, dead: false };
    current = conn;
    // Keep an error listener attached for the client's whole life: pg throws
    // on an unhandled 'error' event, which would crash the gateway.
    client.on("error", (err) => markDead(conn, err));
    client.on("end", () => markDead(conn, new Error("connection ended")));
    client.on("notification", (msg) => {
      if (conn.dead || msg.channel !== channel || !msg.payload) return;
      try {
        onPayload(msg.payload);
      } catch (err) {
        log.error("[realtime] onPayload threw:", err);
      }
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${channel}`);
    } catch (err) {
      markDead(conn, err);
      return;
    }
    if (conn.dead || stopped) {
      client.end().catch(() => {});
      return;
    }
    backoff = minRetryMs;
    healthTimer = setInterval(() => healthCheck(conn), healthIntervalMs);
    healthTimer.unref?.();
    setLive(true);
    if (firstAttempt) {
      const p = firstAttempt;
      firstAttempt = null;
      p.resolve();
    }
  }

  return {
    /** Connects once. Rejects if that first attempt fails; later drops retry forever. */
    start() {
      return new Promise((resolve, reject) => {
        firstAttempt = { resolve, reject };
        connect();
      });
    },
    get live() {
      return live;
    },
    /** For tests and ops: drop the current connection as if it had failed. */
    kill(reason = "killed") {
      if (current) markDead(current, new Error(reason));
    },
    async stop() {
      stopped = true;
      clearTimeout(retryTimer);
      clearInterval(healthTimer);
      const conn = current;
      current = null;
      if (conn) {
        conn.dead = true;
        await conn.client.end().catch(() => {});
      }
      live = false;
    },
  };
}

/* ───────────────────────── HTTP + WebSocket ───────────────────────── */

export function createGateway({
  allowedOrigins = null,
  requireTicket = false,
  secret,
  trustProxy = false,
  isLive = () => true,
  log = console,
  ...limits
} = {}) {
  const opts = { ...DEFAULTS, ...limits };
  /** electionId -> Set<WebSocket> */
  const rooms = new Map();
  const perIp = new Map();
  let total = 0;

  function joinRoom(ws, electionId, scope) {
    if (ws._room && ws._room !== electionId) leaveRoom(ws);
    let set = rooms.get(electionId);
    if (!set) rooms.set(electionId, (set = new Set()));
    set.add(ws);
    ws._room = electionId;
    ws._scope = scope;
  }

  function leaveRoom(ws) {
    const id = ws._room;
    if (!id) return;
    const set = rooms.get(id);
    if (set) {
      set.delete(ws);
      if (set.size === 0) rooms.delete(id);
    }
    ws._room = null;
  }

  function send(ws, obj) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }

  function fanout(electionId, event, data, audience = "all") {
    const set = rooms.get(String(electionId).toLowerCase());
    if (!set || set.size === 0) return 0;
    const frame = JSON.stringify({ type: "event", event, data: data ?? null });
    let sent = 0;
    for (const ws of set) {
      if (audience === "admin" && ws._scope !== "admin") continue;
      if (ws.readyState === ws.OPEN) {
        ws.send(frame);
        sent++;
      }
    }
    return sent;
  }

  /** Sends one frame to every subscribed socket in every room. */
  function broadcastAll(obj) {
    const frame = JSON.stringify(obj);
    let sent = 0;
    for (const set of rooms.values()) {
      for (const ws of set) {
        if (ws.readyState === ws.OPEN) {
          ws.send(frame);
          sent++;
        }
      }
    }
    return sent;
  }

  /** Relays one NOTIFY payload from Postgres. */
  function handleNotify(payload) {
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      log.error("[realtime] bad notify payload");
      return 0;
    }
    const { electionId, event, data, audience } = parsed || {};
    if (typeof electionId !== "string" || typeof event !== "string") return 0;
    return fanout(electionId, event, data, audience === "admin" ? "admin" : "all");
  }

  /**
   * Called when LISTEN goes down or comes back. Events sent while it was down
   * are gone, so on recovery every client is told to refetch.
   */
  function handleLiveChange(live, { first = false } = {}) {
    broadcastAll({ type: "status", live });
    if (live && !first) broadcastAll({ type: "event", event: "resync", data: null });
  }

  const httpServer = http.createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/health" || req.url?.startsWith("/health?"))) {
      const live = isLive();
      res.writeHead(live ? 200 : 503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: live, live, rooms: rooms.size, connections: total }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: opts.maxPayload });

  function reject(socket, status, text) {
    try {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    } catch {
      /* ignore */
    }
    socket.destroy();
  }

  httpServer.on("upgrade", (req, socket, head) => {
    socket.on("error", () => {});
    if (!originAllowed(req.headers.origin, allowedOrigins)) {
      log.warn?.(`[realtime] rejected origin ${String(req.headers.origin).slice(0, 100)}`);
      return reject(socket, 403, "Forbidden");
    }
    const ip = clientIp(req, trustProxy);
    if (total >= opts.maxConnections) return reject(socket, 503, "Service Unavailable");
    if ((perIp.get(ip) || 0) >= opts.maxConnectionsPerIp) return reject(socket, 429, "Too Many Requests");
    // Count the TCP socket, not the WebSocket, so a failed handshake releases its slot too.
    total++;
    perIp.set(ip, (perIp.get(ip) || 0) + 1);
    socket.once("close", () => {
      total--;
      const n = (perIp.get(ip) || 1) - 1;
      if (n <= 0) perIp.delete(ip);
      else perIp.set(ip, n);
    });
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws) => {
    ws.isAlive = true;
    ws._room = null;
    ws._scope = null;
    let windowStart = Date.now();
    let frames = 0;

    const subscribeTimer = setTimeout(() => {
      if (!ws._room) ws.close(CLOSE.SUBSCRIBE_TIMEOUT, "subscribe timeout");
    }, opts.subscribeTimeoutMs);
    subscribeTimer.unref?.();

    ws.on("pong", () => {
      ws.isAlive = true;
    });

    ws.on("message", (raw, isBinary) => {
      const now = Date.now();
      if (now - windowStart > opts.rateWindowMs) {
        windowStart = now;
        frames = 0;
      }
      if (++frames > opts.maxFramesPerWindow) return ws.close(CLOSE.RATE_LIMIT, "rate limit");
      if (isBinary) return ws.close(CLOSE.UNSUPPORTED, "text frames only");

      const msg = parseClientFrame(raw);
      if (msg.error) return ws.close(CLOSE.BAD_FRAME, msg.error);

      if (msg.type === "ping") {
        ws.isAlive = true;
        return send(ws, { type: "pong", live: isLive() });
      }

      // subscribe
      let scope = "voter";
      if (requireTicket || msg.ticket) {
        const claims = msg.ticket ? verifyTicket(msg.ticket, secret) : null;
        if (!claims || claims.electionId !== msg.election) {
          send(ws, { type: "error", code: msg.ticket ? "bad_ticket" : "ticket_required" });
          return ws.close(CLOSE.BAD_TICKET, "invalid ticket");
        }
        scope = claims.scope;
      }
      joinRoom(ws, msg.election, scope);
      clearTimeout(subscribeTimer);
      send(ws, { type: "subscribed", election: msg.election, live: isLive() });
    });

    ws.on("close", () => {
      clearTimeout(subscribeTimer);
      leaveRoom(ws);
    });
    ws.on("error", () => leaveRoom(ws));
  });

  // Protocol-level ping; drops sockets whose peer has gone away.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        leaveRoom(ws);
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* closed */
      }
    }
  }, opts.heartbeatMs);
  heartbeat.unref?.();

  return {
    httpServer,
    wss,
    fanout,
    handleNotify,
    handleLiveChange,
    stats: () => ({ rooms: rooms.size, connections: total, perIp: new Map(perIp) }),
    listen(port, host) {
      return new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, host, () => {
          httpServer.off("error", reject);
          resolve(httpServer.address().port);
        });
      });
    },
    close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) {
        try {
          ws.close(CLOSE.SHUTDOWN, "server shutting down");
        } catch {
          /* ignore */
        }
      }
      wss.close();
      return new Promise((resolve) => {
        httpServer.close(() => resolve());
        httpServer.closeAllConnections?.();
      });
    },
  };
}
