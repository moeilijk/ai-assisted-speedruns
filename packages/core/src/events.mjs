// Append harness events to <run>/run.jsonl and follow the file for events
// written by the broker (game plugins) so the recorder can react to them.
import fs from "node:fs";
import path from "node:path";
import { defaultTimeZone, localTimestamp } from "./timestamp.mjs";

export function createEventLog(runDir, { source = "harness", timeZone = defaultTimeZone() } = {}) {
  const file = path.join(runDir, "run.jsonl");
  return {
    file,
    append(event, data = {}) {
      const record = { timestamp: localTimestamp(Date.now(), timeZone), source, kind: "event", event, data };
      fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
      return record;
    },
  };
}

/** Poll run.jsonl for new `event` records and hand them to `onEvent`. */
export function followEvents(runDir, onEvent, { intervalMs = 500, onRecord = null } = {}) {
  const file = path.join(runDir, "run.jsonl");
  let offset = fs.existsSync(file) ? fs.statSync(file).size : 0;
  let rest = "";
  const inflight = new Set();
  const tick = () => {
    if (!fs.existsSync(file)) return;
    const size = fs.statSync(file).size;
    if (size <= offset) return;
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    offset = size;
    rest += buf.toString("utf8");
    let at;
    while ((at = rest.indexOf("\n")) !== -1) {
      const line = rest.slice(0, at);
      rest = rest.slice(at + 1);
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        onRecord?.(r);
        if (r.kind === "event") {
          const p = Promise.resolve(onEvent(r)).catch(() => {}).finally(() => inflight.delete(p));
          inflight.add(p);
        }
      } catch {
        // partial or bad line
      }
    }
  };
  const timer = setInterval(tick, intervalMs);
  return {
    /**
     * Reads what is in the file now and waits for the handlers, twice: a handler may append an event of its own (the
     * harness declares a victory as a game.over), and that one has to be read too before an outcome is decided.
     */
    async flush() {
      for (let i = 0; i < 2; i += 1) { tick(); await Promise.all([...inflight]); }
    },
    /** Stop polling; reads the remainder of the file and waits for the handlers. */
    async stop() {
      clearInterval(timer);
      tick();
      await Promise.all([...inflight]);
    },
  };
}

/**
 * Handlers in the log's order: `followEvents` hands over every event as it reads it, without waiting for the previous
 * one's handlers, and a handler that waits on something (the recorder's chapter mark in OBS, the timer's split index)
 * lets the next event overtake it. Measured 2026-09-24 (FCEUX mocks smb-mock-01, nes15-mock-01/02): the game.over
 * right after the last milestone had its pause in LiveSplit before the milestone's split, and LiveSplit refused the
 * split. Returns a function that runs its argument after everything queued before it.
 */
export function inOrder() {
  let chain = Promise.resolve();
  return (fn) => {
    const p = chain.then(fn);
    chain = p.catch(() => {});
    return p;
  };
}

export function readRunLog(runDir) {
  const file = path.join(runDir, "run.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}
