#!/usr/bin/env node
// Installs what the FCEUX plugin needs, each pinned in UPSTREAM.json and checked by sha256:
//   <dir>/fceux64.exe …                 FCEUX (the official 64-bit Windows zip, unchanged)
//   <dir>/fceux-mcp/bridge.lua …        fceux-mcp's bridge (our fork's release), the Lua script the plugin talks to
// <dir> is AAS_FCEUX_DIR, default %LOCALAPPDATA%\aas\FCEUX, where the GUI installs its tools. Nothing is changed in
// FCEUX itself; the bridge needs no LuaSocket of its own on Windows (FCEUX has it built in).
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readZipEntries } from "../../packages/core/src/zip-read.mjs";
import { loadSettings } from "../../packages/core/src/settings.mjs";
import { fceuxDir } from "./paths.mjs";

loadSettings(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const upstream = JSON.parse(fs.readFileSync(path.join(here, "UPSTREAM.json"), "utf8"));
const dir = fceuxDir();
if (!dir) throw new Error("no install folder: set AAS_FCEUX_DIR, or run this on Windows/WSL where %LOCALAPPDATA% is known");
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

/** Unpacks the zip's entries under `prefix` (that prefix taken off) into dest. */
function unpack(zip, dest, { prefix = "", only = null } = {}) {
  const entries = readZipEntries(zip);
  if (!entries) throw new Error(`not a zip: ${zip}`);
  let n = 0;
  for (const { name, data } of entries) {
    if (!name.startsWith(prefix) || name.endsWith("/")) continue;
    const rel = name.slice(prefix.length);
    if (only && !only.some((o) => rel === o || rel.startsWith(`${o}/`))) continue;
    const out = path.resolve(dest, rel);
    if (!out.startsWith(path.resolve(dest) + path.sep)) throw new Error(`entry ${name} points outside ${dest}`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, data);
    n += 1;
  }
  return n;
}

const f = upstream.fceux;
console.log(`FCEUX ${f.version}: ${unpack(await download(f), dir)} files in ${dir}`);
const m = upstream.fceux_mcp;
const bridgeDir = path.join(dir, "fceux-mcp");
const prefix = `${path.posix.dirname(m.bridge)}/`;
console.log(`fceux-mcp ${m.version}: ${unpack(await download(m), bridgeDir, { prefix, only: ["bridge.lua", "LICENSE", "vendor/json"] })} files in ${bridgeDir}`);
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
