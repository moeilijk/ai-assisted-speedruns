#!/usr/bin/env node
// Verification against a real OBS: preflight (scene collection, no mic),
// a short recording with a fake playback event and a chapter, stop, and the
// output file. Needs OBS running with the WebSocket server enabled and
// AAS_OBS_PASSWORD (from .env). Usage: node packages/recorder-obs/smoke.mjs [--seconds 6]
import fs from "node:fs";
import { createObsRecorder, toLocalPath } from "./index.mjs";

const seconds = Number(process.argv[process.argv.indexOf("--seconds") + 1]) || 6;
const rec = createObsRecorder({ outroSeconds: 1 });
const game = { id: "portal", name: "Portal", processName: "hl2.exe" };
const brief = { id: "obs-smoke", category: { game: "portal", goal: "credits" }, model: "smoke" };
await rec.preflight(brief, game);
console.log("PASS: preflight (collection AAS-portal, no microphone)");
const { t0 } = await rec.start(brief, { runDir: process.cwd(), overlayUrl: "http://127.0.0.1:8765/" });
console.log(`PASS: recording started, t0 ${t0.toISOString()}`);
const at = (s) => new Date(t0.getTime() + s * 1000).toISOString();
await new Promise((r) => setTimeout(r, 1500));
await rec.onEvent({ kind: "event", timestamp: at(1.5), event: "game.playback", data: { phase: "start", planned_ticks: 67 } });
await new Promise((r) => setTimeout(r, 1000));
await rec.onEvent({ kind: "event", timestamp: at(2.5), event: "game.milestone", data: { label: "Smoke chapter", chapter: true } });
await new Promise((r) => setTimeout(r, Math.max(0, seconds - 3) * 1000));
await rec.onEvent({ kind: "event", timestamp: at(seconds), event: "run.ended", data: {} });
const result = await rec.stop();
console.log(`PASS: recording stopped: ${result.outputPath}`);
const local = toLocalPath(result.outputPath);
const size = fs.existsSync(local) ? fs.statSync(local).size : null;
console.log(size ? `PASS: file ${local} (${(size / 1048576).toFixed(1)} MB)` : `WARN: file not visible from here: ${local}`);
console.log(`chapters: ${JSON.stringify(result.chapters)}`);
