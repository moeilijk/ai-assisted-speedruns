// A run's name is its id on the Archive and the last part of its address there (/runs/<handle>/<run id>/), so it has
// to be unique among the runs of one account, not only among the runs of one game. Runs are kept per game
// (<output>/<Game>/<run>), and counting names per game folder gave every game its own "opus-01" and "codex-01": on
// 2026-10-15 three runs stood under one address, and two of their recordings were filed under the wrong run because
// all six files began AAS_opus-01_. The GUI proposes a name with the game in it; `aas configure` and `aas publish`,
// which the GUI runs too, refuse a name another game's run already has, so a name typed by hand cannot do it either.
import fs from "node:fs";
import path from "node:path";
import { toLocal } from "./gui/windows-paths.mjs";

/** The output location (AAS_OUTPUT_DIR) as a local path, or null when none is set. */
const outputRoot = () => { const o = toLocal(process.env.AAS_OUTPUT_DIR ?? ""); return o ? path.resolve(o) : null; };

/** The proposed name of a run: the game's id, the run type's prefix and a number, e.g. balatro-codex-01. */
export const runNameOf = (gameId, prefix, n) => `${String(gameId).replace(/_/g, "-")}-${prefix}-${String(n).padStart(2, "0")}`;

/**
 * Another game's run, or its published bundle, that carries `name`, next to `gameDir` (the folder this game's runs are
 * kept in); null when there is none. A run is a folder with a brief.json, a bundle one with a manifest.json, so a
 * folder that only happens to share the name is not taken for one.
 */
export function runNameTakenElsewhere(gameDir, name, root = outputRoot()) {
  const here = path.resolve(gameDir);
  // Only where runs are kept per game: the output location, whose folders are games. A run made anywhere else — a
  // folder of one's own, a test's temporary one — has no game folders around it, and what lies next to it is not
  // another game (the first version of this looked there too and refused six tests' runs for each other's).
  if (!root || path.dirname(here) !== path.resolve(root)) return null;
  let entries;
  try { entries = fs.readdirSync(path.resolve(root), { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === path.basename(here)) continue;
    const run = path.join(path.resolve(root), e.name, name);
    if (fs.existsSync(path.join(run, "brief.json"))) return run;
    const bundle = path.join(path.resolve(root), e.name, "public", name);
    if (fs.existsSync(path.join(bundle, "manifest.json"))) return bundle;
  }
  return null;
}

/** The refusal, in words a person can act on. */
export const takenMessage = (name, where) =>
  `The run name "${name}" is already used by another game's run (${where}). A run's name is its address on the Archive, so it has to be unique among all your runs: choose another, or leave the name empty in the GUI for one that is.`;
