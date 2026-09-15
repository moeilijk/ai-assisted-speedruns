#!/usr/bin/env node
// Produce a text-only public derivative of a Claude Code session log (the
// private per-session .jsonl under ~/.claude/projects/<project>/). Review the
// output before publishing it. Same output shape as runtime-codex/export-rollout.mjs:
// session.sanitized.jsonl + summary.json (schema 2); `aas publish` raises it to
// schema 6 and adds the blocks that belong to a bundle.
//
// Usage: node export-claude-session.mjs <session.jsonl> <new-output-directory>
// Env:   AAS_TIME_ZONE, AAS_COMPLETION_MARKER (prefix of the agent's final message)
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { once } from "node:events";
import { defaultTimeZone, localTimestamp } from "./timestamp.mjs";
import { createSanitizer } from "./sanitize.mjs";

const HOST_TEXT_RE = /^\s*(?:<system-reminder>|<command-name>|<local-command-stdout>|<command-message>|<environment_context>|<ide_selection>|# AGENTS\.md instructions)/;

export async function exportClaudeSession(input, destination, { completionTime: knownCompletion = null, timeZone = defaultTimeZone(), completionMarker = process.env.AAS_COMPLETION_MARKER || null } = {}) {
  const ts = (v) => localTimestamp(v, timeZone);
  fs.mkdirSync(destination, { recursive: true });
  const output = fs.createWriteStream(path.join(destination, "session.sanitized.jsonl"), { flags: "wx" });
  const { cleanText, clean, counts: imageCounts, redactions } = createSanitizer();
  const counts = { source_records: 0, exported_records: 0, omitted_records: 0 };
  const ids = new Map();
  const models = new Map();
  // The CLI versions the session log records on its rows, in order of first appearance: a resumed session may have
  // continued under a newer Claude Code.
  const cliVersions = new Set();
  let synthetic = 0;
  const methods = new Map();
  const usage = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
  let firstTime, lastTime, completionTime = knownCompletion || undefined, sequence = 0;

  const emit = async (row, item) => {
    const record = { sequence: ++sequence, timestamp: ts(row.timestamp), elapsed_seconds: Math.round((Date.parse(row.timestamp) - Date.parse(firstTime)) / 1000), ...item };
    if (!output.write(`${JSON.stringify(record)}\n`)) await once(output, "drain");
    counts.exported_records++;
  };
  const contentParts = (content) => (typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : []);

  for await (const line of readline.createInterface({ input: fs.createReadStream(input), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    // Counted per content part, so that source = exported + omitted holds
    // although one Claude record can carry several parts.
    if (!["user", "assistant"].includes(row.type) || !row.message || row.isSidechain) {
      counts.source_records++;
      counts.omitted_records++;
      continue;
    }
    if (row.timestamp) {
      firstTime ??= row.timestamp;
      lastTime = row.timestamp;
    }
    if (typeof row.version === "string" && row.version) cliVersions.add(row.version);
    const m = row.message;
    let exported = 0;
    const parts = contentParts(m.content);
    counts.source_records += Math.max(1, parts.length);
    if (row.type === "assistant") {
      // "<synthetic>" is Claude Code's placeholder for a record it wrote itself (an API error, an interrupt), not a
      // model the API answered with: counted, never listed as a model, so a real model fallback stays visible.
      if (m.model === "<synthetic>") synthetic += 1;
      else if (typeof m.model === "string" && (!models.has(m.model) || (models.get(m.model) === null && row.effort))) models.set(m.model, row.effort ?? null);
      if (m.usage && row.requestId !== usage.lastRequest) {
        // One API response may be split over several records; count each request once.
        usage.lastRequest = row.requestId;
        const u = m.usage;
        usage.input_tokens += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        usage.cached_input_tokens += u.cache_read_input_tokens ?? 0;
        usage.cache_write_input_tokens += u.cache_creation_input_tokens ?? 0;
        usage.output_tokens += u.output_tokens ?? 0;
        usage.reasoning_output_tokens += u.output_tokens_details?.thinking_tokens ?? 0;
      }
      for (const part of contentParts(m.content)) {
        if (part.type === "text" && part.text?.trim()) {
          if (completionMarker && !completionTime && part.text.startsWith(completionMarker)) completionTime = row.timestamp;
          await emit(row, { kind: "message", role: "assistant", channel: null, text: cleanText(part.text) });
          exported++;
        } else if (part.type === "tool_use") {
          const id = `call-${String(ids.size + 1).padStart(5, "0")}`;
          ids.set(part.id, id);
          methods.set(part.name, (methods.get(part.name) ?? 0) + 1);
          await emit(row, { kind: "tool_call", call: id, name: part.name, input: clean(part.input ?? {}) });
          exported++;
        }
      }
    } else {
      for (const part of contentParts(m.content)) {
        if (part.type === "text" && part.text?.trim() && !HOST_TEXT_RE.test(part.text)) {
          await emit(row, { kind: "message", role: "user", channel: null, text: cleanText(part.text) });
          exported++;
        } else if (part.type === "tool_result" && ids.has(part.tool_use_id)) {
          // Only text / image_omitted parts are published (spec §5); other
          // structured parts (Claude Code's tool_reference, ...) become text.
          const parts = contentParts(part.content).map((p) => {
            if (p.type === "text") return { type: "text", text: cleanText(p.text ?? "") };
            const cleaned = clean(p);
            return cleaned.type === "image_omitted" ? cleaned : { type: "text", text: JSON.stringify(cleaned) };
          });
          const item = { kind: "tool_result", call: ids.get(part.tool_use_id), output: parts };
          if (part.is_error) item.is_error = true;
          await emit(row, item);
          exported++;
        }
      }
    }
    counts.omitted_records += Math.max(1, parts.length) - exported;
  }
  output.end();
  await once(output, "finish");
  delete usage.lastRequest;
  usage.total_tokens = usage.input_tokens + usage.output_tokens;
  if (!firstTime) throw new Error("No user or assistant records found in the session log.");
  const summary = {
    schema_version: 2,
    time_zone: timeZone,
    run_dates: `${ts(firstTime).slice(0, 10)} to ${ts(lastTime).slice(0, 10)}`,
    started_at: ts(firstTime),
    completed_at: completionTime ? ts(completionTime) : null,
    ended_at: ts(lastTime),
    models: [...models].map(([model, reasoning_effort]) => ({ model, reasoning_effort })),
    ...counts,
    removed_images: imageCounts.removed_images,
    redactions,
    elapsed_to_completion_seconds: completionTime ? Math.round((Date.parse(completionTime) - Date.parse(firstTime)) / 1000) : null,
    elapsed_including_post_completion_seconds: Math.round((Date.parse(lastTime) - Date.parse(firstTime)) / 1000),
    last_reported_thread_token_usage: usage,
    tool_methods_in_exec: Object.fromEntries(methods),
    synthetic_records: synthetic,
    cli_versions: [...cliVersions],
    export_notes: [
      "Sanitized text export of run messages, tool calls, and results from a Claude Code session log.",
      `Timestamps use ${timeZone} time, with an explicit UTC offset; elapsed seconds are durations.`,
      "Host/system context, thinking blocks, sidechains, session metadata, opaque data and original identifiers are omitted.",
      "Embedded images are omitted from this text release.",
      "Token counts are summed per API request and include cached input.",
    ],
  };
  fs.writeFileSync(path.join(destination, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
  return { counts: { ...counts, removed_images: imageCounts.removed_images }, redactions, summary };
}

/** Claude Code stores a project's session logs under ~/.claude/projects/<cwd with non-alphanumerics replaced by '-'>/. */
export function claudeProjectDir(cwd, home = process.env.HOME || process.env.USERPROFILE) {
  return path.join(home, ".claude", "projects", path.resolve(cwd).replace(/[^A-Za-z0-9]/g, "-"));
}

if (process.argv[1]?.endsWith("export-claude-session.mjs")) {
  const [input, destination] = process.argv.slice(2);
  if (!input || !destination) throw new Error("Usage: node export-claude-session.mjs <session.jsonl> <new-output-directory>");
  const r = await exportClaudeSession(input, destination);
  console.log(JSON.stringify({ records: r.counts, redactions: r.redactions }));
}
