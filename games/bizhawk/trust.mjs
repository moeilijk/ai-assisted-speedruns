// Whether EmuHawk trusts the bizhawk-mcp-native tool. BizHawk asks "Trust this external tool to run on your device?"
// the first time it loads an external tool, and keeps the answer in its own config.ini as TrustedExtTools: the DLL's
// path and "SHA512:<hash of the DLL>" (ExternalToolManager.cs, BizHawk 2.11.1). A new version of the DLL has another hash,
// so BizHawk asks again; this reads the same two things, so the tooling knows before it starts EmuHawk.
// It also reads which build of the tool is installed (its release writes build-info.json next to the DLL): an older
// one takes the same calls but ignores what it does not know, such as the buttons frame_advance holds, and the game
// would get no input without an error. Only the pinned build counts as ready.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TOOL_DLL = "BizHawkMcp.dll";

export function trustState(dir) {
  const dll = path.join(dir, "ExternalTools", TOOL_DLL);
  if (!fs.existsSync(dll)) return { installed: false, trusted: false, detail: `${TOOL_DLL} is not installed (npm run bizhawk:install)` };
  const pin = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "UPSTREAM.json"), "utf8")).bizhawk_mcp_native;
  let build = null;
  try { build = JSON.parse(fs.readFileSync(path.join(dir, "ExternalTools", "build-info.json"), "utf8")); } catch { /* none */ }
  const repo = pin.repo.replace(/^https:\/\/github\.com\//, "");
  if (build?.tool?.version !== pin.version || build?.workflow?.repository !== repo) {
    const have = build?.tool?.version ? `${build.tool.version} from ${build.workflow?.repository ?? "?"}` : "a build without build-info.json";
    return { installed: true, outdated: true, trusted: false, detail: `${TOOL_DLL} is ${have}; this tooling needs ${pin.version} from ${repo} (npm run bizhawk:install)` };
  }
  const checksum = `SHA512:${createHash("sha512").update(fs.readFileSync(dll)).digest("hex").toUpperCase()}`;
  let trusted = false;
  try {
    const config = JSON.parse(fs.readFileSync(path.join(dir, "config.ini"), "utf8").replace(/^﻿/, ""));
    trusted = Object.entries(config.TrustedExtTools ?? {}).some(([file, sum]) => file.split(/[\\/]/).pop() === TOOL_DLL && sum === checksum);
  } catch { /* no config yet: EmuHawk has never run */ }
  return { installed: true, trusted, checksum, detail: trusted ? `BizHawk trusts ${TOOL_DLL} (${checksum.slice(0, 19)}…)` : `BizHawk has not been told to trust ${TOOL_DLL} yet (npm run bizhawk:allow)` };
}
