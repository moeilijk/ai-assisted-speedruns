#!/usr/bin/env node
// Close what the harness started for Balatro (game, bridge, LiveSplit, OBS; Steam when a launcher of this harness
// started it, or always with --steam), gracefully. `aas run` and `aas resume` do the same by themselves when a run
// ends, unless --keep-open; this is the manual command for everything else.
import { closeAll } from "../../packages/core/src/close-all.mjs";
import { loadRecorder, loadTimer } from "../../packages/core/src/plugins.mjs";
import plugin from "./plugin.mjs";
import { loadSettings } from "../../packages/core/src/settings.mjs";

// This game's own settings, then the machine's: the same two files every command reads (settings.mjs).
loadSettings(import.meta.url);

const steam = process.argv.includes("--steam") ? true : "auto";
await closeAll({ plugin, recorder: await loadRecorder("obs"), timer: await loadTimer("livesplit"), steam, log: console.log });
