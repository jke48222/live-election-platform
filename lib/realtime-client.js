/**
 * Browser realtime client — replaces the Supabase Broadcast channel in the
 * voter and admin pages. Connects to the self-hosted gateway, subscribes to a
 * single election's room, and invokes handlers on each event. Auto-reconnects
 * with backoff and re-subscribes on reconnect.
 *
 *   const conn = connectElection(electionId, {
 *     onEvent: (event, data) => { ... },          // 'state_change' | 'purge' | ...
 *     onStatus: (status) => { ... },              // 'open' | 'closed' | 'reconnecting'
 *   });
 *   // later
 *   conn.close();
 *
 * Set NEXT_PUBLIC_REALTIME_URL (e.g. ws://localhost:3001 in dev,
 * wss://realtime.yourdomain in prod). Defaults to ws://<host>:3001.
 */
export function connectElection(electionId, { onEvent, onStatus } = {}) {
  let ws = null;
  let closed = false;
  let backoff = 500;

  const url = resolveUrl();

  function resolveUrl() {
    const explicit = process.env.NEXT_PUBLIC_REALTIME_URL;
    if (explicit) return explicit;
    if (typeof window === "undefined") return "ws://localhost:3001";
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.hostname}:3001`;
  }

  function open() {
    if (closed) return;
    onStatus?.("reconnecting");
    ws = new WebSocket(url);

    ws.onopen = () => {
      backoff = 500;
      ws.send(JSON.stringify({ type: "subscribe", election: electionId }));
      onStatus?.("open");
    };

    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === "event") onEvent?.(msg.event, msg.data);
    };

    ws.onclose = () => {
      onStatus?.("closed");
      if (closed) return;
      setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, 10_000);
    };

    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* onclose handles reconnect */
      }
    };
  }

  open();

  return {
    close() {
      closed = true;
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    },
    /** Re-subscribe (e.g. after tab regains focus). */
    resubscribe() {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "subscribe", election: electionId }));
      }
    },
  };
}
