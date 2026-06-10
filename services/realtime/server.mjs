#!/usr/bin/env node
/**
 * Self-hosted realtime gateway — replaces Supabase Broadcast.
 *
 *   node --env-file=.env.local services/realtime/server.mjs
 *
 * A single long-lived Postgres connection LISTENs on the `election_events`
 * channel. API routes emit events with pg_notify (see lib/realtime.js) inside
 * their transaction, so a NOTIFY fires only when the DB change commits. Each
 * notification carries { electionId, event, data }; the gateway fans it out
 * over WebSocket to every client subscribed to that election's room.
 *
 * Protocol (JSON text frames):
 *   client → { type:'subscribe', election:'<uuid>' } | { type:'ping' }
 *   server → { type:'subscribed', election } | { type:'event', event, data } | { type:'pong' }
 *
 * Also serves GET /health for ops checks.
 */
import http from "node:http";
import { WebSocketServer } from "ws";
import pg from "pg";

const PORT = Number(process.env.REALTIME_PORT || 3001);
const PG_URL =
  process.env.APP_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgres://app:app_local_dev@localhost:5432/elections";
const NOTIFY_CHANNEL = "election_events";

/** electionId -> Set<WebSocket> */
const rooms = new Map();

function joinRoom(electionId, ws) {
  if (ws._room) leaveRoom(ws);
  let set = rooms.get(electionId);
  if (!set) rooms.set(electionId, (set = new Set()));
  set.add(ws);
  ws._room = electionId;
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

function fanout(electionId, event, data) {
  const set = rooms.get(electionId);
  if (!set || set.size === 0) return 0;
  const frame = JSON.stringify({ type: "event", event, data });
  let sent = 0;
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) {
      ws.send(frame);
      sent++;
    }
  }
  return sent;
}

// ── Postgres LISTEN with auto-reconnect ──
let listenClient;
async function startListener() {
  listenClient = new pg.Client({ connectionString: PG_URL });
  listenClient.on("error", (err) => {
    console.error("[realtime] pg listen error:", err.message);
    setTimeout(retryListener, 1000);
  });
  listenClient.on("notification", (msg) => {
    if (msg.channel !== NOTIFY_CHANNEL || !msg.payload) return;
    let parsed;
    try {
      parsed = JSON.parse(msg.payload);
    } catch {
      console.error("[realtime] bad notify payload:", msg.payload);
      return;
    }
    const { electionId, event, data } = parsed || {};
    if (!electionId || !event) return;
    fanout(electionId, event, data);
  });
  await listenClient.connect();
  await listenClient.query(`LISTEN ${NOTIFY_CHANNEL}`);
  console.log(`[realtime] LISTEN ${NOTIFY_CHANNEL} on ${PG_URL.replace(/:[^:@/]+@/, ":***@")}`);
}

let retrying = false;
async function retryListener() {
  if (retrying) return;
  retrying = true;
  try {
    try {
      await listenClient?.end();
    } catch {
      /* ignore */
    }
    await startListener();
  } catch (err) {
    console.error("[realtime] reconnect failed, retrying:", err.message);
    setTimeout(retryListener, 2000);
  } finally {
    retrying = false;
  }
}

// ── HTTP + WebSocket server ──
const httpServer = http.createServer((req, res) => {
  if (req.method === "GET" && req.url.startsWith("/health")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "subscribe" && typeof msg.election === "string") {
      joinRoom(msg.election, ws);
      ws.send(JSON.stringify({ type: "subscribed", election: msg.election }));
    } else if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
    }
  });
  ws.on("close", () => leaveRoom(ws));
  ws.on("error", () => leaveRoom(ws));
});

// Heartbeat: drop dead sockets every 30s.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      leaveRoom(ws);
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);

function shutdown() {
  clearInterval(heartbeat);
  wss.close();
  httpServer.close();
  listenClient?.end().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

startListener()
  .then(() => {
    httpServer.listen(PORT, () => console.log(`[realtime] gateway on :${PORT}`));
  })
  .catch((err) => {
    console.error("[realtime] failed to start:", err);
    process.exit(1);
  });
