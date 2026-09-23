#!/usr/bin/env node
// A LiveSplit splits file per end of every profile, so a run shows its own splits on screen from the first frame.
//
//   node games/bizhawk/make-splits.mjs [--write]
//
// Not written by hand: the segments of a file are the profile's ends up to and including that end, named by their
// `split`, the same names the plugin's milestones carry. Without --write it says what it would write.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderSplitsTemplate } from "../../packages/timer-livesplit/index.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const profiles = fs.readdirSync(path.join(here, "profiles")).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(here, "profiles", f), "utf8")));

/** Every splits file: { file, content } per end of every profile. */
export function splitsFiles() {
  const out = [];
  for (const p of profiles) {
    p.ends.forEach((end, i) => {
      const segments = p.ends.slice(0, i + 1).map((e) => e.split ?? e.label);
      out.push({ file: path.join(here, "splits", `${p.id}-${end.id}.lss`), content: renderSplitsTemplate({ game: p.name, category: `AI Assisted Speedrun (${end.id})`, segments }) });
    });
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const write = process.argv.includes("--write");
  for (const s of splitsFiles()) {
    if (write) { fs.mkdirSync(path.dirname(s.file), { recursive: true }); fs.writeFileSync(s.file, s.content); }
    console.log(`${write ? "wrote" : "would write"} ${path.relative(process.cwd(), s.file)}`);
  }
}
