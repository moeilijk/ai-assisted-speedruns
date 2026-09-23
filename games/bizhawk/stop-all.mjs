#!/usr/bin/env node
// Close what the harness started for BizHawk (EmuHawk, LiveSplit, OBS), gracefully. `aas run` and `aas resume` do the
// same by themselves when a run ends, unless --keep-open; this is the manual command for everything else.
import { closeAll } from "../../packages/core/src/close-all.mjs";
import { loadRecorder, loadTimer } from "../../packages/core/src/plugins.mjs";
import plugin from "./plugin.mjs";
import { loadSettings } from "../../packages/core/src/settings.mjs";

loadSettings(import.meta.url);
await closeAll({ plugin, recorder: await loadRecorder("obs"), timer: await loadTimer("livesplit"), steam: false, log: console.log });
