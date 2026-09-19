#!/usr/bin/env node
// Prints a game plugin's doctor rows as JSON. A separate process, so the plugin reads the settings as they are now
// (a plugin reads them when it loads, and the GUI changes them while it runs).
//
// The settings are loaded here first, the same two files every other command reads: this game's own
// `.local/games/<game>.env` and then `.env` (settings.mjs). Without that the plugin's checks run with none of the
// game's own variables set and report a game that is set up as one that is not.
import { loadSettings } from "../settings.mjs";

const file = process.argv[2];
try {
  loadSettings(file);
  const { default: plugin } = await import(new URL(`file://${file}`).href);
  console.log(JSON.stringify((await plugin.doctor?.({})) ?? []));
} catch (e) {
  console.log(JSON.stringify([{ ok: false, what: "checks", detail: String(e?.message ?? e) }]));
}
