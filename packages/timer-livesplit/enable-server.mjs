// The Setup tab's button: LiveSplit starts its server with itself (ServerStartup=1 in the settings.cfg next to it).
import path from "node:path";
import { enableServerStartup } from "./install-livesplit.mjs";

const exe = process.argv[2];
if (!exe) { console.error("usage: enable-server.mjs <LiveSplit.exe>"); process.exit(1); }
console.log(enableServerStartup(path.join(path.dirname(path.resolve(exe)), "settings.cfg")));
console.log("LiveSplit reads this when it starts; close it first if it is open.");
