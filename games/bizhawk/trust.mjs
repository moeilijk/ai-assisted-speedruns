// Whether EmuHawk trusts the bizhawk-mcp-native tool. BizHawk asks "Trust this external tool to run on your device?"
// the first time it loads an external tool, and keeps the answer in its own config.ini as TrustedExtTools: the DLL's
// path and "SHA512:<hash of the DLL>" (ExternalToolManager.cs, BizHawk 2.11.1). A new version of the DLL has another hash,
// so BizHawk asks again; this reads the same two things, so the tooling knows before it starts EmuHawk.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const TOOL_DLL = "BizHawkMcp.dll";

export function trustState(dir) {
  const dll = path.join(dir, "ExternalTools", TOOL_DLL);
  if (!fs.existsSync(dll)) return { installed: false, trusted: false, detail: `${TOOL_DLL} is not installed (npm run bizhawk:install)` };
  const checksum = `SHA512:${createHash("sha512").update(fs.readFileSync(dll)).digest("hex").toUpperCase()}`;
  let trusted = false;
  try {
    const config = JSON.parse(fs.readFileSync(path.join(dir, "config.ini"), "utf8").replace(/^﻿/, ""));
    trusted = Object.entries(config.TrustedExtTools ?? {}).some(([file, sum]) => file.split(/[\\/]/).pop() === TOOL_DLL && sum === checksum);
  } catch { /* no config yet: EmuHawk has never run */ }
  return { installed: true, trusted, checksum, detail: trusted ? `BizHawk trusts ${TOOL_DLL} (${checksum.slice(0, 19)}…)` : `BizHawk has not been told to trust ${TOOL_DLL} yet (npm run bizhawk:allow)` };
}
