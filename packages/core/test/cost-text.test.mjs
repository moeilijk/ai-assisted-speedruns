// The cost text `aas run` shows is the one in the README, word for word.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { COST_TEXT } from "../src/cost-text.mjs";

test("the README carries the cost text aas run shows", () => {
  const readme = fs.readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
  assert.ok(readme.includes(`## What a run costs\n\n${COST_TEXT}\n`));
});
