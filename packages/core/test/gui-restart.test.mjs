// The restart button: only a GUI that `aas gui` runs as its child can start itself again (it ends with RESTART_CODE
// and `aas gui` starts it on the code as it is now); any other GUI says how to restart it by hand.
import { test } from "node:test";
import assert from "node:assert/strict";

test("a GUI not started by aas gui refuses to restart itself and says what to do instead", async () => {
  const { startGui, RESTART_CODE } = await import("../src/gui/server.mjs");
  assert.equal(RESTART_CODE, 75);
  const saved = process.env.AAS_GUI_CHILD;
  delete process.env.AAS_GUI_CHILD;
  const gui = await startGui({ port: 0, open: false, checkAtStart: false, log() {} });
  try {
    const res = await fetch(`http://127.0.0.1:${gui.server.address().port}/api/restart`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /not started by aas gui.*close it and start it again \(AAS\.cmd or npm run gui\)/);
  } finally {
    if (saved !== undefined) process.env.AAS_GUI_CHILD = saved;
    gui.server.close();
  }
});
