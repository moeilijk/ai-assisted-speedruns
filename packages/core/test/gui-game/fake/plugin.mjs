// A game for the GUI's own tests: everything the GUI needs from a game plugin (setup, a scripted player, save and
// load), and nothing outside this process. `npm test` runs the whole GUI session with it through the real commands:
// start the game, `aas run`, `aas publish`, and Continue with `aas resume`.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PNG1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
let saveDir = null;

export default {
  id: "gui_fake",
  name: "GUI Fake",
  version: "0.0.0",
  ends: [{ id: "end", label: "The end", final: true }],
  capabilities: { turnBased: true, canPause: true, stateAccess: "full", inputRoute: "api", igt: false },
  endpoints: [],
  documentation: "# GUI Fake\n\n`game.observe()` returns `{turn}`; `game.act()` returns `{turn}`.\n",
  instructions: "Play the GUI fake.",
  category: { build: "GUI Fake 1.0", observation: "full", input: "input", timing: "paused-think", human: "none" },
  async build() { return { game: "GUI Fake", version: "1.0", platform: "Node.js", mods: [], settings: {} }; },
  setup: {
    folder: "GuiFake",
    settings: [],
    launch: path.join(here, "launch.mjs"),
    stop: path.join(here, "stop.mjs"),
    bot: path.join(here, "bot.mjs"),
    recorders: [],
  },
  async connect() {
    let turn = 1;
    return {
      async observe() { return { turn }; },
      async act() { turn += 1; return { turn }; },
      async screenshot() { const url = `data:image/png;base64,${PNG1x1}`; globalThis.aas?.emitImage(url); return { screenshots: [{ url, width: 1, height: 1 }] }; },
      close() {},
    };
  },
  async prepareRun({ runDir }) { saveDir = runDir; return { readyAt: new Date() }; },
  async saveState({ name }) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(name))) throw new Error(`save name ${JSON.stringify(String(name))} is not a plain name`);
    const file = path.join(saveDir ?? here, `${name}.sav`);
    fs.writeFileSync(file, "saved");
    return { file };
  },
  async loadState({ name }) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(name))) throw new Error(`save name ${JSON.stringify(String(name))} is not a plain name`);
    return { readyAt: new Date() };
  },
};
