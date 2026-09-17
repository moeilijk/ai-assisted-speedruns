#!/usr/bin/env node
// Installs NirSoft SoundVolumeView (pinned in UPSTREAM.json, sha256 checked) into a folder on a Windows drive; the
// launchers use it to keep a game's sound off the speakers (audio-route.mjs). NirSoft serves one address for the
// current version, so a newer release there shows up as a sha256 mismatch: the pin is then updated in the tooling,
// never skipped. All files of the zip are kept, as its licence asks.
//
//   node packages/core/src/windows/install-soundvolumeview.mjs <folder>
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readZipEntries } from "../zip-read.mjs";

const pin = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "UPSTREAM.json"), "utf8")).soundvolumeview;

export async function installSoundVolumeView(dir, { log = console.log } = {}) {
  const exe = path.join(dir, "SoundVolumeView.exe");
  if (fs.existsSync(exe)) { log(`SoundVolumeView already in ${dir}`); return exe; }
  log(`downloading ${pin.url}`);
  const res = await fetch(pin.url);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const sha = createHash("sha256").update(buf).digest("hex");
  if (sha !== pin.sha256) throw new Error(`NirSoft now serves another file than SoundVolumeView ${pin.version} (sha256 ${sha}); the tooling's pin needs an update, or install it yourself from ${pin.site} and choose SoundVolumeView.exe`);
  fs.mkdirSync(dir, { recursive: true });
  const zip = path.join(dir, "soundvolumeview-x64.zip");
  fs.writeFileSync(zip, buf);
  for (const { name, data } of readZipEntries(zip)) fs.writeFileSync(path.join(dir, name), data);
  fs.rmSync(zip, { force: true });
  log(`SoundVolumeView ${pin.version} in ${dir}`);
  return exe;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2];
  if (!dir) throw new Error("usage: install-soundvolumeview.mjs <folder>");
  console.log(await installSoundVolumeView(path.resolve(dir)));
}
