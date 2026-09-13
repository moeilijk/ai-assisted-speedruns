#!/usr/bin/env node
// `aas`: the command-line entry point.
//
//   aas configure --runtime <codex|claude-code> --game <plugin.mjs> --run-dir <dir> [--model m] [--effort low|medium|high|xhigh|max] [--goal g] [--instructions file]
//   aas start --runtime <id> --run-dir <dir>
//   aas check-connection --game <plugin.mjs> --run-dir <dir> [--exercise]
//   aas check [--strict] [--core] <run-dir>   (--core: bundle without its recording files)
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadRuntime } from "./plugins.mjs";
import { brokerSpec, configure } from "./configure.mjs";
export { brokerSpec, configure };

// Machine settings come from the repository's .env (copied from .env.example). The CLI loads it itself, so
// that the same command works from any shell; a variable already in the environment keeps its value.
const dotEnv = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..", ".env");
if (fs.existsSync(dotEnv)) process.loadEnvFile(dotEnv);

// Flags that never take a value (so `aas check --strict <dir>` keeps its directory).
const BOOLEAN_FLAGS = new Set(["strict", "core", "headless", "exercise", "no-cut", "no-autosave", "ignore-budget", "keep-open", "help"]);
function parse(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (BOOLEAN_FLAGS.has(key) || next === undefined || next.startsWith("--")) opts[key] = true;
      else opts[key] = argv[++i];
    } else opts._.push(a);
  }
  return opts;
}

export async function start(opts) {
  for (const k of ["runtime", "run-dir"]) if (!opts[k]) throw new Error(`--${k} is required`);
  const runDir = path.resolve(opts["run-dir"]);
  const brief = JSON.parse(fs.readFileSync(path.join(runDir, "brief.json"), "utf8"));
  const runtime = await loadRuntime(opts.runtime);
  return runtime.start(runDir, brief);
}

if (process.argv[1]?.endsWith("cli.mjs") || process.argv[1]?.endsWith("/aas") || process.argv[1]?.endsWith("\\aas")) {
  const [command, ...rest] = process.argv.slice(2);
  const opts = parse(rest);
  try {
    switch (command) {
      case "configure": {
        const r = await configure(opts);
        console.log(`Configured ${r.brief.runtime} run "${r.brief.id}" for ${r.brief.category.game} in ${r.runDir}`);
        console.log(r.hint);
        break;
      }
      case "start": {
        const outcome = await start(opts);
        console.log(JSON.stringify(outcome));
        process.exitCode = outcome.status === "failed" ? 1 : 0;
        break;
      }
      case "doctor": {
        const { doctor } = await import("./doctor.mjs");
        const r = await doctor({ game: opts.game, recorder: opts.recorder ?? null, timer: opts.timer ?? null, runtime: opts.runtime ?? null, runDir: opts["run-dir"] ?? null });
        process.exitCode = r.ok ? 0 : 1;
        break;
      }
      case "check-connection": {
        const { checkConnection } = await import("./check-connection.mjs");
        if (!opts.game || !opts["run-dir"]) throw new Error("--game and --run-dir are required");
        await checkConnection({ gameModule: opts.game, runDir: path.resolve(opts["run-dir"]), exercise: opts.exercise === true });
        break;
      }
      case "check": {
        const { checkRun, formatReport } = await import("./check-run.mjs");
        const dir = opts._[0];
        if (!dir) throw new Error("Usage: aas check [--strict] [--core] <run-dir>");
        const report = checkRun(path.resolve(dir), { core: Boolean(opts.core) });
        console.log(formatReport(dir, report));
        const invalid = report.results.some((r) => r.status === "invalid");
        const unmet = report.results.some((r) => r.status === "unmet");
        process.exitCode = invalid || (opts.strict && unmet) ? 1 : 0;
        break;
      }
      case "budget": {
        // Every runtime that runs on a plan reports its own stand; nothing here knows the plans by name.
        const { PACKAGES, loadRuntime } = await import("./plugins.mjs");
        let stop = false;
        for (const dir of fs.readdirSync(PACKAGES).filter((d) => d.startsWith("runtime-")).sort()) {
          try {
            const rt = await loadRuntime(dir.slice("runtime-".length));
            if (!rt.budget) continue;
            const b = await rt.budget();
            console.log(`${b.ok ? "OK  " : "STOP"}  ${rt.id}: ${b.detail}`);
            if (!b.ok) stop = true;
          } catch (e) {
            console.log(`?     ${dir.slice("runtime-".length)}: ${e.message}`);
          }
        }
        process.exitCode = stop ? 1 : 0;
        break;
      }
      case "run": {
        const { run } = await import("./run.mjs");
        const r = await run(opts);
        console.log(JSON.stringify({ status: r.outcome.status, recording: r.recording.files, wall_clock_seconds: r.recording.wall_clock_seconds }));
        process.exitCode = r.outcome.status === "failed" ? 1 : 0;
        break;
      }
      case "resume": {
        const { resume } = await import("./resume.mjs");
        const r = await resume(opts);
        console.log(JSON.stringify({ status: r.outcome.status, segment: r.segment, recording: r.recording.files }));
        process.exitCode = r.outcome.status === "failed" ? 1 : 0;
        break;
      }
      case "publish": {
        const { publish } = await import("./publish.mjs");
        const [src, out] = opts._;
        if (!src || !out) throw new Error("Usage: aas publish <run-dir> <out-dir> [--video-url <url>] [--sign [key]] [--session <log>] [--completion-marker <text>]");
        const r = await publish(src, out, { session: opts.session, completionMarker: opts["completion-marker"], videoUrl: opts["video-url"], signKey: opts.sign });
        process.exitCode = r.scan.findings.length || r.check.results.some((x) => x.status === "invalid") ? 1 : 0;
        break;
      }
      case "timeline": {
        const { computeTimeline, writeTimeline, formatTimeline } = await import("./timeline.mjs");
        const dir = opts._[0];
        if (!dir) throw new Error("Usage: aas timeline <run-dir>");
        const t = computeTimeline(path.resolve(dir), { marginBefore: opts["margin-before"], marginAfter: opts["margin-after"], attempt: opts.attempt });
        console.log(`written to ${writeTimeline(path.resolve(dir), t)}`);
        console.log(formatTimeline(t));
        break;
      }
      case "render": {
        const { render } = await import("./render.mjs");
        const dir = opts._[0];
        if (!dir) throw new Error("Usage: aas render <run-dir> [--video f] [--out f] [--burn timers,inputs] [--no-cut] [--crf 18]");
        render(dir, { attempt: opts.attempt, video: opts.video, out: opts.out, burn: String(opts.burn ?? "").split(",").filter(Boolean), cut: !opts["no-cut"], crf: opts.crf, marginBefore: opts["margin-before"], marginAfter: opts["margin-after"] });
        break;
      }
      case "scan": {
        const { scanPublication } = await import("./publish.mjs");
        const dir = opts._[0];
        if (!dir) throw new Error("Usage: aas scan <dir>");
        const r = scanPublication(path.resolve(dir));
        console.log(JSON.stringify(r, null, 2));
        process.exitCode = r.findings.length ? 1 : 0;
        break;
      }
      default:
        console.error(
          [
            "Usage:",
            "  aas configure --runtime <codex|claude-code> --game <plugin.mjs> --run-dir <dir> [--model m] [--effort low|medium|high|xhigh|max] [--goal g] [--prompt text] [--instructions file]",
            "  aas run --runtime <id> --game <plugin.mjs> --run-dir <dir> [--recorder <obs|source-demo|null>] [--timer livesplit] [--overlay-port 8765] [--headless --max-turns N --max-minutes M] [--keep-open] [configure options]",
            "                                           when the run ends the game, the timer, the recorder and a Steam the launcher started are closed; --keep-open leaves them",
            "  aas budget [--max <percent>]             the Claude plan usage; runs stay under AAS_BUDGET_WEEKLY_MAX (default 50%)",
            "  aas resume --run-dir <dir> [--save name] [--recorder obs] [--timer livesplit] [--overlay-port 8765] [--headless --max-turns N --max-minutes M]",
            "  aas start --runtime <id> --run-dir <dir>",
            "  aas doctor --game <plugin.mjs> [--recorder obs] [--timer livesplit] [--runtime claude-code] [--run-dir <dir>]   read-only checks before a run",
            "  aas check-connection --game <plugin.mjs> --run-dir <dir> [--exercise]",
            "  aas timeline <run-dir>                       timers, sections, cut list, timers.srt, inputs.srt",
            "  aas render <run-dir> [--burn timers,inputs]  ffmpeg: playbacks only (pauses cut), optional burned-in timers/keys",
            "  aas publish <run-dir> <out-dir> [--video-url <url>[,<url>]] [--sign [key]] [--session <log>] [--completion-marker <text>]",
            "                                           --sign without a path uses ~/.ssh/id_ed25519, the key your code-hosting account already publishes",
            "  aas check [--strict] <run-dir>",
            "  aas scan <dir>",
          ].join("\n"),
        );
        process.exitCode = command ? 1 : 0;
    }
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}
