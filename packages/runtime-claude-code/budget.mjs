// The user's Claude plan usage, from the same endpoint Claude Code's /usage uses
// (OAuth token from ~/.claude/.credentials.json; the token never leaves this
// machine except towards api.anthropic.com). A run may only use part of the
// weekly limit, so that the rest stays available for other work:
// AAS_BUDGET_WEEKLY_MAX (percent, default 50). `aas budget` prints the stand;
// aas run/resume refuse to start above the limit and a running session is
// interrupted (resumable) when it crosses it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const WEEKLY_MAX_DEFAULT = 50;
export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const CREDENTIALS_FILE = path.join(os.homedir(), ".claude", ".credentials.json");
export const weeklyMax = () => { const n = Number(process.env.AAS_BUDGET_WEEKLY_MAX); return Number.isFinite(n) && n > 0 ? n : WEEKLY_MAX_DEFAULT; };

export function normalizeUsage(body, at = new Date()) {
  const bucket = (b) => ({ percent: typeof b?.utilization === "number" ? b.utilization : null, resetsAt: b?.resets_at ?? null });
  return { at: at.toISOString(), fiveHour: bucket(body?.five_hour), weekly: bucket(body?.seven_day), limits: Array.isArray(body?.limits) ? body.limits.map((l) => ({ kind: l.kind, percent: l.percent, resetsAt: l.resets_at ?? null })) : [] };
}

export async function readUsage({ credentialsFile = CREDENTIALS_FILE, fetchImpl = globalThis.fetch } = {}) {
  if (!fs.existsSync(credentialsFile)) throw new Error(`no Claude login found (${credentialsFile}); log in to Claude Code first`);
  const token = JSON.parse(fs.readFileSync(credentialsFile, "utf8"))?.claudeAiOauth?.accessToken;
  if (!token) throw new Error("no OAuth token in the Claude credentials file");
  const res = await fetchImpl(USAGE_URL, { headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`usage endpoint answered ${res.status}${res.status === 401 ? " (token expired: open Claude Code once so that it refreshes)" : ""}`);
  return normalizeUsage(await res.json());
}

const when = (iso) => (iso ? new Date(iso).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "?");
/** Whether a run may (still) use the plan: the week must stay under `max` percent. */
export function budgetVerdict(usage, max = weeklyMax()) {
  const p = usage.weekly.percent;
  const ok = p === null || p < max;
  return { ok, percent: p, max, detail: `week ${p ?? "?"}% used of the plan, limit for runs ${max}% (resets ${when(usage.weekly.resetsAt)}); 5-hour window ${usage.fiveHour.percent ?? "?"}% (resets ${when(usage.fiveHour.resetsAt)})` };
}
export async function checkBudget(opts = {}) {
  const usage = await readUsage(opts);
  return { ...budgetVerdict(usage, opts.max), usage };
}

