// followEvents hands over every event as it reads it, without waiting for the previous one's handlers; inOrder is
// what the harness wraps the recorder's and the timer's handlers in, so a slow handler (the recorder's chapter mark in
// OBS at a milestone) does not let the next event (the game.over right after the last milestone) reach the timer first.
// Measured 2026-09-24 in the FCEUX mocks: the pause was in LiveSplit before the split, and LiveSplit refused the split.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { followEvents, inOrder } from "../src/events.mjs";

const lines = [
  { timestamp: "2026-09-24T10:24:04.656+02:00", source: "game", kind: "event", event: "game.milestone", data: { label: "Solved", chapter: true } },
  { timestamp: "2026-09-24T10:24:04.658+02:00", source: "game", kind: "event", event: "game.over", data: { victory: true } },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function seen(wrap) {
  const dir = mkdtempSync(join(tmpdir(), "aas-events-"));
  const follower = followEvents(dir, (ev) => wrap(async () => {
    if (ev.event === "game.milestone") await sleep(50); // the recorder waiting on OBS
    order.push(ev.event);
  }), { intervalMs: 10 });
  const order = [];
  writeFileSync(join(dir, "run.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  await follower.flush();
  follower.stop();
  return order;
}

test("without inOrder the game.over overtakes the milestone's slow handler", async () => {
  assert.deepEqual(await seen((fn) => fn()), ["game.over", "game.milestone"]);
});

test("with inOrder the handlers run in the log's order", async () => {
  assert.deepEqual(await seen(inOrder()), ["game.milestone", "game.over"]);
});
