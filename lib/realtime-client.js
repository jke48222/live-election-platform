/**
 * Browser realtime client. Connects to the self-hosted gateway, subscribes to
 * one election's room, and calls handlers on each event.
 *
 *   const conn = connectElection(electionId, {
 *     onEvent: (event, data) => { ... },   // 'state_change' | 'purge' | 'resync' | ...
 *     onStatus: (status) => { ... },       // 'reconnecting' | 'open' | 'degraded' | 'closed'
 *     onSync: (reason) => { ... },         // refetch state over REST now
 *     getTicket: async () => ticket,       // optional signed subscribe ticket
 *   });
 *   conn.close();
 *
 * Live events are a fast path, not the source of truth. A socket can look
 * open while delivering nothing (a phone that moved from Wi-Fi to cellular),
 * the gateway can be down, and the gateway loses any event sent while its own
 * Postgres connection is down. So this client:
 *   - sends { type:'ping' } every 15 s and treats the socket as dead if no
 *     reply arrives within 5 s, then reconnects;
 *   - reports 'degraded' when the gateway says it is not receiving events;
 *   - calls onSync after each subscribe, on the gateway's 'resync' event, when
 *     the tab becomes visible, every 4 s while not live, and every 15 s while
 *     live as a fail-safe. onSync is where the page refetches its state.
 *
 * Set NEXT_PUBLIC_REALTIME_URL (ws://localhost:3001 in dev, wss://... in
 * production). Defaults to ws(s)://<page host>:3001.
 */

export const HEARTBEAT_MS = 15_000;
export const PONG_TIMEOUT_MS = 5_000;
export const CONNECT_TIMEOUT_MS = 10_000;
export const POLL_WHEN_DOWN_MS = 4_000;
export const POLL_WHEN_LIVE_MS = 15_000;
export const MIN_BACKOFF_MS = 500;
export const MAX_BACKOFF_MS = 10_000;

/** True when a REST refetch is due. lastSyncAt null means never synced. */
export function syncDue({ live, lastSyncAt, now, downMs = POLL_WHEN_DOWN_MS, liveMs = POLL_WHEN_LIVE_MS }) {
  if (lastSyncAt == null) return true;
  return now - lastSyncAt >= (live ? liveMs : downMs);
}

/** 'ping' when a ping is due, 'dead' when the last ping went unanswered too long, else 'wait'. */
export function heartbeatAction({
  lastPingAt,
  awaitingPong,
  now,
  intervalMs = HEARTBEAT_MS,
  timeoutMs = PONG_TIMEOUT_MS,
}) {
  if (awaitingPong) return now - lastPingAt >= timeoutMs ? "dead" : "wait";
  return now - lastPingAt >= intervalMs ? "ping" : "wait";
}

/** The status a subscribed socket should report. */
export function connectionStatus({ socketOpen, subscribed, serverLive }) {
  if (!socketOpen) return "closed";
  if (!subscribed) return "reconnecting";
  return serverLive ? "open" : "degraded";
}

function defaultUrl() {
  const explicit = process.env.NEXT_PUBLIC_REALTIME_URL;
  if (explicit) return explicit;
  if (typeof window === "undefined") return "ws://localhost:3001";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.hostname}:3001`;
}

export function connectElection(
  electionId,
  {
    onEvent,
    onStatus,
    onSync,
    getTicket,
    url = defaultUrl(),
    WebSocketImpl = globalThis.WebSocket,
    now = Date.now,
    tickMs = 1_000,
    heartbeatMs = HEARTBEAT_MS,
    pongTimeoutMs = PONG_TIMEOUT_MS,
    connectTimeoutMs = CONNECT_TIMEOUT_MS,
    pollDownMs = POLL_WHEN_DOWN_MS,
    pollLiveMs = POLL_WHEN_LIVE_MS,
    minBackoffMs = MIN_BACKOFF_MS,
    maxBackoffMs = MAX_BACKOFF_MS,
  } = {}
) {
  const OPEN = 1;
  let ws = null;
  let closed = false;
  let connecting = false;
  let backoff = minBackoffMs;
  let reconnectTimer = null;
  let subscribed = false;
  let serverLive = false;
  let awaitingPong = false;
  let lastPingAt = 0;
  // The caller has just loaded its state, so the poll clock starts now.
  let lastSyncAt = now();
  let openedAt = 0;
  let status = null;

  function setStatus(next) {
    if (next === status) return;
    status = next;
    try {
      onStatus?.(next);
    } catch {
      /* a handler error must not break the connection loop */
    }
  }

  const socketOpen = () => Boolean(ws && ws.readyState === OPEN);
  const isLive = () => socketOpen() && subscribed && serverLive;

  function refreshStatus() {
    setStatus(connectionStatus({ socketOpen: socketOpen(), subscribed, serverLive }));
  }

  function sync(reason) {
    if (!onSync || closed) return;
    lastSyncAt = now();
    try {
      onSync(reason);
    } catch {
      /* ignore */
    }
  }

  function send(obj) {
    if (!socketOpen()) return false;
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  function ping() {
    if (send({ type: "ping" })) {
      lastPingAt = now();
      awaitingPong = true;
    }
  }

  /** Forgets the current socket without waiting for its close handshake. */
  function drop() {
    const old = ws;
    ws = null;
    subscribed = false;
    awaitingPong = false;
    if (old) {
      old.onopen = old.onmessage = old.onclose = old.onerror = null;
      try {
        old.close();
      } catch {
        /* ignore */
      }
    }
    setStatus("closed");
    scheduleReconnect();
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer || connecting) return;
    const delay = Math.round(backoff * (0.75 + Math.random() * 0.5));
    backoff = Math.min(backoff * 2, maxBackoffMs);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      open();
    }, delay);
  }

  function reconnectNow() {
    if (closed || connecting || ws) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    backoff = minBackoffMs;
    open();
  }

  async function open() {
    if (closed || ws || connecting) return;
    connecting = true;
    setStatus("reconnecting");
    let ticket = null;
    let ticketFailed = false;
    try {
      if (getTicket) ticket = await getTicket();
    } catch {
      ticketFailed = true;
    }
    connecting = false;
    if (closed) return;
    if (ticketFailed) return scheduleReconnect();

    let sock;
    try {
      sock = new WebSocketImpl(url);
    } catch {
      return scheduleReconnect();
    }
    ws = sock;
    subscribed = false;
    serverLive = false;
    awaitingPong = false;
    lastPingAt = now();
    openedAt = lastPingAt;

    sock.onopen = () => {
      if (sock !== ws) return;
      const frame = { type: "subscribe", election: electionId };
      if (ticket) frame.ticket = ticket;
      send(frame);
    };

    sock.onmessage = (e) => {
      if (sock !== ws) return;
      awaitingPong = false; // any frame proves the socket is alive
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      switch (msg?.type) {
        case "subscribed":
          subscribed = true;
          serverLive = msg.live !== false;
          backoff = minBackoffMs;
          refreshStatus();
          // Subscribed first, then refetch, so no event falls between the two.
          sync("subscribed");
          break;
        case "status":
        case "pong":
          if (typeof msg.live === "boolean") {
            serverLive = msg.live;
            if (subscribed) refreshStatus();
          }
          break;
        case "event":
          if (msg.event === "resync") sync("resync");
          try {
            onEvent?.(msg.event, msg.data);
          } catch {
            /* ignore */
          }
          break;
        default:
          break;
      }
    };

    sock.onclose = () => {
      if (sock === ws) drop();
    };
    sock.onerror = () => {
      if (sock === ws) drop();
    };
  }

  function tick() {
    if (closed) return;
    const t = now();
    // A socket that has not subscribed within the deadline (a handshake into a
    // dead network, or a subscribe the gateway never answered) is dropped.
    if (ws && !subscribed && t - openedAt >= connectTimeoutMs) {
      drop();
    } else if (socketOpen()) {
      const action = heartbeatAction({
        lastPingAt,
        awaitingPong,
        now: t,
        intervalMs: heartbeatMs,
        timeoutMs: pongTimeoutMs,
      });
      if (action === "ping") ping();
      else if (action === "dead") drop();
    }
    if (onSync && syncDue({ live: isLive(), lastSyncAt, now: t, downMs: pollDownMs, liveMs: pollLiveMs })) {
      sync("poll");
    }
  }

  /** Checks a socket that claims to be open, or reconnects at once if there is none. */
  function check() {
    if (closed) return;
    if (ws) ping();
    else reconnectNow();
  }

  function onVisibility() {
    if (document.visibilityState !== "visible") return;
    check();
    sync("visible");
  }

  const ticker = setInterval(tick, tickMs);
  const hasDocument = typeof document !== "undefined" && document.addEventListener;
  const hasWindow = typeof window !== "undefined" && window.addEventListener;
  if (hasDocument) document.addEventListener("visibilitychange", onVisibility);
  if (hasWindow) window.addEventListener("online", check);

  open();

  return {
    close() {
      if (closed) return;
      closed = true;
      clearInterval(ticker);
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      if (hasDocument) document.removeEventListener("visibilitychange", onVisibility);
      if (hasWindow) window.removeEventListener("online", check);
      const old = ws;
      ws = null;
      subscribed = false;
      if (old) {
        old.onopen = old.onmessage = old.onclose = old.onerror = null;
        try {
          old.close();
        } catch {
          /* ignore */
        }
      }
      setStatus("closed");
    },
    /**
     * Kept for callers that re-subscribe when the tab regains focus. The room
     * membership lives as long as the socket, so this pings the socket to
     * prove it is alive, or reconnects at once if there is no socket.
     */
    resubscribe: check,
    /** The current status: 'reconnecting' | 'open' | 'degraded' | 'closed'. */
    get status() {
      return status;
    },
  };
}
