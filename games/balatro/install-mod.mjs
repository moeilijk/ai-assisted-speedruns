#!/usr/bin/env node
// Installs what the Balatro plugin needs, each pinned in UPSTREAM.json and checked by sha256:
//   <game>/version.dll                 Lovely, the Lua injector (loads mods from the folder given with --mod-dir)
//   <tools>/Mods/smods/                Steamodded, the mod loader balatrobot runs on
//   <tools>/Mods/balatrobot/           balatrobot (its manifest, entry point and src/lua, as its installation guide lists)
// <tools> is AAS_BALATRO_TOOLS_DIR, default <game>/aas. The launcher starts the game with --mod-dir <tools>/Mods, so
// the game's own mod folder (%AppData%/Balatro/Mods) stays empty and a start from Steam loads no mods.
// Env: AAS_BALATRO_GAME_ROOT (the Balatro folder), AAS_BALATRO_TOOLS_DIR
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readZipEntries } from "../../packages/core/src/zip-read.mjs";
import { toolsDir } from "./plugin.mjs";
import { loadSettings } from "../../packages/core/src/settings.mjs";

// This game's own settings, then the machine's: the same two files every command reads (settings.mjs).
loadSettings(import.meta.url);

const root = process.env.AAS_BALATRO_GAME_ROOT;
if (!root) throw new Error("AAS_BALATRO_GAME_ROOT is not set (the Balatro folder, with Balatro.exe)");
if (!fs.existsSync(path.join(root, "Balatro.exe"))) throw new Error(`Balatro.exe not found in ${root}`);
const here = path.dirname(fileURLToPath(import.meta.url));
const upstream = JSON.parse(fs.readFileSync(path.join(here, "UPSTREAM.json"), "utf8"));
const tools = toolsDir(path.resolve(root));
const cache = path.join(tools, "downloads");
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

async function download(pin) {
  fs.mkdirSync(cache, { recursive: true });
  const file = path.join(cache, `${path.basename(pin.folder ?? pin.file)}-${pin.version}.zip`);
  if (fs.existsSync(file) && sha(fs.readFileSync(file)) === pin.sha256) return file;
  console.log(`downloading ${pin.url}`);
  const res = await fetch(pin.url);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${pin.url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha(buf) !== pin.sha256) throw new Error(`sha256 mismatch for ${pin.url}: ${sha(buf)}, pinned ${pin.sha256}`);
  fs.writeFileSync(file, buf);
  return file;
}

/** Unpacks the entries of a GitHub source zip (one top folder) into `dest`, keeping only `keep` (paths or folder prefixes). */
function unpack(zip, dest, keep = null) {
  const entries = readZipEntries(zip);
  if (!entries) throw new Error(`not a zip: ${zip}`);
  fs.rmSync(dest, { recursive: true, force: true });
  let n = 0;
  for (const { name, data } of entries) {
    const rel = name.split("/").slice(1).join("/");
    if (!rel) continue;
    if (keep && !keep.some((k) => (k.endsWith("/") ? rel.startsWith(k) : rel === k))) continue;
    const out = path.join(dest, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, data);
    n += 1;
  }
  return n;
}

// 1. Lovely
{
  const pin = upstream.lovely;
  const dll = path.join(root, pin.file);
  const entry = readZipEntries(await download(pin), pin.file)?.[0];
  if (!entry) throw new Error(`${pin.file} not in ${pin.url}`);
  if (!fs.existsSync(dll) || sha(fs.readFileSync(dll)) !== sha(entry.data)) fs.writeFileSync(dll, entry.data);
  console.log(`lovely: ${dll} (${pin.version}, sha256 ${sha(entry.data).slice(0, 16)}…)`);
}
// 2. Steamodded and balatrobot
for (const key of ["steamodded", "balatrobot"]) {
  const pin = upstream[key];
  const dest = path.join(tools, "Mods", pin.folder);
  const n = unpack(await download(pin), dest, pin.files ?? null);
  console.log(`${key}: ${dest} (${pin.version}, ${n} files)`);
}
console.log(`mods folder: ${path.join(tools, "Mods")} (the launcher passes it to Lovely with --mod-dir)`);
