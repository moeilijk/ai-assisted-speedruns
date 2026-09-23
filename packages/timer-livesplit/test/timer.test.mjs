// The LiveSplit timer against a stand-in for the LiveSplit Server: the commands the timer sends and the answers the
// real server gives (getcurrenttimerphase, getsplitindex; measured on LiveSplit 1.8.37, 2026-09-23). A connection can
// be "deaf": LiveSplit takes it and does nothing, as in the run whose timer never started (smb-mock-04).
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createLiveSplitTimer } from "../index.mjs";

function startFakeLiveSplit({ segments = 2, deafConnections = 0 } = {}) {
  const state = { phase: "NotRunning", index: -1, connections: 0 };
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    state.connections += 1;
    const deaf = state.connections <= deafConnections;
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (d) => {
      buf += d;
      let at;
      while ((at = buf.indexOf("\n")) !== -1) {
        const cmd = buf.slice(0, at).replace(/\r$/, "").trim();
        buf = buf.slice(at + 1);
        if (deaf) continue;
        if (cmd === "reset") { state.phase = "NotRunning"; state.index = -1; }
        else if (cmd === "starttimer") { state.phase = "Running"; state.index = 0; }
        else if (cmd === "split" && state.phase === "Running") { state.index += 1; if (state.index >= segments) state.phase = "Ended"; }
        else if (cmd === "pause" && state.phase === "Running") state.phase = "Paused";
        else if (cmd === "getcurrenttimerphase") socket.write(`${state.phase}\r\n`);
        else if (cmd === "getsplitindex") socket.write(`${state.index}\r\n`);
        else if (cmd === "getcurrenttime" || cmd === "getcurrentgametime") socket.write("00:00:01.0000000\r\n");
      }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ state, port: server.address().port, close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(r); }) })));
}

const brief = { id: "t", category: { game: "x", goal: "b" } };
const milestone = (label) => ({ event: "game.milestone", data: { label, chapter: true } });

test("a start LiveSplit takes: its timer runs, every split moves on, nothing to report", async () => {
  const ls = await startFakeLiveSplit({ segments: 2 });
  const timer = createLiveSplitTimer({ port: ls.port, windows: async () => ["LiveSplit"] });
  await timer.start(brief);
  assert.equal(ls.state.phase, "Running");
  await timer.onEvent(milestone("One"));
  await timer.onEvent(milestone("Two"));
  assert.equal(ls.state.phase, "Ended");
  const r = await timer.stop();
  assert.deepEqual(r.problems, []);
  await ls.close();
});

test("LiveSplit that does not take the start is started again on a new connection, and that is reported", async () => {
  const ls = await startFakeLiveSplit({ deafConnections: 1 });
  const timer = createLiveSplitTimer({ port: ls.port, windows: async () => ["LiveSplit"] });
  await timer.start(brief);
  assert.equal(ls.state.phase, "Running");
  assert.equal(ls.state.connections, 2);
  const r = await timer.stop();
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0].what, /not answering; connected again/);
  assert.deepEqual(r.problems[0].windows, ["LiveSplit"], "LiveSplit's windows are kept with the problem");
  await ls.close();
});

test("a run does not start when LiveSplit does not take the start twice", async () => {
  const ls = await startFakeLiveSplit({ deafConnections: 5 });
  const timer = createLiveSplitTimer({ port: ls.port, windows: async () => ["LiveSplit"] });
  await assert.rejects(timer.start(brief), /LiveSplit did not start its timer \(phase no answer; LiveSplit's windows: LiveSplit\)/);
  await ls.close();
});
