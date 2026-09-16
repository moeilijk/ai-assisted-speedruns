// Plugin loading by id (packages/<kind>-<id>) or by module path.
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { CORE_DIR, loadGamePlugin } from "./mcp-client.mjs";

export const PACKAGES = path.resolve(CORE_DIR, "..");
/** The AAS Archive, where published runs are submitted. */
export const ARCHIVE_URL = "https://ai-assisted-speedruns.org";
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

async function load(kind, idOrPath) {
  const file = /\.m?js$/.test(idOrPath) ? path.resolve(idOrPath) : path.join(PACKAGES, `${kind}-${idOrPath}`, "index.mjs");
  if (!fs.existsSync(file)) throw new Error(`Unknown ${kind} "${idOrPath}" (no ${file}).`);
  const loaded = await import(pathToFileURL(file).href);
  return loaded.default ?? loaded;
}
/** A runtime names itself for people (`name`, e.g. "Claude Code") next to its `id`; a bundle carries both. */
export const loadRuntime = async (id) => {
  const runtime = await load("runtime", id);
  if (typeof runtime?.name !== "string" || !runtime.name) throw new Error(`runtime "${id}" has no name: every runtime plugin names itself ({ id, name }).`);
  return runtime;
};
export const loadRecorder = (id) => load("recorder", id);
export const loadTimer = (id) => load("timer", id);
export { loadGamePlugin };
