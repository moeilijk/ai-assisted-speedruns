// The runtime, recorder and timer plugins `aas gui` offers, found the way the CLI finds them (packages/<kind>-<id>):
// the GUI names none of them. Each says what it is (`name`, `ai`, `cli`), what it needs (`setup`) and how it is
// checked (`doctor()`); this module only reads that. AAS_PLUGIN_DIRS adds folders to look in (the tests' own plugins).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PACKAGES } from "../plugins.mjs";
import { readSettings as readEnv } from "../settings.mjs";
import { onPath } from "./checks.mjs";
import { toLocal } from "./windows-paths.mjs";

const dirs = () => [PACKAGES, ...String(process.env.AAS_PLUGIN_DIRS ?? "").split(path.delimiter).filter(Boolean)];
const cache = new Map();

/** Every plugin of one kind: `{ id, file, plugin }`, in id order; a plugin that does not load is left out. */
export async function pluginsOf(kind) {
  const out = [];
  for (const dir of dirs()) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((d) => d.startsWith(`${kind}-`)).sort(); } catch { continue; }
    for (const d of names) {
      const file = path.join(dir, d, "index.mjs");
      if (!fs.existsSync(file)) continue;
      try {
        if (!cache.has(file)) cache.set(file, (await import(pathToFileURL(file).href)).default);
        const plugin = cache.get(file);
        if (plugin?.id) out.push({ id: plugin.id, file, plugin, kind });
      } catch { /* a plugin that does not load is not offered */ }
    }
  }
  return out;
}

/** The runtimes: a mock (`ai` not true) needs no program; an AI is here when its CLI is on the PATH. */
export async function runtimes() {
  // The mock first (it tests the machine without tokens), then the AIs in id order.
  return (await pluginsOf("runtime")).sort((a, b) => (a.plugin.ai === true) - (b.plugin.ai === true)).map(({ id, file, plugin }) => ({
    id,
    file,
    name: plugin.name,
    ai: plugin.ai === true,
    cli: plugin.cli ?? null,
    present: plugin.cli ? Boolean(onPath(plugin.cli)) : true,
    label: plugin.ai === true ? `${plugin.name} (AI run)` : `Mock run (${plugin.name}, no AI)`,
    // The run name's prefix: the CLI's own name for an AI, "mock" for a run no model plays.
    prefix: plugin.ai === true ? (plugin.cli ?? id) : "mock",
  }));
}

/** A setting holds when it has a value, or when the plugin's own default (a function) finds the file it expects. */
export function settingHolds(setting, env = readEnv()) {
  if (!setting) return true;
  const value = toLocal(env[setting.env] ?? "");
  if (value) return fs.existsSync(value);
  try { const d = typeof setting.default === "function" ? setting.default() : null; return Boolean(d) && fs.existsSync(d); } catch { return false; }
}

/** The timers, and whether each is set up (its first setting holds): the Timing choice offers those that are. */
export async function timers() {
  const env = readEnv();
  return (await pluginsOf("timer")).map(({ id, file, plugin }) => ({ id, file, name: plugin.name ?? id, launch: plugin.launch ?? null, ready: settingHolds(plugin.setup?.settings?.[0], env) }));
}

/** The recorders a game says fit it (its `setup.recorders`), in its order; "no recording" last, never a valid run. */
export async function recordersFor(setup) {
  const all = await pluginsOf("recorder");
  const named = (setup?.recorders ?? []).map((id) => all.find((r) => r.id === id)).filter(Boolean);
  const none = all.find((r) => r.id === "null");
  return [...named.filter((r) => r.id !== "null"), ...(none ? [none] : [])].map(({ id, plugin }) => ({ id, name: plugin.name ?? id, launch: plugin.launch ?? null }));
}

/** The plugins with a Setup section of their own (`setup`), for the Setup tab: `{ kind, id, name, setup }`. */
export async function setupPlugins() {
  const out = [];
  for (const kind of ["runtime", "recorder", "timer"]) for (const { id, file, plugin } of await pluginsOf(kind)) if (plugin.setup) out.push({ kind, id, file, name: plugin.name ?? id, setup: plugin.setup, plugin });
  return out;
}
