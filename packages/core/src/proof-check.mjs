// The archive's check of an upload with proof, as one function it can take over unchanged: the proof itself
// (checkProof: tickets, receipts and every head recomputed from the private logs) and the public timeline made again
// from those logs with the same function `aas publish` made it with. A timeline that was edited after it was made
// does not come out equal. `aas check <upload.zip>` runs the same thing on this machine.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildTimeline } from "./publish.mjs";
import { loadRuntime } from "./plugins.mjs";
import { checkProof } from "./proof.mjs";
import { readZipEntries } from "./zip-read.mjs";

/**
 * Makes session.sanitized.jsonl and timeline.json again from `privateDir` and compares them byte for byte with the
 * bundle's. Returns `{ equal, differences }`.
 */
export async function regenerate(bundleDir, privateDir) {
  const proof = JSON.parse(fs.readFileSync(path.join(bundleDir, "proof.json"), "utf8"));
  const summary = JSON.parse(fs.readFileSync(path.join(bundleDir, "summary.json"), "utf8"));
  const label = proof.export?.session;
  if (!label) return { equal: false, differences: ["proof.json does not say which session log the timeline was made from"] };
  const session = path.join(privateDir, `session-${label.split(":")[1]}.jsonl`);
  if (!fs.existsSync(session)) return { equal: false, differences: [`${label} is not in the private part`] };
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "aas-regenerate-"));
  const runDir = path.join(work, "run");
  const outDir = path.join(work, "out");
  fs.mkdirSync(runDir);
  for (const f of ["run.jsonl", "recording.json", "brief.json"]) if (fs.existsSync(path.join(privateDir, f))) fs.copyFileSync(path.join(privateDir, f), path.join(runDir, f));
  const savedZone = process.env.AAS_TIME_ZONE;
  try {
    const brief = JSON.parse(fs.readFileSync(path.join(runDir, "brief.json"), "utf8"));
    let rt = null;
    try { rt = await loadRuntime(summary.harness?.plugins?.runtime?.id); } catch { /* a runtime this tooling does not know: the harness's own export */ }
    // The timestamps are written in the run's own time zone, whatever zone the archive runs in.
    if (summary.time_zone) process.env.AAS_TIME_ZONE = summary.time_zone;
    await buildTimeline({ runDir, outDir, brief, rt, session, completionMarker: proof.export?.completion_marker ?? null });
    const differences = [];
    for (const f of ["session.sanitized.jsonl", "timeline.json"]) {
      const mine = path.join(outDir, f), theirs = path.join(bundleDir, f);
      if (!fs.existsSync(theirs) && !fs.existsSync(mine)) continue;
      if (!fs.existsSync(theirs) || !fs.existsSync(mine) || !fs.readFileSync(mine).equals(fs.readFileSync(theirs))) differences.push(`${f} is not what the private logs make`);
    }
    return { equal: !differences.length, differences };
  } finally {
    if (savedZone === undefined) delete process.env.AAS_TIME_ZONE; else process.env.AAS_TIME_ZONE = savedZone;
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** Everything the archive checks about an upload's proof: `{ status, detail }`, status signed|unsigned|review|invalid. */
export async function checkUploadProof(bundleDir, privateDir) {
  const p = checkProof(bundleDir, { privateDir: privateDir && fs.existsSync(privateDir) ? privateDir : null });
  if (p.status === "unsigned" || p.status === "invalid") return p;
  if (!privateDir || !fs.existsSync(privateDir)) return { ...p, status: "invalid", detail: "the upload has proof but no private part to check it against" };
  const r = await regenerate(bundleDir, privateDir);
  if (!r.equal) return { status: "invalid", detail: r.differences.join("; "), problems: r.differences, review: p.review };
  return { ...p, detail: `${p.detail}; the public timeline is what the private logs make` };
}

/** checkUploadProof on an upload zip as it is sent; null for a zip without proof.json. */
export async function checkZipProof(zipFile) {
  const entries = readZipEntries(zipFile);
  if (!entries?.some((e) => e.name.endsWith("/proof.json"))) return null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aas-proof-"));
  try {
    for (const { name, data } of entries) {
      const dest = path.resolve(tmp, name);
      if (!dest.startsWith(tmp + path.sep) || name.includes("\\")) throw new Error(`entry ${name} points outside the upload`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, data);
    }
    const top = path.join(tmp, entries[0].name.split("/")[0]);
    return await checkUploadProof(top, path.join(top, "private"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
