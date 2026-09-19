#!/usr/bin/env node
// Scores SeedSearch output (ForgottenArbiter's mod, verbose) against the AI-seed criteria in
// seed-criteria.md and prints the candidates, best first, with the seed code the game uses.
//   node games/slay-the-spire/seed-pick.mjs <seedsearch.log> [--top 20] [--json]
import fs from "node:fs";
import { seedString } from "./plugin.mjs";
import { loadSettings } from "../../packages/core/src/settings.mjs";

// This game's own settings, then the machine's: the same two files every command reads (settings.mjs).
loadSettings(import.meta.url);

export const GOOD_CARDS = ["Pommel Strike", "Shrug It Off", "Iron Wave", "Cleave", "Thunderclap", "Uppercut", "Carnage", "Inflame", "Battle Trance", "Feel No Pain", "Whirlwind", "Immolate", "Bludgeon"];
export const GOOD_RELICS = ["Bag of Marbles", "Vajra", "Anchor", "Red Skull", "Bronze Scales", "Oddly Smooth Stone", "Blood Vial", "Lantern", "Orichalcum"];
const LAMENT = /next three combats have 1 HP/i;

const list = (s) => s.replace(/^\[|\]$/g, "").split(",").map((x) => x.trim()).filter(Boolean);
/** Parse the verbose log into one record per seed. */
export function parseSeedSearch(text) {
  const blocks = text.replace(/\r\n?/g, "\n").split(/^Seed: /m).slice(1);
  return blocks.map((b) => {
    const lines = b.split("\n");
    // Header: "Seed: 2PL (3.311)": the game's seed code, then the number with the JVM locale's thousands separators.
    const m = /^(\S*)\s*\((-?[\d.,\s]+)\)/.exec(lines[0]);
    const seed = m ? m[2].replace(/[^\d-]/g, "") : lines[0].trim();
    const printedCode = m ? m[1] : "";
    if (printedCode && seedString(seed) !== printedCode) console.error(`seed code mismatch for ${seed}: printed ${printedCode}, computed ${seedString(seed)}`);
    // A section runs from its header line ("Bosses:", "22 combats (1 elite(s)):") to the next header (a line ending in ":" that is not a floor line).
    const isHeader = (l) => /:$/.test(l) && !/^Floor \d+:/.test(l) && !l.startsWith("[");
    const section = (name) => { const i = lines.findIndex((l) => l.startsWith(name)); if (i === -1) return []; const out = []; for (const l of lines.slice(i + 1)) { if (isHeader(l) || l.startsWith("#####")) break; if (l.trim()) out.push(l.trim()); } return out; };
    const neow = section("Neow Options:").map((l) => l.replace(/^\[\s*|\s*\]$/g, ""));
    const bosses = list(section("Bosses:")[0] ?? "");
    const combats = list((lines.find((l) => /^\d+ combats/.test(l)) ? section(lines.find((l) => /^\d+ combats/.test(l)))[0] : "") ?? "");
    const elites = Number(/\((\d+) elite/.exec(lines.find((l) => /^\d+ combats/.test(l)) ?? "")?.[1] ?? 0);
    const relics = list(section(lines.find((l) => /^\d+ relics:/.test(l)) ?? "x")[0] ?? "");
    const shopRelics = list(section("Shop relics:")[0] ?? "");
    const path = list((section("True map path:")[0] ?? section("Map path:")[0] ?? "")).map((x) => x.split("/")[0]);
    const cards = {};
    for (const l of section("Card choices:")) { const cm = /^Floor (\d+): \[(.*)\]$/.exec(l); if (cm) cards[Number(cm[1])] = list(`[${cm[2]}]`); }
    const events = list(section("Events:")[0] ?? "");
    return { seed, code: seedString(seed), neow, bosses, combats, elites, relics, shopRelics, path, cards, events };
  });
}
/** Criteria 2 to 6: each a pass/fail with a note; score = passes, ties by fewer early elites. */
export function scoreSeed(r) {
  const act1 = r.path.slice(0, 15); // floors 1..15, index 14 = the floor before the boss
  const earlyElites = act1.slice(0, 8).filter((x) => x === "E").length; // before floor 9
  const checks = {
    lament: r.neow.some((n) => LAMENT.test(n)),
    noFloor6Elite: act1[5] !== "E",
    fewEarlyElites: earlyElites <= 1,
    restBeforeBoss: act1[14] === "R",
    shopBeforeFloor10: act1.slice(0, 9).includes("$") || act1.slice(0, 9).includes("S"),
    goodEarlyCard: Object.entries(r.cards).filter(([f]) => Number(f) <= 6).slice(0, 3).some(([, c]) => c.some((x) => GOOD_CARDS.includes(x))),
    goodAct1Relic: [...r.relics, ...r.shopRelics.slice(0, 3)].some((x) => GOOD_RELICS.includes(x)),
    act3NotTimeEater: r.bosses[2] !== "Time Eater",
    act2NotChamp: r.bosses[1] !== "Champ",
  };
  const passes = Object.values(checks).filter(Boolean).length;
  // Tie-breaker among seeds that pass: more plain good cards in the first three rewards, more plain relics in act 1,
  // more rest sites in act 1, and the easier act 1 bosses for a starter deck (Slime Boss, The Guardian).
  const early = Object.entries(r.cards).filter(([f]) => Number(f) <= 8).slice(0, 3).flatMap(([, c]) => c);
  const bonus = early.filter((x) => GOOD_CARDS.includes(x)).length + [...r.relics, ...r.shopRelics.slice(0, 3)].filter((x) => GOOD_RELICS.includes(x)).length + act1.filter((x) => x === "R").length * 0.5 + (["Slime Boss", "The Guardian"].includes(r.bosses[0]) ? 1 : 0);
  return { checks, passes, earlyElites, bonus };
}
if (process.argv[1]?.endsWith("seed-pick.mjs")) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) throw new Error("usage: seed-pick.mjs <seedsearch.log> [--top N] [--json]");
  const top = Number(args[args.indexOf("--top") + 1]) || 20;
  const records = parseSeedSearch(fs.readFileSync(file, "utf8")).map((r) => ({ ...r, ...scoreSeed(r) }));
  records.sort((a, b) => b.passes - a.passes || a.earlyElites - b.earlyElites || b.bonus - a.bonus);
  const total = Object.keys(records[0]?.checks ?? {}).length;
  console.log(`${records.length} seeds in ${file}; ${records.filter((r) => r.passes === total).length} pass all ${total} checks`);
  if (args.includes("--json")) { console.log(JSON.stringify(records.slice(0, top), null, 1)); }
  else for (const r of records.slice(0, top)) {
    const failed = Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => k);
    console.log(`${String(r.passes).padStart(2)}/${total} +${r.bonus.toFixed(1).padStart(4)}  ${r.code.padEnd(14)} (${r.seed})  bosses ${r.bosses.join(" / ")}  act1 ${r.path.slice(0, 15).join("")}  neow: ${r.neow.map((n) => n.slice(0, 28)).join(" | ")}${failed.length ? `  FAIL ${failed.join(",")}` : ""}`);
    console.log(`        cards ${Object.entries(r.cards).slice(0, 3).map(([f, c]) => `f${f}: ${c.join(", ")}`).join("; ")}; relics ${r.relics.slice(1).join(", ")}`);
  }
}
