#!/usr/bin/env node
// The campaign, as SourceAutoRecord itself has it: every single-player map in order with the name the game gives
// it. SAR carries that table in `src/Games/Portal2.cpp` because its own speedrun timer needs it, so the list comes
// from the tool this plugin already pins (UPSTREAM.json) and not from anywhere else.
//
//   node games/portal-2/extract-maps.mjs [--write]
//
// Without --write it prints what it would write and changes nothing. `maps.json` carries the commit it was taken
// from, so the list can be made again and compared.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { sar } = JSON.parse(fs.readFileSync(path.join(here, "UPSTREAM.json"), "utf8"));
export const SOURCE = `https://raw.githubusercontent.com/p2sr/SourceAutoRecord/${sar.commit}/src/Games/Portal2.cpp`;

/** The `{"map", "Name", "leaderboard"}` rows of SAR's table, in the order they stand in the file. */
export function parseMaps(cpp) {
  const rows = [...cpp.matchAll(/\{\s*"(sp_[a-z0-9_]+)"\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*\}/g)]
    .map(([, map, name, leaderboard]) => ({ map, name, leaderboard: leaderboard || null }));
  if (!rows.length) throw new Error(`no single-player maps found in ${SOURCE}; SAR's table has moved or changed shape`);
  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r.map)) throw new Error(`${r.map} is in the table twice`);
    seen.add(r.map);
  }
  return rows;
}

export async function extract({ write = false, log = console.log } = {}) {
  const res = await fetch(SOURCE);
  if (!res.ok) throw new Error(`${SOURCE}: ${res.status} ${res.statusText}`);
  const maps = parseMaps(await res.text());
  const data = {
    game: "Portal 2",
    source: { repo: sar.repo, license: sar.license, version: sar.version, commit: sar.commit, file: "src/Games/Portal2.cpp", url: SOURCE },
    taken: new Date().toISOString().slice(0, 10),
    maps,
  };
  log(`${maps.length} single-player maps, ${maps[0].map} (${maps[0].name}) … ${maps.at(-1).map} (${maps.at(-1).name})`);
  const file = path.join(here, "maps.json");
  if (write) { fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`); log(`wrote ${file}`); }
  else log(`(dry run; pass --write to update ${file})`);
  return data;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await extract({ write: process.argv.includes("--write") });
