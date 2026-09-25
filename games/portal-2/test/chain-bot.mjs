// The chain test's player for Portal 2 (the plugin has no scripted player of its own): it looks three times, which is
// what reads the engine's console log for the map, and is done.
export function createBot() {
  let n = 0;
  return { next() { n += 1; return n <= 3 ? { code: "return await portal2.observe()", note: `look ${n}` } : null; } };
}
