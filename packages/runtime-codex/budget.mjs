// The ChatGPT plan's stand for Codex runs (see the notes below).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// --- Codex (the ChatGPT plan) ---------------------------------------------------------------------------------
// Codex writes its own limit stand into every rollout after each turn (`token_count` events carry `rate_limits`:
// `primary.used_percent` of a window of `window_minutes`, `resets_at`, `plan_type`). No endpoint is asked: the
// newest rollout under $CODEX_HOME/sessions is the stand as Codex last saw it, from any session on this machine.
// Runs stay under AAS_CODEX_BUDGET_MAX percent (default 50) of that window, like the Claude rule.
export const CODEX_MAX_DEFAULT = 50;
export const codexMax = () => { const n = Number(process.env.AAS_CODEX_BUDGET_MAX); return Number.isFinite(n) && n > 0 ? n : CODEX_MAX_DEFAULT; };
export const codexHome = (env = process.env) => env.CODEX_HOME || path.join(env.HOME ?? os.homedir(), ".codex");

/** The last `rate_limits` in a rollout file, or null. */
export function rateLimitsOf(file) {
  let last = null;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const i = line.indexOf('"rate_limits":{');
    if (i < 0) continue;
    try { const r = JSON.parse(line); const rl = r?.payload?.rate_limits ?? r?.rate_limits ?? findKey(r, "rate_limits"); if (rl?.primary) last = { rl, at: r.timestamp ?? null }; } catch { /* partial line */ }
  }
  return last;
}
function findKey(obj, key, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 6) return null;
  if (key in obj) return obj[key];
  for (const v of Object.values(obj)) { const r = findKey(v, key, depth + 1); if (r) return r; }
  return null;
}
/** Every rollout under the sessions folder, newest first. */
export function rolloutFiles(home = codexHome()) {
  const root = path.join(home, "sessions");
  if (!fs.existsSync(root)) return [];
  const out = [];
  const walk = (dir, depth) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory() && depth < 4) walk(p, depth + 1); else if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) out.push(p); } };
  walk(root, 0);
  return out.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}
/** The Codex plan's stand as last recorded on this machine: percent of the primary window used, its length, its reset. */
export function readCodexUsage({ home = codexHome(), files = null } = {}) {
  for (const file of files ?? rolloutFiles(home).slice(0, 20)) {
    const found = rateLimitsOf(file);
    if (!found) continue;
    const p = found.rl.primary;
    return { at: found.at ?? new Date(fs.statSync(file).mtimeMs).toISOString(), file, percent: typeof p.used_percent === "number" ? p.used_percent : null, windowMinutes: p.window_minutes ?? null, resetsAt: p.resets_at ? new Date(p.resets_at * 1000).toISOString() : null, planType: found.rl.plan_type ?? null };
  }
  return { at: null, file: null, percent: null, windowMinutes: null, resetsAt: null, planType: null };
}
export function codexVerdict(usage, max = codexMax()) {
  const p = usage.percent;
  const ok = p === null || p < max;
  const window = usage.windowMinutes ? (usage.windowMinutes % 1440 === 0 ? `${usage.windowMinutes / 1440}-day` : `${Math.round(usage.windowMinutes / 60)}-hour`) : "current";
  const seen = usage.at ? new Date(usage.at).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "never";
  return { ok, percent: p, max, detail: p === null ? `no Codex limit stand recorded on this machine yet (a first codex session records it)` : `${window} window ${p}% used of the ChatGPT plan${usage.planType ? ` (${usage.planType})` : ""}, limit for runs ${max}% (resets ${when(usage.resetsAt)}; stand as Codex last saw it, ${seen})` };
}
export function checkCodexBudget(opts = {}) {
  const usage = readCodexUsage(opts);
  return { ...codexVerdict(usage, opts.max), usage };
}

const when = (iso) => (iso ? new Date(iso).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "?");
