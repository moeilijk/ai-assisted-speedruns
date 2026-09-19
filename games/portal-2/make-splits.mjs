#!/usr/bin/env node
// A LiveSplit splits file per end of the campaign, so a run shows its own splits on screen from the first tick.
//
//   node games/portal-2/make-splits.mjs [--write]
//
// Not written by hand: the ends come from maps.json (SAR's own table, extract-maps.mjs), and the segments of a
// file are the maps before that end — entering a map closes the one before it, the same way Portal's splits work.
// Without --write it says what it would write and changes nothing.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENDS, SEGMENTS } from "./plugin.mjs";
import { MAPS } from "./maps.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** An empty .lss (LiveSplit 1.7.0): a name per segment and no times, which is what a run starts from. */
export function renderEmptyLss(category, segments) {
  const body = segments.map((name) => `    <Segment>
      <Name>${esc(name)}</Name>
      <Icon />
      <SplitTimes>
        <SplitTime name="Personal Best" />
      </SplitTimes>
      <BestSegmentTime />
      <SegmentHistory />
    </Segment>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<Run version="1.7.0">
  <GameIcon />
  <GameName>Portal 2</GameName>
  <CategoryName>AI Assisted Speedrun (${esc(category)})</CategoryName>
  <Metadata>
    <Run id="" />
    <Platform usesEmulator="False">PC</Platform>
    <Region />
    <Variables />
  </Metadata>
  <Offset>00:00:00</Offset>
  <AttemptCount>0</AttemptCount>
  <AttemptHistory />
  <Segments>
${body}
  </Segments>
  <AutoSplitterSettings />
</Run>
`;
}

/** The segments of a run that aims at `end`: every map up to it, because entering a map closes the one before. */
export function segmentsFor(endId) {
  const index = endId === "credits" ? MAPS.length - 1 : MAPS.findIndex((m) => m.map === endId);
  if (index < 0) throw new Error(`${endId} is not one of the campaign's ends`);
  return SEGMENTS.slice(0, index);
}

export function makeSplits({ write = false, log = console.log } = {}) {
  const dir = path.join(here, "splits");
  if (write) fs.mkdirSync(dir, { recursive: true });
  const written = [];
  for (const end of ENDS) {
    const file = path.join(dir, `portal2-${end.id}.lss`);
    const text = renderEmptyLss(end.id, segmentsFor(end.id));
    if (write) fs.writeFileSync(file, text);
    written.push(file);
  }
  log(`${written.length} splits files for ${ENDS.length} ends${write ? ` in ${dir}` : " (dry run; pass --write)"}`);
  return written;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) makeSplits({ write: process.argv.includes("--write") });
