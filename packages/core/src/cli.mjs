#!/usr/bin/env node
// `aas`: the command-line entry point.
//
//   aas configure --runtime <codex|claude-code> --game <plugin.mjs> --run-dir <dir> [--model m] [--effort low|medium|high|xhigh|max] [--goal g] [--instructions file]
//   aas start --runtime <id> --run-dir <dir>
//   aas check-connection --game <plugin.mjs> --run-dir <dir> [--exercise]
//   aas check [--strict] [--core] <bundle-dir | bundle.zip>   (--core: accepted and ignored)
//   aas login | aas logout | aas tickets [extend|revoke|delete <ticket>]
import fs from "node:fs";
import path from "node:path";
import { loadSettings } from "./settings.mjs";
import { pathToFileURL } from "node:url";
import { ARCHIVE_URL, loadRuntime } from "./plugins.mjs";
import { brokerSpec, configure } from "./configure.mjs";
export { brokerSpec, configure };

// Settings come from two files: the game's own (.local/games/<game>.env) and the machine's (.env). The CLI loads
// them itself, so the same command works from any shell; see settings.mjs for the order and why.
const gameArg = (() => { const i = process.argv.indexOf("--game"); return i === -1 ? null : process.argv[i + 1]; })();
loadSettings(gameArg);

// Flags that never take a value (so `aas check --strict <dir>` keeps its directory).
const BOOLEAN_FLAGS = new Set(["upload", "keep", "no-open", "strict", "core", "headless", "exercise", "no-cut", "no-autosave", "ignore-budget", "keep-open", "allow-breaking", "help"]);
function parse(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      const value = BOOLEAN_FLAGS.has(key) || next === undefined || next.startsWith("--") ? true : argv[++i];
      // A flag given more than once collects its values (`--identity a --identity b`).
      if (key in opts) opts[key] = [].concat(opts[key], value);
      else opts[key] = value;
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
        const { checkBundle, formatReport } = await import("./check-run.mjs");
        const dir = opts._[0];
        if (!dir) throw new Error("Usage: aas check [--strict] <bundle-dir | bundle.zip>");
        const report = checkBundle(path.resolve(dir), { core: Boolean(opts.core) });
        // An upload zip with its private part: the archive's whole check of the proof, the timeline made again too.
        if (fs.statSync(path.resolve(dir)).isFile()) {
          const { checkZipProof } = await import("./proof-check.mjs");
          const whole = await checkZipProof(path.resolve(dir));
          if (whole) {
            const row = report.results.find((r) => r.requirement === "proof");
            if (row) Object.assign(row, { status: { signed: "met", unsigned: "unmet", review: "unmet", invalid: "invalid" }[whole.status], detail: whole.detail });
          }
        }
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
      case "key": {
        // The publisher's own signing key: made here when they have none, because this tooling can be
        // downloaded without an account anywhere and most people who play a game have no SSH key.
        const { createKey, makeClaim, verifyClaim } = await import("./sign.mjs");
        const { AAS_KEY_FILE, resolveSignKey } = await import("./publish.mjs");
        if (opts.verify) {
          // A claim as published: any wrapper around it (a clearsigned block, a page, a mail) is ignored.
          const text = opts.verify === true || opts.verify === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(String(opts.verify), "utf8");
          const r = verifyClaim(text);
          console.log(r.valid ? `valid claim by ${r.fingerprint}` : `NOT a valid claim: ${r.problem}`);
          for (const id of r.identities ?? []) console.log(`  identity: ${id}`);
          if (r.valid) console.log(`  issued: ${r.issued}\n  key: ${r.publicLine}\nIt says this key claims those identities. Whether they agree is what the place you found it in says.`);
          process.exitCode = r.valid ? 0 : 1;
          break;
        }
        const file = opts._[0] ? path.resolve(opts._[0]) : (typeof opts.key === "string" ? path.resolve(opts.key) : AAS_KEY_FILE());
        const k = createKey(file);
        console.log(`${k.created ? "created" : "already there"}: ${k.file}`);
        console.log(k.publicLine);
        console.log(k.fingerprint);
        if (!opts.claim) {
          console.log(`That public line is what identifies you as a publisher: record it on your account page at the archive (${ARCHIVE_URL}/account/, Record key).`);
          console.log("To publish it anywhere instead: aas key --claim --identity <uri> [--identity <uri>]");
          break;
        }
        // A claim: the publisher's own signed statement about their key, plain text, tied to no archive.
        const identities = [].concat(opts.identity ?? []).filter((x) => typeof x === "string").flatMap((x) => x.split(",")).map((x) => x.trim()).filter(Boolean);
        if (!identities.length) throw new Error("--claim needs at least one --identity <uri> (https://…, mailto:…)");
        const claim = makeClaim(resolveSignKey(file), { identities });
        if (opts.out) { fs.writeFileSync(String(opts.out), claim.text); console.log(`claim written to ${opts.out}`); }
        else { console.log(""); console.log(claim.text.trimEnd()); }
        break;
      }
      case "publish": {
        const { publish } = await import("./publish.mjs");
        const [src, out] = opts._;
        if (!src || !out) throw new Error("Usage: aas publish <run-dir> <out-dir> [--sign [key]] [--session <log>] [--completion-marker <text>]");
        if (opts["video-url"] !== undefined) throw new Error("--video-url is gone: a bundle carries no video links");
        const r = await publish(src, out, { session: opts.session, completionMarker: opts["completion-marker"], signKey: opts.sign });
        process.exitCode = r.scan.findings.length || r.check.results.some((x) => x.status === "invalid") ? 1 : 0;
        if (opts.upload && !process.exitCode) {
          const { uploadBundle } = await import("./upload.mjs");
          const answer = await uploadBundle(r.zip.file);
          console.log(`uploaded: ${answer.status ?? "received"}${answer.submission ? ` (${answer.submission})` : ""}${answer.reasons?.length ? `; ${answer.reasons.join("; ")}` : ""}`);
        }
        break;
      }
      case "login": {
        const { login } = await import("./auth.mjs");
        const c = await login();
        console.log(`signed in to ${c.archive}; runs record their proof under this account from now on`);
        break;
      }
      case "logout": {
        const { logout } = await import("./auth.mjs");
        console.log((await logout()) ? "signed out: the archive revoked this machine's token and it is forgotten here" : "not signed in");
        break;
      }
      case "tickets": {
        // The tickets of this machine's runs: what they are, until when, and extend, revoke or delete one.
        const { readTicketIndex, proofClient } = await import("./proof.mjs");
        const { accessToken } = await import("./auth.mjs");
        const [action, id] = opts._;
        const list = readTicketIndex();
        if (!action) {
          if (!list.length) console.log("no tickets on this machine");
          for (const t of list) console.log(`${t.ticket}  ${t.account ? "account  " : "anonymous"}  segment ${t.segment}  issued ${t.issued_at}  expires ${t.expires_at ?? "?"}  ${t.run_dir}`);
          break;
        }
        if (!["extend", "revoke", "delete"].includes(action) || !id) throw new Error("Usage: aas tickets [extend|revoke|delete <ticket>]");
        const t = list.find((x) => x.ticket === id);
        if (!t) throw new Error(`${id} is not a ticket of this machine (aas tickets lists them)`);
        const answer = await proofClient({ token: t.account ? () => accessToken() : async () => null }).manage(t, action);
        console.log(`${action}: ${JSON.stringify(answer)}`);
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
      case "upload-sheet": {
        const { writeUploadSheet } = await import("./upload-sheet.mjs");
        const dir = opts._[0];
        if (!dir) throw new Error("Usage: aas upload-sheet <run-dir> [--bundle <public-dir>] [--note <text>]");
        const out = writeUploadSheet(dir, { bundleDir: opts.bundle, note: opts.note, log: console.log });
        if (!out) process.exitCode = 1;
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
      case "check-agent": {
        const { checkAgent } = await import("./check-agent.mjs");
        if (!opts.runtime || !opts.game) throw new Error("Usage: aas check-agent --runtime <claude-code|codex> --game <plugin.mjs> [--run-dir <dir>] [--keep]");
        const r = await checkAgent({ runtime: opts.runtime, game: opts.game, runDir: opts["run-dir"] ?? null, keep: opts.keep === true });
        process.exitCode = r.ok ? 0 : 1;
        break;
      }
      case "gui": {
        const { startGui } = await import("./gui/server.mjs");
        const g = await startGui({ port: Number(opts.port ?? 8770), open: !opts["no-open"] });
        // A GUI that was already running has been opened again; only the GUI of this process keeps the window busy.
        if (!g.already) await new Promise(() => {}); // runs until Ctrl-C (or the window's own end)
        break;
      }
      default:
        console.error(
          [
            "Usage:",
            "  aas check-agent --runtime <claude-code|codex> --game <plugin.mjs> [--run-dir <dir>] [--keep]   does the agent's CLI reach the broker? (no model call, no tokens)",
            "  aas gui [--port 8770] [--no-open]           a web page to set up tools and games and to start runs; shows the commands it runs",
            "  aas configure --runtime <codex|claude-code> --game <plugin.mjs> --run-dir <dir> [--model m] [--effort low|medium|high|xhigh|max] [--goal g] [--prompt text] [--instructions file]",
            "  aas run --runtime <id> --game <plugin.mjs> --run-dir <dir> [--recorder <obs|source-demo|null>] [--timer livesplit] [--overlay-port 8765] [--headless --max-turns N --max-minutes M] [--keep-open] [configure options]",
            "                                           when the run ends the game, the timer, the recorder and a Steam the launcher started are closed; --keep-open leaves them",
            "  aas budget [--max <percent>]             the Claude plan usage; runs stay under AAS_BUDGET_WEEKLY_MAX (default 50%)",
            "  aas resume --run-dir <dir> [--save name] [--allow-breaking] [--recorder obs] [--timer livesplit] [--overlay-port 8765] [--headless --max-turns N --max-minutes M]",
            "  aas start --runtime <id> --run-dir <dir>",
            "  aas doctor --game <plugin.mjs> [--recorder obs] [--timer livesplit] [--runtime claude-code] [--run-dir <dir>]   read-only checks before a run",
            "  aas check-connection --game <plugin.mjs> --run-dir <dir> [--exercise]",
            "  aas timeline <run-dir>                       timers, sections, cut list, timers.srt, inputs.srt",
            "  aas render <run-dir> [--burn timers,inputs]  ffmpeg: playbacks only (pauses cut), optional burned-in timers/keys",
            "  aas key [file]                           the publisher's signing key: makes one if there is none, prints the public line to register",
            "  aas key --claim --identity <uri> [--out f]   a signed statement that this key is yours, to publish anywhere",
            "  aas key --verify <file|->                a claim as published: does it verify, and which identities does it name",
            "  aas publish <run-dir> <out-dir> [--sign [key]] [--session <log>] [--completion-marker <text>]",
            "                                           --sign without a path uses the key of `aas key`, or an SSH key if you already have one",
            "  aas upload-sheet <run-dir> [--bundle <public-dir>] [--note <text>]",
            "                                           <run-dir>/recording/UPLOAD.txt: the cut and the full recording per segment, each with its line and chapters",
            "  aas check [--strict] <bundle-dir | bundle.zip>",
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
