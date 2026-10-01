// The ends a run's log already holds a milestone for. An end is told once per run: a resume, or a game plugin whose
// controller is made again, does not tell it a second time (2026-10-02: a resume split LiveSplit twice, and the
// emulator plugins told every `atLeast` end again after a resume). For the harness and for game plugins alike.
import fs from "node:fs";
import path from "node:path";

/** The `end` ids of the game.milestone events in `<runDir>/run.jsonl`; empty when there is no run or no log. */
export function endsInLog(runDir) {
  const ends = new Set();
  if (!runDir) return ends;
  let text = "";
  try { text = fs.readFileSync(path.join(runDir, "run.jsonl"), "utf8"); } catch { return ends; }
  for (const line of text.split("\n")) {
    if (!line.includes('"game.milestone"')) continue;
    try {
      const r = JSON.parse(line);
      if (r.kind === "event" && r.event === "game.milestone" && r.data?.end) ends.add(r.data.end);
    } catch { /* a line still being written */ }
  }
  return ends;
}
