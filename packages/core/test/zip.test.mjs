// The upload file: a zip a standard reader can open, containing the bundle without its recording.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, zipBuffer } from "../src/zip.mjs";
import { packBundle, writeManifest } from "../src/publish.mjs";

const hasUnzip = (() => { try { execFileSync("unzip", ["-v"], { stdio: "ignore" }); return true; } catch { return false; } })();

test("crc32 matches the known value of the zip specification's example input", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test("the zip is readable by unzip and keeps every byte", { skip: !hasUnzip && "unzip not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "aas-zip-"));
  const file = join(dir, "t.zip");
  const big = Buffer.from("summary".repeat(500));
  writeFileSync(file, zipBuffer([{ name: "run-01/summary.json", data: big }, { name: "run-01/a.txt", data: Buffer.from("hi") }]));
  execFileSync("unzip", ["-t", file]);
  execFileSync("unzip", ["-q", file, "-d", join(dir, "out")]);
  assert.deepEqual(readFileSync(join(dir, "out", "run-01", "summary.json")), big);
  assert.equal(readFileSync(join(dir, "out", "run-01", "a.txt"), "utf8"), "hi");
});

test("packBundle leaves the recording out, keeps its hashes in the manifest, and names the run inside the zip", { skip: !hasUnzip && "unzip not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "aas-pack-"));
  const out = join(dir, "sts-01-public");
  mkdirSync(join(out, "recording"), { recursive: true });
  mkdirSync(join(out, "runtime-config"), { recursive: true });
  writeFileSync(join(out, "summary.json"), "{}\n");
  writeFileSync(join(out, "runtime-config", "mcp.template.json"), "{}\n");
  writeFileSync(join(out, "recording", "run.mp4"), Buffer.from("video"));
  const files = writeManifest(out, { runId: "sts-01" });
  const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  assert.equal(manifest.bundle, "aas-public");
  assert.equal(manifest.run_id, "sts-01");
  assert.ok(files.some((f) => f.path === "recording/run.mp4" && f.sha256), "the linked recording keeps its hash in the manifest");
  const zip = packBundle(out);
  assert.equal(zip.file, `${out}.zip`);
  assert.ok(existsSync(zip.file));
  const list = execFileSync("unzip", ["-Z", "-1", zip.file], { encoding: "utf8" }).split("\n").filter(Boolean).sort();
  assert.deepEqual(list, ["sts-01/manifest.json", "sts-01/runtime-config/mcp.template.json", "sts-01/summary.json"]);
});
