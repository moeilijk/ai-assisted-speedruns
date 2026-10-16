// Plugin loading by id (packages/<kind>-<id>) or by module path.
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { CORE_DIR, loadGamePlugin } from "./mcp-client.mjs";

export const PACKAGES = path.resolve(CORE_DIR, "..");
/** The AAS Archive, where published runs are submitted. */
export { ARCHIVE_URL } from "./versions.mjs";
export const FRAMEWORK_VERSION = JSON.parse(fs.readFileSync(path.join(CORE_DIR, "package.json"), "utf8")).version;

/**
 * The tooling a session runs with: the release version, the commit of the clone (null outside a git clone), and
 * whether tracked files differ from that commit (null when that cannot be read). Each `run.started` carries it.
 */
export function toolingIdentity() {
  const git = (...args) => {
    try { return execFileSync("git", ["-C", path.resolve(PACKAGES, ".."), ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; }
  };
  const commit = git("rev-parse", "HEAD");
  const status = commit ? git("status", "--porcelain", "--untracked-files=no") : null;
  return { version: FRAMEWORK_VERSION, commit, modified: status === null ? null : status !== "" };
}

/** Where a plugin lives: a module path as given, or packages/<kind>-<id>/index.mjs. */
export function pluginFile(kind, idOrPath) {
  const file = /\.m?js$/.test(idOrPath) ? path.resolve(idOrPath) : path.join(PACKAGES, `${kind}-${idOrPath}`, "index.mjs");
  if (!fs.existsSync(file)) throw new Error(`Unknown ${kind} "${idOrPath}" (no ${file}).`);
  return file;
}

/**
 * The sha256 of a plugin as it ran. A plugin that is a package directory (packages/<kind>-<id>/index.mjs) is
 * hashed over every `.mjs`, `.json` and `.md` in that directory, `test/` left out because it never runs in a run:
 * the relative path and the sha256 of each file, sorted by path, one `<path> <sha256>` line each, and the sha256
 * of those lines. A plugin given as a single module file is that file's own hash.
 *
 * Why a number and not a name: what drove a run is the publisher's word as long as a bundle only names its
 * runtime, and a runtime plugin declares its own `ai`. An archive that knows a runtime knows this number, so it
 * reads what ran instead of what the bundle claims about it (SPEC §3).
 */
export function pluginDigest(file) {
  const abs = path.resolve(file);
  const dir = path.dirname(abs);
  const inPackage = path.basename(abs) === "index.mjs" && path.dirname(dir) === PACKAGES;
  const one = (f) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
  if (!inPackage) return createHash("sha256").update(`${path.basename(abs)} ${one(abs)}\n`).digest("hex");
  const walk = (d, prefix = "") =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? (e.name === "test" || e.name === "node_modules" ? [] : walk(path.join(d, e.name), `${prefix}${e.name}/`)) : [`${prefix}${e.name}`]);
  const lines = walk(dir)
    .filter((p) => /\.(mjs|json|md)$/.test(p))
    .sort()
    .map((p) => `${p} ${one(path.join(dir, p))}`);
  return createHash("sha256").update(`${lines.join("\n")}\n`).digest("hex");
}

async function load(kind, idOrPath) {
  const loaded = await import(pathToFileURL(pluginFile(kind, idOrPath)).href);
  return loaded.default ?? loaded;
}
/** A runtime names itself for people (`name`, e.g. "Claude Code") next to its `id`; a bundle carries both. */
export const loadRuntime = async (id) => {
  const runtime = await load("runtime", id);
  if (typeof runtime?.name !== "string" || !runtime.name) throw new Error(`runtime "${id}" has no name: every runtime plugin names itself ({ id, name }).`);
  return runtime;
};

/**
 * Who drove a run, as a statement and a bundle carry it: the runtime's id and version, whether a model plays
 * (`ai`), and `sha256`, the plugin as it ran (pluginDigest). Null for `sha256` when the plugin cannot be read
 * from here, which is what a bundle then says: nothing is guessed.
 */
/**
 * pluginDigest as the plugin stood at a commit of this repository, read from git rather than the disk: the same files,
 * the same order, the same hash. A run records the tooling commit it ran on, so the runtime that drove it can be named
 * by its hash after the tooling has moved on. null when git cannot answer (no history, a commit it does not know).
 */
export function pluginDigestAt(file, commit) {
  const abs = path.resolve(file);
  const repo = path.dirname(PACKAGES);
  const rel = (p) => path.relative(repo, p).split(path.sep).join("/");
  const git = (args) => execFileSync("git", ["-C", repo, ...args], { maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  try {
    const one = (p) => createHash("sha256").update(git(["show", `${commit}:${p}`])).digest("hex");
    const dir = path.dirname(abs);
    const inPackage = path.basename(abs) === "index.mjs" && path.dirname(dir) === PACKAGES;
    if (!inPackage) return createHash("sha256").update(`${path.basename(abs)} ${one(rel(abs))}\n`).digest("hex");
    const prefix = `${rel(dir)}/`;
    const lines = git(["ls-tree", "-r", "--name-only", commit, "--", rel(dir)]).toString("utf8").split("\n").filter(Boolean)
      .map((p) => p.slice(prefix.length))
      .filter((p) => !/(^|\/)(test|node_modules)\//.test(p) && /\.(mjs|json|md)$/.test(p))
      .sort()
      .map((p) => `${p} ${one(prefix + p)}`);
    return lines.length ? createHash("sha256").update(`${lines.join("\n")}\n`).digest("hex") : null;
  } catch { return null; }
}

export function runtimeIdentity(runtime, idOrPath) {
  let sha256 = null;
  try { sha256 = pluginDigest(pluginFile("runtime", idOrPath ?? runtime?.id)); } catch { sha256 = null; }
  return { id: runtime?.id ?? null, version: runtime?.version ?? null, ai: runtime?.ai ?? null, sha256 };
}
export const loadRecorder = (id) => load("recorder", id);
export const loadTimer = (id) => load("timer", id);
export { loadGamePlugin };
