#!/usr/bin/env node
// Installs LiveSplit (pinned in UPSTREAM.json, sha256 checked) into a folder of your choice and sets it up for the
// harness: its TCP server starts with it (ServerStartup in settings.cfg). The folder must be on a Windows drive,
// because LiveSplit is a Windows program. AAS_LIVESPLIT_EXE is not written here; the GUI does that.
//
//   node packages/timer-livesplit/install-livesplit.mjs <folder>
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readZipEntries } from "../core/src/zip-read.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pin = JSON.parse(fs.readFileSync(path.join(here, "UPSTREAM.json"), "utf8")).livesplit;

/** settings.cfg with the server starting with LiveSplit; an existing file keeps everything else. */
export function enableServerStartup(settingsFile) {
  if (!fs.existsSync(settingsFile)) {
    // LiveSplit ignores a settings file that lacks its other elements (it wrote ServerStartup back as 0, measured
    // 2026-09-17 on 1.8.37), so a new install gets the complete file LiveSplit itself writes, with the server on.
    fs.copyFileSync(path.join(here, "settings.template.cfg"), settingsFile);
    return "settings.cfg written (LiveSplit's own defaults; the server starts with LiveSplit)";
  }
  let cfg = fs.readFileSync(settingsFile, "utf8");
  if (/<ServerStartup>1<\/ServerStartup>/.test(cfg)) return "settings.cfg: server already starts with LiveSplit";
  cfg = /<ServerStartup>[^<]*<\/ServerStartup>/.test(cfg) ? cfg.replace(/<ServerStartup>[^<]*<\/ServerStartup>/, "<ServerStartup>1</ServerStartup>") : cfg.replace(/<\/Settings>\s*$/, "  <ServerStartup>1</ServerStartup>\n</Settings>\n");
  fs.writeFileSync(settingsFile, cfg);
  return "settings.cfg: server set to start with LiveSplit";
}

export async function installLiveSplit(dir, { log = console.log } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const exe = path.join(dir, "LiveSplit.exe");
  const zip = path.join(dir, `LiveSplit_${pin.version}.zip`);
  const sha = (buf) => createHash("sha256").update(buf).digest("hex");
  if (!fs.existsSync(exe)) {
    if (!fs.existsSync(zip) || sha(fs.readFileSync(zip)) !== pin.sha256) {
      log(`downloading ${pin.url}`);
      const res = await fetch(pin.url);
      if (!res.ok) throw new Error(`download failed: ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (sha(buf) !== pin.sha256) throw new Error(`sha256 mismatch: ${sha(buf)}, pinned ${pin.sha256}`);
      fs.writeFileSync(zip, buf);
    }
    let n = 0;
    for (const { name, data } of readZipEntries(zip)) {
      const out = path.join(dir, name);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, data);
      n += 1;
    }
    fs.rmSync(zip, { force: true });
    log(`LiveSplit ${pin.version}: ${n} files in ${dir}`);
  } else {
    log(`LiveSplit already in ${dir}`);
  }
  log(enableServerStartup(path.join(dir, "settings.cfg")));
  return exe;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2];
  if (!dir) throw new Error("usage: install-livesplit.mjs <folder>");
  console.log(await installLiveSplit(path.resolve(dir)));
}
