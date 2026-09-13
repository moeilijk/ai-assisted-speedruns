// Closes Slay the Spire the way a user would, and undoes what the launcher set up for the run: the
// keep-awake helper and the neutral profile name. Called by the game plugin's `close()` (the harness at the
// end of a run) and by stop-all.mjs (the manual command).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { closeWindows } from "../../packages/core/src/close-windows.mjs";

export function restoreProfileName(root = process.env.AAS_STS_GAME_ROOT) {
  if (!root) return null;
  const prefs = path.join(root, "preferences", "STSPlayer");
  const backup = `${prefs}.aas-backup`;
  if (!fs.existsSync(backup) || !fs.existsSync(prefs)) return null;
  const own = JSON.parse(fs.readFileSync(backup, "utf8")).name;
  const now = JSON.parse(fs.readFileSync(prefs, "utf8"));
  let line = null;
  if (own && now.name !== own) { fs.writeFileSync(prefs, JSON.stringify({ ...now, name: own }, null, 2)); line = "profile: player's own name restored"; }
  fs.rmSync(backup, { force: true });
  return line;
}

export async function closeGame({ log = () => {} } = {}) {
  const lines = [];
  const say = (t) => { for (const l of String(t ?? "").split("\n")) if (l.trim()) { lines.push(l); log(l); } };
  if (process.env.AAS_STS_GAME_ROOT) {
    const portalDir = new URL("../portal/", import.meta.url).pathname;
    say(spawnSync(process.execPath, [path.join(portalDir, "keep-display-awake.mjs"), "stop"], { encoding: "utf8" }).stdout.trim());
  }
  say(closeWindows([
    // ModTheSpire's log window first: closing it ends the whole JVM (game included) in ~5 s,
    // whereas WM_CLOSE to the game window alone takes 30 s or more., measured:.
    { name: "java", title: "ModTheSpire", seconds: 20 },
    { name: "java", title: "Modded Slay the Spire", seconds: 20 },
  ], { report: ["java"] }));
  say(restoreProfileName());
  return lines.join("\n");
}
