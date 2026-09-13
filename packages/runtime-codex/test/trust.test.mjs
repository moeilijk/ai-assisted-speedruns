// Codex trusts a run directory through an exact entry in its user config; configure writes it, nothing else changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexConfigFile, isTrusted, trustRunDir } from "../index.mjs";

test("the exact project entry is appended once and the rest of the file stays", () => {
  const dir = mkdtempSync(join(tmpdir(), "aas-codex-"));
  const file = join(dir, "config.toml");
  writeFileSync(file, 'model = "gpt-5"\n[projects."/"]\ntrust_level = "trusted"\n');
  assert.equal(isTrusted("/run/x", { file }), false, 'the wildcard entry for "/" does not count');
  assert.deepEqual(trustRunDir("/run/x", { file }), { file, dir: "/run/x", changed: true });
  assert.equal(isTrusted("/run/x", { file }), true);
  assert.deepEqual(trustRunDir("/run/x", { file }), { file, dir: "/run/x", changed: false });
  const text = readFileSync(file, "utf8");
  assert.ok(text.startsWith('model = "gpt-5"\n[projects."/"]\ntrust_level = "trusted"\n'));
  assert.equal(text.split('[projects."/run/x"]').length, 2);
  assert.equal(codexConfigFile({ CODEX_HOME: "/c" }), "/c/config.toml");
  assert.equal(codexConfigFile({ HOME: "/home/u" }), "/home/u/.codex/config.toml");
});
