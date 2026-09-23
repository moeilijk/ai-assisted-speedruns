#!/usr/bin/env node
// `npm run bizhawk:tas -- <profile>`: the published TAS movie a profile's mock replays, made ready once. It downloads the
// movie from TASVideos (pinned by sha256; CC BY 2.0, credited in the profile's `tas`) into .local/tas and, for a movie
// made in another emulator, has BizHawk's own importer turn it into a .bk2 next to it.
//
// BizHawk's importer asks one question on the way, every time: "ROM required to populate hash — Please select the
// original ROM to finalize the import process." It wants the ROM to put a SHA-1 in the new movie's header
// (IMovieImport.cs, 2.11.1). This step answers Cancel itself: BizHawk then writes the .bk2 without that SHA-1, and the
// ROM is checked by the profile's own SHA-1 before any run starts. It runs with no run going and says so beforehand.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSettings } from "../../packages/core/src/settings.mjs";
import { answerDialog } from "../../packages/core/src/close-windows.mjs";
import { readZipEntries } from "../../packages/core/src/zip-read.mjs";
import { bizhawkDir, hostPath } from "./paths.mjs";
import { ping } from "./mcp.mjs";
import { closeGame } from "./close-game.mjs";

loadSettings(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const id = process.argv[2];
if (!id) throw new Error("Usage: npm run bizhawk:tas -- <profile id>");
process.env.AAS_BIZHAWK_PROFILE = id;
const { PROFILE, romPath, playableRom } = await import("./plugin.mjs");
const tas = PROFILE?.tas;
if (!tas) throw new Error(`profile ${id} names no TAS movie`);
const dir = path.resolve(here, "..", "..", ".local", "tas");
fs.mkdirSync(dir, { recursive: true });
const bk2 = path.join(dir, PROFILE.bot.movie);
console.log(`${tas.title}, ${tas.publication} (${tas.license})`);
if (fs.existsSync(bk2)) { console.log(`ready: ${bk2}`); process.exit(0); }

// 1. The publication's file, checked by its pinned sha256.
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
const movie = path.join(dir, tas.movie);
fs.writeFileSync(movie, entry.data);
if (movie.endsWith(".bk2")) { console.log(`ready: ${movie}`); process.exit(0); }

// 2. BizHawk's importer, with nothing else running in EmuHawk.
if (await ping()) throw new Error("EmuHawk is running: close it first (npm run bizhawk:stop); the import opens its own EmuHawk");
const bh = bizhawkDir();
const rom = playableRom(romPath(), bh);
console.log([
  `BizHawk now imports ${tas.movie} (${tas.emulator}) into ${path.basename(bk2)}.`,
  'It asks "ROM required to populate hash"; this step answers Cancel itself (the ROM is checked by the profile\'s',
  "own SHA-1 instead). EmuHawk closes again when the movie is written.",
].join("\n"));
const child = spawn(path.join(bh, "EmuHawk.exe"), ["--chromeless", `--movie=${hostPath(movie)}`, hostPath(rom)], { cwd: bh, detached: true, stdio: "ignore" });
child.unref();
const answered = answerDialog({ processName: "EmuHawk", title: "ROM required to populate hash", button: "Cancel", seconds: 90 });
for (let i = 0; i < 60 && !fs.existsSync(bk2); i += 1) await new Promise((r) => setTimeout(r, 500));
await closeGame({ log: () => {} });
if (!fs.existsSync(bk2)) throw new Error(`BizHawk did not write ${bk2}${answered ? "" : " (its question did not appear)"}`);
console.log(`ready: ${bk2}${answered ? " (BizHawk's question answered with Cancel)" : ""}`);
