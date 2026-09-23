// What a run plays can be chosen by a variable (BizHawk's profile). The run records the variables its plugin names in
// `runEnv` in its brief, and publish and resume set them again before the plugin is loaded, whatever the shell holds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { configure } from "../src/configure.mjs";
import { applyRunEnv } from "../src/settings.mjs";

const here = dirname(fileURLToPath(import.meta.url));
process.env.CODEX_HOME = process.env.CODEX_HOME ?? mkdtempSync(join(tmpdir(), "aas-codex-home-"));
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "aas-runenv-cfg-"));

test("the variables in a plugin's runEnv are recorded in the brief and win over the shell afterwards", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aas-runenv-"));
  const game = join(dir, "game.mjs");
  writeFileSync(game, `import fake from ${JSON.stringify(join(here, "fake-game.mjs"))};
export default { ...fake, instructions: "test", runEnv: ["AAS_TEST_VARIANT", "AAS_TEST_UNSET"] };
`);
  const runDir = join(dir, "run");
  process.env.AAS_TEST_VARIANT = "smb";
  delete process.env.AAS_TEST_UNSET;
  await configure({ runtime: join(here, "stub-runtime.mjs"), game, "run-dir": runDir }, { log() {} });
  const brief = JSON.parse(readFileSync(join(runDir, "brief.json"), "utf8"));
  assert.deepEqual(brief.gameEnv, { AAS_TEST_VARIANT: "smb" }, "only what was set, by name");
  process.env.AAS_TEST_VARIANT = "nes15";
  assert.deepEqual(applyRunEnv(brief), ["AAS_TEST_VARIANT"]);
  assert.equal(process.env.AAS_TEST_VARIANT, "smb");
  assert.deepEqual(applyRunEnv({}), [], "an older brief without gameEnv changes nothing");
  delete process.env.AAS_TEST_VARIANT;
});
