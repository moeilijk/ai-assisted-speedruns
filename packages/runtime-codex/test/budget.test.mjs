// The Codex plan's stand comes from the rollouts Codex writes; runs stay under AAS_CODEX_BUDGET_MAX.
import { test } from "node:test";
import assert from "node:assert/strict";

test("the Codex plan's stand comes from the newest rollout's rate_limits; runs stay under AAS_CODEX_BUDGET_MAX", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { readCodexUsage, codexVerdict } = await import("../budget.mjs");
  const home = mkdtempSync(join(tmpdir(), "aas-codex-budget-"));
  const dir = join(home, "sessions", "2026", "09", "13");
  mkdirSync(dir, { recursive: true });
  const line = (pct) => JSON.stringify({ timestamp: "2026-09-13T12:25:40.000Z", type: "event_msg", payload: { type: "token_count", info: null, rate_limits: { limit_id: "codex", primary: { used_percent: pct, window_minutes: 43200, resets_at: 1789413485 }, secondary: null, plan_type: "plus" } } });
  writeFileSync(join(dir, "rollout-2026-09-13T12-25-34-abc.jsonl"), `{"type":"session_meta"}\n${line(30)}\n${line(67)}\n`);
  const u = readCodexUsage({ home });
  assert.equal(u.percent, 67, "the last stand in the file");
  assert.equal(u.windowMinutes, 43200);
  assert.equal(u.planType, "plus");
  assert.equal(codexVerdict(u, 50).ok, false);
  assert.equal(codexVerdict(u, 70).ok, true);
  assert.match(codexVerdict(u, 50).detail, /30-day window 67% used.*limit for runs 50%/);
  assert.equal(codexVerdict(readCodexUsage({ home: join(home, "nowhere") }), 50).ok, true, "no stand recorded does not block");
});
