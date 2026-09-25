// A stand-in for fceux-mcp's bridge inside FCEUX, with the answers measured on the real one (FCEUX 2.6.6 win64, our
// fork, 2026-09-23): JSON lines over TCP, several clients at once, emu.step with steps of held buttons (600 frames at
// most per call in the plugin), and the methods the plugin uses. With `dir` it answers through files instead, as the
// bridge does where LuaSocket cannot load (FCEUX's win64-QtSDL build; bridge.lua, "File transport").
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { toLocal } from "../../../packages/core/src/gui/windows-paths.mjs";

// The path the plugin hands FCEUX is the Windows form of a WSL path, with / or \ (//wsl.localhost/<distro>/tmp/…).
const local = (p) => { const m = /^[\\/]{2}wsl(?:\.localhost|\$)[\\/][^\\/]+([\\/].*)$/i.exec(String(p)); return m ? m[1].replaceAll("\\", "/") : toLocal(String(p)); };

export async function startFakeBridge({ md5 = "F53AF989E2C9C37F01D9A276D8AEC04A", memory = {}, dir = null } = {}) {
  const state = { md5, framecount: 0, paused: true, steps: [], calls: [], memory: { ...memory }, onFrame: null, connections: 0, saves: [], messages: [], inFiles: 0 };
  const handlers = {
    ping: () => "pong",
    "emu.framecount": () => state.framecount,
    "emu.paused": () => state.paused,
    "emu.pause": () => { state.paused = true; return true; },
    "emu.poweron": () => { state.framecount = 0; state.messages.push("Power on"); return { framecount: 0 }; },
    "emu.reload": () => { state.framecount = 0; state.messages.length = 0; return { filename: "nes15-NTSC", framecount: 0 }; },
    "rom.getfilename": () => "nes15-NTSC",
    "rom.gethash": () => state.md5.toLowerCase(),
    "emu.step": (p) => {
      const plan = p.steps ?? [{ frames: p.frames ?? 1 }];
      for (const s of plan) {
        for (let i = 0; i < s.frames; i += 1) {
          state.steps.push({ frame: state.framecount, buttons: s.buttons ?? null, reset: Boolean(s.reset && i === 0) });
          state.framecount += 1;
          state.onFrame?.(state);
        }
      }
      return state.framecount;
    },
    "memory.readbyte": (p) => state.memory[p.address] ?? 0,
    "memory.readword": (p) => (state.memory[p.address] ?? 0) + 256 * (state.memory[p.address + 1] ?? 0),
    "memory.readbyterange": (p) => Array.from({ length: p.length }, (_, i) => state.memory[p.address + i] ?? 0),
    "gui.screen": () => ({ width: 2, height: 1, rgb: Buffer.from([255, 0, 0, 0, 0, 255]).toString("base64") }),
    // A savestate is the frame count and the memory, written where the plugin asks, and read back on load.
    "savestate.savefile": (p) => { state.saves.push(p.path); try { fs.writeFileSync(local(p.path), JSON.stringify({ framecount: state.framecount, memory: state.memory })); } catch { /* a path that is not on this machine (the unit tests' Windows paths) */ } return { path: p.path, framecount: state.framecount }; },
    "savestate.loadfile": (p) => { try { const s = JSON.parse(fs.readFileSync(local(p.path), "utf8")); state.framecount = s.framecount; state.memory = { ...s.memory }; } catch { /* as above */ } return { path: p.path, framecount: state.framecount }; },
    "emu.exit": () => true,
  };
  const answer = (req) => {
    state.calls.push(req.method === "emu.step" ? `emu.step:${(req.params.steps ?? [{ frames: req.params.frames }]).reduce((n, s) => n + s.frames, 0)}` : req.method);
    const h = handlers[req.method];
    return h ? { id: req.id, result: h(req.params ?? {}) } : { id: req.id, error: { code: "method_not_found", message: `no handler for '${req.method}'` } };
  };
  if (dir) {
    // Eight places, client-<k> with a token; <token>-in-<n> read in order, <token>-out-<n> written under another name
    // and renamed.
    const clients = new Map(); // slot -> { token, inseq, outseq }
    const timer = setInterval(() => {
      for (let k = 1; k <= 8; k += 1) {
        let token = null;
        try { token = fs.readFileSync(path.join(dir, `client-${k}`), "utf8").trim(); } catch {}
        const known = clients.get(k);
        if (known && known.token !== token) clients.delete(k);
        if (token && (!known || known.token !== token)) { clients.set(k, { token, inseq: 1, outseq: 1 }); state.connections += 1; }
      }
      for (const c of clients.values()) {
        for (;;) {
          const name = path.join(dir, `${c.token}-in-${c.inseq}`);
          let data;
          try { data = fs.readFileSync(name, "utf8"); } catch { break; }
          fs.rmSync(name);
          c.inseq += 1;
          state.inFiles += 1;
          const out = data.split("\n").filter(Boolean).map((l) => `${JSON.stringify(answer(JSON.parse(l)))}\n`).join("");
          const target = path.join(dir, `${c.token}-out-${c.outseq}`);
          c.outseq += 1;
          fs.writeFileSync(`${target}.tmp`, out);
          fs.renameSync(`${target}.tmp`, target);
        }
      }
    }, 5);
    state.clients = clients;
    state.close = async () => clearInterval(timer);
    return state;
  }
  const sockets = new Set();
  const server = net.createServer((sock) => {
    state.connections += 1;
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("error", () => {});
    sock.on("data", (d) => {
      buf += d;
      let at;
      while ((at = buf.indexOf("\n")) !== -1) {
        const req = JSON.parse(buf.slice(0, at));
        buf = buf.slice(at + 1);
        sock.write(`${JSON.stringify(answer(req))}\n`);
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  state.port = server.address().port;
  state.close = () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); });
  return state;
}
