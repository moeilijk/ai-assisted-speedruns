// A fake Slay the Spire behind the bridge protocol: main menu -> START -> a few
// one-monster fights per act, PROCEED to the next floor, act change after
// `floorsPerAct`, victory after act `acts`. Enough to drive the plugin and the
// harness end to end without the game. PNG 1x1 for screenshots.
import net from "node:net";

const PNG1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

export async function startFakeSts({ floorsPerAct = 2, acts = 3, monsterHp = 10, cardDamage = 6, delayMs = 20 } = {}) {
  const st = { inGame: false, floor: 0, act: 1, hp: 80, monsterHp: 0, phase: "MAIN_MENU", over: false, victory: false, seed: "AAS-FAKE", cls: null, ascension: 0, commands: [] };
  const state = () => {
    if (!st.inGame) return { available_commands: ["start", "state"], ready_for_command: true, in_game: false };
    const g = { screen_type: st.phase === "COMBAT" ? "NONE" : st.phase, screen_state: st.over ? { victory: st.victory, score: 100 } : {}, seed: st.seed, class: st.cls, ascension_level: st.ascension, floor: st.floor, act: st.act, act_boss: "Fake Boss", current_hp: st.hp, max_hp: 80, gold: 99, deck: [{ id: "Strike_R", name: "Strike" }], relics: [], potions: [], map: [], choice_list: [], room_phase: st.phase === "COMBAT" ? "COMBAT" : st.over ? "COMPLETE" : "COMPLETE" };
    const cmds = st.over ? ["proceed", "state"] : st.phase === "COMBAT" ? ["play", "end", "state"] : st.phase === "EVENT" ? ["choose", "state"] : ["proceed", "state"];
    if (st.phase === "EVENT") { g.screen_state = { event_name: "Secret Portal", event_id: "SecretPortal", options: [{ text: "Enter the portal. Skip to the boss.", label: "Enter", disabled: false, choice_index: 0 }, { text: "Leave.", label: "Leave", disabled: false, choice_index: 1 }] }; g.choice_list = ["enter", "leave"]; }
    if (st.phase === "COMBAT") g.combat_state = { turn: 1, hand: [{ id: "Strike_R", name: "Strike", cost: 1, is_playable: true, has_target: true }], draw_pile: [], discard_pile: [], exhaust_pile: [], player: { energy: 3, block: 0, current_hp: st.hp, max_hp: 80, powers: [] }, monsters: [{ name: "Fake Cultist", current_hp: st.monsterHp, max_hp: monsterHp, block: 0, intent: "ATTACK", move_adjusted_damage: 6, move_hits: 1, is_gone: false, powers: [] }] };
    return { available_commands: cmds, ready_for_command: true, in_game: true, game_state: g };
  };
  const nextFloor = () => { st.floor += 1; if (st.floor > st.act * floorsPerAct) { if (st.act >= acts) { st.over = true; st.victory = true; st.phase = "GAME_OVER"; return; } st.act += 1; } st.phase = "COMBAT"; st.monsterHp = monsterHp; };
  const handle = (line) => {
    const [cmd, ...args] = line.trim().split(/\s+/);
    st.commands.push(line.trim());
    const c = cmd.toUpperCase();
    if (c === "STATE") return state();
    if (!st.inGame) {
      if (c !== "START") return { error: `Invalid command "${cmd}" at the main menu`, ready_for_command: true };
      st.inGame = true; st.cls = (args[0] ?? "IRONCLAD").toUpperCase(); st.ascension = Number(args[1] ?? 0); if (args[2]) st.seed = args[2]; st.floor = 0; st.act = 1; st.hp = 80; st.over = false; st.victory = false; nextFloor();
      return state();
    }
    if (st.over) { if (c === "PROCEED" || c === "CONFIRM") { st.inGame = false; st.over = false; st.floor = 0; return state(); } return { error: "The run is over", ready_for_command: true }; }
    if (st.phase === "COMBAT") {
      if (c === "PLAY") { st.monsterHp = Math.max(0, st.monsterHp - cardDamage); if (st.monsterHp === 0) st.phase = "COMBAT_REWARD"; return state(); }
      if (c === "END") { st.hp -= 6; if (st.hp <= 0) { st.over = true; st.victory = false; st.phase = "GAME_OVER"; } return state(); }
      return { error: `Invalid command "${cmd}" in combat`, ready_for_command: true };
    }
    if (st.phase === "EVENT" && c === "CHOOSE") { const pick = (args[0] ?? "").toLowerCase(); if (pick === "0" || pick === "enter") { st.floor = st.act * floorsPerAct; } st.phase = "COMBAT_REWARD"; return state(); }
    if (c === "PROCEED" || c === "CONFIRM") { nextFloor(); return state(); }
    return { error: `Invalid command "${cmd}"`, ready_for_command: true };
  };
  const server = net.createServer((sock) => {
    sock.setEncoding("utf8");
    let buf = "";
    sock.write(`${JSON.stringify(state())}\n`);
    sock.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        if (line.startsWith('{"aas":')) {
          const req = JSON.parse(line);
          if (req.aas === "screenshot") sock.write(`${JSON.stringify({ aas: "screenshot", png: PNG1x1, width: 1 })}\n`);
          else if (req.aas === "click") { if (st.over) { st.inGame = false; st.over = false; st.floor = 0; } else if (!st.inGame && st.floor > 0) { st.inGame = true; st.phase = st.monsterHp > 0 ? "COMBAT" : "COMBAT_REWARD"; } sock.write(`${JSON.stringify({ aas: "click", ok: true })}\n`); setTimeout(() => { if (!sock.destroyed) sock.write(`${JSON.stringify(state())}\n`); }, delayMs); }
          else if (req.aas === "state") sock.write(`${JSON.stringify({ aas: "state", state: state() })}\n`);
          continue;
        }
        setTimeout(() => { if (!sock.destroyed) sock.write(`${JSON.stringify(handle(line))}\n`); }, delayMs);
      }
    });
    sock.on("error", () => {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, state: st, /** simulate closing and reopening the game: back to the main menu with the run saved */ toMenu() { st.inGame = false; }, /** put the run on the Secret Portal event screen */ portal() { st.phase = "EVENT"; }, close: () => new Promise((r) => server.close(() => r())) };
}
