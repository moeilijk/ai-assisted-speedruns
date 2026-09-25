#!/usr/bin/env node
// The shared fixtures of the tooling and the Archive: one real bundle, made by the harness from a mock run of the
// tests' own game, and a copy of it for every class of damage the Archive must recognise, each with the verdict both
// sides expect (verdicts.json). The Archive's suite uploads them and asserts its verdicts; the tooling's suite
// (packages/spec/test/fixtures.test.mjs) asserts what `aas check` says. Classes that need the Archive's own tickets
// (missed head, fork, foreign or resubmitted ticket) are made live by `npm run e2e:chain`, not here.
//
//   node packages/spec/fixtures/make-fixtures.mjs [--out <dir>]   writes the zips and verdicts.json (default: here)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { crc32 } from "../../core/src/zip.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..", "..", "..");

/** A zip written entry by entry, so that a name, a size or a method can be made wrong on purpose. */
export function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const method = e.method ?? 0;
    const data = method === 8 ? zlib.deflateRawSync(e.data) : e.data;
    const size = e.size ?? e.data.length;
    const local = Buffer.alloc(30);
    const crc = e.crc ?? crc32(e.data) >>> 0;
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(method, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(size, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** The real bundle every fixture starts from: a mock run of the tests' game through run() and publish(). */
async function baseBundle(work) {
  const { run } = await import(path.join(REPO, "packages", "core", "src", "run.mjs"));
  const { publish } = await import(path.join(REPO, "packages", "core", "src", "publish.mjs"));
  const { readZipEntries } = await import(path.join(REPO, "packages", "core", "src", "zip-read.mjs"));
  const fake = path.join(REPO, "packages", "core", "test", "gui-game", "fake");
  const runDir = path.join(work, "fixture-01");
  await run({ runtime: path.join(REPO, "packages", "runtime-scripted", "index.mjs"), game: path.join(fake, "plugin.mjs"), "run-dir": runDir, bot: path.join(fake, "bot.mjs"), recorder: "null", "keep-open": true, proof: "off" }, { log() {} });
  await publish(runDir, path.join(work, "public", "fixture-01"), { log() {} });
  return readZipEntries(path.join(work, "public", "fixture-01.zip")).map((e) => ({ name: e.name, data: e.data }));
}

const clone = (entries) => entries.map((e) => ({ ...e, data: Buffer.from(e.data) }));
const top = (entries) => entries[0].name.split("/")[0];
const get = (entries, rel) => entries.find((e) => e.name === `${top(entries)}/${rel}`);
const json = (entries, rel) => JSON.parse(get(entries, rel).data.toString("utf8"));
const put = (entries, rel, value) => { const e = get(entries, rel); e.data = Buffer.from(typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`); };
/** The manifest made to match the files again, so that only the intended damage is left. */
function remanifest(entries) {
  const m = json(entries, "manifest.json");
  m.files = m.files.map((f) => { const e = get(entries, f.path); return e ? { ...f, sha256: createHash("sha256").update(e.data).digest("hex"), bytes: e.data.length } : f; });
  put(entries, "manifest.json", m);
}
/** The fixture as a run of its own (another run id and run_uid), so the Archive can accept it next to the others. */
export function asOwnRun(entries, runId, runUid) {
  const from = top(entries);
  for (const e of entries) e.name = `${runId}/${e.name.slice(from.length + 1)}`;
  const s = json(entries, "summary.json"); s.run_id = runId; s.run_uid = runUid; put(entries, "summary.json", s);
  const m = json(entries, "manifest.json"); m.run_id = runId; m.run_uid = runUid; put(entries, "manifest.json", m);
  remanifest(entries);
  return entries;
}
const HOSTILE = `<script>alert("aas")</script><img src=x onerror=alert(1)>"'&‮`;

/** The hostile string in every field the run page and the agent page show, so escaping is proven where it counts. */
function hostile(b) {
  const s = json(b, "summary.json");
  Object.assign(s.game, { game: HOSTILE, version: HOSTILE, platform: HOSTILE, settings: { [HOSTILE]: HOSTILE }, mods: [{ name: HOSTILE, version: HOSTILE, source: "javascript:alert(1)" }] });
  s.category.goal_end.label = HOSTILE;
  s.ends = s.ends.map((e) => ({ ...e, label: HOSTILE }));
  s.goals = (s.goals ?? []).map((g) => ({ ...g, label: HOSTILE }));
  if (s.models?.[0]) s.models[0].model = HOSTILE;
  s.upload_note = HOSTILE;
  put(b, "summary.json", s);
  const t = json(b, "timeline.json");
  t.sections = (t.sections ?? []).map((x) => ({ ...x, label: HOSTILE }));
  t.cut_chapters = [{ at: 0, label: HOSTILE }];
  put(b, "timeline.json", t);
  put(b, "tools.json", json(b, "tools.json").map((x) => ({ ...x, name: HOSTILE, description: HOSTILE })));
  put(b, "documentation.md", `# ${HOSTILE}\n\n${HOSTILE}\n`);
  put(b, "AGENTS.md", `Play the GUI fake. ${HOSTILE}\n`);
  return asOwnRun(b, "fixture-02", "f1f7e02f1f7e02f1f7e02f1f7e02f1f7");
}

/**
 * Every class: how its zip is made from the base, what the Archive answers (its table of 2026-09-25) and what the
 * tooling's `aas check` says (a throw, or a requirement with a status and a reason).
 */
export const CLASSES = [
  // The Archive takes a mock in only from its e2e account, as a test; from any other account it is refused.
  { class: "mock", make: (b) => b, archive: { http: 200, status: "review", mock: true, ordinary_account: { http: 422, status: "rejected", code: "bundle.mock" } }, tooling: { requirement: "a model played", status: "unmet", match: "mock" } },
  { class: "tampered-log", make: (b) => { const e = get(b, "session.sanitized.jsonl"); e.data = Buffer.concat([e.data, Buffer.from('{"type":"assistant","note":"added after the run"}\n')]); return b; }, archive: { http: 200, status: "review", unmet: ["Every file matches its hash"] }, tooling: { requirement: "manifest.json", status: "invalid", match: "session.sanitized.jsonl: sha256 mismatch" } },
  { class: "tampered-timeline", make: (b) => { const t = json(b, "timeline.json"); t.edited_after_the_run = true; put(b, "timeline.json", t); return b; }, archive: { http: 200, status: "review", unmet: ["Every file matches its hash"] }, tooling: { requirement: "manifest.json", status: "invalid", match: "timeline.json: sha256 mismatch" } },
  { class: "zip-slip", make: (b) => [...b, { name: `${top(b)}/../../escape.txt`, data: Buffer.from("x") }], archive: { http: 422, status: "rejected", code: "zip.unsafe-path" }, tooling: { throws: "outside" } },
  { class: "absolute-path", make: (b) => [...b, { name: "/etc/aas-fixture.txt", data: Buffer.from("x") }], archive: { http: 422, status: "rejected", code: "zip.unsafe-path" }, tooling: { throws: "outside" } },
  { class: "hidden-file", make: (b) => [...b, { name: `${top(b)}/.hidden`, data: Buffer.from("x") }], archive: { http: 422, status: "rejected", code: "zip.unsafe-path" }, tooling: { requirement: "manifest.json", status: "invalid", match: ".hidden: a hidden file" } },
  { class: "zip-bomb", make: (b) => [...b, { name: `${top(b)}/bomb.txt`, data: Buffer.alloc(20 * 1024 * 1024), method: 8, size: 100 }], archive: { http: 422, status: "rejected", code: "zip.inflate" }, tooling: { throws: "does not inflate to its declared 100 bytes" } },
  { class: "duplicate-entry", make: (b) => [...b, { ...get(b, "summary.json") }], archive: { http: 422, status: "rejected", code: "zip.duplicate" }, tooling: { throws: "is in it twice" } },
  { class: "bad-crc", make: (b) => b.map((e) => (e.name.endsWith("/summary.json") ? { ...e, crc: 12345 } : e)), archive: { http: 422, status: "rejected", code: "zip.malformed" }, tooling: { throws: "its CRC-32 does not match its data" } },
  { class: "malformed-zip", raw: (zip) => Buffer.concat([zip.subarray(0, 200), zip.subarray(zip.length - 22)]), archive: { http: 422, status: "rejected", code: "zip.malformed" }, tooling: { throws: "not a zip that can be read safely" } },
  { class: "manifest-path", make: (b) => { const m = json(b, "manifest.json"); m.files.push({ path: "runtime-config/../../../../etc/hostname", sha256: "0".repeat(64), bytes: 1 }); put(b, "manifest.json", m); return b; }, archive: { http: 422, status: "rejected", code: "bundle.manifest-path" }, tooling: { requirement: "manifest.json", status: "invalid", match: "not a plain path inside the bundle; not read" } },
  { class: "not-published", make: (b) => { const m = json(b, "manifest.json"); m.bundle = "something-else"; put(b, "manifest.json", m); return b; }, archive: { http: 422, status: "rejected", code: "bundle.not-published" }, tooling: { requirement: "public bundle", status: "unmet", match: "expected \"aas-public\"" } },
  { class: "no-run-id", make: (b) => { const m = json(b, "manifest.json"); delete m.run_id; put(b, "manifest.json", m); const s = json(b, "summary.json"); delete s.run_id; put(b, "summary.json", s); remanifest(b); return b; }, archive: { http: 422, status: "rejected", code: "bundle.run-id" }, tooling: { requirement: "run id", status: "invalid", match: "manifest.run_id null and summary.run_id null" } },
  { class: "privacy", make: (b) => { put(b, "AGENTS.md", "Play the GUI fake.\npassword=hunter2 at /home/someone/secret\n"); remanifest(b); return b; }, archive: { http: 422, status: "rejected", code: "bundle.privacy" }, tooling: { requirement: "privacy", status: "invalid", match: "AGENTS.md: private Unix home path" } },
  { class: "recording-in-bundle", make: (b) => [...b, { name: `${top(b)}/recording/run.mp4`, data: Buffer.from("not really a video") }], archive: { http: 422, status: "rejected", code: "bundle.recording" }, tooling: { requirement: "manifest.json", status: "invalid", match: "recording/run.mp4" } },
  { class: "wrong-version", make: (b) => { const s = json(b, "summary.json"); s.schema_version = 999; put(b, "summary.json", s); remanifest(b); return b; }, archive: { http: 422, status: "rejected", code: "bundle.version" }, tooling: { requirement: "summary.json", status: "invalid", match: "schema" } },
  { class: "hostile-strings", make: (b) => hostile(b), archive: { http: 200, status: "review", escaped: HOSTILE }, tooling: { requirement: "manifest.json", status: "met", match: "files verified" } },
];

async function main() {
  const i = process.argv.indexOf("--out");
  const out = path.resolve(i > 0 ? process.argv[i + 1] : here);
  fs.mkdirSync(out, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "aas-fixtures-"));
  const base = await baseBundle(work);
  const baseZip = writeZip(base);
  const table = [];
  for (const c of CLASSES) {
    const file = `${c.class}.zip`;
    fs.writeFileSync(path.join(out, file), c.raw ? c.raw(baseZip) : writeZip(c.make(clone(base))));
    table.push({ class: c.class, fixture: file, archive: c.archive, tooling: c.tooling });
  }
  fs.writeFileSync(path.join(out, "verdicts.json"), `${JSON.stringify({ made_by: "packages/spec/fixtures/make-fixtures.mjs", base: "a mock run of packages/core/test/gui-game through run() and publish()", classes: table }, null, 2)}\n`);
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`${table.length} fixtures and verdicts.json in ${out}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
