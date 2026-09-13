#!/usr/bin/env node
// `aas check <run-dir>`: conformance check of a (published) run directory
// against the AAS specification (packages/spec/SPEC.md). Validates the
// timeline (session.sanitized.jsonl), summary.json (schema 2 or 3), manifest
// hashes, and the presence of the other required files. Exit code 1 when the
// timeline or summary is invalid, or with --strict when any requirement is unmet.
import { createHash } from "node:crypto";
import { verifyBundle } from "./sign.mjs";
import fs from "node:fs";
import path from "node:path";

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:[+-]\d{2}:\d{2}|Z)$/;
const CALL_RE = /^call-\d{5,}$/;
const CATEGORY_VALUES = {
  observation: ["vision", "state", "full"],
  input: ["input", "api"],
  timing: ["paused-think", "realtime"],
  human: ["none", "restart-only", "assisted"],
};
const SUMMARY_V2_KEYS = [
  "schema_version", "time_zone", "run_dates", "started_at", "completed_at", "ended_at", "models",
  "source_records", "exported_records", "omitted_records", "removed_images", "redactions",
  "elapsed_to_completion_seconds", "elapsed_including_post_completion_seconds",
  "last_reported_thread_token_usage", "tool_methods_in_exec", "export_notes",
];

/**
 * `core` is accepted and ignored: it used to mean "a bundle without its recording files", which is now every
 * bundle, because a recording is published where video is published and the bundle carries the link.
 */
export function checkRun(runDir, { core: _ignoredCore = false } = {}) {
  const results = []; // { requirement, status: "met" | "unmet" | "invalid", detail }
  const add = (requirement, status, detail = "") => results.push({ requirement, status, detail });
  const file = (name) => path.join(runDir, name);
  const exists = (name) => fs.existsSync(file(name));

  // --- timeline ---
  let records = [];
  let humanRecords = 0;
  if (!exists("session.sanitized.jsonl")) add("session.sanitized.jsonl", "unmet", "missing");
  else {
    const problems = [];
    const lines = fs.readFileSync(file("session.sanitized.jsonl"), "utf8").split("\n").filter((l) => l.trim());
    const openCalls = new Map();
    let lastElapsed = -1;
    lines.forEach((line, i) => {
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        problems.push(`line ${i + 1}: not JSON`);
        return;
      }
      records.push(r);
      const at = `line ${i + 1}`;
      if (r.sequence !== i + 1) problems.push(`${at}: sequence ${r.sequence}, expected ${i + 1}`);
      if (!TIMESTAMP_RE.test(String(r.timestamp))) problems.push(`${at}: timestamp "${r.timestamp}" is not ISO 8601 with offset`);
      if (!Number.isInteger(r.elapsed_seconds) || r.elapsed_seconds < 0) problems.push(`${at}: elapsed_seconds must be a non-negative integer`);
      else if (r.elapsed_seconds < lastElapsed) problems.push(`${at}: elapsed_seconds goes backwards`);
      else lastElapsed = r.elapsed_seconds;
      switch (r.kind) {
        case "message":
          if (!["user", "assistant"].includes(r.role)) problems.push(`${at}: message role "${r.role}"`);
          if (typeof r.text !== "string") problems.push(`${at}: message without text`);
          if (!("channel" in r)) problems.push(`${at}: message without channel`);
          break;
        case "tool_call":
          if (!CALL_RE.test(String(r.call))) problems.push(`${at}: call id "${r.call}"`);
          if (typeof r.name !== "string") problems.push(`${at}: tool_call without name`);
          if (!("input" in r)) problems.push(`${at}: tool_call without input`);
          openCalls.set(r.call, i + 1);
          break;
        case "tool_result":
          if (!openCalls.has(r.call)) problems.push(`${at}: tool_result for unknown call "${r.call}"`);
          openCalls.delete(r.call);
          // Schema 2 (portal-agent) allows a plain string; parts are text,
          // input_text (Codex) or image_omitted.
          if (typeof r.output === "string") {
            if (/data:image\//.test(r.output)) problems.push(`${at}: image data in a published timeline`);
          } else if (!Array.isArray(r.output)) problems.push(`${at}: tool_result output must be a string or an array`);
          else for (const part of r.output) {
            if (!part || typeof part !== "object") problems.push(`${at}: output part is not an object`);
            else if (!["text", "input_text", "image_omitted"].includes(part.type)) problems.push(`${at}: output part type "${part.type}"`);
            else if (typeof part.data === "string" || /data:image\//.test(part.text ?? "")) problems.push(`${at}: image data in a published timeline`);
          }
          break;
        case "event":
          if (typeof r.event !== "string") problems.push(`${at}: event without name`);
          if (r.event === "run.human") humanRecords += 1;
          break;
        default:
          problems.push(`${at}: unknown kind "${r.kind}"`);
      }
    });
    if (openCalls.size) problems.push(`${openCalls.size} tool_call(s) without tool_result (first: ${[...openCalls.keys()][0]})`);
    if (problems.length) add("timeline format", "invalid", problems.slice(0, 10).join("; ") + (problems.length > 10 ? ` (+${problems.length - 10} more)` : ""));
    else add("timeline format", "met", `${records.length} records`);
  }

  // --- summary ---
  let summary = null;
  if (!exists("summary.json")) add("summary.json", "unmet", "missing");
  else {
    const problems = [];
    try {
      summary = JSON.parse(fs.readFileSync(file("summary.json"), "utf8"));
    } catch (error) {
      problems.push(`not JSON: ${error.message}`);
    }
    if (summary) {
      for (const key of SUMMARY_V2_KEYS) if (!(key in summary)) problems.push(`missing ${key}`);
      if (![2, 3, 4].includes(summary.schema_version)) problems.push(`schema_version ${summary.schema_version} is not 2, 3 or 4`);
      for (const key of ["started_at", "ended_at"]) if (!TIMESTAMP_RE.test(String(summary[key]))) problems.push(`${key} is not ISO 8601 with offset`);
      if (summary.completed_at !== null && !TIMESTAMP_RE.test(String(summary.completed_at))) problems.push("completed_at must be null or ISO 8601 with offset");
      if (!Array.isArray(summary.models) || !summary.models.every((m) => typeof m?.model === "string")) problems.push("models must list {model, reasoning_effort}");
      // Monitoring a silent model fallback: the API may answer with another model than the run asked for.
      if (summary.requested && typeof summary.requested === "object") {
        const asked = summary.requested.model;
        const seen = (summary.models ?? []).map((m) => m.model);
        if (asked && seen.length && !seen.includes(asked)) problems.push(`requested model ${asked} but the session used ${seen.join(", ")}`);
        else if (asked && seen.length > 1) problems.push(`requested model ${asked} but the session used more than one model: ${seen.join(", ")}`);
      }
      if (records.length && summary.exported_records !== records.length) problems.push(`exported_records ${summary.exported_records} but timeline has ${records.length}`);
      if (summary.source_records !== summary.exported_records + summary.omitted_records) problems.push("source_records != exported + omitted");
      if (summary.schema_version >= 3) {
        const c = summary.category;
        if (!c || typeof c !== "object") problems.push("schema 3 requires category");
        else {
          for (const key of ["game", "build", "goal"]) if (typeof c[key] !== "string" || !c[key]) problems.push(`category.${key} missing`);
          for (const [key, values] of Object.entries(CATEGORY_VALUES)) if (!values.includes(c[key])) problems.push(`category.${key} "${c[key]}" not in ${values.join("/")}`);
          if (c.human === "none" && humanRecords) problems.push(`category.human is none but the timeline has ${humanRecords} run.human record(s)`);
        }
        if (!summary.recording || typeof summary.recording !== "object") problems.push("a recording block is required");
        if (!summary.harness || typeof summary.harness !== "object") problems.push("a harness block is required");
      }
      if (summary.schema_version >= 4) {
        // What a store needs to file this bundle: which standard, which packaging, which publication of which run.
        if (typeof summary.spec_version !== "string" || !summary.spec_version) problems.push("schema 4 requires spec_version");
        const b = summary.bundle;
        if (!b || typeof b !== "object") problems.push("schema 4 requires a bundle block");
        else {
          if (b.kind !== "aas-public") problems.push(`bundle.kind "${b.kind}" is not "aas-public"`);
          if (!Number.isInteger(b.bundle_version)) problems.push("bundle.bundle_version must be an integer");
          if (!Number.isInteger(b.revision) || b.revision < 1) problems.push("bundle.revision must be a positive integer");
          if (typeof b.run_id !== "string" || !b.run_id) problems.push("bundle.run_id missing");
          if (!TIMESTAMP_RE.test(String(b.published_at))) problems.push("bundle.published_at is not ISO 8601 with offset");
        }
        if (!Array.isArray(summary.recordings)) problems.push("schema 4 requires recordings as a list");
        if (summary.harness && (typeof summary.harness.version !== "string" || !summary.harness.version)) problems.push("harness.version missing");
      } else if (humanRecords && summary.category?.human === "none") problems.push("run.human records with human: none");
    }
    add("summary.json", problems.length ? "invalid" : "met", problems.join("; ") || `schema ${summary.schema_version}`);
  }

  // --- other required files ---
  for (const name of ["tools.json", "AGENTS.md", "documentation.md", "runtime-config"]) {
    add(name, exists(name) ? "met" : "unmet", exists(name) ? "" : "missing");
  }
  if (exists("tools.json")) {
    try {
      const tools = JSON.parse(fs.readFileSync(file("tools.json"), "utf8"));
      const bad = !Array.isArray(tools) || tools.some((t) => typeof t?.name !== "string" || typeof t?.description !== "string" || typeof t?.inputSchema !== "object");
      if (bad) add("tools.json format", "invalid", "expected an array of {name, description, inputSchema}");
    } catch (error) {
      add("tools.json format", "invalid", error.message);
    }
  }
  // The goal: a run that did not reach it is a recording of an attempt, not an entry (spec §8.6). Visible in the
  // bundle itself: a game.over with victory on the timeline, and completed_at in the summary.
  if (exists("session.sanitized.jsonl")) {
    const won = fs.readFileSync(file("session.sanitized.jsonl"), "utf8").split("\n").filter((l) => l.trim()).some((l) => {
      try { const r = JSON.parse(l); return r.kind === "event" && r.event === "game.over" && r.data?.victory === true; } catch { return false; }
    });
    let completedAt = null;
    try { completedAt = JSON.parse(fs.readFileSync(file("summary.json"), "utf8")).completed_at ?? null; } catch { /* reported above */ }
    add("goal reached", won || completedAt ? "met" : "unmet", won ? `victory on the timeline${completedAt ? `, completed_at ${completedAt}` : ""}` : completedAt ? `completed_at ${completedAt}` : "no victory on the timeline and no completed_at: a stopped session, not an entry");
  }
  // Where the recording is published: a bundle carries the link, not the video (a run is hours of 1080p60).
  // With the chapters and `elapsed_seconds` that link is what makes a tool call locatable in the recording.
  // Who made this bundle: the signature covers manifest.json and therefore the whole bundle. An entry says who
  // published it, so an unsigned bundle is a requirement not met, not a free choice; it stays a readable bundle
  // (the status is `unmet`, not `invalid`) because a fixture or a local copy has no publisher to speak of.
  // A checker can only say the signature is valid for its own key; whose key it is belongs to an archive.
  const sig = verifyBundle(runDir);
  if (sig.signed) add("signature", sig.valid ? "met" : "invalid", sig.valid ? `valid for ${sig.fingerprint} (whose key that is, is for an archive to say)` : sig.problem ?? "invalid");
  else add("signature", "unmet", "not signed: an entry says who published it (aas publish --sign <key>, with a key the publisher's account publishes)");
  // Reproduction: the game's build and the mods that were loaded, from the game plugin.
  try {
    const g = JSON.parse(fs.readFileSync(file("summary.json"), "utf8")).game ?? null;
    const mods = (g?.mods ?? []).map((m) => `${m.name}${m.version ? ` ${m.version}` : ""}`).join(", ");
    add("reproducible", g?.version ? "met" : "unmet", g?.version ? `${g.game ?? "game"} ${g.version}${mods ? `; ${mods}` : ""}` : "summary.game has no game version: the bundle does not say which build was played");
  } catch { /* reported above */ }
  const recordingFiles = exists("recording") ? fs.readdirSync(file("recording")).filter((f) => !f.startsWith(".")) : [];
  let recordingUrl = null;
  try { recordingUrl = JSON.parse(fs.readFileSync(file("summary.json"), "utf8")).recording?.url ?? null; } catch { /* reported above */ }
  let rec = null;
  try { rec = JSON.parse(fs.readFileSync(file("summary.json"), "utf8")).recording ?? null; } catch { /* reported above */ }
  const publications = (() => { try { return JSON.parse(fs.readFileSync(file("summary.json"), "utf8")).recordings ?? []; } catch { return []; } })();
  add("recording published", publications.length ? "met" : "unmet",
    publications.length ? publications.map((r) => `${r.platform}: ${r.url}${r.kind === "vod" ? " (a VOD expires; publish a copy that keeps)" : ""}`).join("; ")
      : "summary.recordings is empty: the bundle does not say where the recording can be watched (aas publish --video-url <url>[,<url>])");
  // What binds that link to this bundle: the description of the video must carry this fingerprint and the
  // duration must match. A platform re-encodes the file, so its hash cannot do this.
  const runId = (() => { try { return JSON.parse(fs.readFileSync(file("summary.json"), "utf8")).run_id ?? null; } catch { return null; } })();
  add("recording bound to this bundle", rec?.fingerprint ? "met" : "unmet",
    rec?.fingerprint
      ? `${publications.length ? publications.map((r) => `${r.platform} ${r.binding_field}`).join(", ") : "the recording's description"} must contain "AAS ${runId ?? "?"} · fingerprint ${String(rec.fingerprint).slice(0, 16)}"${rec.duration_seconds ? `, and the length must be about ${rec.duration_seconds} s` : ""}`
      : "summary.recording has no fingerprint: nothing ties the published recording to this bundle");
  const recordingPresent = recordingFiles.length > 0;
  if (exists("summary.json")) {
    try {
      const bi = JSON.parse(fs.readFileSync(file("summary.json"), "utf8")).recording?.black_intervals;
      if (Array.isArray(bi)) {
        const long = bi.filter((b) => b.seconds >= 10 && !b.game); // black inside a loading/cinematic phase is the game's own
        // The publisher measures this at publish time and declares it here; a reader that has only the bundle cannot
        // recompute it, because the recording is linked, not packed. What a reader can check is the recording's
        // sha256 in the manifest, and then measure the linked file itself with the same tool.
        const where = "measured by the publisher on the recording it made and uploaded";
        add("recording shows a picture", long.length ? "unmet" : "met", `${long.length ? long.map((b) => `${b.file}: black ${b.seconds} s from ${b.start} s`).join("; ") : bi.length ? `${bi.length} short black interval(s)` : "no black interval of a second or more"} (${where})`);
      }
    } catch { /* summary problems are reported above */ }
  }
  if (exists("run.jsonl")) add("run.jsonl not published", "unmet", "private log present in the run directory; do not publish it");

  // --- manifest ---
  if (!exists("manifest.json")) add("manifest.json", "unmet", "missing");
  else {
    const problems = [];
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(file("manifest.json"), "utf8"));
    } catch (error) {
      problems.push(`not JSON: ${error.message}`);
    }
    if (manifest) {
      // The marker a reader checks before trusting this as a published bundle (a run directory has no manifest).
      add("public bundle", manifest.bundle === "aas-public" ? "met" : "unmet", manifest.bundle === "aas-public" ? `${manifest.run_id ?? "?"} revision ${manifest.revision ?? "?"}, run ${manifest.run_uid ?? "no uid"}, spec ${manifest.spec_version ?? "?"}` : `manifest.bundle is ${JSON.stringify(manifest.bundle)}, expected "aas-public"`);
      const listed = new Map((manifest.files ?? []).map((f) => [String(f.path).replaceAll("\\", "/"), f]));
      for (const [p, f] of listed) {
        if (!fs.existsSync(file(p))) {
          problems.push(`${p}: listed but missing`);
          continue;
        }
        const data = fs.readFileSync(file(p));
        const sha = createHash("sha256").update(data).digest("hex");
        if (sha !== f.sha256) problems.push(`${p}: sha256 mismatch`);
        if (Number.isInteger(f.bytes) && f.bytes !== data.length) problems.push(`${p}: bytes ${f.bytes} != ${data.length}`);
      }
      const walk = (dir, prefix = "") =>
        fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory() ? walk(path.join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`],
        );
      for (const p of walk(runDir)) {
        // signature.json signs the manifest, so the manifest cannot list it.
        if (["manifest.json", "run.jsonl", "signature.json"].includes(p) || p.startsWith(".")) continue;
        if (!listed.has(p)) problems.push(`${p}: not in manifest`);
      }
    }
    add("manifest.json", problems.length ? "invalid" : "met", problems.slice(0, 10).join("; ") || `${manifest?.files?.length ?? 0} files verified`);
  }

  return { results, records: records.length, summary };
}

export function formatReport(runDir, { results }) {
  const width = Math.max(...results.map((r) => r.requirement.length));
  const lines = [`AAS conformance check: ${runDir}`];
  for (const r of results) {
    const mark = r.status === "met" ? "PASS" : r.status === "invalid" ? "FAIL" : "MISSING";
    lines.push(`  ${mark.padEnd(7)} ${r.requirement.padEnd(width)}  ${r.detail}`);
  }
  const invalid = results.filter((r) => r.status === "invalid").length;
  const unmet = results.filter((r) => r.status === "unmet").length;
  lines.push(invalid ? `Result: ${invalid} invalid, ${unmet} missing. Not conforming.` : unmet ? `Result: valid where present, ${unmet} requirement(s) missing. Not conforming.` : "Result: conforming.");
  return lines.join("\n");
}

if (process.argv[1]?.endsWith("check-run.mjs")) {
  const args = process.argv.slice(2);
  const strict = args.includes("--strict");
  const dir = args.find((a) => !a.startsWith("--"));
  if (!dir) throw new Error("Usage: check [--strict] <run-dir>");
  const report = checkRun(path.resolve(dir));
  console.log(formatReport(dir, report));
  const invalid = report.results.some((r) => r.status === "invalid");
  const unmet = report.results.some((r) => r.status === "unmet");
  process.exitCode = invalid || (strict && unmet) ? 1 : 0;
}
