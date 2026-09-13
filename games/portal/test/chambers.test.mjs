// Chamber progress from positions against the maps' markers (chambers.json).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CHAMBERS, CHAMBER_MAPS, chamberAt, createChamberTracker } from "../chambers.mjs";

test("23 chambers in campaign order, every test chamber has a sign", () => {
  assert.equal(CHAMBERS.length, 23);
  assert.deepEqual(CHAMBERS.slice(0, 3), ["00", "01", "02"]);
  assert.deepEqual(CHAMBERS.slice(-3), ["e00", "e01", "e02"]);
  for (const m of CHAMBER_MAPS) for (const c of m.chambers) if (!c.id.startsWith("e")) assert.ok(c.sign, `${m.map} ${c.id} sign`);
});

test("chamber 01 is entered at the elevator top or its sign; forward progress only", () => {
  const t = createChamberTracker();
  assert.equal(t.chamber, "00");
  assert.equal(t.observe({ x: -607, y: -346, z: 161 }), null); // the vault
  assert.equal(chamberAt("testchmb_a_00", { x: -1516.9, y: -852.8, z: 724.6 }), "01"); // run 03: top of the middle elevator
  assert.equal(t.observe({ x: -1516.9, y: -852.8, z: 724.6 }), "01");
  assert.equal(t.observe({ x: -1040, y: -878, z: 704 }), null); // near sign 01 again: no second milestone
  assert.equal(t.observe({ x: -736, y: -414, z: 256 }), null); // back at sign 00: never backwards
  assert.equal(t.chamber, "01");
});

test("a level change enters the next map's first chamber; a resumed tracker continues from its state", () => {
  const t = createChamberTracker();
  assert.equal(t.nextMap(), "testchmb_a_01");
  assert.equal(t.enterMap("testchmb_a_01"), "02");
  assert.equal(t.observe({ x: -702, y: 64, z: 704 }), "03"); // sign 03
  const resumed = createChamberTracker({ map: "testchmb_a_15", chamber: "19" });
  assert.equal(resumed.enterMap("escape_00"), "e00");
  assert.equal(resumed.enterMap("escape_00"), null); // a reload of the same map
});
