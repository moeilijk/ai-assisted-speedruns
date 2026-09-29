// What `aas gui` needs from LiveSplit, kept with the timer: its setting, its conditions before any run, and the
// buttons that put them right (install the pinned release, start its server with LiveSplit, stop its questions).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toLocal, toWindows, ON_WINDOWS } from "../core/src/gui/windows-paths.mjs";
import { aasToolsDir } from "../core/src/gui/detect.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const exists = (p) => { try { return Boolean(p) && fs.existsSync(p); } catch { return false; } };
/** The folder the install button puts LiveSplit in (%LOCALAPPDATA%\aas\LiveSplit). */
const installDir = () => (aasToolsDir() ? path.join(aasToolsDir(), "LiveSplit") : null);
const installed = () => { const d = installDir(); return d && exists(path.join(d, "LiveSplit.exe")) ? path.join(d, "LiveSplit.exe") : null; };
const exeOf = (env) => toLocal(env.AAS_LIVESPLIT_EXE ?? "") || installed();

export const setup = {
  group: "Windows tools",
  settings: [{ env: "AAS_LIVESPLIT_EXE", label: "LiveSplit", kind: "file", expect: "LiveSplit.exe", default: installed, what: "LiveSplit.exe itself, wherever you unpacked it: the timer that is shown in the recording and takes the splits." }],
  fixes: {
    install: {
      label: `Install LiveSplit ${JSON.parse(fs.readFileSync(path.join(here, "UPSTREAM.json"), "utf8")).livesplit.version}`,
      script: path.join(here, "install-livesplit.mjs"),
      args: () => [installDir()],
      sets: () => ({ AAS_LIVESPLIT_EXE: path.join(installDir(), "LiveSplit.exe") }),
    },
    server: { label: "Start the server with LiveSplit", script: path.join(here, "enable-server.mjs"), args: () => [exeOf(process.env)] },
    windows: { label: "Stop LiveSplit's questions (Windows asks permission once)", script: path.join(here, "windows-setup.mjs"), args: () => [exeOf(process.env)] },
  },
};

/** The Setup tab's conditions for LiveSplit, before any run. */
export async function setupRows({ env = process.env } = {}) {
  const rows = [];
  const exe = exeOf(env);
  // `detail` says what is wrong, so a row that holds carries none.
  const add = (ok, what, detail = "", extra = {}) => { rows.push({ ok: Boolean(ok), what, detail: ok ? "" : detail, ...extra }); return Boolean(ok); };
  if (!add(exists(exe), "LiveSplit.exe is there", exe ? `${toWindows(exe)} is not there.` : "LiveSplit shows the timer and the splits in the recording.", { level: "missing", fix: "install" })) return rows;
  const cfg = path.join(path.dirname(exe), "settings.cfg");
  if (!add(/<ServerStartup>1<\/ServerStartup>/.test(exists(cfg) ? fs.readFileSync(cfg, "utf8") : ""), "its server starts with LiveSplit", "Its server does not start with LiveSplit, so the harness cannot use it.", { level: "warn", fix: "server" })) return rows;
  if (ON_WINDOWS) {
    const { windowsSetupStatus } = await import("./windows-setup.mjs");
    const w = windowsSetupStatus(exe);
    add(w.outboundBlocked, "it does not check for updates at every start", "LiveSplit asks about updates at every start.", { level: "warn", fix: "windows" });
    add(w.fileTypes, "it does not ask for administrator rights at every start", "LiveSplit asks for administrator rights at every start.", { level: "warn", fix: "windows" });
  }
  return rows;
}
