// Is this bundle a run of an AI, and can a reader tell without believing the publisher (SPEC §3, §8.10, §8.11)?
// What is checked here is the way round that matters: a mock that is read as a run is the forgery worth making.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkRun } from "../src/check-run.mjs";
import { loadRuntime, pluginDigest, pluginFile, runtimeIdentity } from "../src/plugins.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sha = (t) => createHash("sha256").update(Buffer.from(t, "utf8")).digest("hex");
const status = (r, name) => r.results.find((x) => x.requirement === name)?.status;
const detail = (r, name) => r.results.find((x) => x.requirement === name)?.detail ?? "";
const problems = (r) => detail(r, "summary.json");

test("a runtime plugin has a hash of its own, over everything of it that runs", async () => {
  const file = pluginFile("runtime", "scripted");
  assert.match(pluginDigest(file), /^[0-9a-f]{64}$/);
  assert.equal(pluginDigest(file), pluginDigest(file), "the same plugin is the same number");
  assert.notEqual(pluginDigest(file), pluginDigest(pluginFile("runtime", "claude-code")), "two runtimes are two numbers");
  // A module given by path is hashed as itself: a runtime somebody wrote is still placeable.
  const own = join(mkdtempSync(join(tmpdir(), "aas-rt-")), "index.mjs");
  writeFileSync(own, "export default { id: 'x', name: 'X', ai: true };\n");
  assert.match(pluginDigest(own), /^[0-9a-f]{64}$/);
  writeFileSync(own, "export default { id: 'x', name: 'X', ai: true }; // changed\n");
  assert.notEqual(pluginDigest(own), pluginDigest(join(here, "stub-runtime.mjs")));
  // And what a statement and a bundle carry: id, version, ai and that number, nothing guessed.
  const id = runtimeIdentity(await loadRuntime("scripted"), "scripted");
  assert.deepEqual({ ...id, sha256: typeof id.sha256 }, { id: "scripted", version: "0.1.0", ai: false, sha256: "string" });
  assert.deepEqual(runtimeIdentity(null, "no-such-runtime"), { id: null, version: null, ai: null, sha256: null });
});

/** The smallest schema 16 bundle the checker reads far enough: only what these tests are about is filled in. */
function bundle({ summary = {}, timeline = [], agents = "Reach the end.\n" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "aas-mock-"));
  writeFileSync(join(dir, "AGENTS.md"), agents);
  writeFileSync(join(dir, "session.sanitized.jsonl"), timeline.map((r, i) => JSON.stringify({ sequence: i + 1, timestamp: "2026-09-19T10:00:00.000+02:00", elapsed_seconds: i, ...r })).join("\n"));
  const goalPrompt = "Reach test chamber 01.";
  writeFileSync(join(dir, "summary.json"), JSON.stringify({
    schema_version: 16, spec_version: "0.40", time_zone: "Europe/Amsterdam", run_dates: "2026-09-19 to 2026-09-19",
    started_at: "2026-09-19T10:00:00.000+02:00", completed_at: null, ended_at: "2026-09-19T10:01:00.000+02:00",
    models: [], source_records: 0, exported_records: 0, omitted_records: 0, removed_images: 0, redactions: {},
    elapsed_to_completion_seconds: null, elapsed_including_post_completion_seconds: 60,
    last_reported_thread_token_usage: {}, export_notes: [],
    mock: false,
    ai_evidence: { assistant_records: 3, tool_calls: 2, output_tokens: 1200, models: 1, human_turns: 0 },
    brief: { instructions_sha256: sha(agents), goal_prompt_sha256: sha(goalPrompt) },
    category: { game: "portal", goal: "chamber01", goal_prompt: goalPrompt, observation: "vision", input: "input", timing: "paused-think", human: "none" },
    harness: { version: "0.22.1", plugins: { runtime: { id: "claude-code", name: "Claude Code", version: "0.1.0", ai: true, sha256: "a".repeat(64), cli_versions: [] } } },
    ...summary,
  }));
  return dir;
}

test("a bundle is a mock unless its runtime says a model plays", () => {
  // The inversion of draft 0.40: an unknown runtime is a mock, where schema 15 read it as a run.
  const unknown = bundle({ summary: { mock: true, harness: { version: "0.22.1", plugins: { runtime: { id: "something", name: "Something", version: "1", ai: null, sha256: null, cli_versions: [] } } } } });
  assert.doesNotMatch(problems(checkRun(unknown)), /since schema 16/);
  assert.equal(status(checkRun(unknown), "a model played"), "unmet");
  assert.match(detail(checkRun(unknown), "a model played"), /does not say a model plays \(ai: null\)/);

  // And the word may not disagree with the runtime it names: mock false, ai null is refused outright.
  const lying = bundle({ summary: { mock: false, harness: { version: "0.22.1", plugins: { runtime: { id: "something", name: "Something", version: "1", ai: null, sha256: null, cli_versions: [] } } } } });
  assert.match(problems(checkRun(lying)), /mock is false while harness\.plugins\.runtime\.ai is null/);
});

test("a bundle that claims a model played must show what a model leaves behind", () => {
  const empty = bundle({ summary: { ai_evidence: { assistant_records: 0, tool_calls: 0, output_tokens: 0, models: 0, human_turns: 0 } } });
  const r = checkRun(empty);
  assert.equal(status(r, "a model played"), "invalid");
  assert.match(detail(r, "a model played"), /the timeline holds no message from a model/);
  assert.match(detail(r, "a model played"), /no output tokens were reported/);

  const played = checkRun(bundle({}));
  assert.equal(status(played, "a model played"), "met");
  assert.match(detail(played, "a model played"), /3 message\(s\) from 1 model\(s\), 2 tool call\(s\), 1200 output tokens/);
});

test("a run nothing witnessed has nothing that fixed what it was told", () => {
  // The hashes in the bundle are the publisher's own until an archive signed them before the run (SPEC §8.10).
  const r = checkRun(bundle({}));
  assert.equal(status(r, "prompt witnessed"), "unmet");
  assert.match(detail(r, "prompt witnessed"), /no witnessed start: nothing fixed what this run was told before it ran/);
});

test("the published prompt is the prompt that was hashed", () => {
  // AGENTS.md is in the bundle verbatim, so its hash is recomputed here and a swapped one is caught.
  const swapped = bundle({ summary: { brief: { instructions_sha256: "b".repeat(64), goal_prompt_sha256: sha("Reach test chamber 01.") } } });
  assert.match(problems(checkRun(swapped)), /brief\.instructions_sha256 is not the sha256 of the published AGENTS\.md/);
  const other = bundle({ summary: { category: { game: "portal", goal: "chamber01", goal_prompt: "Walk forward for two seconds, then look left.", observation: "vision", input: "input", timing: "paused-think", human: "none" } } });
  assert.match(problems(checkRun(other)), /brief\.goal_prompt_sha256 is not the sha256 of category\.goal_prompt/);
});

test("a message typed into a running session is help, and the bundle says assisted", () => {
  const typed = bundle({ summary: { ai_evidence: { assistant_records: 3, tool_calls: 2, output_tokens: 1200, models: 1, human_turns: 2 } } });
  assert.match(problems(checkRun(typed)), /2 message\(s\) to the agent beyond the goal prompt of each segment, so category\.human must be assisted/);
  const honest = bundle({ summary: {
    ai_evidence: { assistant_records: 3, tool_calls: 2, output_tokens: 1200, models: 1, human_turns: 2 },
    category: { game: "portal", goal: "chamber01", goal_prompt: "Reach test chamber 01.", observation: "vision", input: "input", timing: "paused-think", human: "assisted" },
  } });
  assert.doesNotMatch(problems(checkRun(honest)), /must be assisted/);
});

test("input the agent did not ask for is input somebody else played", () => {
  const inside = [
    { kind: "tool_call", call: "call-00001", name: "portal_exec", input: "await t.run()" },
    { kind: "event", event: "game.playback", data: { phase: "start", index: 1 } },
    { kind: "event", event: "game.playback", data: { phase: "end", index: 1, ticks: 130 } },
    { kind: "tool_result", call: "call-00001", output: [{ type: "text", text: "{}" }] },
  ];
  assert.equal(status(checkRun(bundle({ timeline: inside })), "input from tool calls"), "met");
  const outside = [
    { kind: "tool_call", call: "call-00001", name: "portal_exec", input: "await t.run()" },
    { kind: "tool_result", call: "call-00001", output: [{ type: "text", text: "{}" }] },
    { kind: "event", event: "game.playback", data: { phase: "start", index: 2 } },
  ];
  const r = checkRun(bundle({ timeline: outside }));
  assert.equal(status(r, "input from tool calls"), "invalid");
  assert.match(detail(r, "input from tool calls"), /1 playback\(s\) outside any tool call/);
});
