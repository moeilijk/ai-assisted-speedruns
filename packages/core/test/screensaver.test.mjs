// The screensaver helper reads what the Windows side answers ("<was running> <running now>") and says what it did.
import { test } from "node:test";
import assert from "node:assert/strict";
import { endScreensaver, screensaverRunning } from "../src/windows/screensaver.mjs";

test("a running screensaver is ended and said so; one that is not running is left alone in silence", () => {
  const asked = [];
  const run = (end) => { asked.push(end); return "True False"; };
  assert.match(endScreensaver({ run }), /^screensaver: was running .*; ended$/);
  assert.deepEqual(asked, [true]);
  assert.equal(endScreensaver({ run: () => "False False" }), null);
  assert.match(endScreensaver({ run: () => "True True" }), /did not end/);
});

test("without a Windows side to ask, nothing is claimed", () => {
  assert.equal(endScreensaver({ run: () => null }), null);
  assert.equal(screensaverRunning({ run: () => null }), null);
  assert.equal(screensaverRunning({ run: () => "Add-Type : garbage\nTrue True" }), true);
  assert.equal(screensaverRunning({ run: () => "False False" }), false);
});
