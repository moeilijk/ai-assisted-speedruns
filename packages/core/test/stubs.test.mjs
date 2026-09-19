// Stub game plugins: every one loads under the plugin contract (ends with labels, exactly one final), says it is a
// stub, and cannot be configured into a run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGamePlugin } from "../src/mcp-client.mjs";
import { configure } from "../src/configure.mjs";

const games = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "games");
const stubs = readdirSync(games).map((d) => join(games, d, "plugin.mjs")).filter((f) => existsSync(f) && /stub: true/.test(readFileSync(f, "utf8")));

// The games still waiting for a plugin, by their folder. Naming them rather than counting them means finishing one
// is a change this test points at, instead of a number that silently drifts.
const EXPECTED = ["bizhawk", "celeste", "half-life-2", "kerbal-space-program", "openrct2", "slay-the-spire-2", "unity-bepinex", "unreal-ue4ss"];

test("every stub game plugin loads, declares its ends, and refuses to run", async () => {
  assert.deepEqual(stubs.map((f) => f.split("/").at(-2)).sort(), [...EXPECTED].sort(), "the stubs are the games still waiting for a plugin; finishing one means taking it out of this list");
  for (const file of stubs) {
    const plugin = await loadGamePlugin(file);
    assert.equal(plugin.stub, true, file);
    assert.equal(plugin.ends.filter((e) => e.final).length, 1, file);
    await assert.rejects(plugin.connect(), /is a stub game plugin/, file);
    const runDir = join(mkdtempSync(join(tmpdir(), "aas-stub-")), "run");
    await assert.rejects(configure({ runtime: "claude-code", game: file, "run-dir": runDir, instructions: file }, { log() {} }), /is a stub game plugin/, file);
  }
});
