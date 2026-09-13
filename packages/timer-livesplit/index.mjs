// Timer plugin for LiveSplit through the LiveSplit Server component
// (TCP, default 127.0.0.1:16834, one command per line). LiveSplit shows RTA
// and Game Time on screen, which the recorder captures, and keeps the splits.
//
// Mapping of run events (paused-think model: game time advances only while
// a playback runs):
//   run.started            starttimer, initgametime, pausegametime
//   game.playback start    unpausegametime
//   game.playback end      setgametime <IGT from ticks>, pausegametime
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

export function createLiveSplitTimer(options = {}) {
  const host = options.host ?? process.env.AAS_LIVESPLIT_HOST ?? "127.0.0.1";
  const port = Number(options.port ?? process.env.AAS_LIVESPLIT_PORT ?? 16834);
  let ls = null;
  let igt = 0;
  let over = false;
  const sent = [];
  const send = (c) => {
    sent.push(c);
    ls?.send(c);
  };
  return {
    processName: "LiveSplit",
    /** Read-only check for `aas doctor`: the LiveSplit Server reachable. */
    async doctor() {
      const r = await new Promise((res) => { const s = net.connect(port, host); s.setTimeout(2500); s.on("connect", () => (s.destroy(), res("open"))); s.on("error", (e) => (s.destroy(), res(e.code ?? "error"))); s.on("timeout", () => (s.destroy(), res("timeout"))); });
      return [{ ok: r === "open", what: `LiveSplit Server ${host}:${port}`, detail: r === "open" ? "reachable" : `${r} (start LiveSplit; Control → Start Server, or ServerStartup=1 in settings.cfg)` }];
    },
    /** Closes LiveSplit the way a user would, answering "Save Splits?" with No. */
    async close() {
      const { closeWindows } = await import("../core/src/close-windows.mjs");
      return closeWindows([{ name: "LiveSplit", title: "LiveSplit", seconds: 15, dialogTitle: "Save Splits?", dialogButton: "&No" }], { report: ["LiveSplit"] });
    },
    id: "livesplit",
    version: "0.1.0",
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
      send("reset");
      send("initgametime");
      send("starttimer");
      send("pausegametime");
      send(`setgametime ${igt.toFixed(3)}`);
    },
    async onEvent(event) {
      switch (event.event) {
        case "game.playback":
          if (event.data?.phase === "start") send("unpausegametime");
          else if (event.data?.phase === "end") {
            if (typeof event.data.ticks === "number") igt += Math.round(event.data.ticks * 15) / 1000;
            else if (typeof event.data.seconds === "number") igt += Math.round(event.data.seconds * 1000) / 1000;
            send(`setgametime ${igt.toFixed(3)}`);
            send("pausegametime");
          }
          break;
        case "game.milestone":
          if (event.data?.chapter) send("split");
          break;
        case "game.over":
          if (event.data?.victory) { over = true; send("pause"); }
          break;
        case "game.attempt":
          if (event.data?.phase === "start") { igt = 0; send("reset"); send("initgametime"); send("starttimer"); send("pausegametime"); send("setgametime 0.000"); }
          break;
        case "run.ended":
          if (!over) send("pause");
          break;
        default:
      }
    },
    async stop() {
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
      return { igt, times };
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
  const ended = new Date(started.getTime() + timeline.totals.rta * 1000);
  const segments = timeline.sections.map((s, i, all) => {
    const name = i + 1 < all.length ? all[i + 1].label : "End";
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
