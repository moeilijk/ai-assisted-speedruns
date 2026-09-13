// A short-lived SPT IPC session for the harness (not the broker): console
// commands (`cmd`) and a readiness probe. portal-agent's controller keeps
// its own connection inside the broker; this one is opened around a run.
import net from "node:net";

const NUL = "\0";

export function sptSession({ host = "127.0.0.1", port = 27182 } = {}, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let buffer = "";
    let nextId = 1;
    const pending = new Map();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out connecting to SPT IPC at ${host}:${port}. Is Portal running with \`exec portal_agent\` done (y_spt_ipc 1)?`));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("error", (e) => {
      clearTimeout(timer);
      for (const p of pending.values()) p.reject(e);
      reject(e);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf(NUL)) !== -1) {
        const frame = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        if (!frame) continue;
        let msg;
        try {
          msg = JSON.parse(frame);
        } catch {
          continue;
        }
        const p = pending.get(String(msg.id));
        if (p) {
          // tas_run answers twice: an ack (type tas_run) and, after playback, tas_run_done.
          if (p.type === "tas_run" && msg.type === "tas_run" && msg.ok !== false) return;
          pending.delete(String(msg.id));
          p.resolve(msg);
        }
      }
    });
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve({
        /** Resolves once the frame has been handed to the kernel; SPT sends no reply for cmd. */
        cmd(command) {
          return new Promise((res, rej) => socket.write(`${JSON.stringify({ type: "cmd", cmd: command })}${NUL}`, (e) => (e ? rej(e) : res())));
        },
        request(type, payload = {}, ms = 5000) {
          const id = nextId++;
          return new Promise((res, rej) => {
            const t = setTimeout(() => {
              pending.delete(String(id));
              rej(new Error(`Timed out waiting for SPT ${type}.`));
            }, ms);
            pending.set(String(id), { type, resolve: (m) => (clearTimeout(t), res(m)), reject: rej });
            socket.write(`${JSON.stringify({ type, id, ...payload })}${NUL}`);
          });
        },
        close() {
          socket.end();
          setTimeout(() => socket.destroy(), 500).unref();
        },
      });
    });
  });
}

/**
 * Wait until the run is loaded and TAS-paused: `look_delta 0/0` answers ok
 * (it errors with "start_run is still loading the player" while loading)
 * AND `observe` reports a finite player position (at the main menu there is
 * no player, so look_delta alone is not enough).
 */
export async function waitUntilReady(session, { timeoutMs = 180000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = "no reply";
  for (;;) {
    const look = await session.request("look_delta", { pitch: 0, yaw: 0 }, 5000).catch((e) => ({ error: e.message }));
    if (look?.ok === true) {
      const obs = await session.request("observe", { fields: ["position"] }, 5000).catch((e) => ({ error: e.message }));
      const p = obs?.position;
      if (obs?.ok === true && p && ["x", "y", "z"].every((k) => Number.isFinite(p[k]) && Math.abs(p[k]) < 1e6)) return { position: p };
      last = obs?.error ?? obs?.unavailable?.position ?? "no player position yet";
    } else last = look?.error ?? "no reply";
    if (Date.now() > deadline) throw new Error(`Game did not become ready within ${timeoutMs / 1000} s (${last}).`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
