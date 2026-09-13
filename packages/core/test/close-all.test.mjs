// The close step at the end of a run: the game plugin first, then the timer and the recorder close their own
// programs, Steam only when a launcher of this harness started it (marker) or when asked. Nothing on this
// machine is touched: the plugins are fakes and the Steam step is injected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { closeAll, hasWindowsDesktop } from "../src/close-all.mjs";

const fakeCloser = (calls) => (steps, opts) => { calls.push({ steps, opts }); return "still running: "; };

test("closes the game, then the timer and the recorder through their own close(); Steam only when asked", { skip: !hasWindowsDesktop() && "no Windows desktop" }, async () => {
  const calls = [];
  const order = [];
  const plugin = { processName: "java.exe", close: async ({ log }) => { order.push("game"); log("java closed"); } };
  const timer = { id: "t", processName: "LiveSplit", close: async () => { order.push("timer"); return "LiveSplit closed"; } };
  const recorder = { id: "r", processName: "obs64", close: async () => { order.push("recorder"); return "obs64 closed"; } };
  const lines = await closeAll({ plugin, recorder, timer, steam: false, closer: fakeCloser(calls) });
  assert.deepEqual(order, ["game", "timer", "recorder"]);
  assert.equal(lines.filter((l) => l === "java closed").length, 1);
  assert.ok(lines.includes("LiveSplit closed") && lines.includes("obs64 closed"));
  assert.equal(calls.length, 0, "no Steam step when not asked");
  const steam = [];
  await closeAll({ plugin, recorder: { id: "null" }, timer: null, steam: true, closer: fakeCloser(steam) });
  assert.equal(steam[0].opts.steam, true);
  assert.deepEqual(steam[0].opts.report, ["java", "steam"]);
});

test("a game that fails to close is reported, the rest still closes", { skip: !hasWindowsDesktop() && "no Windows desktop" }, async () => {
  const closed = [];
  const plugin = { close: async () => { throw new Error("no window"); } };
  const lines = await closeAll({ plugin, recorder: { id: "r", close: async () => { closed.push("r"); return "closed"; } }, steam: false, closer: fakeCloser([]) });
  assert.ok(lines.some((l) => /did not close cleanly: no window/.test(l)));
  assert.deepEqual(closed, ["r"]);
});
