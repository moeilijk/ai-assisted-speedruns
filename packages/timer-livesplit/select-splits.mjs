#!/usr/bin/env node
// Make LiveSplit open a given splits file at its next start: LiveSplit ignores a
// splits path on its command line and opens the LAST entry of <RecentSplits> in
// settings.cfg (oldest first, most recent last;, measured: with a
// screenshot of the window), so the entry is put last (LiveSplit must not be running).
//   node packages/timer-livesplit/select-splits.mjs <file.lss>   (AAS_LIVESPLIT_EXE locates settings.cfg)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function selectSplits(lssFile, { settingsFile = path.join(path.dirname(process.env.AAS_LIVESPLIT_EXE ?? ""), "settings.cfg") } = {}) {
  if (!fs.existsSync(settingsFile)) throw new Error(`LiveSplit settings not found at ${settingsFile} (set AAS_LIVESPLIT_EXE)`);
  const lss = fs.readFileSync(lssFile, "utf8");
  const game = lss.match(/<GameName>([^<]*)<\/GameName>/)?.[1] ?? "";
  const category = lss.match(/<CategoryName>([^<]*)<\/CategoryName>/)?.[1] ?? "";
  const winPath = process.platform === "win32" ? path.resolve(lssFile) : execFileSync("wslpath", ["-w", lssFile], { encoding: "utf8" }).trim();
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const entry = `<SplitsFile gameName="${esc(game)}" categoryName="${esc(category)}" lastTimingMethod="GameTime" lastHotkeyProfile="Default">${esc(winPath)}</SplitsFile>`;
  let cfg = fs.readFileSync(settingsFile, "utf8");
  const others = [...cfg.matchAll(/<SplitsFile[^>]*>([^<]*)<\/SplitsFile>/g)].filter((m) => m[1] !== esc(winPath)).map((m) => m[0]);
  const block = `<RecentSplits>\n    ${[...others, entry].join("\n    ")}\n  </RecentSplits>`;
  cfg = /<RecentSplits>[\s\S]*?<\/RecentSplits>/.test(cfg) ? cfg.replace(/<RecentSplits>[\s\S]*?<\/RecentSplits>/, block) : cfg.replace(/<RecentSplits\s*\/>/, block);
  fs.writeFileSync(settingsFile, cfg);
  return { settingsFile, splits: winPath, game, category };
}

if (process.argv[1]?.endsWith("select-splits.mjs")) {
  const r = selectSplits(process.argv[2]);
  console.log(`LiveSplit will open ${r.splits} (${r.game}, ${r.category})`);
}
