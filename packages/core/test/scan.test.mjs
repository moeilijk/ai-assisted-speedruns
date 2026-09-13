// The privacy scan: a password in a config and a WSL mount path are findings; the placeholders are not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SCAN_RULES } from "../src/sanitize.mjs";

const rulesHit = (text) => SCAN_RULES.filter(([, re]) => re.test(text)).map(([rule]) => rule);

test("a password value in a config is found, a placeholder is not", () => {
  assert.ok(rulesHit('"AAS_OBS_PASSWORD": "hunter2hunter2"').includes("password or token in a config"));
  assert.ok(rulesHit('server_password = "abc"').includes("password or token in a config"));
  assert.ok(!rulesHit('"AAS_OBS_PASSWORD": "__ENV__"').includes("password or token in a config"));
});

test("a WSL mount path is found", () => {
  assert.ok(rulesHit('"AAS_STS_GAME_ROOT": "/mnt/x/Games/ExampleGame"').includes("WSL mount path"));
  assert.ok(!rulesHit('"AAS_RUN_DIR": "__RUN_DIR__"').includes("WSL mount path"));
});
