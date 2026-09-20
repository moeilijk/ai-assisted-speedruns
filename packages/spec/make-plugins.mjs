#!/usr/bin/env node
// Writes packages/spec/plugins.json: every plugin this release ships — runtime, recorder, timer and game — with
// the version it declares and a sha256 over its own directory. The point is not the hash but the pair: a plugin
// whose files changed must not still carry the version it had before, or the number says nothing about what ran.
//
//   node packages/spec/make-plugins.mjs [--write]
//
// --write refuses while a plugin's sha256 has changed and its version has not; it names them and says what to do.
// So the loop is: change a plugin, run this, it refuses, set the plugin's version to the release you are making,
// run it again. packages/spec/test/plugins.test.mjs fails while plugins.json is out of date, so neither step can
// be skipped quietly. runtimes.json (SPEC §3, what the archive holds a bundle against) stays its own file with its
// own shape; the three runtime rows here carry the same numbers.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGES, loadRuntime, loadRecorder, loadTimer, loadGamePlugin, runtimeIdentity } from "../core/src/plugins.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PLUGINS_FILE = path.join(HERE, "plugins.json");
const GAMES = path.resolve(PACKAGES, "..", "games");

export const COVERS =
  "every .mjs, .json and .md of the plugin's own directory, test/ and node_modules/ excluded, each as " +
  "\"<relative path> <sha256 of its bytes>\", sorted by path, joined with newlines and hashed";

/** The same walk pluginDigest does for a package, over any directory: what changed in this plugin, and nothing else. */
export function dirDigest(dir) {
  const one = (f) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
  const walk = (d, prefix = "") =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? (e.name === "test" || e.name === "node_modules" ? [] : walk(path.join(d, e.name), `${prefix}${e.name}/`)) : [`${prefix}${e.name}`]);
  const lines = walk(dir).filter((p) => /\.(mjs|json|md)$/.test(p)).sort().map((p) => `${p} ${one(path.join(dir, p))}`);
  return createHash("sha256").update(`${lines.join("\n")}\n`).digest("hex");
}

const dirsIn = (root, prefix) =>
  fs.readdirSync(root).filter((d) => d.startsWith(prefix) && fs.existsSync(path.join(root, d, prefix === "" ? "plugin.mjs" : "index.mjs"))).sort();

/** Every plugin in this checkout, in kind then directory order. */
export async function pluginRows() {
  const rows = [];
  const add = (kind, dir, plugin, extra = {}) =>
    rows.push({ kind, dir, id: plugin.id ?? null, name: plugin.name ?? null, version: plugin.version ?? null, ...extra, sha256: dirDigest(dir) });

  for (const d of dirsIn(PACKAGES, "runtime-")) {
    const id = d.slice("runtime-".length);
    const plugin = await loadRuntime(id);
    add("runtime", path.join(PACKAGES, d), plugin, { ai: runtimeIdentity(plugin, id).ai });
  }
  for (const d of dirsIn(PACKAGES, "recorder-")) add("recorder", path.join(PACKAGES, d), await loadRecorder(d.slice("recorder-".length)));
  for (const d of dirsIn(PACKAGES, "timer-")) add("timer", path.join(PACKAGES, d), await loadTimer(d.slice("timer-".length)));
  for (const d of dirsIn(GAMES, "")) {
    const plugin = await loadGamePlugin(path.join(GAMES, d, "plugin.mjs"));
    add("game", path.join(GAMES, d), plugin, { stub: plugin.stub === true });
  }
  return rows.map((r) => ({ ...r, dir: path.relative(path.resolve(PACKAGES, ".."), r.dir).split(path.sep).join("/") }));
}

export const readPublished = () => {
  try { return JSON.parse(fs.readFileSync(PLUGINS_FILE, "utf8")); } catch { return null; }
};

/**
 * The rows whose files changed while their version stayed the same: what this file exists to catch. A row that is
 * new here has nothing to compare against, so it is not one of them.
 */
export function staleVersions(rows, published = readPublished()) {
  const before = new Map((published?.plugins ?? []).map((p) => [`${p.kind}/${p.dir}`, p]));
  return rows.filter((r) => {
    const was = before.get(`${r.kind}/${r.dir}`);
    return was && was.sha256 !== r.sha256 && was.version === r.version;
  });
}

export async function makePlugins({ write = false, log = console.log } = {}) {
  const rows = await pluginRows();
  const stale = staleVersions(rows);
  if (write && stale.length) {
    for (const r of stale) log(`${r.dir} changed and still says ${r.version}`);
    throw new Error(`${stale.length} plugin(s) changed without a new version: set each one's version to the release you are making, then run this again`);
  }
  const data = { covers: COVERS, generated_by: "node packages/spec/make-plugins.mjs --write", plugins: rows };
  const text = `${JSON.stringify(data, null, 2)}\n`;
  if (write) { fs.writeFileSync(PLUGINS_FILE, text); log(`wrote ${PLUGINS_FILE}`); }
  for (const r of rows) log(`${r.kind.padEnd(9)} ${r.dir.padEnd(30)} ${String(r.version).padEnd(8)} ${r.sha256}`);
  return data;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await makePlugins({ write: process.argv.includes("--write") });
