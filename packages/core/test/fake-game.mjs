// Minimal GamePlugin used by the broker tests and by runtime plugins for dry runs.
const PNG1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
export default {
  id: "fake_game",
  name: "Fake Game",
  capabilities: { turnBased: true, canPause: true, stateAccess: "full", inputRoute: "api", igt: false },
  endpoints: [],
  documentation: "# Fake Game API\n\n`game.observe()` returns `{turn, hp}`; `game.act(name)` returns `{ok, turn}`; `game.screenshot()`.\n",
  async connect() {
    let turn = 1;
    return {
      async observe() { return { turn, hp: 100 }; },
      async act(name) { turn += 1; return { ok: true, did: name, turn }; },
      async screenshot() {
        const url = `data:image/png;base64,${PNG1x1}`;
        globalThis.aas?.emitImage(url);
        return { screenshots: [{ url, width: 1, height: 1 }] };
      },
      close() {},
    };
  },
};
