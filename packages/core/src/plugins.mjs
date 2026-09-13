// Plugin loading by id (packages/<kind>-<id>) or by module path.
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { CORE_DIR, loadGamePlugin } from "./mcp-client.mjs";

export const PACKAGES = path.resolve(CORE_DIR, "..");
export const FRAMEWORK_VERSION = JSON.parse(fs.readFileSync(path.join(CORE_DIR, "package.json"), "utf8")).version;

async function load(kind, idOrPath) {
  const file = /\.m?js$/.test(idOrPath) ? path.resolve(idOrPath) : path.join(PACKAGES, `${kind}-${idOrPath}`, "index.mjs");
  if (!fs.existsSync(file)) throw new Error(`Unknown ${kind} "${idOrPath}" (no ${file}).`);
  const loaded = await import(pathToFileURL(file).href);
  return loaded.default ?? loaded;
}
export const loadRuntime = (id) => load("runtime", id);
export const loadRecorder = (id) => load("recorder", id);
export const loadTimer = (id) => load("timer", id);
export { loadGamePlugin };
