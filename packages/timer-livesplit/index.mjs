// Timer plugin for LiveSplit through the LiveSplit Server component
// (TCP, default 127.0.0.1:16834, one command per line). LiveSplit shows RTA
// and Game Time on screen, which the recorder captures, and keeps the splits.
//
// Mapping of run events (paused-think model: game time advances only by what a
// playback played). Game time runs while the game plays and stands still while
// the agent thinks. The timer hears a playback's start and end through the run
// log, read every half second, so it does not wait for the end to stop the
// clock: a playback that says how long it plays (`seconds`, `planned_ticks`)
// runs game time from the moment in its start event, and the timer pauses it
// itself at the planned end, on the exact value. LiveSplit's clock can then not
// run on past a playback and be put back at its end (2026-10-03, seen by the
// owner), and does not stand still while the game plays and jump at the end
// (2026-10-08, seen by the owner). A playback that does not say how long it
// plays (Slay the Spire's and Balatro's commands) moves game time at its end.
//   run.started            starttimer, initgametime, pausegametime
//   game.playback start    setgametime <IGT so far + time already played>, unpausegametime; pausegametime and
//                          setgametime <IGT + planned> at the planned end
//   game.playback end      pausegametime, setgametime <IGT from ticks>
//   game.milestone chapter split
//   game.over victory      pause (the goal is reached; the milestone before it did the final split)
//   game.over defeat       nothing yet (the death screen is still the dead run)
//   game.attempt start     reset, initgametime, starttimer, pausegametime, setgametime 0: the next run is its own LiveSplit attempt
//                          with its own splits; the session total (all runs) is in the overlay and the timeline
//   run.human              (no LiveSplit command; recorded in the log)
//   run.ended              pause, unless game.over already stopped the timer (a stopped session completes no segment either)
//
// Options / env: host, port (AAS_LIVESPLIT_HOST / AAS_LIVESPLIT_PORT).
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setup, setupRows } from "./setup.mjs";
import { playbackSeconds } from "../core/src/igt.mjs";

/** How long a playback plays, from its start event: `seconds`, or `planned_ticks` at 15 ms a tick (Portal); 0 when it does not say. */
export function plannedSeconds(data) {
  if (typeof data?.seconds === "number" && Number.isFinite(data.seconds) && data.seconds > 0) return data.seconds;
  if (typeof data?.planned_ticks === "number" && Number.isFinite(data.planned_ticks) && data.planned_ticks > 0) return Math.round(data.planned_ticks * 15) / 1000;
  return 0;
}

export function connectLiveSplit({ host = "127.0.0.1", port = 16834 } = {}, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out connecting to LiveSplit Server at ${host}:${port}. Start LiveSplit, right-click → Control → Start Server.`));
    }, timeoutMs);
    socket.setEncoding("utf8");
    let buffer = "";
    const waiters = [];
    socket.on("data", (d) => {
      buffer += d;
      let at;
      while ((at = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, at).replace(/\r$/, "");
        buffer = buffer.slice(at + 1);
        waiters.shift()?.(line);
      }
    });
    socket.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve({
        send(command) {
          socket.write(`${command}\r\n`);
        },
        query(command, ms = 2000) {
          return new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error(`LiveSplit did not answer ${command}`)), ms);
            waiters.push((line) => {
              clearTimeout(t);
              res(line);
            });
            socket.write(`${command}\r\n`);
          });
        },
        close() {
          socket.end();
          socket.destroy();
        },
      });
    });
  });
}

const lsTime = (seconds) => {
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${s.toFixed(7).padStart(10, "0")}`;
};

/** How late the end of a command can be heard: the session reads the run log every tenth of a second. */
const HEARD_WITHIN = 0.15;
/**
 * The smallest step back that LiveSplit cannot show: it shows hundredths. A timer that pauses itself at a planned end
 * fires a few milliseconds late, so LiveSplit stands at 0.3002 where the exact value is 0.300; setting that is no step
 * anyone sees, while refusing it left LiveSplit a hair too high (measured in the timer test, 1 run in 4).
 */
const UNSEEN = 0.01;

export function createLiveSplitTimer(options = {}) {
  const host = options.host ?? process.env.AAS_LIVESPLIT_HOST ?? "127.0.0.1";
  const port = Number(options.port ?? process.env.AAS_LIVESPLIT_PORT ?? 16834);
  let ls = null;
  let igt = 0;
  let playing = null;
  const stopPlaying = () => { if (playing) { clearTimeout(playing); playing = null; } };
  // What LiveSplit's game time shows, as the timer set it: a value, and since when it runs from it (null: paused).
  // LiveSplit is never told a value below this, so its game time does not go back.
  let shown = { value: 0, since: null };
  const showing = () => (shown.since == null ? shown.value : shown.value + (Date.now() - shown.since) / 1000);
  let over = false;
  const sent = [];
  // What LiveSplit did not do as asked (its timer not running after the start, a split that did not move on): kept
  // with the timer's result in recording.json. Measured 2026-09-23: a run whose LiveSplit never started its timer
  // went on for 8 minutes with nothing on screen and nothing in any log.
  const problems = [];
  // LiveSplit's own windows when a start fails: a dialog in front of it is the first thing to rule out.
  const windows = options.windows ?? (async () => (await import("../core/src/close-windows.mjs")).windowTitles("LiveSplit"));
  const send = (c) => {
    sent.push(c);
    ls?.send(c);
  };
  const phase = async () => { try { return await ls.query("getcurrenttimerphase"); } catch { return null; } };
  const startCommands = (from) => { send("reset"); send("initgametime"); send("starttimer"); send("pausegametime"); send(`setgametime ${from.toFixed(3)}`); shown = { value: from, since: null }; };
  const setGame = (v) => { send(`setgametime ${v.toFixed(3)}`); shown = { value: v, since: shown.since == null ? null : Date.now() }; };
  const runGame = () => { send("unpausegametime"); shown = { value: showing(), since: Date.now() }; };
  const pauseGame = () => { send("pausegametime"); shown = { value: showing(), since: null }; };
  return {
    processName: "LiveSplit",
    name: "LiveSplit",
    launch: path.join(path.dirname(fileURLToPath(import.meta.url)), "launch-livesplit.mjs"),
    setup,
    /** Read-only checks for `aas doctor`: LiveSplit set up (setup.mjs), then its server reachable (`when: "run"`). */
    async doctor() {
      const rows = await setupRows();
      const r = await new Promise((res) => { const s = net.connect(port, host); s.setTimeout(2500); s.on("connect", () => (s.destroy(), res("open"))); s.on("error", (e) => (s.destroy(), res(e.code ?? "error"))); s.on("timeout", () => (s.destroy(), res("timeout"))); });
      rows.push({ ok: r === "open", what: `LiveSplit Server ${host}:${port}`, detail: r === "open" ? "reachable" : `${r} (start LiveSplit; Control → Start Server, or ServerStartup=1 in settings.cfg)`, when: "run" });
      return rows;
    },
    /** Closes LiveSplit the way a user would, answering "Save Splits?" with No. */
    async close() {
      const { closeWindows } = await import("../core/src/close-windows.mjs");
      return closeWindows([{ name: "LiveSplit", title: "LiveSplit", seconds: 15, dialogTitle: "Save Splits?", dialogButton: "&No" }], { report: ["LiveSplit"] });
    },
    id: "livesplit",
    version: "1.0.5",
    sent,
    async preflight() {
      const probe = await connectLiveSplit({ host, port });
      probe.close();
    },
    // `igt` (seconds) continues a resumed run from the in-game time reached before the save.
    async start(brief, { igt: startIgt = 0 } = {}) {
      ls = await connectLiveSplit({ host, port });
      igt = Number(startIgt) || 0;
      over = false;
      startCommands(igt);
      // LiveSplit answers on its server when it runs; the timer's phase says whether it took the start.
      let got = await phase();
      if (got !== "Running") {
        problems.push({ at: new Date().toISOString(), what: `after the start LiveSplit's timer was ${got ?? "not answering"}; connected again and started again`, windows: await windows() });
        ls.close();
        ls = await connectLiveSplit({ host, port });
        startCommands(igt);
        got = await phase();
      }
      if (got !== "Running") { ls.close(); ls = null; throw new Error(`LiveSplit did not start its timer (phase ${got ?? "no answer"}; LiveSplit's windows: ${(await windows()).join(", ") || "none"}): the run does not start without its timer on screen`); }
    },
    async onEvent(event) {
      switch (event.event) {
        case "game.playback":
          if (event.data?.phase === "start") {
            // Game time runs during every command and stands still while the agent thinks (timing paused-think). A
            // command that says how long it plays (Portal's ticks, an emulator's seconds) is stopped by the timer at
            // its planned end. One that does not (Balatro, Slay the Spire) runs behind the command by as long as its end
            // can take to be heard — the session reads the run log every tenth of a second — so LiveSplit has not passed
            // the end when it hears it, and only moves forward to the exact value. For those games a command's game time
            // is its real time (measured: Balatro 28 of 28 commands, Slay the Spire 295 and 267, equal to the thousandth).
            // From 2026-10-03 to 1.0.5 such a command left game time standing still until its end, for up to six seconds,
            // and then it jumped (the owner, 2026-10-16); before that it ran ahead and was put back.
            const planned = plannedSeconds(event.data);
            const startedAt = Date.parse(event.timestamp ?? "");
            const since = Number.isFinite(startedAt) ? Math.max(0, (Date.now() - startedAt) / 1000) : 0;
            stopPlaying();
            const finish = planned > 0 ? igt + planned : Infinity;
            const now = igt + since - (planned > 0 ? 0 : HEARD_WITHIN);
            const from = Math.max(now, igt, showing());
            if (from < finish) {
              setGame(from);
              const pauseAtFinish = () => {
                if (!Number.isFinite(finish)) return;
                playing = setTimeout(() => { playing = null; pauseGame(); if (finish >= showing() - UNSEEN) setGame(finish); }, (finish - from) * 1000);
                playing.unref?.();
              };
              // Never below what LiveSplit shows: when it already shows more, it waits until game time reaches it.
              const wait = from - now;
              if (wait > 0) {
                playing = setTimeout(() => { playing = null; runGame(); pauseAtFinish(); }, wait * 1000);
                playing.unref?.();
              } else { runGame(); pauseAtFinish(); }
            }
          }
          if (event.data?.phase === "end") {
            stopPlaying();
            pauseGame();
            igt += playbackSeconds(event.data);
            // Only forward. Should the end have been heard later than the command ran behind, LiveSplit keeps the value
            // it shows and the next command waits until game time reaches it; the published times come from the
            // timeline, not from LiveSplit, and are exact either way.
            if (igt >= showing() - UNSEEN) setGame(igt);
          }
          break;
        case "game.milestone":
          if (event.data?.chapter) {
            const before = Number(await ls?.query("getsplitindex").catch(() => NaN));
            send("split");
            const after = Number(await ls?.query("getsplitindex").catch(() => NaN));
            if (!(after === before + 1 || (after === -1 && before >= 0))) problems.push({ at: new Date().toISOString(), what: `split for ${event.data?.label ?? "a milestone"}: LiveSplit's split index went from ${before} to ${after}` });
          }
          break;
        case "game.over":
          if (event.data?.victory) { stopPlaying(); over = true; send("pause"); }
          break;
        case "game.attempt":
          if (event.data?.phase === "start") { stopPlaying(); igt = 0; send("reset"); send("initgametime"); send("starttimer"); send("pausegametime"); send("setgametime 0.000"); }
          break;
        case "run.ended":
          stopPlaying();
          if (!over) send("pause");
          break;
        default:
      }
    },
    async stop() {
      stopPlaying();
      let times = null;
      if (ls) {
        try {
          times = { real: await ls.query("getcurrenttime"), game: await ls.query("getcurrentgametime") };
        } catch {
          // older LiveSplit Server versions answer only getcurrenttime
        }
        ls.close();
        ls = null;
      }
      return { igt, times, problems };
    },
  };
}

/** An empty LiveSplit splits file (.lss) with the given segment names, to load before a run. */
export function renderSplitsTemplate({ game, category, segments }) {
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const seg = segments.map((name) => `    <Segment>
      <Name>${esc(name)}</Name>
      <Icon />
      <SplitTimes>
        <SplitTime name="Personal Best" />
      </SplitTimes>
      <BestSegmentTime />
      <SegmentHistory />
    </Segment>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Run version="1.7.0">
  <GameIcon />
  <GameName>${esc(game)}</GameName>
  <CategoryName>${esc(category)}</CategoryName>
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
${seg.join("\n")}
  </Segments>
  <AutoSplitterSettings />
</Run>
`;
}

/** A LiveSplit splits file (.lss) from an `aas timeline` result, for publication. */
export function renderLss(timeline, { game = "Portal", category = "AI Assisted Speedrun", attemptId = 1 } = {}) {
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const started = new Date(timeline.t0);
  const fmt = (d) => `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  // A completed run splits up to its completion; post-completion sections (credits, an unpublished goal extension) are not splits.
  const sections = timeline.sections.filter((s) => !s.post_completion);
  const ended = new Date(started.getTime() + (timeline.totals_to_completion?.rta ?? timeline.totals.rta) * 1000);
  const segments = sections.map((s, i) => {
    // A split is named after what ends it: the next section in the whole timeline (the goal's milestone at completion).
    const next = timeline.sections[timeline.sections.indexOf(s) + 1];
    const name = next ? next.label : "End";
    return `    <Segment>
      <Name>${esc(name)}</Name>
      <Icon />
      <SplitTimes>
        <SplitTime name="Personal Best">
          <RealTime>${lsTime(s.end_rta)}</RealTime>
          <GameTime>${lsTime(s.split_igt)}</GameTime>
        </SplitTime>
      </SplitTimes>
      <BestSegmentTime>
        <RealTime>${lsTime(s.rta)}</RealTime>
        <GameTime>${lsTime(s.igt)}</GameTime>
      </BestSegmentTime>
      <SegmentHistory>
        <Time id="${attemptId}">
          <RealTime>${lsTime(s.rta)}</RealTime>
          <GameTime>${lsTime(s.igt)}</GameTime>
        </Time>
      </SegmentHistory>
    </Segment>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<Run version="1.7.0">
  <GameIcon />
  <GameName>${esc(game)}</GameName>
  <CategoryName>${esc(category)}</CategoryName>
  <Metadata>
    <Run id="" />
    <Platform usesEmulator="False">PC</Platform>
    <Region />
    <Variables />
  </Metadata>
  <Offset>00:00:00</Offset>
  <AttemptCount>${attemptId}</AttemptCount>
  <AttemptHistory>
    <Attempt id="${attemptId}" started="${fmt(started)}" isStartedSynced="True" ended="${fmt(ended)}" isEndedSynced="True">
      <RealTime>${lsTime(timeline.totals.rta)}</RealTime>
      <GameTime>${lsTime(timeline.totals.igt)}</GameTime>
    </Attempt>
  </AttemptHistory>
  <Segments>
${segments.join("\n")}
  </Segments>
  <AutoSplitterSettings />
</Run>
`;
}

export function writeLss(runDir, timeline, options) {
  const file = path.join(runDir, "timeline", "splits.lss");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, renderLss(timeline, options));
  return file;
}

export default createLiveSplitTimer();
