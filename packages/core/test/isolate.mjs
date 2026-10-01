// Every test runs apart from the machine it runs on: a config directory of its own (not the credentials or the
// tickets of the person running the tests), its own settings files and GUI note (never the GUI that may be open on
// this machine), no proof unless a test asks for it, and an archive address that cannot exist, so no test reaches a
// real archive. `npm test` loads this before every test file (node --import), and the
// processes a test starts inherit it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aas-test-config-"));
process.env.XDG_CONFIG_HOME = path.join(dir, "config");
process.env.AAS_ENV_FILE = path.join(dir, ".env");
process.env.AAS_GAME_ENV_DIR = path.join(dir, "games");
process.env.AAS_GUI_NOTE = path.join(dir, "gui.json");
process.env.AAS_GUI_CHECKS = path.join(dir, "gui-checks.json");
process.env.AAS_PROOF = "off";
process.env.AAS_PROOF_URL = "https://archive.invalid";
delete process.env.AAS_PROOF_KEYS;
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
