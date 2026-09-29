// The Setup tab's button: copies OBS's own WebSocket address and password into .env (AAS_OBS_URL, AAS_OBS_PASSWORD).
import { obsWebsocketConfig } from "./setup.mjs";
import { writeEnv } from "../core/src/gui/env-file.mjs";

const ws = obsWebsocketConfig();
if (!ws) { console.error("OBS's WebSocket settings were not found: OBS → Tools → WebSocket Server Settings."); process.exit(1); }
writeEnv({ AAS_OBS_URL: `ws://127.0.0.1:${ws.server_port}`, AAS_OBS_PASSWORD: ws.auth_required ? ws.server_password : "" });
console.log(`OBS's WebSocket address (ws://127.0.0.1:${ws.server_port}) and password copied into the settings`);
