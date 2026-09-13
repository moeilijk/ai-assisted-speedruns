#!/usr/bin/env node
// Start OBS Studio for a run (Windows): minimized, no updater, and without the
// "did not shut down properly" dialog that would otherwise block the WebSocket
// server from starting. Waits until obs-websocket answers.
// Minimized to the taskbar, not to the tray: a tray-minimized OBS has no window
// at all, and then it cannot be closed the way a user would (WM_CLOSE), which
// left it running after every run.
import { execFileSync } from "node:child_process";
import net from "node:net";

const exe = process.env.AAS_OBS_EXE ?? "C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe";
const dir = exe.replace(/\\[^\\]+$/, "");
const url = new URL(process.env.AAS_OBS_URL ?? "ws://127.0.0.1:4455");
const probe = () => new Promise((res) => { const s = net.connect(Number(url.port || 4455), url.hostname); s.setTimeout(2000); s.on("connect", () => (s.destroy(), res(true))); s.on("error", () => res(false)); s.on("timeout", () => (s.destroy(), res(false))); });
if (await probe()) {
  console.log("OBS websocket already up");
  process.exit(0);
}
execFileSync("powershell.exe", ["-NoProfile", "-Command", `if (-not (Get-Process obs64 -ErrorAction SilentlyContinue)) { Start-Process -FilePath '${exe}' -WorkingDirectory '${dir}' -ArgumentList '--startminimized','--disable-updater','--disable-shutdown-check' -WindowStyle Minimized }`]);
const deadline = Date.now() + 120000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 3000));
  if (await probe()) {
    console.log(`OBS websocket up at ${url.host}`);
    process.exit(0);
  }
}
throw new Error("OBS started but obs-websocket did not answer within 120 s (Tools → WebSocket Server Settings → Enable).");
