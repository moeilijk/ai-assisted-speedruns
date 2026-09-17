#!/usr/bin/env node
// Prints the active playback devices as JSON (the GUI's choice of the quiet device). A separate process, because
// audio-route.mjs reads its settings from the environment when it loads.
const { playbackDevices } = await import("../windows/audio-route.mjs");
try { console.log(JSON.stringify(playbackDevices())); } catch { console.log("[]"); }
