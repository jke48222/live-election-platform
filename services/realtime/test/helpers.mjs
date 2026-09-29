import { EventEmitter } from "node:events";
import { WebSocket } from "ws";

/** A stand-in for pg.Client that the tests can break on demand. */
export class FakePgClient extends EventEmitter {
  constructor({ failConnect = false, hangQueries = false } = {}) {
    super();
    this.failConnect = failConnect;
    this.hangQueries = hangQueries;
    this.ended = false;
    this.queries = [];
  }
  async connect() {
    if (this.failConnect) throw new Error("connect refused");
  }
  query(text) {
    this.queries.push(text);
    if (this.hangQueries && text === "SELECT 1") return new Promise(() => {});
    return Promise.resolve({ rows: [] });
  }
  async end() {
    if (this.ended) return;
    this.ended = true;
    setImmediate(() => this.emit("end"));
  }
  notify(payload, channel = "election_events") {
    this.emit("notification", { channel, payload: typeof payload === "string" ? payload : JSON.stringify(payload) });
  }
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(fn, { timeout = 2000, step = 10 } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error("condition not met in time");
    await wait(step);
  }
}

/** Opens a ws client and records every frame and the close code. */
export function openClient(url, options) {
  const ws = new WebSocket(url, options);
  const frames = [];
  const state = { ws, frames, closeCode: null, unexpected: null };
  ws.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
  ws.on("close", (code) => {
    state.closeCode = code;
  });
  ws.on("error", () => {});
  state.opened = new Promise((resolve) => {
    ws.on("open", () => resolve(true));
    ws.on("close", () => resolve(false));
    // With this listener attached, ws leaves the failed handshake to us.
    ws.on("unexpected-response", (req, res) => {
      state.unexpected = res.statusCode;
      req.destroy();
      resolve(false);
    });
  });
  state.send = (obj) => ws.send(typeof obj === "string" ? obj : JSON.stringify(obj));
  return state;
}
