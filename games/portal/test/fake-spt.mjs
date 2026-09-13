// A fake SourcePauseTool IPC server speaking portal-agent's wire protocol
// (JSON frames terminated by NUL over TCP) well enough for a functional test:
// observe, look_delta, tas_run, tas_abort and a 64x36 rgb8 screenshot.
import net from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const NUL = "\0";

export async function startFakeSpt({ width = 64, height = 36, gameRoot = null, readyDelayMs = 50, transitionAfterTicks = Infinity } = {}) {
  const state = { pitch: 0, yaw: 90, roll: 0, x: -544, y: -368, z: 128, runActive: false, ready: true, demoDir: null, ticksPlayed: 0 };
  const seen = [];
  const sockets = new Set();
  const write = (socket, message) => socket.write(`${JSON.stringify(message)}${NUL}`);
  const facing = () => ({ pitch: state.pitch, yaw: state.yaw, roll: state.roll });
  const position = () => ({ x: state.x, y: state.y, z: state.z });

  function handle(socket, m) {
    seen.push(m);
    switch (m.type) {
      case "observe": {
        const reply = { type: "observe", id: m.id, ok: true };
        if (m.fields.includes("facing")) reply.facing = facing();
        if (m.fields.includes("position")) reply.position = position();
        return write(socket, reply);
      }
      case "cmd": {
        // Upstream SPT's console-command channel; start_run/stop_run are
        // portal-agent's aliases for y_spt_agent_start_run / _stop_run.
        const cmd = String(m.cmd ?? "").trim();
        if (/^(start_run|y_spt_agent_start_run)$/.test(cmd)) {
          state.runActive = true;
          state.ready = false;
          state.ticksPlayed = 0;
          if (gameRoot) {
            const dir = join(gameRoot, "portal", "agent_runs", new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, ""));
            mkdirSync(dir, { recursive: true });
            state.demoDir = dir;
            writeFileSync(join(dir, "testchmb_a_00.dem"), Buffer.from("HL2DEMO\0fake"));
          }
          setTimeout(() => (state.ready = true), readyDelayMs);
        } else if (/^save\s+\S+$/.test(cmd)) {
          const name = cmd.split(/\s+/)[1];
          state.saves = state.saves ?? {};
          state.saves[name] = { x: state.x, y: state.y, z: state.z, yaw: state.yaw };
          if (gameRoot) {
            mkdirSync(join(gameRoot, "portal", "SAVE"), { recursive: true });
            writeFileSync(join(gameRoot, "portal", "SAVE", `${name}.sav`), Buffer.from(`fake save ${name}`));
          }
        } else if (/^load\s+\S+$/.test(cmd)) {
          const saved = state.saves?.[cmd.split(/\s+/)[1]];
          if (saved) Object.assign(state, saved);
          state.ready = false;
          setTimeout(() => (state.ready = true), readyDelayMs);
        } else if (/^(stop_run|y_spt_agent_stop_run)$/.test(cmd)) {
          state.runActive = false;
          if (state.demoDir) writeFileSync(join(state.demoDir, "testchmb_a_01.dem"), Buffer.from("HL2DEMO\0fake2"));
        }
        return; // SPT sends no reply for cmd
      }
      case "look_delta":
        if (!state.ready) return write(socket, { type: "look_delta", id: m.id, ok: false, error: "start_run is still loading the player" });
        state.pitch += m.pitch;
        state.yaw = (((state.yaw + m.yaw) % 360) + 360) % 360;
        return write(socket, { type: "look_delta", id: m.id, ok: true, facing: facing() });
      case "tas_run": {
        if (!state.ready) return write(socket, { type: "tas_run", id: m.id, ok: false, error: "start_run is still loading the player" });
        write(socket, { type: "tas_run", id: m.id, ok: true, steps: m.steps.length });
        let ticks = 0;
        let aborted = false;
        for (const step of m.steps) {
          ticks += step.ticks;
          state.ticksPlayed += step.ticks;
          if (step.keys?.forward) state.x += step.ticks * 4;
          if (step.yaw) state.yaw = (((state.yaw + step.yaw) % 360) + 360) % 360;
          if (state.ticksPlayed >= transitionAfterTicks) {
            aborted = true;
            state.ticksPlayed = -Infinity;
            break;
          }
        }
        const done = { type: "tas_run_done", id: m.id, ok: true, aborted, ticks, angles: facing() };
        if (aborted) done.reason = "level transition";
        if (m.include_position) done.position = position();
        return write(socket, done);
      }
      case "tas_abort":
        return write(socket, { type: "tas_abort", id: m.id, ok: true });
      case "screenshot": {
        write(socket, { type: "screenshot_ack", id: m.id, ok: true });
        write(socket, { type: "screenshot_begin", id: m.id, ok: true, format: "rgb8", width, height });
        const rgb = Buffer.alloc(width * height * 3);
        for (let i = 0; i < width * height; i += 1) {
          rgb[i * 3] = (i % width) * 4;
          rgb[i * 3 + 1] = 128;
          rgb[i * 3 + 2] = Math.floor(i / width) * 7;
        }
        write(socket, { type: "screenshot_chunk", id: m.id, ok: true, data: rgb.toString("base64") });
        return write(socket, { type: "screenshot_end", id: m.id, ok: true });
      }
      default:
        return write(socket, { type: m.type, id: m.id, ok: false, error: `unknown message type ${m.type}` });
    }
  }

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf(NUL)) !== -1) {
        const frame = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        if (frame) handle(socket, JSON.parse(frame));
      }
    });
  });
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  return {
    port: server.address().port,
    seen,
    state,
    close: () =>
      new Promise((res) => {
        for (const s of sockets) s.destroy();
        server.close(() => res());
      }),
  };
}
