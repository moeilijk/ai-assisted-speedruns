// A fake balatrobot: JSON-RPC over HTTP with the states of a run (menu -> blind select -> hand -> round eval ->
// shop), small/big/boss blinds per ante, the win after the boss of `winAnte`, a game over when the hands run out.
// Every played card scores `chipsPerCard`. Enough to drive the bridge and the plugin without the game.
import http from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { deflateRawSync, inflateRawSync } from "node:zlib";

const PNG1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const BLINDS = ["SMALL", "BIG", "BOSS"];

const STATE_NUMBERS = { SELECTING_HAND: 1, GAME_OVER: 4, SHOP: 5, BLIND_SELECT: 7, ROUND_EVAL: 8, MENU: 11 };
const luaString = (s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\\n")}"`; // like Lua's %q

/**
 * The fake keeps the game's own save file the way the game does (`saveFile`, deflate-compressed Lua with the fields
 * the plugin reads), written after every action, `saveLag` ms later: the plugin waits for it, as it must with the game.
 */
export async function startFakeBalatrobot({ winAnte = 2, blindScore = 300, chipsPerCard = 100, hands = 4, saveFile = process.env.AAS_BALATRO_SAVE_FILE ?? null, saveLag = 0 } = {}) {
  const st = { state: "MENU", ante: 0, round: 0, blind: 0, chips: 0, hands, won: false, money: 4, deck: null, stake: null, seed: null, calls: [] };
  const luaSave = () => `return {["BLIND"]={["dollars"]=${st.state === "ROUND_EVAL" ? 3 : 0},["name"]="Small Blind",},["STATE"]=${STATE_NUMBERS[st.state] ?? 0},`
    + `["GAME"]={["round"]=${st.round},["dollars"]=${st.money},["round_resets"]={["ante"]=${st.ante},["blind_tag"]="\\"MANUAL_REPLACE\\"",},`
    + `["current_round"]={["hands_left"]=${st.hands},["discards_left"]=3,},},["AAS_FAKE"]=${luaString(JSON.stringify({ ...st, calls: undefined }))},}`;
  const persist = () => {
    if (!saveFile) return;
    const write = () => writeFileSync(saveFile, deflateRawSync(Buffer.from(luaSave(), "latin1")));
    if (saveLag > 0) setTimeout(write, saveLag).unref(); else write();
  };
  const restore = (file) => {
    const raw = readFileSync(file);
    let saved;
    try { saved = JSON.parse(raw.toString("utf8")); } catch {
      const lua = inflateRawSync(raw).toString("latin1");
      const m = lua.match(/\["AAS_FAKE"\]="((?:[^"\\]|\\[\s\S])*)"/);
      saved = JSON.parse(m[1].replace(/\\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
    }
    Object.assign(st, saved, { calls: st.calls });
  };
  const card = (i) => ({ id: i, key: `H_${"23456789TJQKA"[i % 13]}`, set: "DEFAULT", label: `Card ${i}`, value: { suit: "H", rank: "23456789TJQKA"[i % 13], effect: "" }, modifier: {}, state: {}, cost: { sell: 1, buy: 0 } });
  const view = () => {
    if (st.state === "MENU") return { state: "MENU", round_num: 0, ante_num: 0, money: 0 };
    return {
      state: st.state, round_num: st.round, ante_num: st.ante, money: st.money, deck: st.deck, stake: st.stake, seed: st.seed, won: st.won,
      round: { hands_left: st.hands, hands_played: hands - st.hands, discards_left: 3, discards_used: 0, reroll_cost: 5, chips: st.chips },
      blinds: Object.fromEntries(BLINDS.map((b, i) => [b.toLowerCase(), { type: b, status: i < st.blind ? "DEFEATED" : i === st.blind ? (st.state === "BLIND_SELECT" ? "SELECT" : "CURRENT") : "UPCOMING", name: `${b} Blind`, effect: "", score: blindScore * (i + 1), tag_name: "", tag_effect: "" }])),
      hand: { count: 8, limit: 8, highlighted_limit: 5, cards: st.state === "SELECTING_HAND" ? Array.from({ length: 8 }, (_, i) => card(i)) : [] },
      jokers: { count: 0, limit: 5, highlighted_limit: 1, cards: [] },
      consumables: { count: 0, limit: 2, highlighted_limit: 1, cards: [] },
      shop: { count: 0, limit: 2, highlighted_limit: 1, cards: [] },
    };
  };
  const err = (name, message) => ({ error: { code: { BAD_REQUEST: -32001, INVALID_STATE: -32002, NOT_ALLOWED: -32003 }[name] ?? -32000, message, data: { name } } });
  const need = (...states) => (states.includes(st.state) ? null : err("INVALID_STATE", `requires ${states.join(" or ")}, the game is in ${st.state}`));
  const handlers = {
    health: () => ({ status: "ok" }),
    gamestate: () => view(),
    start: (p) => need("MENU") ?? (!p?.deck || !p?.stake ? err("BAD_REQUEST", "deck and stake are required") : (Object.assign(st, { state: "BLIND_SELECT", ante: 1, round: 0, blind: 0, chips: 0, hands, won: false, deck: p.deck, stake: p.stake, seed: p.seed ?? `RND${st.calls.filter((c) => c.method === "start").length - 1}` }), view())),
    menu: () => (Object.assign(st, { state: "MENU" }), view()),
    select: () => need("BLIND_SELECT") ?? (Object.assign(st, { state: "SELECTING_HAND", round: st.round + 1, chips: 0, hands }), view()),
    skip: () => need("BLIND_SELECT") ?? (st.blind === 2 ? err("NOT_ALLOWED", "the boss blind cannot be skipped") : (st.blind += 1, view())),
    play: (p) => {
      const bad = need("SELECTING_HAND"); if (bad) return bad;
      const n = p?.cards?.length ?? 0; if (n < 1 || n > 5) return err("BAD_REQUEST", "play 1 to 5 cards");
      st.chips += n * chipsPerCard; st.hands -= 1;
      if (st.chips >= blindScore * (st.blind + 1)) {
        st.state = "ROUND_EVAL";
        if (st.blind === 2) { if (st.ante >= winAnte) st.won = true; st.ante += 1; st.blind = 0; } else st.blind += 1;
      } else if (st.hands <= 0) st.state = "GAME_OVER";
      return view();
    },
    discard: (p) => need("SELECTING_HAND") ?? (p?.cards?.length ? view() : err("BAD_REQUEST", "no cards")),
    cash_out: () => need("ROUND_EVAL") ?? (st.money += 5, st.state = "SHOP", view()),
    next_round: () => need("SHOP") ?? (st.state = "BLIND_SELECT", view()),
    reroll: () => need("SHOP") ?? view(),
    buy: () => need("SHOP") ?? err("NOT_ALLOWED", "nothing to buy"),
    sell: () => err("NOT_ALLOWED", "nothing to sell"),
    pack: () => need("SMODS_BOOSTER_OPENED"),
    use: () => err("NOT_ALLOWED", "no consumables"),
    rearrange: () => view(),
    set: (p) => { if (p?.money !== undefined) st.money = p.money; return view(); },
    add: () => view(),
    save: (p) => (writeFileSync(p.path, JSON.stringify({ ...st, calls: undefined })), { success: true, path: p.path }),
    load: (p) => { restore(p.path); return { success: true, path: p.path }; },
    screenshot: (p) => (writeFileSync(p.path, Buffer.from(PNG1x1, "base64")), { success: true, path: p.path }),
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      st.calls.push({ method: body.method, params: body.params ?? null });
      const h = handlers[body.method];
      const out = h ? h(body.params) : err("BAD_REQUEST", `unknown method ${body.method}`);
      if (h && !["health", "gamestate", "screenshot", "save"].includes(body.method)) persist();
      const msg = out && typeof out === "object" && "error" in out && out.error?.data ? { jsonrpc: "2.0", id: body.id, error: out.error } : { jsonrpc: "2.0", id: body.id, result: out };
      const text = JSON.stringify(msg);
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text), Connection: "close" });
      res.end(text);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, state: st, close: () => new Promise((r) => server.close(() => r())) };
}
