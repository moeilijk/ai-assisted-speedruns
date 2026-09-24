#!/usr/bin/env node
// `npm run fceux:tas -- <profile>`: the published TAS movie a profile's mock replays, made ready once. It downloads the
// movie from TASVideos (pinned by sha256; CC BY 2.0, credited in the profile's `tas`) into .local/tas. FCEUX plays an
// .fm2 as it is, so there is nothing to convert.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSettings } from "../../packages/core/src/settings.mjs";
import { readZipEntries } from "../../packages/core/src/zip-read.mjs";

loadSettings(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const id = process.argv[2];
if (!id) throw new Error("Usage: npm run fceux:tas -- <profile id>");
process.env.AAS_FCEUX_PROFILE = id;
const { PROFILE } = await import("./plugin.mjs");
const tas = PROFILE?.tas;
if (!tas) throw new Error(`profile ${id} names no TAS movie`);
const dir = path.resolve(here, "..", "..", ".local", "tas");
fs.mkdirSync(dir, { recursive: true });
const movie = path.join(dir, PROFILE.bot.movie);
console.log(`${tas.title}, ${tas.publication} (${tas.license})`);
if (fs.existsSync(movie)) { console.log(`ready: ${movie}`); process.exit(0); }

const zip = path.join(dir, `${path.basename(new URL(tas.publication).pathname)}.zip`);
if (!fs.existsSync(zip) || createHash("sha256").update(fs.readFileSync(zip)).digest("hex") !== tas.sha256) {
  const res = await fetch(tas.url);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${tas.url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = createHash("sha256").update(buf).digest("hex");
  if (got !== tas.sha256) throw new Error(`sha256 mismatch for ${tas.url}: ${got}, pinned ${tas.sha256}`);
  fs.writeFileSync(zip, buf);
}
const entry = (readZipEntries(zip) ?? []).find((e) => e.name === tas.movie);
if (!entry) throw new Error(`${tas.movie} is not in ${zip}`);
fs.writeFileSync(movie, entry.data);
console.log(`ready: ${movie}`);
