// Recorder plugin for Source games with portal-agent's SPT patch: the
// recording is the in-game demo that `start_run` / `stop_run` drive. The
// Portal game plugin sends those (prepareRun / endRun, called by `aas run`);
// this recorder only notes which agent_runs/<timestamp>/ directory is new
// and collects its .dem files afterwards.
//
// Options (constructor or env): gameRoot (AAS_PORTAL_GAME_ROOT: the Source
// Unpack folder) or demoDir.
import fs from "node:fs";
import path from "node:path";

export function createSourceDemoRecorder(options = {}) {
  const gameRoot = options.gameRoot ?? process.env.AAS_PORTAL_GAME_ROOT ?? null;
  const demoDir = options.demoDir ?? (gameRoot ? path.join(gameRoot, "portal", "agent_runs") : null);
  const log = options.log ?? ((t) => process.stderr.write(`[recorder-source-demo] ${t}\n`));
  let before = new Set();
  let t0 = null;
  const chapters = [];

  const listRuns = () => (demoDir && fs.existsSync(demoDir) ? fs.readdirSync(demoDir).filter((d) => fs.statSync(path.join(demoDir, d)).isDirectory()) : []);

  return {
    id: "source-demo",
    name: "In-game demo (Source engine)",
    version: "0.29.1",
    async preflight(brief, game) {
      if (!demoDir) throw new Error("source-demo recorder needs the game folder: set AAS_PORTAL_GAME_ROOT (the Source Unpack root) or pass gameRoot/demoDir.");
      if (!game?.prepareRun) throw new Error(`source-demo recorder needs a game plugin with prepareRun/endRun (start_run / stop_run); ${game?.id} has none.`);
    },
    async start() {
      before = new Set(listRuns());
      t0 = new Date(); // the demo starts with start_run, sent right after this by the game plugin
      return { t0 };
    },
    async onEvent(event) {
      if (event.event === "game.milestone" && t0 && event.data?.chapter) {
        chapters.push({ at: Math.max(0, (Date.parse(event.timestamp) - t0.getTime()) / 1000), label: String(event.data.label ?? "milestone") });
      }
    },
    async stop() {
      // stop_run was sent by the game plugin's endRun; give the game a moment to flush the demo.
      await new Promise((r) => setTimeout(r, options.settleMs ?? 1500));
      const created = listRuns().filter((d) => !before.has(d)).sort();
      const dir = created.at(-1) ?? listRuns().sort().at(-1);
      const files = dir ? fs.readdirSync(path.join(demoDir, dir)).filter((f) => f.endsWith(".dem")).map((f) => path.join(demoDir, dir, f)) : [];
      if (!files.length) log(`warning: no .dem files found under ${demoDir}`);
      return { files, t0: t0 ?? new Date(), chapters };
    },
  };
}

export default createSourceDemoRecorder();
