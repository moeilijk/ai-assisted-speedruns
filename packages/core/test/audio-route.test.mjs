// The quiet-audio switch is a per-machine option: without AAS_QUIET_AUDIO_DEVICE it must do
// nothing and say so, and with a device but no SoundVolumeView it must name the missing setting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../src/windows/audio-route.mjs", import.meta.url));
const run = (args, env) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });

test("no quiet device configured: check and snapshot are no-ops, set-quiet fails", () => {
  for (const args of [["--check"], ["--snapshot", "/dev/null"], ["--restore", "/dev/null"]]) {
    const r = run(args, {});
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /no quiet audio device configured/);
  }
  const r = run(["--set-quiet"], {});
  assert.equal(r.status, 1);
  assert.match(r.stdout, /AAS_QUIET_AUDIO_DEVICE/);
});

test("quiet device without SoundVolumeView: names the missing setting", () => {
  const r = run(["--check"], { AAS_QUIET_AUDIO_DEVICE: "Some HDMI Output" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /AAS_SOUNDVOLUMEVIEW/);
});
