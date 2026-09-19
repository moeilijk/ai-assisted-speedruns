#!/usr/bin/env node
// Writes packages/spec/runtimes.json: every runtime plugin this release ships, with the sha256 an archive holds a
// bundle against (SPEC §3). Never written by hand — the number has to be the one `aas publish` puts in
// harness.plugins.runtime.sha256, and the only way to be sure of that is to ask the same function for it.
//
//   node packages/spec/make-runtimes.mjs [--write]
//
// A runtime plugin that changes gets a new hash, so this file is made again with every release that touches one;
// packages/core/test/mock.test.mjs fails while it is out of date.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGES, loadRuntime, runtimeIdentity } from "../core/src/plugins.mjs";

export const RUNTIMES_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "runtimes.json");

/** Every packages/runtime-* in this checkout, in name order. */
export const runtimeIds = () =>
  fs.readdirSync(PACKAGES).filter((d) => d.startsWith("runtime-") && fs.existsSync(path.join(PACKAGES, d, "index.mjs"))).map((d) => d.slice("runtime-".length)).sort();

export async function runtimeRows() {
  const rows = [];
  for (const id of runtimeIds()) {
    const plugin = await loadRuntime(id);
    const { sha256, ai, version } = runtimeIdentity(plugin, id);
    rows.push({ id: plugin.id, name: plugin.name, version, ai, sha256 });
  }
  return rows;
}

export async function makeRuntimes({ write = false, log = console.log } = {}) {
  const data = {
    // What the hash is over, because an archive cannot guess it: every .mjs, .json and .md of the plugin's package
    // directory, `test/` left out, each as "<relative path> <sha256 of its bytes>", sorted by path, joined with
    // newlines and hashed (packages/core/src/plugins.mjs, pluginDigest). The same function writes the number a
    // bundle carries, so the two cannot drift.
    covers: "every .mjs, .json and .md of packages/runtime-<id>/, test/ excluded; see pluginDigest in packages/core/src/plugins.mjs",
    generated_by: "node packages/spec/make-runtimes.mjs --write",
    runtimes: await runtimeRows(),
  };
  const text = `${JSON.stringify(data, null, 2)}\n`;
  if (write) { fs.writeFileSync(RUNTIMES_FILE, text); log(`wrote ${RUNTIMES_FILE}`); }
  for (const r of data.runtimes) log(`${r.id.padEnd(14)} ${r.ai ? "ai    " : "no-ai "} ${r.sha256}`);
  return data;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await makeRuntimes({ write: process.argv.includes("--write") });
