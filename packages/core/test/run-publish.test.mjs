// End to end without an agent: `aas run` with the stub runtime, the Portal
// plugin against the fake SPT (with a fake game folder for the demos), the
// source-demo recorder and a fake LiveSplit server; then `aas timeline` and
// `aas publish`, whose result must pass `aas check` as conforming.
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeSpt } from "../../../games/portal/test/fake-spt.mjs";
import { run } from "../src/run.mjs";
import { resume } from "../src/resume.mjs";
import { publish } from "../src/publish.mjs";
import { computeTimeline } from "../src/timeline.mjs";
import { configure } from "../src/configure.mjs";
import { startFakeWitness } from "./fake-witness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
process.env.CODEX_HOME = process.env.CODEX_HOME ?? mkdtempSync(join(tmpdir(), "aas-codex-home-"));
const root = resolve(here, "..", "..", "..");
const portalAgentDir = resolve(process.env.AAS_PORTAL_AGENT_DIR || join(root, ".local", "portal-agent"));
const available = existsSync(join(portalAgentDir, "controller", "index.mjs"));

async function fakeLiveSplit() {
  const commands = [];
  const server = net.createServer((s) => {
    s.setEncoding("utf8");
    let buf = "";
    s.on("data", (d) => {
      buf += d;
      let at;
      while ((at = buf.indexOf("\n")) !== -1) {
        const c = buf.slice(0, at).replace(/\r$/, "");
        buf = buf.slice(at + 1);
        commands.push(c);
        if (c === "getcurrenttime") s.write("0:01:02.34\r\n");
        if (c === "getcurrentgametime") s.write("0:00:03.00\r\n");
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, commands, close: () => new Promise((r) => server.close(() => r())) };
}

test("aas run + timeline + publish produce a conforming Portal run directory", { skip: !available && "portal-agent not checked out", timeout: 60000 }, async () => {
  const gameRoot = mkdtempSync(join(tmpdir(), "aas-game-"));
  const spt = await startFakeSpt({ gameRoot, readyDelayMs: 300, transitionAfterTicks: 150 });
  const ls = await fakeLiveSplit();
  const runDir = join(mkdtempSync(join(tmpdir(), "aas-run-")), "portal-01");
  process.env.AAS_PORTAL_SPT_PORT = String(spt.port);
  process.env.AAS_PORTAL_AGENT_DIR = portalAgentDir;
  process.env.AAS_PORTAL_GAME_ROOT = gameRoot;
  process.env.AAS_LIVESPLIT_PORT = String(ls.port);
  process.env.AAS_TIME_ZONE = "Europe/Amsterdam";
  // A witness of its own, trusted through AAS_WITNESS_KEYS, and a publisher key made here: nothing reaches the archive.
  const witness = await startFakeWitness(dirname(runDir));
  const signKey = join(dirname(runDir), "publisher.pem");
  writeFileSync(signKey, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }));
  const savedEnv = { AAS_WITNESS_URL: process.env.AAS_WITNESS_URL, AAS_WITNESS_KEYS: process.env.AAS_WITNESS_KEYS, AAS_SIGN_KEY: process.env.AAS_SIGN_KEY };
  Object.assign(process.env, { AAS_WITNESS_URL: witness.url, AAS_WITNESS_KEYS: witness.keysFile, AAS_SIGN_KEY: signKey });
  let result;
  try {
    // configure first so stub-codes.json can be placed before the run
    const { configure } = await import("../src/configure.mjs");
    await configure({ runtime: join(here, "stub-runtime.mjs"), game: join(root, "games", "portal", "plugin.mjs"), "run-dir": runDir, model: "stub-model" });
    writeFileSync(join(runDir, "stub-codes.json"), JSON.stringify([
      "return await portal.observe()",
      "const t = portal.tas(); t.hold(67, { forward: true }); const r = await t.run(); return r.ticks",
      "const t = portal.tas(); t.hold(100, { forward: true }); const r = await t.run({ screenshot: false }); return { ticks: r.ticks, aborted: r.aborted, reason: r.reason }",
      "const t = portal.tas(); t.hold(33, { forward: true }); return (await t.run()).ticks",
    ]));
    result = await run({ runtime: join(here, "stub-runtime.mjs"), game: join(root, "games", "portal", "plugin.mjs"), "run-dir": runDir, recorder: "source-demo", timer: "livesplit", "autosave-minutes": "0.01", "keep-open": true }, { log: () => {} });
    // Autosave happened (milestone at the transition, the interval, the end of session) and left files.
    const saved = readFileSync(join(runDir, "run.jsonl"), "utf8").split("\n").filter((l) => l.includes('"game.saved"')).map((l) => JSON.parse(l));
    assert.ok(saved.length >= 2, `saves: ${saved.length}`);
    assert.ok(saved.some((e) => /milestone/.test(e.data.reason)), "milestone save");
    assert.ok(existsSync(join(runDir, "saves", `${saved.at(-1).data.name}.sav`)), "save copied into the run");
    assert.equal(result.outcome.status, "stopped");
    // Resume from the last save: second recording segment, run.human, new playbacks.
    writeFileSync(join(runDir, "stub-codes-resume.json"), JSON.stringify(["const t = portal.tas(); t.hold(67, { forward: true }); return (await t.run()).ticks"]));
    // Tooling that would serve the agent other documentation than its earlier session had does not resume the run,
    // and leaves the run directory as it was.
    const documentation = readFileSync(join(runDir, "documentation.md"), "utf8");
    const brief = readFileSync(join(runDir, "brief.json"), "utf8");
    const log = readFileSync(join(runDir, "run.jsonl"), "utf8");
    writeFileSync(join(runDir, "documentation.md"), `${documentation}An older description.\n`);
    await assert.rejects(resume({ "run-dir": runDir, recorder: "source-demo", timer: "livesplit", "no-autosave": true, "keep-open": true }, { log: () => {} }),
      /cannot be resumed with the installed tooling: this broker would serve other documentation\.md than the run started with/);
    assert.equal(readFileSync(join(runDir, "brief.json"), "utf8"), brief);
    assert.equal(readFileSync(join(runDir, "run.jsonl"), "utf8"), log);
    writeFileSync(join(runDir, "documentation.md"), documentation);
    const resumed = await resume({ "run-dir": runDir, recorder: "source-demo", timer: "livesplit", "no-autosave": true, "keep-open": true }, { log: () => {} });
    assert.equal(resumed.segment, 2);
    const starts = readFileSync(join(runDir, "run.jsonl"), "utf8").split("\n").filter((l) => l.includes('"run.started"')).map((l) => JSON.parse(l).data.tooling);
    assert.equal(starts.length, 2, "each session says which tooling ran it");
    for (const t of starts) {
      assert.equal(t.version, JSON.parse(readFileSync(join(root, "packages", "core", "package.json"), "utf8")).version);
      assert.match(t.commit, /^[0-9a-f]{40}$/);
      assert.equal(typeof t.modified, "boolean");
    }
    assert.equal(resumed.outcome.status, "completed");
    const witnessed = readFileSync(join(runDir, "run.jsonl"), "utf8").split("\n").filter((l) => l.includes('"run.witnessed"')).map((l) => JSON.parse(l).data);
    assert.deepEqual(witnessed.map((w) => `${w.segment} ${w.phase}`), ["1 start", "1 end", "2 start", "2 end"], "the archive witnessed the start and end of both segments");
    assert.equal(witness.statements.length, 4);
    const stops = readFileSync(join(runDir, "run.jsonl"), "utf8").split("\n").filter((l) => l.includes('"recording.stopped"'));
    assert.equal(stops.length, 2, "each segment's recording is logged as stopped, the resumed one too");
    assert.match(witness.statements[0], /^aas-witness v1\nphase: start\nrun_uid: [0-9a-f]{32}\nsegment: 1\ntooling: \d+\.\d+\.\d+ [0-9a-f]{40} (clean|modified)\nat: .+\nt0: .+\nkey: ssh-ed25519 \S+\nsignature: \S+$/);
    assert.match(witness.statements[1], /\nphase: end\n[\s\S]*\nended_at: .+\nseconds: \d+(\.\d+)?\n/);
    assert.ok(spt.seen.some((m) => m.type === "cmd" && /^load aas_/.test(m.cmd)), "load sent");
  } finally {
    delete process.env.AAS_PORTAL_GAME_ROOT;
    delete process.env.AAS_LIVESPLIT_PORT;
    await spt.close();
    await ls.close();
  }
  const recording = JSON.parse(readFileSync(join(runDir, "recording.json"), "utf8"));
  assert.equal(recording.segments.length, 2);
  assert.ok(recording.files.length >= 2);
  assert.ok(spt.seen.some((m) => m.type === "cmd" && m.cmd === "start_run"));
  assert.ok(spt.seen.some((m) => m.type === "cmd" && m.cmd === "stop_run"));
  assert.ok(existsSync(join(runDir, "recording", "testchmb_a_00.dem")));

  // LiveSplit: timer started, game time paused while thinking, split at the map transition; a stopped session pauses, it does not split.
  assert.deepEqual(ls.commands.slice(0, 5), ["reset", "initgametime", "starttimer", "pausegametime", "setgametime 0.000"]);
  assert.ok(ls.commands.filter((c) => c === "split").length >= 1);
  assert.equal(ls.commands.filter((c) => !c.startsWith("get")).at(-1), "pause");
  assert.ok(ls.commands.filter((c) => c === "unpausegametime").length >= 3);
  assert.ok(ls.commands.includes("setgametime 3.000"), ls.commands.join(","));

  // Timeline: 3 + 1 playbacks over two segments, 267 ticks = 4.005 s IGT, one map transition → two sections.
  const t = computeTimeline(runDir);
  assert.equal(t.playbacks.length, 4);
  assert.equal(Math.round(t.totals.igt * 1000), 4005);
  assert.equal(t.sections.length, 3, "Start, the map transition, and the resume (run.human) as a section boundary");
  assert.match(t.sections[2].label, /^Human: resumed/);
  assert.equal(t.segments.length, 2);
  assert.ok(t.playbacks.at(-1).start >= t.segments[1].offset, "resumed playback lies in segment 2's run time");
  assert.equal(t.sections[1].label, "Chamber 02");
  assert.ok(t.totals.thinking >= 0 && t.totals.rta >= t.totals.playback_wall);
  assert.equal(t.keep.length >= 1, true);

  // Publish → conforming.
  const outDir = join(dirname(runDir), "public");
  // Signed, because an entry says who published it; a generated PKCS#8 key needs no ssh-keygen here.
  let p;
  try {
    p = await publish(runDir, outDir, { completionMarker: "Reached the end credits", signKey, log: () => {} });
  } finally {
    await witness.close();
  }
  const witnessCheck = p.check.results.find((r) => r.requirement === "witnessed");
  assert.equal(witnessCheck.status, "met", witnessCheck.detail);
  assert.match(witnessCheck.detail, new RegExp(`2 segment\\(s\\), start and end, receipts by ${witness.fingerprint.replace(/[+/]/g, "\\$&")}`));
  assert.deepEqual(p.scan.findings, [], JSON.stringify(p.scan.findings));
  assert.ok(p.check.results.every((r) => r.status === "met"), JSON.stringify(p.check.results.filter((r) => r.status !== "met")));
  // Without the test witness's key the receipts are not the archive's: the check says so.
  for (const [k, v] of Object.entries(savedEnv)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  const { checkRun } = await import("../src/check-run.mjs");
  const strange = checkRun(outDir).results.find((r) => r.requirement === "witnessed");
  assert.equal(strange.status, "invalid");
  assert.match(strange.detail, /not signed by a witness key of the archive/);
  assert.equal(p.summary.schema_version, 12);
  assert.deepEqual(p.summary.game.mods.map((m) => [m.name, m.details]), [["SourcePauseTool", "portal-agent's IPC patch"]], "the mod's own name, the patch in details");
  for (const m of p.summary.models) assert.deepEqual(Object.keys(m), ["model", "parts", "reasoning_effort", "context_window", "max_output_tokens", "provider"], "each model with what the runtime reported, null where it reported nothing");
  assert.ok(Array.isArray(p.summary.harness.plugins.runtime.cli_versions), "the runtime CLI's versions, apart from the plugin's version");
  assert.equal("cli_versions" in p.summary, false);
  assert.ok(Array.isArray(p.summary.recording.videos), "the videos a runner may upload are in the bundle");
  for (const v of p.summary.recording.videos) assert.ok(v.title && v.description.trim().endsWith(v.line), "a suggested title and a description that ends on the line");
  for (const v of p.summary.recording.videos) assert.match(v.line, new RegExp(`^AAS ${p.summary.run_id} · fingerprint ${p.summary.recording.fingerprint.slice(0, 16)} · \\d+ s$`));
  assert.equal("black_intervals" in p.summary.recording, false, "what the video shows is the archive's to judge");
  assert.deepEqual(p.summary.ends, [{ id: "credits", label: "End credits", final: true }], "the game's ends as the plugin declares them");
  assert.deepEqual(p.summary.category.goal_end, { id: "credits", label: "End credits", final: true });
  assert.equal(p.summary.goals.length, 1);
  assert.equal(p.summary.goals[0].id, "credits");
  assert.equal(p.summary.goals[0].reached_at !== null, true);
  assert.equal(p.summary.harness.plugins.runtime.name, "Stub runtime");
  const spec = readFileSync(resolve(here, "..", "..", "spec", "SPEC.md"), "utf8");
  assert.equal(p.summary.spec_version, spec.match(/Specification, draft (\d+\.\d+)/)[1], "a bundle names the draft SPEC.md is at");
  assert.equal(p.summary.spec_version, [...spec.matchAll(/^\| (\d+\.\d+) \|/gm)].at(-1)[1], "the last listed draft is the current one");
  assert.equal(p.summary.bundle.kind, "aas-public");
  assert.equal(p.summary.bundle.revision, 1, "the first publication of this run");
  assert.equal(p.summary.bundle.run_id, p.summary.run_id);
  assert.equal(p.summary.harness.version, p.summary.harness.framework.split(" ").at(-1));
  assert.equal("recordings" in p.summary, false, "video links come from the archive, not from the bundle");
  assert.equal("url" in p.summary.recording, false);
  assert.match(p.summary.recording.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(p.summary.category.game, "portal");
  assert.equal(p.summary.category.human, "restart-only", "a resume makes the run restart-only");
  assert.equal(p.summary.recording.igt_seconds, 4.005);
  assert.equal(p.summary.completed_at !== null, true);
  const files = readdirSync(outDir).sort();
  for (const f of ["AGENTS.md", "chapters.txt", "documentation.md", "game-config", "manifest.json", "runtime-config", "session.sanitized.jsonl", "splits.lss", "summary.json", "timeline.json", "tools.json"]) assert.ok(files.includes(f), f);
  assert.match(readFileSync(join(outDir, "game-config", "LICENSE"), "utf8"), /Copyright \(c\) 2026 cozyblaze/, "cozyblaze's license travels with his game configuration");
  const timeline = readFileSync(join(outDir, "session.sanitized.jsonl"), "utf8");
  assert.doesNotMatch(timeline, /data:image/);
  assert.match(timeline, /image_omitted/);
  const published = timeline.split("\n").filter((l) => l.includes('"run.started"')).map((l) => JSON.parse(l).data.tooling);
  assert.equal(published.length, 2);
  assert.ok(published.every((t) => /^[0-9a-f]{40}$/.test(t.commit) && t.version), "the bundle shows per segment which tooling ran it");
  assert.match(readFileSync(join(outDir, "splits.lss"), "utf8"), /<GameName>Portal<\/GameName>/);
  assert.ok(existsSync(join(runDir, "timeline", "cut.sh")) && existsSync(join(runDir, "timeline", "timers.srt")));
  assert.match(readFileSync(join(runDir, "timeline", "inputs.srt"), "utf8"), /forward/);
  assert.deepEqual(t.playbacks[0].steps, [{ ticks: 67, keys: ["forward"] }]);
});

test("a run keeps one identifier across renames and republications, and the name it was published under is separate", async (t) => {
  const { mkdtempSync, readFileSync, writeFileSync, renameSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "aas-uid-"));
  const runDir = join(dir, "run-first-name");
  const game = join(here, "fake-game.mjs");
  await configure({ runtime: join(here, "stub-runtime.mjs"), game, "run-dir": runDir, instructions: game }, { log() {} });
  const uid = JSON.parse(readFileSync(join(runDir, "brief.json"), "utf8")).run_uid;
  assert.match(uid, /^[0-9a-f]{32}$/, "128 bits of hex, not a UUID: a dashed UUID is what the privacy scan calls a session identifier");
  // Enough of a run to publish: a timeline and a session log.
  writeFileSync(join(runDir, "run.jsonl"), `${JSON.stringify({ timestamp: "2026-01-01T00:00:00.000+01:00", kind: "event", event: "run.started", data: {} })}\n`);
  writeFileSync(join(runDir, "session.jsonl"), `${JSON.stringify({ type: "assistant", message: { role: "assistant", model: "m", content: [{ type: "text", text: "hello" }] }, timestamp: "2026-01-01T00:00:00.000Z", uuid: "u1", sessionId: "s" })}\n`);
  const first = await publish(runDir, join(dir, "first-name"), { log() {} });
  assert.equal(first.summary.run_uid, uid);
  assert.equal(first.summary.bundle.revision, 1);
  // The run directory is renamed and published again under the naming convention that came later.
  const renamed = join(dir, "run-second-name");
  renameSync(runDir, renamed);
  rmSync(join(dir, "first-name"), { recursive: true, force: true });
  const second = await publish(renamed, join(dir, "second-name"), { log() {} });
  assert.equal(second.summary.run_uid, uid, "the same run, whatever it is called");
  assert.equal(second.summary.run_id, "second-name");
  assert.equal(second.summary.bundle.revision, 2, "the counter belongs to the run, so it carries over the rename");
  assert.equal(JSON.parse(readFileSync(join(dir, "second-name", "manifest.json"), "utf8")).run_uid, uid);
});
