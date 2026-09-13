import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startOverlayServer } from "../src/overlay-server.mjs";
import { createEventLog } from "../src/events.mjs";

test("overlay server serves the page and streams run.jsonl records as SSE", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "aas-overlay-"));
  const events = createEventLog(runDir);
  events.append("run.started", { id: "x" });
  const overlay = await startOverlayServer(runDir);
  try {
    const page = await (await fetch(overlay.url)).text();
    assert.match(page, /EventSource\("\/events"\)/);
    const res = await fetch(`${overlay.url}events`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let got = "";
    const read = async (until) => {
      while (!got.includes(until)) {
        const { value, done } = await reader.read();
        if (done) break;
        got += decoder.decode(value);
      }
    };
    await read("run.started"); // replayed history
    events.append("game.playback", { phase: "start", steps: [{ ticks: 67, keys: ["forward"] }], planned_ticks: 67 });
    await read("game.playback");
    assert.match(got, /"steps":\[\{"ticks":67,"keys":\["forward"\]\}\]/);
    reader.cancel();
  } finally {
    await overlay.close();
  }
});
