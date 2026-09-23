#!/usr/bin/env node
// Installs what the BizHawk plugin needs, each pinned in UPSTREAM.json and checked by sha256:
//   <dir>/EmuHawk.exe …                 BizHawk (the official Windows zip, unchanged)
//   <dir>/ExternalTools/BizHawkMcp.dll  bizhawk-mcp-native, the external tool the plugin talks to (with its dependencies)
// <dir> is AAS_BIZHAWK_DIR, default %LOCALAPPDATA%\aas\BizHawk, where the GUI installs its tools. Nothing is changed in
// BizHawk itself. The first time EmuHawk loads the tool it asks whether to trust it; that answer is the person's, and
// BizHawk keeps it (per the DLL's checksum) in its own config.ini.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readZipEntries } from "../../packages/core/src/zip-read.mjs";
import { loadSettings } from "../../packages/core/src/settings.mjs";
import { bizhawkDir } from "./paths.mjs";
import { allowTool } from "./allow-tool.mjs";

loadSettings(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const upstream = JSON.parse(fs.readFileSync(path.join(here, "UPSTREAM.json"), "utf8"));
const dir = bizhawkDir();
if (!dir) throw new Error("no install folder: set AAS_BIZHAWK_DIR, or run this on Windows/WSL where %LOCALAPPDATA% is known");
const cache = path.join(dir, "..", "downloads");
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

async function download(pin) {
  fs.mkdirSync(cache, { recursive: true });
  const file = path.join(cache, path.basename(new URL(pin.url).pathname));
  if (fs.existsSync(file) && sha(fs.readFileSync(file)) === pin.sha256) return file;
  console.log(`downloading ${pin.url}`);
  const res = await fetch(pin.url);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${pin.url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha(buf) !== pin.sha256) throw new Error(`sha256 mismatch for ${pin.url}: ${sha(buf)}, pinned ${pin.sha256}`);
  fs.writeFileSync(file, buf);
  return file;
}

function unpack(zip, dest) {
  const entries = readZipEntries(zip);
  if (!entries) throw new Error(`not a zip: ${zip}`);
  for (const { name, data } of entries) {
    const out = path.resolve(dest, name);
    if (!out.startsWith(path.resolve(dest) + path.sep)) throw new Error(`entry ${name} points outside ${dest}`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, data);
  }
  return entries.length;
}

const b = upstream.bizhawk;
console.log(`BizHawk ${b.version}: ${unpack(await download(b), dir)} files in ${dir}`);
const m = upstream.bizhawk_mcp_native;
console.log(`bizhawk-mcp-native ${m.version}: ${unpack(await download(m), path.join(dir, "ExternalTools"))} files in ${path.join(dir, "ExternalTools")}`);
// The test profile's ROM, freely licensed (BSD-2-Clause), pinned by commit and checked by SHA-1, into the ROMs folder.
{
  const { romsDir } = await import("./plugin.mjs");
  for (const [id, pin] of Object.entries(upstream.test_roms ?? {})) {
    const dest = path.join(romsDir(), pin.file);
    const have = fs.existsSync(dest) && createHash("sha1").update(fs.readFileSync(dest)).digest("hex").toUpperCase() === pin.sha1;
    if (!have) {
      const res = await fetch(pin.url);
      if (!res.ok) throw new Error(`download failed: ${res.status} ${pin.url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const got = createHash("sha1").update(buf).digest("hex").toUpperCase();
      if (got !== pin.sha1) throw new Error(`SHA-1 mismatch for ${pin.url}: ${got}, pinned ${pin.sha1}`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
    }
    console.log(`test ROM ${id}: ${dest} (${pin.license})`);
  }
}
// The last step: BizHawk's own question whether it may load the tool, announced here and never during a run.
await allowTool();
