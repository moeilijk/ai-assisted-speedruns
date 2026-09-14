// `aas check` against portal-agent's published evidence (the schema 2 fixture)
// and against synthetic invalid input.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkRun } from "../src/check-run.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const evidence = resolve(process.env.AAS_PORTAL_AGENT_DIR || join(here, "..", "..", "..", ".local", "portal-agent"), "evidence");
const status = (report, name) => report.results.find((r) => r.requirement === name)?.status;

test("portal-agent evidence: timeline and summary valid, other files reported missing", { skip: !existsSync(evidence) && "portal-agent not checked out" }, () => {
  const report = checkRun(evidence);
  assert.equal(status(report, "timeline format"), "met");
  assert.equal(report.records, 6925);
  assert.equal(status(report, "summary.json"), "met");
  assert.equal(report.summary.schema_version, 2);
  for (const name of ["tools.json", "AGENTS.md", "documentation.md", "runtime-config", "manifest.json"]) {
    assert.equal(status(report, name), "unmet", name);
  }
});

test("invalid timeline and manifest mismatch are detected", () => {
  const dir = mkdtempSync(join(tmpdir(), "aas-check-"));
  writeFileSync(join(dir, "session.sanitized.jsonl"), [
    JSON.stringify({ sequence: 1, timestamp: "2026-09-09T10:00:00.000+02:00", elapsed_seconds: 0, kind: "tool_call", call: "call-00001", name: "x_exec", input: "return 1" }),
    JSON.stringify({ sequence: 3, timestamp: "2026-09-09T10:00:01.000+02:00", elapsed_seconds: 1, kind: "tool_result", call: "call-00001", output: [{ type: "image", data: "AAAA" }] }),
  ].join("\n"));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ version: 1, files: [{ path: "session.sanitized.jsonl", bytes: 1, sha256: "00" }] }));
  const report = checkRun(dir);
  assert.equal(status(report, "timeline format"), "invalid");
  assert.match(report.results.find((r) => r.requirement === "timeline format").detail, /sequence 3.*part type "image"/);
  assert.equal(status(report, "manifest.json"), "invalid");
  assert.equal(status(report, "summary.json"), "unmet");
});

test("a model the run did not ask for is reported (silent fallback)", () => {
  const dir = mkdtempSync(join(tmpdir(), "aas-check-model-"));
  const base = {
    schema_version: 2, time_zone: "Europe/Amsterdam", run_dates: "2026-09-09 to 2026-09-09",
    started_at: "2026-09-09T10:00:00.000+02:00", completed_at: null, ended_at: "2026-09-09T10:01:00.000+02:00",
    source_records: 0, exported_records: 0, omitted_records: 0, removed_images: 0, redactions: {},
    elapsed_to_completion_seconds: null, elapsed_including_post_completion_seconds: 60,
    last_reported_thread_token_usage: {}, export_notes: [],
  };
  const report = (summary) => { writeFileSync(join(dir, "summary.json"), JSON.stringify(summary)); return checkRun(dir); };
  const problems = (r) => r.results.find((x) => x.requirement === "summary.json")?.detail ?? "";

  const fell_back = report({ ...base, models: [{ model: "claude-haiku-4-5-20251001", reasoning_effort: null }], requested: { model: "claude-opus-5", reasoning_effort: null } });
  assert.match(problems(fell_back), /requested model claude-opus-5 but the session used claude-haiku/);

  const honest = report({ ...base, models: [{ model: "claude-opus-5", reasoning_effort: null }], requested: { model: "claude-opus-5", reasoning_effort: null } });
  assert.doesNotMatch(problems(honest), /requested model/);
});

test("a run made without a recording is invalid", () => {
  const dir = mkdtempSync(join(tmpdir(), "aas-check-norec-"));
  const base = {
    schema_version: 3, time_zone: "Europe/Amsterdam", run_dates: "2026-09-09 to 2026-09-09",
    started_at: "2026-09-09T10:00:00.000+02:00", completed_at: null, ended_at: "2026-09-09T10:01:00.000+02:00",
    source_records: 0, exported_records: 0, omitted_records: 0, removed_images: 0, redactions: {},
    elapsed_to_completion_seconds: null, elapsed_including_post_completion_seconds: 60,
    last_reported_thread_token_usage: {}, export_notes: [],
    category: { game: "portal", build: "5135", goal: "credits" }, harness: { version: "0.1.0" },
  };
  const report = (recording) => { writeFileSync(join(dir, "summary.json"), JSON.stringify({ ...base, recording })); return checkRun(dir).results.find((x) => x.requirement === "summary.json"); };
  for (const recording of [{ recorder: "null" }, { recorder: null }]) {
    const r = report(recording);
    assert.equal(r.status, "invalid");
    assert.match(r.detail, /no recording was made .*a run without a recording is not a valid run/);
  }
  assert.doesNotMatch(report({ recorder: "obs" }).detail, /no recording was made/);
});

test("a victory before a goal extension does not reach the extended goal", () => {
  const dir = mkdtempSync(join(tmpdir(), "aas-check-goal-"));
  const ev = (event, data) => JSON.stringify({ timestamp: "2026-09-13T10:00:00.000+02:00", kind: "event", event, data });
  const reached = (lines) => {
    writeFileSync(join(dir, "session.sanitized.jsonl"), lines.join("\n") + "\n");
    writeFileSync(join(dir, "summary.json"), JSON.stringify({ completed_at: null }));
    return checkRun(dir).results.find((x) => x.requirement === "goal reached").status;
  };
  assert.equal(reached([ev("game.over", { victory: true, label: "Victory (act1)" })]), "met");
  assert.equal(reached([ev("game.over", { victory: true, label: "Victory (act1)" }), ev("game.goal", { from: "act1", to: "act3" })]), "unmet");
  assert.equal(reached([ev("game.over", { victory: true }), ev("game.goal", { from: "act1", to: "act3" }), ev("game.over", { victory: true, label: "Victory" })]), "met");
});

test("a resume that extended a reached goal does not bind the published run's human axis", () => {
  const dir = mkdtempSync(join(tmpdir(), "aas-check-ext-"));
  const ev = (timestamp, event, data = {}) => JSON.stringify({ timestamp, kind: "event", event, data });
  const base = {
    schema_version: 2, time_zone: "Europe/Amsterdam", run_dates: "2026-09-13 to 2026-09-13",
    started_at: "2026-09-13T10:51:00.000+02:00", completed_at: "2026-09-13T11:14:00.000+02:00", ended_at: "2026-09-13T15:45:00.000+02:00",
    source_records: 0, exported_records: 0, omitted_records: 0, removed_images: 0, redactions: {},
    elapsed_to_completion_seconds: 1380, elapsed_including_post_completion_seconds: 17700,
    last_reported_thread_token_usage: {}, export_notes: [], category: { human: "none" },
  };
  const problems = (lines) => {
    writeFileSync(join(dir, "session.sanitized.jsonl"), lines.join("\n") + "\n");
    writeFileSync(join(dir, "summary.json"), JSON.stringify(base));
    return checkRun(dir).results.find((x) => x.requirement === "summary.json")?.detail ?? "";
  };
  const won = ev("2026-09-13T11:14:00.000+02:00", "game.over", { victory: true });
  const resumed = ev("2026-09-13T15:42:23.000+02:00", "run.human", { note: "resumed after completed" });
  assert.doesNotMatch(problems([won, resumed, ev("2026-09-13T15:42:23.100+02:00", "game.goal", { from: "act1", to: "act3" })]), /run\.human records with human: none/, "the extension's resume is not the published run's");
  assert.match(problems([won, resumed]), /run\.human records with human: none/, "without an extension every resume counts");
});
