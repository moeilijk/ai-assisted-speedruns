// The controller side of SAR's TAS protocol: one socket to `sar_tas_protocol_server`, the game's own packets kept as
// state, and a request/answer pair where the protocol has one (entity info, advance tick).
//
// Deliberately thin: it does not interpret the game, it speaks the protocol. What a run does with it is the game
// plugin's business.
import net from "node:net";
import { decode, encode, FROM_GAME, TO_GAME } from "./sar-protocol.mjs";

const DEADLINE = Number(process.env.AAS_PORTAL2_TIMEOUT_MS || 10000);

export async function connectSar({ host = process.env.AAS_PORTAL2_HOST || "127.0.0.1", port = Number(process.env.AAS_PORTAL2_PORT || 6555), timeout = DEADLINE } = {}) {
  const socket = net.createConnection({ host, port });
  socket.setNoDelay(true);
  const state = { location: null, tick: null, playback: "unknown", rate: null, script: null };
  const waiting = [];
  const listeners = new Set();

  const settle = (packet) => {
    for (let i = 0; i < waiting.length; i += 1) {
      if (waiting[i].wants(packet)) { const w = waiting.splice(i, 1)[0]; clearTimeout(w.timer); w.resolve(packet); return; }
    }
  };
  // A packet from the game is state first; a pending request may be waiting for exactly this one.
  const handle = (p) => {
    if (p.id === 255) state.location = p.location;
    if (p.id === 6) state.tick = p.tick;
    if (p.id === 7) state.debugTick = p.tick;
    if (p.id === 2) state.rate = p.rate;
    if (p.id === 3) state.playback = "playing";
    if (p.id === 4) state.playback = "paused";
    if (p.id === 5) state.playback = "fast-forwarding";
    if (p.id === 1) state.playback = "inactive";
    if (p.id === 0) state.script = { script1: p.script1, script2: p.script2 };
    for (const l of listeners) l(p);
    settle(p);
  };

  let rest = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    const read = decode(FROM_GAME, Buffer.concat([rest, chunk]));
    rest = read.rest;
    for (const p of read.packets) handle(p);
  });

  // The socket being open says nothing: SAR sends packet 255 ("set game location") first and never again, so that
  // packet is what makes the connection usable, and its absence is what a wrong port looks like.
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer from SAR on ${host}:${port} within ${timeout} ms (is Portal 2 running with sar_tas_protocol_server?)`)), timeout);
    socket.once("error", (e) => { clearTimeout(timer); reject(e); });
    waiting.push({ wants: (p) => p.id === 255, resolve: () => { clearTimeout(timer); resolve(); }, timer });
  });

  /** Waits for the packet a request is answered with; the protocol has no request ids, so it is the next of its kind. */
  const expect = (wants, what) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const i = waiting.findIndex((w) => w.timer === timer);
      if (i >= 0) waiting.splice(i, 1);
      reject(new Error(`SAR did not answer ${what} within ${timeout} ms`));
    }, timeout);
    waiting.push({ wants, resolve, timer });
  });
  const send = (id, values) => new Promise((resolve, reject) => socket.write(encode(TO_GAME, id, values), (e) => (e ? reject(e) : resolve())));

  return {
    state,
    /** Position, angles and velocity of an entity, by SAR's selector ("player", "#12", a targetname). */
    async entity(selector = "player") {
      const answer = expect((p) => p.id === 100, `entity info for ${selector}`);
      await send(100, { selector });
      const p = await answer;
      return { state: p.state, position: p.position, angles: p.angles, velocity: p.velocity };
    },
    /** Continuous entity info: the game sends packet 100 on its own until another selector is set. */
    async watch(selector = "player") { await send(101, { selector }); },
    /** One tick per call, each answered with the tick the game is on. */
    async advance(ticks = 1) {
      for (let i = 0; i < ticks; i += 1) {
        const answer = expect((p) => p.id === 6, "advance tick");
        await send(7);
        await answer;
      }
      return state.tick;
    },
    async pauseAtTick(tick) { await send(6, { tick }); },
    async play() { await send(3); },
    async pause() { await send(4); },
    async fastForward(tick, pauseAfter = 1) { await send(5, { tick, pauseAfter: pauseAfter ? 1 : 0 }); },
    async rate(value) { await send(2, { rate: value }); },
    async stop() { await send(1); },
    /** An inline .p2tas script, played without a file on disk; `start now` continues from the state the game is in. */
    async script(text, name = "aas") {
      // The game answers with "processed script" (id 10), which is what says it parsed it; without waiting a caller
      // cannot tell a script that was refused from one that was never read.
      const answer = expect((p) => p.id === 10, "processed script");
      await send(10, { script1name: name, script1: text, script2name: "", script2: "" });
      const p = await answer;
      return { slot: p.slot, script: p.script };
    },
    on(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    close() { socket.destroy(); },
  };
}
