import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportClaudeSession } from "../src/export-claude-session.mjs";

test("Claude Code session export: messages, tool calls, results; host text, thinking, images and ids removed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aas-export-"));
  const rows = [
    { type: "bridge-session", sessionId: "93710bd9-57de-464a-b3fd-ac9849144519" },
    { type: "user", timestamp: "2026-09-09T10:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "<system-reminder>secret</system-reminder>" }, { type: "text", text: "Play Portal. Contact me at me@example.com" }] } },
    { type: "assistant", timestamp: "2026-09-09T10:00:05.000Z", requestId: "req_1", effort: "high", message: { role: "assistant", model: "claude-fable-5-1", content: [{ type: "thinking", thinking: "hmm", signature: "x" }, { type: "text", text: "Looking." }, { type: "tool_use", id: "toolu_01AAAAAAAAAAAAAAAAAAAAAA", name: "mcp__portal__portal_exec", input: { code: "return await portal.observe()" } }], usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 0, output_tokens: 20, output_tokens_details: { thinking_tokens: 5 } } } },
    { type: "assistant", timestamp: "2026-09-09T10:00:05.100Z", requestId: "req_1", message: { role: "assistant", model: "claude-fable-5-1", content: [{ type: "text", text: "" }], usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 20 } } },
    { type: "user", timestamp: "2026-09-09T10:00:06.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01AAAAAAAAAAAAAAAAAAAAAA", content: [{ type: "text", text: "{\"facing\":1} at /home/someone/run" }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/AAAA" } }, { type: "tool_reference", tool_name: "mcp__portal__portal_exec" }] }] } },
    { type: "assistant", timestamp: "2026-09-09T10:01:00.000Z", requestId: "req_2", version: "2.1.270", message: { role: "assistant", model: "claude-fable-5-1", content: [{ type: "text", text: "Reached the end credits." }], usage: { input_tokens: 1, output_tokens: 2 } } },
  ];
  writeFileSync(join(dir, "s.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n"));
  const r = await exportClaudeSession(join(dir, "s.jsonl"), join(dir, "out"), { timeZone: "Europe/Amsterdam", completionMarker: "Reached the end credits" });
  const lines = readFileSync(join(dir, "out", "session.sanitized.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.kind), ["message", "message", "tool_call", "tool_result", "message"]);
  assert.equal(lines[0].text, "Play Portal. Contact me at [EMAIL]");
  assert.equal(lines[2].call, "call-00001");
  assert.equal(lines[2].name, "mcp__portal__portal_exec");
  assert.deepEqual(lines[3].output, [{ type: "text", text: "{\"facing\":1} at <USER_HOME>/run" }, { type: "image_omitted" }, { type: "text", text: "{\"type\":\"tool_reference\",\"tool_name\":\"mcp__portal__portal_exec\"}" }]);
  assert.equal(lines[0].timestamp, "2026-09-09T12:00:00.000+02:00");
  assert.equal(lines[4].elapsed_seconds, 60);
  const s = r.summary;
  assert.equal(s.elapsed_to_completion_seconds, 60);
  assert.deepEqual(s.models, [{ model: "claude-fable-5-1", reasoning_effort: "high" }]);
  assert.deepEqual(s.cli_versions, ["2.1.270"], "the Claude Code versions the rows record");
  assert.equal(s.last_reported_thread_token_usage.input_tokens, 101);
  assert.equal(s.last_reported_thread_token_usage.reasoning_output_tokens, 5);
  assert.equal(s.removed_images, 1);
  assert.equal(s.redactions.email, 1);
  assert.deepEqual(s.tool_methods_in_exec, { mcp__portal__portal_exec: 1 });
});

test("the model the API answered with is listed, a <synthetic> placeholder is only counted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aas-export-model-"));
  const rows = [
    { type: "user", timestamp: "2026-09-09T10:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "Play." }] } },
    { type: "assistant", timestamp: "2026-09-09T10:00:01.000Z", requestId: "r1", message: { role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } } },
    { type: "assistant", timestamp: "2026-09-09T10:00:02.000Z", requestId: "r2", message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "API Error" }] } },
    // A fallback: the API answered with another model than the run asked for.
    { type: "assistant", timestamp: "2026-09-09T10:00:03.000Z", requestId: "r3", message: { role: "assistant", model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } } },
  ];
  writeFileSync(join(dir, "s.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n"));
  const r = await exportClaudeSession(join(dir, "s.jsonl"), join(dir, "out"), { timeZone: "Europe/Amsterdam" });
  assert.deepEqual(r.summary.models.map((m) => m.model), ["claude-opus-5", "claude-haiku-4-5-20251001"], "<synthetic> is not a model");
  assert.equal(r.summary.synthetic_records, 1);
});

test("what Claude Code reported per model: every invocation's result, the same model under two reports kept apart", async () => {
  const { claudeModelReports } = await import("../../runtime-claude-code/index.mjs");
  const dir = mkdtempSync(join(tmpdir(), "aas-reports-"));
  assert.equal(claudeModelReports(dir).size, 0, "no result record, no report");
  writeFileSync(join(dir, "claude-result.json"), JSON.stringify({ modelUsage: { "claude-sonnet-5": { contextWindow: 200000, maxOutputTokens: 32000 } } }));
  assert.deepEqual(claudeModelReports(dir).get("claude-sonnet-5"), [{ context_window: 200000, max_output_tokens: 32000, provider: null }], "a run from before claude-results.jsonl: the last result");
  const results = [
    { modelUsage: { "claude-sonnet-5": { contextWindow: 200000, maxOutputTokens: 32000 } } },
    { modelUsage: { "claude-sonnet-5": { contextWindow: 1000000, maxOutputTokens: 64000, provider: "firstParty" } } },
    { modelUsage: { "claude-sonnet-5": { contextWindow: 1000000, maxOutputTokens: 64000, provider: "firstParty" } } },
  ];
  writeFileSync(join(dir, "claude-results.jsonl"), results.map((r) => JSON.stringify(r)).join("\n") + "\n");
  assert.deepEqual(claudeModelReports(dir).get("claude-sonnet-5"), [
    { context_window: 200000, max_output_tokens: 32000, provider: null },
    { context_window: 1000000, max_output_tokens: 64000, provider: "firstParty" },
  ]);
});
