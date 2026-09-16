// `aas publish <run-dir> <out-dir>`: build the public bundle of the spec (§4)
// from a private run directory: sanitized timeline + summary (schema 6),
// tools.json, AGENTS.md, documentation.md, runtime-config/, game-config/,
// chapters.txt, timeline.json, splits.lss, manifest.json — and no recording:
// the video is published where video is published and linked from the summary.
// Then scans the result for private data and runs the conformance check.
import { createHash, randomBytes } from "node:crypto";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { CORE_DIR } from "./mcp-client.mjs";
import { exportClaudeSession } from "./export-claude-session.mjs";
import { SCAN_RULES } from "./sanitize.mjs";
import { computeTimeline, writeTimeline } from "./timeline.mjs";
import { probeDuration } from "./render.mjs";
import { SIGNATURE_FILE, signBundle } from "./sign.mjs";
import { zipBuffer } from "./zip.mjs";
import { brokerSpec } from "./configure.mjs";
import { createSanitizer } from "./sanitize.mjs";
import { checkRun, formatReport } from "./check-run.mjs";
import { ARCHIVE_URL, FRAMEWORK_VERSION, loadGamePlugin } from "./plugins.mjs";
import { endsOf, goalHistory, publicEnd } from "./goal.mjs";
import { modelParts } from "./models.mjs";
import { CODE_SCHEMA, bindingLine, recordingVideos } from "./videos.mjs";
import { withVideoTexts } from "./youtube-text.mjs";
import { BUNDLE_VERSION, SUMMARY_SCHEMA } from "./versions.mjs";

const copyTree = (src, dst) => {
  if (!fs.existsSync(src)) return false;
  fs.cpSync(src, dst, { recursive: true });
  return true;
};

const readRunEvents = (runDir) => { const f = path.join(runDir, "run.jsonl"); if (!fs.existsSync(f)) return []; return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && r.kind === "event"); };

/** The marker in every published bundle's manifest: this is a public AAS bundle, not a run directory. */
export const BUNDLE_KIND = "aas-public";
/** The draft of packages/spec/SPEC.md this tooling writes bundles for; SPEC.md carries the same number. */
export const SPEC_VERSION = "0.37";
export { BUNDLE_VERSION, SUMMARY_SCHEMA };

export function writeManifest(dir, { runId = path.basename(dir).replace(/-public$/, ""), runUid = null, revision = 1 } = {}) {
  const walk = (d, prefix = "") =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]));
  const files = walk(dir)
    .filter((p) => !["manifest.json", "run.jsonl", SIGNATURE_FILE].includes(p))
    .sort()
    .map((p) => {
      const data = fs.readFileSync(path.join(dir, p));
      return { path: p, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") };
    });
  fs.writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify({ version: 1, bundle: BUNDLE_KIND, bundle_version: BUNDLE_VERSION, spec_version: SPEC_VERSION, run_id: runId, run_uid: runUid, revision, generated_at: new Date().toISOString(), files }, null, 2)}\n`);
  return files;
}

const BINARY = /\.(dll|exe|pdb|sav|dem|vpk|bsp|zip|7z|png|jpe?g|webp|mp4|mkv|mov|wav|mp3)$/i;
export function scanPublication(dir) {
  const findings = [];
  let files = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name), rel = path.relative(dir, abs).replaceAll("\\", "/");
      if (e.isSymbolicLink()) { findings.push({ file: rel, rule: "symlink" }); continue; }
      if (e.isDirectory()) { walk(abs); continue; }
      files++;
      if (rel === "run.jsonl" || /^rollout-.*\.jsonl$/i.test(e.name)) { findings.push({ file: rel, rule: "private log" }); continue; }
      if (BINARY.test(rel)) { if (!rel.startsWith("recording/")) findings.push({ file: rel, rule: "binary outside recording/" }); continue; }
      const text = fs.readFileSync(abs, "utf8");
      if (text.includes("\0")) findings.push({ file: rel, rule: "binary content" });
      for (const [rule, re] of SCAN_RULES) if (re.test(text)) findings.push({ file: rel, rule });
    }
  };
  walk(dir);
  return { files, findings };
}

export async function publish(runDir, outDir, { session, completionMarker, log = console.log , signKey = null } = {}) {
  runDir = path.resolve(runDir);
  outDir = path.resolve(outDir);
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) throw new Error(`Refusing to write into non-empty ${outDir}`);
  const brief = JSON.parse(fs.readFileSync(path.join(runDir, "brief.json"), "utf8"));
  const recording = fs.existsSync(path.join(runDir, "recording.json")) ? JSON.parse(fs.readFileSync(path.join(runDir, "recording.json"), "utf8")) : null;
  fs.mkdirSync(outDir, { recursive: true });

  // 1. session log → session.sanitized.jsonl + summary.json (schema 2)
  const runtime = brief.runtime;
  let rt = null;
  try { rt = await (await import("./plugins.mjs")).loadRuntime(brief.runtimeModule ?? brief.runtime); } catch { /* an unknown runtime: the log must be given */ }
  if (!session) {
    // Runtimes that keep their log in the run directory say so in outcome.json (privateLog); Claude Code's lives in its own project folder.
    const outcomeFile = path.join(runDir, "outcome.json");
    const privateLog = fs.existsSync(outcomeFile) ? JSON.parse(fs.readFileSync(outcomeFile, "utf8")).privateLog : null;
    if (privateLog && fs.existsSync(privateLog)) session = privateLog;
    else if (rt?.findSession) session = rt.findSession(runDir);
    else if (fs.existsSync(path.join(runDir, "session.jsonl"))) session = path.join(runDir, "session.jsonl");
  }
  if (!session || !fs.existsSync(session)) throw new Error(`No session log found for runtime ${runtime}; pass --session <file>.`);
  // Every goal the run had, from its own events: a resume may extend the goal, and a victory reaches only the goal
  // that held at that moment. An extension is published only once it is reached: until then the bundle keeps the
  // last goal that was reached, completed at its victory, and what came after is post-completion time on the
  // timeline. A run that reached no goal publishes the goal it had (the completion marker is the fallback).
  const history = goalHistory(readRunEvents(runDir), brief.category.goal);
  const lastReached = history.findLastIndex((g) => g.reached_at);
  const goals = lastReached >= 0 ? history.slice(0, lastReached + 1) : history;
  const won = lastReached >= 0 ? { timestamp: history[lastReached].reached_at } : null;
  const publishedGoal = goals.at(-1)?.id ?? brief.category.goal;
  // The runtime exports its own private log; a runtime without an exporter keeps the harness's own session
  // shape (session.jsonl in the run directory, as the scripted and stub runtimes write it).
  if (rt?.exportSession) await rt.exportSession(session, outDir, { completionMarker, completionTime: won?.timestamp ?? null });
  else await exportClaudeSession(session, outDir, { completionMarker, completionTime: won?.timestamp ?? null });
  log(`exported ${path.basename(session)}`);
  // The harness's own events (run.started, game.playback, game.milestone, game.over, run.human, recording.*) belong
  // in the public timeline: the spec reserves them, and without run.human the human axis cannot be verified. They
  // are merged from run.jsonl on the same clock, sanitised, and the file is renumbered.
  const merged = mergeHarnessEvents(runDir, path.join(outDir, "session.sanitized.jsonl"));
  if (merged) log(`${merged.events} harness event(s) merged into the timeline (${merged.records} records)`);

  // 2. the other required files
  for (const f of ["tools.json", "AGENTS.md", "documentation.md"]) if (fs.existsSync(path.join(runDir, f))) fs.copyFileSync(path.join(runDir, f), path.join(outDir, f));
  copyTree(path.join(runDir, "runtime-config"), path.join(outDir, "runtime-config"));
  const plugin = brief.gameModule ? await loadGamePlugin(brief.gameModule) : null;
  for (const src of plugin?.gameConfig ?? []) {
    if (!fs.existsSync(src)) continue;
    const dst = path.join(outDir, "game-config", path.basename(src));
    if (fs.statSync(src).isDirectory()) copyTree(src, dst);
    else { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); }
  }
  // The recording itself is not copied into the bundle: a run is hours of 1080p60 and nobody ships gigabytes.
  // Nor is where it is published: a bundle carries no video links.
  // The bundle carries the chapters and the timings that place the timeline in the recording.

  // 3. timeline: timers, sections, chapters, cut list
  let timeline = null;
  try {
    // Completion as the exported summary states it (the published goal's victory, or the completion marker).
    const exportedCompletion = (() => { try { return JSON.parse(fs.readFileSync(path.join(outDir, "summary.json"), "utf8")).completed_at ?? null; } catch { return null; } })();
    timeline = computeTimeline(runDir, { completedAt: exportedCompletion });
    writeTimeline(runDir, timeline);
    fs.copyFileSync(path.join(runDir, "timeline", "timeline.json"), path.join(outDir, "timeline.json"));
    if (timeline.sections.length > 1) fs.copyFileSync(path.join(runDir, "timeline", "chapters.txt"), path.join(outDir, "chapters.txt"));
    const { writeLss } = await import("../../timer-livesplit/index.mjs");
    fs.copyFileSync(writeLss(runDir, timeline, { game: plugin?.name ?? brief.category.game, category: `AI Assisted Speedrun (${publishedGoal})` }), path.join(outDir, "splits.lss"));
  } catch (error) {
    log(`no timeline: ${error.message}`);
  }

  // 4. summary schema 6
  const summaryFile = path.join(outDir, "summary.json");
  const summary = JSON.parse(fs.readFileSync(summaryFile, "utf8"));
  // Three versions, because three things change at their own pace and a reader has to tell them apart:
  // the standard the run claims to follow, the shape of this summary, and the packaging of the bundle.
  // `revision` counts republications of the same run: a database keyed on (run_id, revision) can tell an
  // update of a run it already holds from a new run, and `published_at` orders them.
  summary.schema_version = SUMMARY_SCHEMA;
  summary.spec_version = SPEC_VERSION;
  summary.run_id = path.basename(outDir);
  // A name can change: a run directory is renamed, a bundle is published under the naming convention that came
  // later. `run_uid` is written once when the run is configured and never changes, so a reader can see that two
  // bundles under different names are the same run. Seeing it is not deciding it: whether a new publication
  // supersedes an older entry is a judgement, and that belongs to whoever keeps the archive.
  if (!brief.run_uid) {
    brief.run_uid = randomBytes(16).toString("hex");
    fs.writeFileSync(path.join(runDir, "brief.json"), `${JSON.stringify(brief, null, 2)}\n`);
    log(`this run had no run_uid (it predates the field); one was written now: ${brief.run_uid}`);
  }
  summary.run_uid = brief.run_uid;
  const revisionFile = path.join(runDir, "publish-revision.json");
  const revision = (() => {
    try { return Number(JSON.parse(fs.readFileSync(revisionFile, "utf8")).revision) + 1 || 1; } catch { return 1; }
  })();
  const previous = (() => { try { return JSON.parse(fs.readFileSync(revisionFile, "utf8")); } catch { return {}; } })();
  // bundle_dir and upload_note are for the upload sheet (aas upload-sheet), which aas render writes again later.
  fs.writeFileSync(revisionFile, `${JSON.stringify({ run_id: summary.run_id, revision, published_at: new Date().toISOString(), bundle_dir: path.resolve(outDir), upload_note: previous.upload_note ?? null }, null, 2)}\n`);
  summary.bundle = { kind: BUNDLE_KIND, bundle_version: BUNDLE_VERSION, run_id: summary.run_id, run_uid: brief.run_uid ?? null, revision, published_at: new Date().toISOString() };
  // What it takes to play the same thing again: the game's build, the mods with their pins, the run's settings.
  try { summary.game = (await plugin?.build?.({ runDir })) ?? null; } catch (e) { summary.game = null; log(`game build info not available (${e.message})`); }
  // A mod's name is its own; what was done to it (a patch) goes in details, null when there is nothing to add.
  if (summary.game?.mods) summary.game.mods = summary.game.mods.map(({ name, details = null, ...rest }) => ({ name, details, ...rest }));
  summary.category = { ...brief.category, goal: publishedGoal, human_notes: brief.category.human_notes ?? null };
  // The goal by name, the game's ends as the plugin declares them, and every goal the run had with when it held and
  // when it was reached: the same fields for every game, because every game plugin declares its ends.
  if (!plugin) throw new Error("the run's brief names no game module, so its ends and goals cannot be published");
  const ends = endsOf(plugin);
  const endOf = (id) => ends.find((e) => e.id === id);
  summary.ends = ends.map(publicEnd);
  summary.category.goal_end = endOf(publishedGoal) ? publicEnd(endOf(publishedGoal)) : null;
  // A run completed by its completion marker rather than a victory event reached its last goal at completed_at.
  if (goals.length && !goals.at(-1).reached_at && summary.completed_at) goals.at(-1).reached_at = summary.completed_at;
  summary.goals = goals.map((g) => ({ ...(endOf(g.id) ? publicEnd(endOf(g.id)) : { id: g.id, label: null, final: null }), declared_at: g.declared_at, reached_at: g.reached_at }));
  // Reproducibility: the seed of the last run (the game's own seed code, and the raw value), plus every run's seed.
  const lastAttempt = timeline?.attempts?.at(-1) ?? null;
  summary.seed = lastAttempt?.seed_code ?? lastAttempt?.seed ?? null;
  summary.attempts = (timeline?.attempts ?? []).map((a) => ({ attempt: a.attempt, seed: a.seed_code ?? a.seed ?? null, outcome: a.outcome, rta: a.rta, igt: a.igt }));
  // Every resume is a run.human record; the category may then not claim `none`. When an extension is not published
  // yet, only the run up to the published goal's victory counts: the resume that extended it belongs to the extension.
  const completedMs = won && history.length > goals.length ? Date.parse(won.timestamp) : null;
  const humanEvents = (await import("./events.mjs")).readRunLog(runDir).filter((r) => r.kind === "event" && r.event === "run.human" && (completedMs === null || Date.parse(r.timestamp) <= completedMs));
  if (humanEvents.length && summary.category.human === "none") {
    summary.category.human = "restart-only";
    summary.category.human_notes = humanEvents.map((e) => e.data?.note).filter(Boolean).join("; ") || `${humanEvents.length} resume(s)`;
  }
  // Whether the recording shows the game is checked by the recorder at the start of the run, where a failed capture
  // can still stop the run; what the published video shows is for the archive to judge (owner, 2026-09-15).
  // A platform re-encodes what you upload, so a hash of the video file proves nothing about the video anyone can
  // watch. What ties the two together is this: the length of the recording, and a fingerprint of this bundle's own
  // timeline that the publisher puts in the video's description. An archive reads the description, compares the
  // fingerprint and the duration, and spot-checks a few tool calls at their elapsed_seconds. A video that belongs
  // to another run fails on all three.
  const rawFiles = (recording?.files ?? []).filter((f) => !/\.cut\.mp4$/.test(f)).map((f) => path.join(runDir, f)).filter((f) => fs.existsSync(f));
  const durations = rawFiles.map((f) => { try { return probeDuration(f); } catch { return null; } }).filter((d) => typeof d === "number");
  const fingerprint = fs.existsSync(path.join(outDir, "session.sanitized.jsonl"))
    ? createHash("sha256").update(fs.readFileSync(path.join(outDir, "session.sanitized.jsonl"))).digest("hex")
    : null;
  const duration = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0)) : null;
  summary.recording = {
    duration_seconds: duration,
    fingerprint,
    recorder: recording?.recorder ?? null,
    t0: recording?.t0 ?? timeline?.t0 ?? null,
    files: recording?.files ?? [],
    chapters: fs.existsSync(path.join(outDir, "chapters.txt")) ? "chapters.txt" : null,
    igt_seconds: timeline ? Math.round(timeline.totals.igt * 1000) / 1000 : null,
    wall_clock_seconds: recording?.wall_clock_seconds ?? (timeline ? Math.round(timeline.totals.rta) : null),
    thinking_seconds: timeline ? Math.round(timeline.totals.thinking) : null,
  };
  // The run's times to its goal, next to the recording's whole-length figures above: null when the run was not completed.
  const ttc = timeline?.totals_to_completion ?? null;
  summary.totals_to_completion = ttc && { rta_seconds: Math.round(ttc.rta * 1000) / 1000, igt_seconds: Math.round(ttc.igt * 1000) / 1000, thinking_seconds: Math.round(ttc.thinking * 1000) / 1000, playbacks: ttc.playbacks, tool_calls: ttc.tool_calls };
  summary.harness = {
    name: "ai-assisted-speedruns",
    version: FRAMEWORK_VERSION,
    framework: `ai-assisted-speedruns ${FRAMEWORK_VERSION}`,
    plugins: {
      game: { id: brief.game?.id ?? brief.category.game ?? null, version: brief.game?.version ?? null },
      // version is the runtime plugin's; cli_versions are the versions of the runtime's own CLI its session log records.
      runtime: { id: runtime ?? null, name: rt?.name ?? null, version: brief.runtimeVersion ?? null, cli_versions: Array.isArray(summary.cli_versions) ? summary.cli_versions : [] },
      recorder: { id: recording?.recorder ?? null, version: recording?.recorder_version ?? null },
      timer: { id: recording?.timer?.id ?? null, version: recording?.timer?.version ?? null },
    },
  };
  // What the run asked for, next to what the API answered with (summary.models, one entry per model seen in the
  // session log). A silent fallback to another model is then visible in the bundle itself; `aas check` reports it.
  delete summary.cli_versions;
  summary.requested = {
    model: brief.model ?? null,
    reasoning_effort: brief.reasoningEffort ?? null,
    note: brief.reasoningEffort ? null : "the runtime does not set a reasoning effort; it passes only --model",
  };
  if (brief.model && !summary.models.length) summary.models = [{ model: brief.model, reasoning_effort: null }];
  // Each model as the runtime reported it: its context window, maximum output and provider, null where the runtime
  // reported nothing. The same model under two different reports is two entries: they are not the same set-up.
  const reports = (() => { try { return rt?.modelReports?.(runDir) ?? null; } catch { return null; } })();
  summary.models = summary.models.flatMap((m) => {
    const own = { context_window: m.context_window ?? null, max_output_tokens: m.max_output_tokens ?? null, provider: m.provider ?? null };
    const list = reports?.get(m.model)?.length ? reports.get(m.model) : [own];
    return list.map((r) => ({ model: m.model, parts: modelParts(m.model), reasoning_effort: m.reasoning_effort ?? null, ...r }));
  });
  // The videos the runner may upload (the whole recording or one per segment, and the cut), each with its length, the
  // line its description must carry, its chapters on its own clock, and a suggested title and description ending on
  // that line: an archive shows them as they are, without deriving or composing any.
  // What the picture shows besides the game: the harness's overlay (timers, the keys being played, the model's last
  // command), when every session had it; null when a session did not say (made before 0.15.0).
  const starts = readRunEvents(runDir).filter((e) => e.event === "run.started");
  const shown = starts.map((e) => e.data?.overlay);
  summary.recording.overlay = starts.length && shown.every((x) => typeof x === "boolean") && new Set(shown).size === 1
    ? { shown: shown[0], keys: shown[0] && readRunEvents(runDir).some((e) => e.event === "game.playback" && e.data?.phase === "start" && (e.data?.steps ?? []).length > 0) }
    : null;
  summary.recording.videos = withVideoTexts(
    recordingVideos({ runId: summary.run_id, fingerprint, durationSeconds: duration, files: summary.recording.files, timeline, schema: summary.schema_version }),
    summary, { archiveUrl: ARCHIVE_URL, note: previous.upload_note ?? null },
  );
  fs.writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);

  // Runtime configuration for publication, regenerated from the current rules rather than copied from configure
  // time: the copy made at configure time once carried the machine's.env.
  try {
    if (rt?.writePublicConfig) {
      const spec = await brokerSpec({ gameModule: brief.gameModule, runDir, timeZone: process.env.AAS_TIME_ZONE });
      await rt.writePublicConfig(runDir, spec);
      fs.rmSync(path.join(outDir, "runtime-config"), { recursive: true, force: true });
      copyTree(path.join(runDir, "runtime-config"), path.join(outDir, "runtime-config"));
    }
  } catch (e) {
    log(`runtime config not regenerated (${e.message}); the copy from configure time is published`);
  }
  // 5. manifest, scan, check
  // The run id in the manifest is the bundle's own directory name: that is what an archive uses as the run's identity.
  const files = writeManifest(outDir, { runId: summary.run_id, runUid: brief.run_uid ?? null, revision });
  // The signature covers the manifest's bytes, so it covers the bundle; it is written after the manifest and is
  // itself not listed in it. Signing is optional: it says two bundles came from one key, and nothing about whose
  // key that is until an archive knows it. Who published a run is the archive's account, not this file.
  let signature = null;
  if (signKey) {
    const key = resolveSignKey(signKey);
    try { signature = signBundle(outDir, key); log(`signed with ${signature.key_fingerprint} (${key})`); }
    catch (e) { throw new Error(`signing failed: ${e.message}`); }
  } else log("not signed (optional: `aas key` once, then --sign, if you want your bundles tied to one key)");
  const scan = scanPublication(outDir);
  const check = checkRun(outDir);
  log(`${files.length} files in manifest; scan: ${scan.findings.length} finding(s)`);
  for (const f of scan.findings) log(`  SCAN ${f.rule}: ${f.file}`);
  if (scan.findings.length) {
    // A bundle with private data in it is not published: the directory is removed again.
    fs.rmSync(outDir, { recursive: true, force: true });
    throw new Error(`not published: ${scan.findings.length} private item(s) found (${scan.findings.map((f) => `${f.rule} in ${f.file}`).join("; ")}); the output directory was removed`);
  }
  // The upload file: only a bundle the scan cleared is packed.
  const zip = packBundle(outDir);
  log(`${path.basename(zip.file)}: ${zip.files} files, ${Math.round(zip.bytes / 1024)} kB (the recording is published separately, not packed)`);
  // The videos the runner uploads (the cut, the full recording per segment, or both) and the code each one's description
  // must contain are in one file next to the videos, in the private run directory.
  const { writeUploadSheet } = await import("./upload-sheet.mjs");
  const uploadSheet = writeUploadSheet(runDir, { bundleDir: outDir, log });
  if (fingerprint) {
    log("");
    log(`Every video you upload needs this code in its description: ${descriptionLine(summary)}`);
    log(`The videos, their code and their chapters: ${uploadSheet}`);
    log(`Submit ${path.basename(zip.file)} at ${ARCHIVE_URL}/submit/.`);
    log("");
  }
  log(formatReport(outDir, check));
  return { outDir, summary, scan, check, timeline, zip, signature, uploadSheet };
}

/** Events of run.jsonl that are not published: the operator's plan usage. */
const PRIVATE_EVENTS = new Set(["budget.checked"]);
/** Fields of event data that name machine files or session identifiers. */
const PRIVATE_EVENT_FIELDS = new Set(["file", "sessionId", "privateLog"]);

export function mergeHarnessEvents(runDir, publicLog) {
  if (!fs.existsSync(publicLog) || !fs.existsSync(path.join(runDir, "run.jsonl"))) return null;
  const { clean } = createSanitizer();
  const events = readRunEvents(runDir)
    .filter((e) => !PRIVATE_EVENTS.has(e.event))
    .map((e) => ({ timestamp: e.timestamp, kind: "event", event: e.event, source: e.source ?? null, data: clean(Object.fromEntries(Object.entries(e.data ?? {}).filter(([k]) => !PRIVATE_EVENT_FIELDS.has(k)))) }));
  if (!events.length) return null;
  const exported = fs.readFileSync(publicLog, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const all = [...exported.map((r, i) => ({ r, i, at: Date.parse(r.timestamp) })), ...events.map((r, i) => ({ r, i: exported.length + i, at: Date.parse(r.timestamp) }))]
    .sort((a, b) => a.at - b.at || a.i - b.i)
    .map((x) => x.r);
  const first = Date.parse(all[0].timestamp);
  const lines = all.map((r, i) => JSON.stringify({ sequence: i + 1, timestamp: r.timestamp, elapsed_seconds: Math.max(0, Math.round((Date.parse(r.timestamp) - first) / 1000)), ...Object.fromEntries(Object.entries(r).filter(([k]) => !["sequence", "timestamp", "elapsed_seconds"].includes(k))) }));
  fs.writeFileSync(publicLog, `${lines.join("\n")}\n`);
  const summaryFile = path.join(path.dirname(publicLog), "summary.json");
  if (fs.existsSync(summaryFile)) {
    const s = JSON.parse(fs.readFileSync(summaryFile, "utf8"));
    // The events are a second source next to the session log: counted on both sides, so source = exported + omitted holds.
    s.source_records = (s.source_records ?? 0) + events.length;
    s.exported_records = (s.exported_records ?? 0) + events.length;
    s.harness_events = events.length;
    fs.writeFileSync(summaryFile, `${JSON.stringify(s, null, 2)}\n`);
  }
  return { events: events.length, records: all.length };
}

/**
 * Packs a published bundle into one zip for upload. A bundle carries no recording, so the zip is the whole of
 * it; the `recording/` filter below is there for a directory a publisher put in the output themselves. The video is linked in the
 * submission form, not carried in the bundle, and its sha256 stays in `manifest.json` so the linked file can
 * still be checked. Returns `{ file, bytes, files }`.
 */
export function packBundle(outDir, { zipFile = `${outDir}.zip` } = {}) {
  const walk = (d, prefix = "") =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]));
  const name = path.basename(outDir).replace(/-public$/, "");
  const entries = walk(outDir)
    .filter((p) => !p.startsWith("recording/") && !p.startsWith("."))
    .sort()
    .map((p) => ({ name: `${name}/${p}`, data: fs.readFileSync(path.join(outDir, p)), mtime: fs.statSync(path.join(outDir, p)).mtime }));
  const buf = zipBuffer(entries);
  fs.writeFileSync(zipFile, buf);
  return { file: zipFile, bytes: buf.length, files: entries.length };
}

/**
 * What an uploaded video's description carries, so the video names the bundle it belongs to: from schema 14 the code,
 * the same for every video; before that the line with `seconds`, that video's length.
 */
export function descriptionLine(summary, seconds = summary.recording?.duration_seconds) {
  const id = summary.run_id ?? summary.category?.game ?? "run";
  if ((summary.schema_version ?? 0) >= CODE_SCHEMA) return bindingLine(summary.schema_version, id, summary.recording?.fingerprint);
  return `AAS ${id} · fingerprint ${String(summary.recording?.fingerprint ?? "").slice(0, 16)} · ${seconds ?? "?"} s`;
}

/** Where the publisher's own signing key lives when they let the tooling make one. */
export const AAS_KEY_FILE = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "aas", "signing.pem");
/** An SSH key the publisher may already have; used only when it is there. */
export const SSH_KEY_FILE = () => path.join(os.homedir(), ".ssh", "id_ed25519");

/**
 * `--sign` with a path signs with that key. `--sign` on its own looks for the publisher's own key: the one
 * `aas key` writes, then an SSH key if they happen to have one. Nothing here assumes an account anywhere: this
 * tooling can be downloaded without one, and most people who play a game have no SSH key at all. The key says
 * "the same hand published these"; an archive says whose hand, from its own accounts.
 */
export function resolveSignKey(signKey) {
  if (typeof signKey === "string" && signKey.trim()) return signKey;
  if (process.env.AAS_SIGN_KEY) return process.env.AAS_SIGN_KEY;
  for (const candidate of [AAS_KEY_FILE(), SSH_KEY_FILE()]) if (fs.existsSync(candidate)) return candidate;
  throw new Error(`--sign needs a key and there is none yet: run \`aas key\` to make one (it lands in ${AAS_KEY_FILE()}), or give a path with --sign <key>`);
}
