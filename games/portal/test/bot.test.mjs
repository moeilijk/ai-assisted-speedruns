// The scripted player replays a recorded route, in order, and stops at its end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBot, loadRoute } from "../bot.mjs";

test("the route is a recording of a run that reached its chamber, not something written here", () => {
  const route = loadRoute("chamber01");
  assert.equal(route.reaches, "chamber01");
  assert.ok(route.source.run && route.source.segment, "it names the run it came from");
  assert.ok(route.steps.length > 50, `a route of ${route.steps.length} steps`);
  for (const step of route.steps) assert.match(step.code, /portal\.(tas|look)/, "every step is input to the game");
});

test("the bot plays the route in order and then stops", () => {
  const route = loadRoute("chamber01");
  const bot = createBot({});
  const played = [];
  for (let step = bot.next(null); step; step = bot.next(null)) played.push(step.code);
  assert.deepEqual(played, route.steps.map((s) => s.code));
  assert.equal(bot.next(null), null, "and it keeps saying it is done");
});

test("AAS_BOT_PORTAL_STEPS makes a shorter test of the same route", () => {
  process.env.AAS_BOT_PORTAL_STEPS = "5";
  try {
    const bot = createBot({});
    let n = 0;
    while (bot.next(null)) n += 1;
    assert.equal(n, 5);
  } finally { delete process.env.AAS_BOT_PORTAL_STEPS; }
});
