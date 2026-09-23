#!/usr/bin/env node
// The one step in which BizHawk asks whether it may load the bizhawk-mcp-native tool, announced beforehand so the
// question is not a surprise: EmuHawk opens without a game, asks, and is closed again once the answer is stored.
// A run never shows this question: the launcher checks the stored answer first and refuses to start without it.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSettings } from "../../packages/core/src/settings.mjs";
import { bizhawkDir } from "./paths.mjs";
import { ping } from "./mcp.mjs";
import { trustState } from "./trust.mjs";
import { closeGame } from "./close-game.mjs";

export async function allowTool({ log = console.log } = {}) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pin = JSON.parse(fs.readFileSync(path.join(here, "UPSTREAM.json"), "utf8")).bizhawk_mcp_native;
  const dir = bizhawkDir();
  const before = trustState(dir);
  if (!before.installed) throw new Error(before.detail);
  if (before.trusted) { log(before.detail); return before; }
  log([
    "BizHawk opens now, without a game, and asks:",
    '  "Trust this external tool to run on your device?"',
    `It asks about ${pin.dll}: bizhawk-mcp-native ${pin.version} by StealthC (${pin.license.split(",")[0]}), ${pin.repo},`,
    `downloaded from its release and checked against sha256 ${pin.sha256.slice(0, 16)}…. It lets this tooling pause`,
    "the game, advance frames, press buttons and take screenshots. Choose Yes to allow it; BizHawk then closes again.",
  ].join("\n"));
  const child = spawn(path.join(dir, "EmuHawk.exe"), ["--open-ext-tool-dll=BizHawkMcp"], { cwd: dir, detached: true, stdio: "ignore" });
  child.unref();
  const deadline = Date.now() + 5 * 60000;
  while (Date.now() < deadline && !(await ping())) await new Promise((r) => setTimeout(r, 1000));
  const answered = await ping();
  // BizHawk writes its config when it closes: only then is the answer stored.
  await closeGame({ log: () => {} });
  const after = trustState(dir);
  log(after.trusted ? `allowed: ${after.detail}` : answered ? "the tool loaded, but BizHawk did not store the answer" : "not allowed (No, or no answer within 5 minutes): BizHawk runs will not start");
  if (!after.trusted) throw new Error("BizHawk does not trust the tool");
  return after;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  loadSettings(import.meta.url);
  await allowTool();
}
