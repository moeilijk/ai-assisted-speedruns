// Closes Portal 2 the way the game itself allows: SAR's TAS protocol is told to stop whatever it is playing, the
// engine's own `quit` is handed to it through a one-tick script's commands column (the only channel the protocol
// has for a console command), and then the window is given the time a user would give it. Nothing is killed.
//
// Called by the game plugin's `close()` (the harness at the end of a run) and by stop-all.mjs (the manual command).
import { closeWindows } from "../../packages/core/src/close-windows.mjs";
import { afterGameClose } from "../../packages/core/src/windows/quiet-start.mjs";
import { connectSar } from "./sar-client.mjs";

export async function closeGame({ log = () => {}, timeoutMs = 4000 } = {}) {
  const lines = [];
  const say = (t) => { for (const l of String(t ?? "").split("\n")) if (l.trim()) { lines.push(l); log(l); } };
  try {
    const sar = await connectSar({ timeout: timeoutMs });
    try {
      await sar.stop();
      // `quit` never answers — the game is gone before it could — so the script is sent and not waited for.
      sar.script(`version 9\nstart now\n+0>|||quit|\n`, "aas_quit").catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
      say("stop and quit sent through SAR's protocol");
    } finally { sar.close(); }
  } catch (e) {
    say(`SAR did not answer (${e.message}); closing the window instead`);
  }
  say(afterGameClose());
  say(closeWindows([{ wait: "portal2", seconds: 25 }], { report: ["portal2"] }));
  return lines.join("\n");
}
