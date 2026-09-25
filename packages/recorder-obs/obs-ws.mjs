// Minimal obs-websocket v5 client on Node's built-in WebSocket (Node 22+).
// Handshake: Hello (op 0) → Identify (op 1, sha256 auth) → Identified (op 2);
// Request (op 6) / RequestResponse (op 7); Event (op 5). No dependencies.
import { createHash } from "node:crypto";

export const EVENT_SUBSCRIPTIONS_ALL = 2047; // every non-high-volume category

export function connectObs({ url = "ws://127.0.0.1:4455", password = "", eventSubscriptions = EVENT_SUBSCRIPTIONS_ALL, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket !== "function") return reject(new Error("Node 22+ with the global WebSocket client is required."));
    const ws = new WebSocket(url, "obswebsocket.json");
    const pending = new Map();
    const listeners = new Map();
    const waits = new Set();
    let nextId = 1;
    let identified = false;
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`Timed out connecting to obs-websocket at ${url}. In OBS: Tools → WebSocket Server Settings → Enable WebSocket server.`));
    }, timeoutMs);
    const send = (op, d) => ws.send(JSON.stringify({ op, d }));
    const api = {
      call(requestType, requestData = {}, ms = 15000) {
        const requestId = String(nextId++);
        return new Promise((res, rej) => {
          const t = setTimeout(() => {
            pending.delete(requestId);
            rej(new Error(`obs-websocket ${requestType} timed out`));
          }, ms);
          pending.set(requestId, { res, rej, t, requestType });
          send(6, { requestType, requestId, requestData });
        });
      },
      /** Like call(), but an error becomes `null` (for optional features such as chapters or the replay buffer). */
      async tryCall(requestType, requestData) {
        try {
          return await api.call(requestType, requestData);
        } catch {
          return null;
        }
      },
      on(eventType, fn) {
        if (!listeners.has(eventType)) listeners.set(eventType, new Set());
        listeners.get(eventType).add(fn);
        return () => listeners.get(eventType)?.delete(fn);
      },
      /** Resolves with the event data, or with null on timeout or close (never rejects). */
      waitFor(eventType, predicate = () => true, ms = 15000) {
        return new Promise((res) => {
          const done = (value) => {
            clearTimeout(t);
            waits.delete(done);
            off();
            res(value);
          };
          const t = setTimeout(() => done(null), ms);
          const off = api.on(eventType, (data) => {
            if (predicate(data)) done(data);
          });
          waits.add(done);
        });
      },
      /** Closes the connection and resolves once it is closed (at most 3 s). Awaiting it matters: a caller that
       *  goes on to block this process (spawnSync) before the socket is closed leaves OBS waiting for it, and OBS
       *  then takes about two minutes to exit (measured 2026-09-25). */
      close() {
        for (const p of pending.values()) {
          clearTimeout(p.t);
          p.rej(new Error("obs-websocket connection closed"));
        }
        pending.clear();
        for (const done of [...waits]) done(null);
        return new Promise((res) => {
          if (ws.readyState === WebSocket.CLOSED) return res();
          const t = setTimeout(res, 3000);
          ws.addEventListener("close", () => { clearTimeout(t); res(); }, { once: true });
          ws.close();
        });
      },
    };
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`Could not connect to obs-websocket at ${url}. Is OBS running with the WebSocket server enabled?`));
    });
    ws.addEventListener("close", () => {
      for (const p of pending.values()) {
        clearTimeout(p.t);
        p.rej(new Error("obs-websocket connection closed"));
      }
      pending.clear();
      if (!identified) {
        clearTimeout(timer);
        reject(new Error("obs-websocket closed the connection during the handshake (wrong password?)"));
      }
    });
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      const d = msg.d ?? {};
      switch (msg.op) {
        case 0: {
          const identify = { rpcVersion: 1, eventSubscriptions };
          if (d.authentication) {
            const { challenge, salt } = d.authentication;
            const secret = createHash("sha256").update(password + salt).digest("base64");
            identify.authentication = createHash("sha256").update(secret + challenge).digest("base64");
          }
          send(1, identify);
          break;
        }
        case 2:
          identified = true;
          clearTimeout(timer);
          resolve(api);
          break;
        case 5:
          for (const fn of listeners.get(d.eventType) ?? []) fn(d.eventData ?? {});
          for (const fn of listeners.get("*") ?? []) fn(d);
          break;
        case 7: {
          const p = pending.get(d.requestId);
          if (!p) break;
          pending.delete(d.requestId);
          clearTimeout(p.t);
          if (d.requestStatus?.result) p.res(d.responseData ?? {});
          else p.rej(new Error(`obs-websocket ${d.requestType} failed (${d.requestStatus?.code}): ${d.requestStatus?.comment ?? "no comment"}`));
          break;
        }
        default:
      }
    });
  });
}
