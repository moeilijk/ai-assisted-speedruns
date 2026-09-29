#!/usr/bin/env node
// The public timeline (session.sanitized.jsonl) and summary (schema 2) of a Mistral Vibe run, from the run's own
// log: what `vibe -p --output streaming` printed, each entry with the time it arrived (vibe-stream.jsonl). The
// entries carry Vibe's own createdAt and updatedAt; those are the times used. Reasoning, notices, checkpoints and
// images are omitted, as the Codex and Claude Code exports omit theirs. The model and usage come from Vibe's own
// saved session (meta.json under $VIBE_HOME/logs/session): the model the session was configured with and the
// provider's model name behind that alias, as Vibe records them; Vibe's stream does not name the model per answer.
//
// Usage: node export-stream.mjs <vibe-stream.jsonl> <new-output-directory>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultTimeZone, localTimestamp } from "../core/src/timestamp.mjs";
import { createSanitizer } from "../core/src/sanitize.mjs";
// Self-contained next to core's timestamp.mjs and sanitize.mjs, as runtime-codex/export-rollout.mjs is: an archive
// runs this file to make a bundle's timeline again.
/** Mistral Vibe's own folder: $VIBE_HOME, else ~/.vibe (where its saved sessions are; an archive has none). */
export const vibeHome = (env = process.env) => env.VIBE_HOME || path.join(env.HOME || "", ".vibe");

/** Vibe's createdAt/updatedAt: milliseconds, or seconds from an older client. */
const toIso = (v, fallback) => (typeof v === "number" ? new Date(v > 1e12 ? v : v * 1000).toISOString() : fallback);
const textOf = (content) => (Array.isArray(content) ? content.filter((c) => typeof c?.text === "string").map((c) => c.text).join("\n") : typeof content === "string" ? content : "");

/** Vibe's own saved sessions for these session ids: `{ meta }` per id (config, stats), newest last. */
export function savedSessions(ids, home = vibeHome()) {
  const dir = path.join(home, "logs", "session");
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir).filter((d) => d.startsWith("session_")).sort(); } catch { return out; }
  for (const d of names) {
    try { const meta = JSON.parse(fs.readFileSync(path.join(dir, d, "meta.json"), "utf8")); if (ids.has(meta.session_id)) out.push(meta); } catch { /* not a session */ }
  }
  return out;
}

export async function exportStream(input, destination, { completionMarker = process.env.AAS_COMPLETION_MARKER || null, timeZone = defaultTimeZone(), home = vibeHome() } = {}) {
  const ts = (v) => localTimestamp(v, timeZone);
  fs.mkdirSync(destination, { recursive: true });
  const rows = fs.readFileSync(input, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const { cleanText, counts: imageCounts, redactions } = createSanitizer();
  const counts = { source_records: rows.length, exported_records: 0, omitted_records: 0 };
  const records = [];
  const versions = new Set();
  const sessionIds = new Set();
  const requested = [];
  let completionTime = null;
  const ids = new Map();
  for (const r of rows) {
    if (r.vibe) { if (r.vibe.version) versions.add(r.vibe.version); requested.push({ model: r.vibe.model ?? null, thinking: r.vibe.thinking ?? null }); counts.omitted_records++; continue; }
    const e = r.entry;
    if (!e) { counts.omitted_records++; continue; }
    if (e.sessionId) sessionIds.add(e.sessionId);
    const at = toIso(e.createdAt, r.receivedAt);
    if (e.type === "message" && (e.role === "user" || e.role === "assistant")) {
      const text = textOf(e.content);
      if (!text.trim()) { counts.omitted_records++; continue; }
      records.push({ at, item: { kind: "message", role: e.role, channel: null, text: cleanText(text) } });
      if (e.role === "assistant" && completionMarker && text.startsWith(completionMarker)) completionTime = at;
    } else if (e.type === "effect" && e.detail?.toolName) {
      const id = `call-${String(ids.size + 1).padStart(5, "0")}`;
      ids.set(e.id, id);
      const input = e.detail.input;
      records.push({ at, item: { kind: "tool_call", call: id, name: e.detail.toolName, input: cleanText(typeof input?.code === "string" ? input.code : JSON.stringify(input ?? null)) } });
      const out = e.state?.outputText || (e.state?.output !== undefined && e.state?.output !== null ? JSON.stringify(e.state.output) : "") || e.state?.error?.message || e.state?.reason || "";
      records.push({ at: toIso(e.updatedAt, r.receivedAt), item: { kind: "tool_result", call: id, output: [{ type: "text", text: cleanText(out) }] } });
    } else counts.omitted_records++;
  }
  records.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const first = records[0]?.at ?? rows[0]?.receivedAt ?? new Date().toISOString();
  const last = records.at(-1)?.at ?? first;
  const output = fs.createWriteStream(path.join(destination, "session.sanitized.jsonl"), { flags: "wx" });
  let sequence = 0;
  for (const r of records) {
    output.write(`${JSON.stringify({ sequence: ++sequence, timestamp: ts(r.at), elapsed_seconds: Math.round((Date.parse(r.at) - Date.parse(first)) / 1000), ...r.item })}\n`);
    counts.exported_records++;
  }
  await new Promise((res) => output.end(res));
  // The model each saved session was configured with, as Vibe records it: the alias, the provider's name for it, the
  // thinking level; and the usage it counted.
  const metas = savedSessions(sessionIds, home);
  const models = new Map();
  for (const m of metas) {
    const alias = m.config?.active_model;
    const entry = alias ? m.config?.models?.[alias] : null;
    if (!entry) continue;
    const key = `${entry.name}|${entry.thinking ?? ""}`;
    if (!models.has(key)) models.set(key, { model: entry.name, reasoning_effort: entry.thinking ?? null, context_window: null, max_output_tokens: null, provider: entry.provider ?? null });
  }
  const stats = metas.at(-1)?.stats ?? null;
  const summary = {
    schema_version: 2,
    time_zone: timeZone,
    run_dates: `${ts(first).slice(0, 10)} to ${ts(last).slice(0, 10)}`,
    started_at: ts(first),
    completed_at: completionTime ? ts(completionTime) : null,
    ended_at: ts(last),
    models: [...models.values()],
    ...counts,
    removed_images: imageCounts.removed_images,
    redactions,
    elapsed_to_completion_seconds: completionTime ? Math.round((Date.parse(completionTime) - Date.parse(first)) / 1000) : null,
    elapsed_including_post_completion_seconds: Math.round((Date.parse(last) - Date.parse(first)) / 1000),
    last_reported_thread_token_usage: stats ? { input_tokens: stats.session_prompt_tokens ?? null, cached_input_tokens: stats.session_cached_tokens ?? null, output_tokens: stats.session_completion_tokens ?? null, cost_usd: stats.session_cost ?? null } : null,
    cli_versions: [...versions],
    export_notes: [
      "Sanitized text export of run messages, tool calls, and results, from what Mistral Vibe streamed during the run.",
      `Timestamps use ${timeZone} time, with an explicit UTC offset; they are Vibe's own createdAt (a call) and updatedAt (its result).`,
      "Reasoning, notices, checkpoints, images and original identifiers are omitted.",
      "models: the model each saved Vibe session was configured with (its alias, the provider's name, the thinking level), as Vibe records it in its session metadata; Vibe's stream does not name the model per answer.",
      "Token counts and cost are Vibe's own session totals.",
    ],
  };
  fs.writeFileSync(path.join(destination, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
  return { records: counts, redactions };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [input, destination] = process.argv.slice(2);
  if (!input || !destination) throw new Error("Usage: node export-stream.mjs <vibe-stream.jsonl> <new-output-directory>");
  console.log(JSON.stringify(await exportStream(input, destination)));
}
