import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { budgetVerdict, normalizeUsage, readUsage } from "../budget.mjs";

const body = { five_hour: { utilization: 21, resets_at: "2026-09-10T13:39:59Z" }, seven_day: { utilization: 26, resets_at: "2026-09-16T16:59:59Z" }, limits: [{ kind: "session", percent: 21 }, { kind: "weekly_all", percent: 26 }] };

test("usage is normalised and judged against the weekly limit for runs", () => {
  const u = normalizeUsage(body);
  assert.equal(u.weekly.percent, 26);
  assert.equal(u.fiveHour.percent, 21);
  assert.equal(budgetVerdict(u, 50).ok, true);
  assert.equal(budgetVerdict(u, 26).ok, false);
  assert.match(budgetVerdict(u, 50).detail, /week 26% used.*limit for runs 50%/);
  assert.equal(budgetVerdict(normalizeUsage({}), 50).ok, true, "unknown usage does not block");
});

test("readUsage sends the OAuth token from the credentials file to the usage endpoint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aas-budget-"));
  const file = join(dir, "credentials.json");
  writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: "tok-123" } }));
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, auth: init.headers.Authorization }; return { ok: true, json: async () => body }; };
  const u = await readUsage({ credentialsFile: file, fetchImpl });
  assert.equal(seen.url, "https://api.anthropic.com/api/oauth/usage");
  assert.equal(seen.auth, "Bearer tok-123");
  assert.equal(u.weekly.percent, 26);
  await assert.rejects(readUsage({ credentialsFile: file, fetchImpl: async () => ({ ok: false, status: 401 }) }), /401.*expired/);
  await assert.rejects(readUsage({ credentialsFile: join(dir, "missing.json"), fetchImpl }), /no Claude login/);
});

