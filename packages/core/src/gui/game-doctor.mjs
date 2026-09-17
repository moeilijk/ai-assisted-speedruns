#!/usr/bin/env node
// Prints a game plugin's doctor rows as JSON. A separate process, so the plugin reads the .env as it is now (plugins
// read their settings when they load, and the GUI changes them while it runs).
const file = process.argv[2];
try {
  const { default: plugin } = await import(new URL(`file://${file}`).href);
  console.log(JSON.stringify((await plugin.doctor?.({})) ?? []));
} catch (e) {
  console.log(JSON.stringify([{ ok: false, what: "checks", detail: String(e?.message ?? e) }]));
}
