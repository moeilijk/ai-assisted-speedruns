// The LiveSplit timer against a stand-in for the LiveSplit Server: the commands the timer sends and the answers the
// real server gives (getcurrenttimerphase, getsplitindex; measured on LiveSplit 1.8.37, 2026-09-23). A connection can
// be "deaf": LiveSplit takes it and does nothing, as in the run whose timer never started (smb-mock-04).
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createLiveSplitTimer } from "../index.mjs";

function startFakeLiveSplit({ segments = 2, deafConnections = 0 } = {}) {
  const state = { phase: "NotRunning", index: -1, connections: 0, commands: [] };
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
        state.commands.push(cmd);
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

test("game time runs while a playback plays and stands still while the agent thinks, on the exact value, never going back", async () => {
  const ls = await startFakeLiveSplit({ segments: 2 });
  const timer = createLiveSplitTimer({ port: ls.port, windows: async () => ["LiveSplit"] });
  await timer.start(brief);
  const clock = () => ls.state.commands.filter((c) => /^(unpausegametime|pausegametime|setgametime)/.test(c));
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  let n = clock().length;
  // A playback of 0.3 s heard at once: game time runs, and the timer stops it itself at 0.300.
  await timer.onEvent({ event: "game.playback", timestamp: new Date().toISOString(), data: { phase: "start", index: 1, frames: 18, seconds: 0.3 } });
  await settle(100);
  assert.deepEqual(clock().slice(n), ["setgametime 0.000", "unpausegametime"]);
  await settle(400);
  assert.deepEqual(clock().slice(n + 2), ["pausegametime", "setgametime 0.300"], "paused at the planned end, before the end is heard");
  await timer.onEvent({ event: "game.playback", timestamp: new Date().toISOString(), data: { phase: "end", index: 1, frames: 18, seconds: 0.3 } });
  await settle(50);
  assert.deepEqual(clock().slice(n + 4), ["pausegametime", "setgametime 0.300"], "the end sets the same value: no jump");
  // A playback heard after it was already over: nothing runs, the end sets it.
  n = clock().length;
  await timer.onEvent({ event: "game.playback", timestamp: new Date(Date.now() - 2000).toISOString(), data: { phase: "start", index: 2, frames: 30, seconds: 0.5 } });
  await timer.onEvent({ event: "game.playback", timestamp: new Date().toISOString(), data: { phase: "end", index: 2, frames: 30, seconds: 0.5 } });
  await settle(50);
  assert.deepEqual(clock().slice(n), ["pausegametime", "setgametime 0.800"]);
  // A command that does not say how long it plays (Slay the Spire): game time moves at its end.
  n = clock().length;
  await timer.onEvent({ event: "game.playback", timestamp: new Date().toISOString(), data: { phase: "start", index: 3, command: "play 1" } });
  await timer.onEvent({ event: "game.playback", timestamp: new Date().toISOString(), data: { phase: "end", index: 3, seconds: 1 } });
  await settle(50);
  assert.deepEqual(clock().slice(n), ["pausegametime", "setgametime 1.800"]);
  const set = clock().filter((c) => c.startsWith("setgametime")).map((c) => Number(c.split(" ")[1]));
  assert.ok(set.every((v, i) => i === 0 || v >= set[i - 1]), `never back: ${set.join(", ")}`);
  await timer.stop();
  await ls.close();
});
