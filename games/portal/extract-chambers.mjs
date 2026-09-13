#!/usr/bin/env node
// Generates games/portal/chambers.json from the game's map files: for every map the
// chamber signs (`signage_numNN.mdl` props stand at each chamber entrance), the
// in-map elevator top (the ride to the map's second chamber) and the level change.
// The player's position against these markers tells which chamber a run is in.
//   AAS_PORTAL_GAME_ROOT=<Source Unpack> node games/portal/extract-chambers.mjs
import fs from "node:fs";
import path from "node:path";
import { MAPS } from "./plugin.mjs";

const root = process.env.AAS_PORTAL_GAME_ROOT;
if (!root) throw new Error("AAS_PORTAL_GAME_ROOT is not set");
// Chambers per map (the game's own numbering; a_12 does not exist, escape maps have no signs).
const EXPECTED = {
  testchmb_a_00: ["00", "01"], testchmb_a_01: ["02", "03"], testchmb_a_02: ["04", "05"], testchmb_a_03: ["06", "07"],
  testchmb_a_04: ["08"], testchmb_a_05: ["09"], testchmb_a_06: ["10"], testchmb_a_07: ["11", "12"], testchmb_a_08: ["13"],
  testchmb_a_09: ["14"], testchmb_a_10: ["15"], testchmb_a_11: ["16"], testchmb_a_13: ["17"], testchmb_a_14: ["18"],
  testchmb_a_15: ["19"], escape_00: ["e00"], escape_01: ["e01"], escape_02: ["e02"],
};
const vec = (s) => { const [x, y, z] = String(s).trim().split(/\s+/).map(Number); return { x, y, z }; };
function entities(bsp) {
  const d = fs.readFileSync(bsp);
  const off = d.readInt32LE(8), len = d.readInt32LE(12); // lump 0 = entities
  const text = d.subarray(off, off + len).toString("latin1");
  return [...text.matchAll(/\{([^}]*)\}/g)].map((m) => Object.fromEntries([...m[1].matchAll(/"([^"]+)"\s+"([^"]*)"/g)].map((kv) => [kv[1], kv[2]])));
}
const maps = MAPS.map((map) => {
  const ents = entities(path.join(root, "portal", "maps", `${map}.bsp`));
  const chambers = EXPECTED[map];
  const signs = ents.filter((e) => /signage_num(\d+)\.mdl/.test(e.model ?? "")).map((e) => ({ id: e.model.match(/signage_num(\d+)/)[1], at: vec(e.origin) }))
    .filter((s) => chambers.includes(s.id)); // a_15 carries a decorative "09" sign
  // The in-map elevator: its top path_track (p4) is where the ride to the second chamber ends;
  // the elevators named after two maps are the level-change elevators.
  const tops = ents.filter((e) => e.classname === "path_track" && /elevator_p4/.test(e.targetname ?? "") && !/a\d\d[-_]a?\d\d|a06_07|a07_08|a08_a?09|a09_a10|a10_a11|a11_a13|a13_a14|a14_a15/.test(e.targetname));
  const middle = tops.length === 1 && chambers.length === 2 ? { at: vec(tops[0].origin), name: tops[0].targetname, target: chambers[1] } : null;
  const next = ents.find((e) => e.classname === "trigger_changelevel" && MAPS.indexOf(e.map) === MAPS.indexOf(map) + 1)?.map ?? null;
  return { map, chambers: chambers.map((id) => ({ id, sign: signs.find((s) => s.id === id)?.at ?? null })), middleElevatorTop: middle, next };
});
const out = path.join(path.dirname(new URL(import.meta.url).pathname), "chambers.json");
fs.writeFileSync(out, `${JSON.stringify({ generated_from: "Portal map entity lumps (Source Unpack 2.6)", maps }, null, 2)}\n`);
for (const m of maps) console.log(`${m.map}: ${m.chambers.map((c) => `${c.id}${c.sign ? "" : " (no sign)"}`).join(", ")}${m.middleElevatorTop ? `; middle elevator top ${m.middleElevatorTop.name} -> ${m.middleElevatorTop.target}` : ""}; next ${m.next}`);
