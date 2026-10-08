// Windows on the display the settings name, on any machine: one display or several, any resolution, any arrangement;
// a display that is gone leaves the window where Windows puts it, and says so.
import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutWindows } from "../src/windows/move-window.mjs";
import { displayOf, displayAt } from "../src/windows/displays.mjs";

const one = [{ name: "\\\\.\\DISPLAY1", primary: true, x: 0, y: 0, width: 1920, height: 1080 }];
const three = [
  { name: "\\\\.\\DISPLAY1", primary: true, x: 0, y: 0, width: 2560, height: 1440 },
  { name: "\\\\.\\DISPLAY2", primary: false, x: -1920, y: 0, width: 1920, height: 1080 },
  { name: "\\\\.\\DISPLAY3", primary: false, x: 2560, y: -360, width: 1280, height: 1024 },
];
const fceux = [
  { handle: "2", title: "Lua Script", width: 421, height: 303 },
  { handle: "1", title: "FCEUX 2.6.6: Super Mario Bros. (World)", width: 272, height: 263 },
];

test("the game's window goes to the top left of the chosen display, its other windows beside it", () => {
  for (const d of [...one, ...three]) {
    const plan = layoutWindows(fceux, { main: "^FCEUX \\d", display: d });
    assert.deepEqual(plan.map((p) => [p.title.slice(0, 5), p.x, p.y]), [["FCEUX", d.x, d.y], ["Lua S", d.x + 272, d.y]], d.name);
  }
});

test("windows that do not fit in a row go to the next row, inside the display", () => {
  const narrow = { name: "narrow", x: 100, y: 50, width: 600, height: 800 };
  const plan = layoutWindows([{ handle: "1", title: "Game", width: 400, height: 300 }, { handle: "2", title: "Tool", width: 300, height: 200 }], { main: "Game", display: narrow });
  assert.deepEqual(plan.map((p) => [p.x, p.y]), [[100, 50], [100, 350]]);
  for (const p of plan) assert.ok(p.x >= narrow.x && p.x + 300 <= narrow.x + narrow.width + 100, "inside the display");
});

test("LiveSplit goes to the top right of its display, clear of the game at the top left", () => {
  const d = three[1];
  const [ls] = layoutWindows([{ handle: "9", title: "LiveSplit", width: 286, height: 519 }], { main: "LiveSplit", display: d, align: "right" });
  assert.deepEqual([ls.x, ls.y], [d.x + d.width - 286, d.y]);
});

test("a window larger than its display stays at the display's edge", () => {
  const [p] = layoutWindows([{ handle: "1", title: "Portal", width: 2560, height: 1440 }], { display: three[1] });
  assert.deepEqual([p.x, p.y], [-1920, 0]);
});

test("the setting names a display by a point on it; a display that is gone gives none, and says which there are", () => {
  assert.equal(displayAt("-1920,1", three).name, "\\\\.\\DISPLAY2");
  assert.equal(displayOf("2600,-300", { all: three }).name, "\\\\.\\DISPLAY3");
  const said = [];
  assert.equal(displayOf("-1920,1", { all: one, setting: "AAS_FCEUX_WINDOW_POS", log: (l) => said.push(l) }), null);
  assert.match(said[0], /AAS_FCEUX_WINDOW_POS=-1920,1 is on none of this machine's displays now \(.*DISPLAY1 \(primary\) 1920x1080 at 0,0\); the window stays where Windows puts it/);
  assert.equal(displayOf("", { all: one }), null);
  assert.equal(displayOf("left", { all: one, log: (l) => said.push(l) }), null);
  assert.match(said.at(-1), /is not X,Y/);
});
