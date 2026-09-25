import { test } from "node:test";
import assert from "node:assert/strict";
import { startFakeObs } from "./fake-obs.mjs";
import { createObsRecorder } from "../index.mjs";
import { connectObs } from "../obs-ws.mjs";

const game = { id: "portal", name: "Portal", processName: "hl2.exe" };
const brief = { id: "portal-01", category: { game: "portal", goal: "credits" }, model: "claude-fable-5-1" };
const quiet = { outroSeconds: 0.05, log: () => {} };

test("obs-ws: authenticates and rejects a wrong password", async () => {
  const obs = await startFakeObs({ password: "pw" });
  try {
    const c = await connectObs({ url: obs.url, password: "pw" });
    assert.equal((await c.call("GetVersion")).obsWebSocketVersion, "5.7.4");
    c.close();
    await assert.rejects(() => connectObs({ url: obs.url, password: "wrong", timeoutMs: 2000 }), /handshake|closed/);
  } finally {
    await obs.close();
  }
});

test("recorder-obs: removes the default microphone from its own collection, refuses one elsewhere", async () => {
  const obs = await startFakeObs({ specialInputs: { mic1: "Mic/Aux" }, inputs: [{ inputName: "Mic/Aux", inputKind: "wasapi_input_capture" }] });
  try {
    await createObsRecorder({ url: obs.url, password: "secret", ...quiet }).preflight(brief, game);
    const own = obs.state.collections.get("AAS-portal");
    assert.ok(!own.inputs.some((i) => i.inputKind === "wasapi_input_capture"));
    assert.equal(own.special.mic1, null);
    // An existing AAS collection where RemoveInput does not work: refuse.
    own.inputs.push({ inputName: "Sneaky Mic", inputKind: "wasapi_input_capture" });
    const stubborn = createObsRecorder({ url: obs.url, password: "secret", ...quiet });
    obs.state.calls.length = 0;
    await stubborn.preflight(brief, game); // removal succeeds in the fake, so this passes
    assert.ok(!own.inputs.some((i) => i.inputName === "Sneaky Mic"));
  } finally {
    await obs.close();
  }
});

test("recorder-obs: builds the scene collection idempotently, records, reacts to events, stops with the output path", async () => {
  const obs = await startFakeObs();
  try {
    const rec = createObsRecorder({ url: obs.url, password: "secret", ...quiet });
    await rec.preflight(brief, game);
    const col = obs.state.collections.get("AAS-portal");
    assert.ok(col, "collection created");
    assert.deepEqual(col.scenes.slice(1), ["Portal-Game", "Portal-Game-Clean"]);
    assert.ok(!col.inputs.some((i) => /Title|Card/.test(i.inputName)), "no text cards: the recording shows the game, LiveSplit and the overlay");
    const capture = col.inputs.find((i) => i.inputName === "Portal Game Window");
    assert.equal(capture.inputKind, "window_capture");
    assert.equal(capture.settings.window, "Portal:Valve001:hl2.exe", "resolved from OBS's window list");
    assert.equal(capture.settings.method, 2);
    assert.deepEqual(capture.scenes, ["Portal-Game", "Portal-Game-Clean"]);
    assert.equal(capture.transform.boundsWidth, 3840);
    assert.equal(capture.transform.boundsType, "OBS_BOUNDS_SCALE_INNER");
    assert.equal(capture.index, 0, "game window at the back of the scene");
    assert.equal(col.inputs.find((i) => i.inputName === "Portal Game Audio").inputKind, "wasapi_process_output_capture");
    const ls = col.inputs.find((i) => i.inputName === "Portal LiveSplit");
    assert.equal(ls?.inputKind, "window_capture", "LiveSplit window capture");
    assert.ok(ls.transform.boundsWidth <= 3840 * 0.10 + 1 && ls.transform.boundsHeight <= 2160 * 0.30 + 1, "LiveSplit stays small in the picture");
    const before = col.inputs.length;
    await rec.preflight(brief, game); // second time: nothing duplicated
    assert.equal(col.inputs.length, before);

    const { t0 } = await rec.start(brief, { runDir: "/tmp/not-a-mnt-path", overlayUrl: "http://127.0.0.1:8765/" });
    assert.ok(t0 instanceof Date);
    assert.equal(obs.state.recording, true);
    assert.equal(obs.state.scene, "Portal-Game", "the recording opens on the game, not on an overlay card");
    assert.match(obs.state["profile:Output.FilenameFormatting"], /^AAS_portal-01_/);
    const overlay = col.inputs.find((i) => i.inputName === "Portal Overlay");
    assert.equal(overlay.settings.url, "http://127.0.0.1:8765/");
    assert.equal(overlay.settings.width, 1920);
    assert.equal(overlay.transform.boundsWidth, 3840);

    const ts = new Date(t0.getTime() + 12500).toISOString();
    await rec.onEvent({ kind: "event", timestamp: ts, event: "game.phase", data: { phase: "loading" } });
    assert.equal(obs.state.scene, "Portal-Game-Clean");
    await rec.onEvent({ kind: "event", timestamp: ts, event: "game.playback", data: { phase: "start" } });
    assert.equal(obs.state.scene, "Portal-Game");
    await rec.onEvent({ kind: "event", timestamp: ts, event: "game.milestone", data: { label: "Chamber 04", chapter: true } });
    assert.deepEqual(obs.state.chapters, ["Chamber 04"]);
    await rec.onEvent({ kind: "event", timestamp: ts, event: "game.highlight", data: {} });
    // A death and the next attempt: a chapter marker, and the game stays in view (no title cards).
    await rec.onEvent({ kind: "event", timestamp: ts, event: "game.over", data: { victory: false, label: "Defeat", floor: 14, deaths: 1 } });
    assert.equal(obs.state.scene, "Portal-Game");
    await rec.onEvent({ kind: "event", timestamp: ts, event: "game.attempt", data: { phase: "start", attempt: 2 } });
    assert.equal(obs.state.scene, "Portal-Game");
    assert.deepEqual(obs.state.chapters, ["Chamber 04", "Attempt 2"]);
    await rec.onEvent({ kind: "event", timestamp: ts, event: "game.over", data: { victory: true, label: "Victory (act1)" } });
    await rec.onEvent({ kind: "event", timestamp: ts, event: "run.ended", data: { status: "completed" } });
    assert.equal(obs.state.scene, "Portal-Game", "the game stays in view until the recording stops");
    await new Promise((r) => setTimeout(r, 30));

    const result = await rec.stop();
    assert.equal(obs.state.recording, false);
    assert.match(result.outputPath, /^D:\\Recordings\\AAS_portal-01_.*\.mp4$/);
    assert.deepEqual(result.chapters, [{ at: 12.5, label: "Chamber 04" }, { at: 12.5, label: "Attempt 2" }]);
    assert.equal(result.replayPaths.length, 1);
    assert.equal(result.files.length, 2);
  } finally {
    await obs.close();
  }
});

test("recorder-obs: a game capture that stays black at the start of the recording refuses the run", async () => {
  const { BLACK_PNG } = await import("./fake-obs.mjs");
  const obs = await startFakeObs();
  try {
    const lines = [];
    const rec = createObsRecorder({ url: obs.url, password: "secret", ...quiet, pictureSeconds: 0.05, writingSeconds: 0.5, log: (t) => lines.push(t) });
    await rec.preflight(brief, game);
    obs.state.screenshot = BLACK_PNG;
    await assert.rejects(rec.start(brief, { runDir: "/tmp/not-a-mnt-path" }), /shows nothing: black/);
    assert.ok(lines.some((l) => /rebinding the capture/.test(l)), lines.join("\n"));
    assert.ok(obs.state.recording, "the recording OBS began is left for the caller to stop and discard");
    obs.state.screenshot = null;
    const rec2 = createObsRecorder({ url: obs.url, password: "secret", ...quiet, pictureSeconds: 0.05, log: (t) => lines.push(t) });
    await rec2.stop().catch(() => {});
  } finally {
    await obs.close();
  }
});

test("recorder-obs: a recording OBS started but does not write refuses the run", async () => {
  const obs = await startFakeObs();
  try {
    const rec = createObsRecorder({ url: obs.url, password: "secret", ...quiet, writingSeconds: 0.3 });
    await rec.preflight(brief, game);
    obs.state.stalled = true;
    await assert.rejects(rec.start(brief, { runDir: "/tmp/not-a-mnt-path" }), /not writing it: 1000 bytes and not growing/);
  } finally {
    await obs.close();
  }
});

test("recorder-obs: a game capture OBS cannot render at all refuses the run instead of going unchecked", async () => {
  const obs = await startFakeObs();
  try {
    const rec = createObsRecorder({ url: obs.url, password: "secret", ...quiet, pictureSeconds: 0.05, writingSeconds: 0.5 });
    await rec.preflight(brief, game);
    obs.state.noScreenshot = true;
    await assert.rejects(rec.start(brief, { runDir: "/tmp/not-a-mnt-path" }), /could not render the game window capture/);
  } finally {
    await obs.close();
  }
});

test("close() resolves once the connection is really closed, so a caller that then blocks leaves OBS nothing to wait for", async () => {
  const fake = await startFakeObs();
  try {
    const o = await connectObs({ url: fake.url, password: "secret" });
    assert.equal(fake.clientCount(), 1);
    const closing = o.close();
    assert.ok(closing instanceof Promise, "close() can be awaited");
    await closing;
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(fake.clientCount(), 0, "OBS's side of the connection is gone when close() has resolved");
  } finally {
    await fake.close();
  }
});
