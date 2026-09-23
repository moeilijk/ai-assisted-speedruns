// Recorder plugin for OBS Studio through obs-websocket v5. Game-independent:
// the game plugin's processName drives the game capture and the application
// audio capture; run events drive scenes, chapters and the replay buffer.
// The earlier, unpublished Zero Company OBS design made generic.
//
// Scene collection `AAS-<game>` with scenes `<Game>-Game` and `-Game-Clean`
// (the clean one without the overlay and LiveSplit); built idempotently through
// the API. The recording shows the game and nothing the harness made up.
// Hard rule: no microphone. Preflight refuses to start when any
// wasapi_input_capture input or a global Mic/Aux device is configured.
//
// Options / env: url (AAS_OBS_URL), password (AAS_OBS_PASSWORD),
// overlayUrl (from `aas run --overlay-port`), liveSplitWindow, outroSeconds,
// recordDirectory (Windows path; default: OBS's own).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { connectObs } from "./obs-ws.mjs";
import { pngMeanLuma } from "./png-luma.mjs";

const MIC_KINDS = new Set(["wasapi_input_capture", "coreaudio_input_capture", "pulse_input_capture", "alsa_input_capture"]);

/** Windows path → WSL path when running under WSL and the drive is mounted; otherwise unchanged. */
export function toLocalPath(p) {
  if (!p || process.platform !== "linux" || !/^[A-Za-z]:[\\/]/.test(p)) return p;
  try {
    return execFileSync("wslpath", ["-u", p], { encoding: "utf8" }).trim();
  } catch {
    return p;
  }
}
/** Local (WSL) path → Windows path for OBS; only for /mnt/<drive> paths. */
export function toWindowsPath(p) {
  if (!p || process.platform !== "linux" || !/^\/mnt\/[a-z]\//.test(p)) return null;
  try {
    return execFileSync("wslpath", ["-w", p], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

export function createObsRecorder(options = {}) {
  const url = options.url ?? process.env.AAS_OBS_URL ?? "ws://127.0.0.1:4455";
  const password = options.password ?? process.env.AAS_OBS_PASSWORD ?? "";
  const outroSeconds = options.outroSeconds ?? 5;
  const log = options.log ?? ((t) => process.stderr.write(`[recorder-obs] ${t}\n`));
  let obs = null;
  let names = null;
  let gamePlugin = null;
  let t0 = null;
  let outputPath = null;
  let replayPaths = [];
  let previousRecordDir = null;
  const chapters = [];
  const timers = new Set();
  const later = (ms, fn) => {
    const t = setTimeout(() => (timers.delete(t), fn()), ms);
    timers.add(t);
  };

  const sceneNames = (gameId) => {
    const p = options.scenePrefix ?? gameId.replace(/(^|_)([a-z])/g, (_, __, c) => c.toUpperCase());
    return { collection: `AAS-${gameId}`, game: `${p}-Game`, clean: `${p}-Game-Clean`, prefix: p };
  };

  async function connect() {
    if (!obs) obs = await connectObs({ url, password });
    return obs;
  }

  /** Mean brightness (0..255) of OBS's own rendering of a source, or null when OBS cannot render it. */
  async function sourceBrightness(o, sourceName) {
    const r = await o.tryCall("GetSourceScreenshot", { sourceName, imageFormat: "png", imageWidth: 320, imageHeight: 180 });
    if (!r?.imageData) return null;
    try { return pngMeanLuma(r.imageData.split(",")[1]); } catch { return null; }
  }
  /**
   * Waits until the source shows something (brightness above 1 of 255); after `seconds` of black, rebinds it once and
   * waits again; then throws. A source OBS cannot render at all is not a picture either: it fails the same way.
   */
  async function assertPicture(o, sourceName, { seconds = 10, every = Math.min(2, seconds) } = {}) {
    let rendered = false;
    for (let round = 0; round < 2; round += 1) {
      const deadline = Date.now() + seconds * 1000;
      let last = null;
      while (Date.now() < deadline) {
        last = await sourceBrightness(o, sourceName);
        if (last !== null) rendered = true;
        if (last !== null && last > 1) { log(`picture check: ${sourceName} shows a picture (brightness ${last.toFixed(1)}${round ? ", after a rebind" : ""})`); return last; }
        await new Promise((r) => setTimeout(r, every * 1000));
      }
      if (round === 0) {
        log(`picture check: ${sourceName} is black after ${seconds} s (brightness ${last?.toFixed(1)}); rebinding the capture`);
        const window = (await o.tryCall("GetInputSettings", { inputName: sourceName }))?.inputSettings?.window;
        if (!window) break;
        await o.tryCall("SetInputSettings", { inputName: sourceName, inputSettings: { window: "" }, overlay: true });
        await o.tryCall("SetInputSettings", { inputName: sourceName, inputSettings: { window }, overlay: true });
      }
    }
    if (!rendered) throw new Error(`OBS could not render the game window capture (${sourceName}) for ${2 * seconds} s from the start of the recording, a rebind included, so there is no evidence the game is being recorded; the run does not start.`);
    throw new Error(`the game window capture in OBS (${sourceName}) shows nothing: black for ${2 * seconds} s from the start of the recording, a rebind included. The run would have no recording of the game, so it does not start.`);
  }

  /**
   * Waits until OBS is actually writing the recording: the output is active and its size grows between two readings.
   * A recording that "started" but writes nothing (a full disk, a failing encoder) is found here, not after the run.
   */
  async function assertWriting(o, { seconds = 10, every = Math.min(1, seconds / 4) } = {}) {
    const deadline = Date.now() + seconds * 1000;
    let first = null, st = null;
    while (Date.now() < deadline) {
      st = await o.call("GetRecordStatus");
      if (st.outputActive && st.outputBytes > 0) {
        if (first === null) first = st.outputBytes;
        else if (st.outputBytes > first) { log(`recording check: OBS is writing (${st.outputBytes} bytes, ${st.outputTimecode})`); return st.outputBytes; }
      }
      await new Promise((r) => setTimeout(r, every * 1000));
    }
    throw new Error(`OBS reports a recording but is not writing it: ${st?.outputActive ? `${st.outputBytes} bytes and not growing` : "the output is not active"} after ${seconds} s. The run would have no recording, so it does not start.`);
  }

  async function listMicrophones(o) {
    const { inputs } = await o.call("GetInputList");
    const mics = inputs.filter((i) => MIC_KINDS.has(i.unversionedInputKind ?? i.inputKind)).map((m) => m.inputName);
    const special = await o.tryCall("GetSpecialInputs");
    for (const k of ["mic1", "mic2", "mic3", "mic4"]) if (special?.[k] && !mics.includes(special[k])) mics.push(special[k]);
    return mics;
  }
  // Hard rule: no microphone in the recording. In our own scene collection
  // (AAS-<game>) a microphone is removed (OBS adds a global Mic/Aux to every
  // new collection by default); anywhere else it is an error.
  async function assertNoMicrophone(o, ownCollection) {
    let mics = await listMicrophones(o);
    if (mics.length && ownCollection) {
      for (const inputName of mics) await o.tryCall("RemoveInput", { inputName });
      log(`removed microphone input(s) from ${ownCollection}: ${mics.join(", ")}`);
      mics = await listMicrophones(o);
    }
    if (mics.length) throw new Error(`OBS has microphone input(s): ${mics.join(", ")}. A run records game audio only; remove them (Settings → Audio → Mic/Aux: Disabled).`);
  }

  async function ensureScenes(o, game, brief, ctx) {
    const n = sceneNames(game.id);
    const collections = await o.call("GetSceneCollectionList");
    if (!collections.sceneCollections.includes(n.collection)) {
      await o.call("CreateSceneCollection", { sceneCollectionName: n.collection });
      log(`created scene collection ${n.collection}`);
    } else if (collections.currentSceneCollectionName !== n.collection) {
      await o.call("SetCurrentSceneCollection", { sceneCollectionName: n.collection });
    }
    const existing = new Set((await o.call("GetSceneList")).scenes.map((s) => s.sceneName));
    for (const scene of [n.game, n.clean]) if (!existing.has(scene)) await o.call("CreateScene", { sceneName: scene });
    // The recording shows the game, LiveSplit and the RTA/IGT overlay, nothing the harness made up: remove
    // the text cards and their scenes from collections that older versions of this recorder built.
    for (const stale of [`${n.prefix} Title`, `${n.prefix} Pause Card`, `${n.prefix} Outro Card`]) await o.tryCall("RemoveInput", { inputName: stale });
    for (const scene of [`${n.prefix}-Intro`, `${n.prefix}-Pause`, `${n.prefix}-Outro`]) if (existing.has(scene)) await o.tryCall("RemoveScene", { sceneName: scene });
    const inputs = new Map((await o.call("GetInputList")).inputs.map((i) => [i.inputName, i]));
    const exe = game.processName ?? "";
    const video = (await o.tryCall("GetVideoSettings")) ?? { baseWidth: 1920, baseHeight: 1080 };
    const canvas = { w: video.baseWidth, h: video.baseHeight };
    // Older collections of ours used game_capture, which needs OBS to inject
    // a hook into the game and silently shows nothing when that is blocked
    // (antivirus). Window capture through Windows Graphics Capture does not.
    if (inputs.get(`${n.prefix} Game Capture`)?.inputKind === "game_capture") {
      await o.tryCall("RemoveInput", { inputName: `${n.prefix} Game Capture` });
      inputs.delete(`${n.prefix} Game Capture`);
    }
    // Place a scene item: bounds box (scale inner, keep aspect) at a position;
    // `bottom` sends it to the back so overlays created earlier stay visible.
    const place = async (scene, inputName, { x = 0, y = 0, w = canvas.w, h = canvas.h, align = 5, bottom = false } = {}) => {
      const items = (await o.tryCall("GetSceneItemList", { sceneName: scene }))?.sceneItems ?? [];
      const item = items.find((i) => i.sourceName === inputName);
      if (!item) return;
      await o.tryCall("SetSceneItemTransform", { sceneName: scene, sceneItemId: item.sceneItemId, sceneItemTransform: { positionX: x, positionY: y, alignment: align, boundsType: "OBS_BOUNDS_SCALE_INNER", boundsAlignment: 0, boundsWidth: w, boundsHeight: h } });
      if (bottom) await o.tryCall("SetSceneItemIndex", { sceneName: scene, sceneItemId: item.sceneItemId, sceneItemIndex: 0 });
    };
    const ensureInput = async (inputName, inputKind, rawSettings, scenes) => {
      const inputSettings = Object.fromEntries(Object.entries(rawSettings).filter(([, v]) => v !== undefined));
      if (!inputs.has(inputName)) {
        await o.call("CreateInput", { sceneName: scenes[0], inputName, inputKind, inputSettings, sceneItemEnabled: true });
        inputs.set(inputName, { inputName, inputKind });
        for (const scene of scenes.slice(1)) await o.tryCall("CreateSceneItem", { sceneName: scene, sourceName: inputName, sceneItemEnabled: true });
      } else await o.tryCall("SetInputSettings", { inputName, inputSettings, overlay: true });
    };
    if (exe) {
      // Window match "title:class:exe"; method 2 = Windows Graphics Capture. WGC needs the full
      // string as OBS lists it (the short "::exe" form finds nothing), so resolve it from OBS's
      // own window list; while the game is not running yet, keep the short form and try again at start.
      const resolveWindow = async (inputName) => {
        const items = (await o.tryCall("GetInputPropertiesListPropertyItems", { inputName, propertyName: "window" }))?.propertyItems ?? [];
        // A game with more than one window (an emulator with a tool window) names its game window by a title pattern.
        const titled = game.windowTitlePattern ? new RegExp(game.windowTitlePattern) : null;
        const ofExe = items.map((i) => i.itemValue).filter((v) => v.endsWith(`:${exe}`) && !v.startsWith("::"));
        // OBS lists the window the input was last set to even when that window is gone; with a title pattern, a window
        // other than that stored one is the live one (an earlier game's title matched the pattern too).
        const stored = (await o.tryCall("GetInputSettings", { inputName }))?.inputSettings?.window ?? null;
        const matching = titled ? ofExe.filter((v) => titled.test(v.split(":")[0])) : ofExe;
        const full = matching.find((v) => v !== stored) ?? matching[0];
        return full ?? `::${exe}`;
      };
      const name = `${n.prefix} Game Window`;
      await ensureInput(name, "window_capture", { window: inputs.has(name) ? undefined : `::${exe}`, priority: 2, method: 2, cursor: false, client_area: true }, [n.game, n.clean]);
      const win = await resolveWindow(name);
      await o.tryCall("SetInputSettings", { inputName: name, inputSettings: { window: win }, overlay: true });
      log(`game window capture: ${win}`);
      await ensureInput(`${n.prefix} Game Audio`, "wasapi_process_output_capture", { window: `::${exe}`, priority: 2 }, [n.game, n.clean]);
      for (const scene of [n.game, n.clean]) await place(scene, `${n.prefix} Game Window`, { bottom: true });
    } else {
      await ensureInput(`${n.prefix} Display Capture`, "monitor_capture", { method: 2 }, [n.game, n.clean]);
      for (const scene of [n.game, n.clean]) await place(scene, `${n.prefix} Display Capture`, { bottom: true });
    }
    if (options.liveSplitWindow !== false) {
      // Match on the executable (priority 2): LiveSplit's window title changes with the loaded splits.
      await ensureInput(`${n.prefix} LiveSplit`, "window_capture", { window: options.liveSplitWindow ?? "LiveSplit:LiveSplit:LiveSplit.exe", priority: 2, method: 2, cursor: false }, [n.game]);
      await place(n.game, `${n.prefix} LiveSplit`, { x: canvas.w * 0.01, y: canvas.h * 0.09, w: canvas.w * 0.10, h: canvas.h * 0.30 });
      // Semi-transparent so the splits read over the game without taking the picture.
      await o.tryCall("CreateSourceFilter", { sourceName: `${n.prefix} LiveSplit`, filterName: "AAS Opacity", filterKind: "color_filter_v2", filterSettings: { opacity: 0.6 } });
      await o.tryCall("SetSourceFilterSettings", { sourceName: `${n.prefix} LiveSplit`, filterName: "AAS Opacity", filterSettings: { opacity: 0.6 } });
    }
    if (ctx?.overlayUrl) {
      // Rendered at 1080p and scaled to the canvas, so the CSS sizes read the same at every output size.
      await ensureInput(`${n.prefix} Overlay`, "browser_source", { url: ctx.overlayUrl, width: 1920, height: 1080, fps: 30, shutdown: true, restart_when_active: true }, [n.game]);
      await place(n.game, `${n.prefix} Overlay`);
    }
    return n;
  }

  return {
    id: "obs",
    name: "OBS Studio (video)",
    launch: path.join(path.dirname(fileURLToPath(import.meta.url)), "launch-obs.mjs"),
    version: "0.33.1",
    processName: "obs64",
    /** Read-only checks for `aas doctor`: the websocket reachable and authenticated, OBS not already recording. */
    async doctor() {
      const rows = [];
      const u = new URL(url);
      const reach = await new Promise((res) => { const s = net.connect(Number(u.port || 4455), u.hostname); s.setTimeout(2500); s.on("connect", () => (s.destroy(), res("open"))); s.on("error", (e) => (s.destroy(), res(e.code ?? "error"))); s.on("timeout", () => (s.destroy(), res("timeout"))); });
      rows.push({ ok: reach === "open", what: `OBS websocket ${u.host}`, detail: reach === "open" ? "reachable" : `${reach} (start OBS; Tools → WebSocket Server Settings)` });
      rows.push({ ok: Boolean(password), what: "AAS_OBS_PASSWORD set", detail: "" });
      if (reach === "open") {
        try {
          const o = await connectObs({ url, password });
          const v = await o.call("GetVersion");
          const st = await o.call("GetRecordStatus");
          o.close();
          rows.push({ ok: true, what: "OBS auth + version", detail: `OBS ${v.obsVersion}, obs-websocket ${v.obsWebSocketVersion}` });
          rows.push({ ok: !st.outputActive, what: "OBS not already recording", detail: "" });
        } catch (e) { rows.push({ ok: false, what: "OBS auth", detail: e.message }); }
      }
      return rows;
    },
    /** Closes OBS the way a user would (WM_CLOSE to its main window). It exits cleanly, but right after a recording
     *  obs-websocket's IO thread takes long to stop, and longer with every OBS session of the day so far: measured on
     *  32 s (11:43), 63 s (15:39) and 93 s (15:45), against 0.1 s eleven minutes after a recording. The
     *  cause is not found; the wait covers it and the report says how long it took. */
    async close() {
      const { closeWindows } = await import("../core/src/close-windows.mjs");
      const t0 = Date.now();
      const out = closeWindows([{ name: "obs64", title: "OBS ", seconds: 180 }], { report: ["obs64"] });
      return `${out}\nobs64: ${Math.round((Date.now() - t0) / 1000)} s from WM_CLOSE to the report`;
    },
    /** Drops the websocket connection without touching OBS: after a failed preflight the run does not start. */
    disconnect() {
      obs?.close();
      obs = null;
    },
    async preflight(brief, game) {
      const o = await connect();
      const v = await o.call("GetVersion");
      log(`OBS ${v.obsVersion}, obs-websocket ${v.obsWebSocketVersion}`);
      gamePlugin = game;
      names = await ensureScenes(o, game, brief, options);
      await assertNoMicrophone(o, names.collection);
      const status = await o.call("GetRecordStatus");
      if (status.outputActive) throw new Error("OBS is already recording; stop that recording first.");
    },
    async start(brief, ctx = {}) {
      const o = await connect();
      // Idempotent; with ctx.overlayUrl this adds or updates the overlay browser source.
      names = await ensureScenes(o, ctx.game ?? gamePlugin ?? { id: brief.category.game }, brief, { ...options, ...ctx });
      const recordDir = options.recordDirectory ?? (ctx.runDir ? toWindowsPath(path.join(ctx.runDir, "recording")) : null);
      if (recordDir) {
        // The directory must exist before StartRecord, or OBS shows "Bad File Path".
        if (ctx.runDir) fs.mkdirSync(path.join(ctx.runDir, "recording"), { recursive: true });
        // What OBS points at now, but only if that is still a real folder: a run that was killed leaves OBS on its
        // recording folder, and that folder is gone once the run is cleaned up. Putting a dead path back is how OBS
        // ends up recording nowhere (owner, reported before 2026-09-19).
        const before = (await o.tryCall("GetRecordDirectory"))?.recordDirectory ?? null;
        previousRecordDir = before && fs.existsSync(toLocalPath(before)) && path.basename(toLocalPath(before)) !== "recording" ? before : null;
        if (before && !previousRecordDir) log(`OBS pointed at ${before}, which is ${fs.existsSync(toLocalPath(before)) ? "a run's own recording folder" : "gone"}; it will be set to the output location afterwards instead`);
        await o.tryCall("SetRecordDirectory", { recordDirectory: recordDir });
      }
      await o.tryCall("SetProfileParameter", { parameterCategory: "Output", parameterName: "FilenameFormatting", parameterValue: `AAS_${brief.id}_%CCYY-%MM-%DD_%hh-%mm-%ss` });
      // Open on the game scene: at t0 the game sits on its own title/main-menu screen, and the run starts from there
      // (prepareRun dwells on it, then begins), so the recording shows a genuine run from the beginning.
      await o.call("SetCurrentProgramScene", { sceneName: names.game });
      // The overlay is a browser source set to shut down when it is not visible and to restart when the
      // scene becomes active. The recording now opens on the game scene, so that activation may never
      // happen and the source would stay blank: refresh it explicitly.
      if (ctx?.overlayUrl) await o.tryCall("PressInputPropertiesButton", { inputName: `${names.prefix} Overlay`, propertyName: "refreshnocache" });
      // A window capture binds to a window handle, not to the text in its settings. The game is started fresh for
      // every run, so the handle it captured last time is gone and the source keeps showing that last frame while
      // the run plays on (, measured: a whole recording frozen on the title screen, GetSourceScreenshot
      // answering "failed to render"). Setting the window again rebinds it to the window that exists now.
      for (const input of [`${names.prefix} Game Window`, `${names.prefix} LiveSplit`]) {
        const current = await o.tryCall("GetInputSettings", { inputName: input });
        const window = current?.inputSettings?.window;
        if (!window) continue;
        await o.tryCall("SetInputSettings", { inputName: input, inputSettings: { window: "" }, overlay: true });
        await o.tryCall("SetInputSettings", { inputName: input, inputSettings: { window }, overlay: true });
      }
      outputPath = null;
      replayPaths = [];
      o.on("ReplayBufferSaved", (e) => {
        if (e.savedReplayPath) replayPaths.push(e.savedReplayPath);
      });
      const started = o.waitFor("RecordStateChanged", (e) => e.outputState === "OBS_WEBSOCKET_OUTPUT_STARTED", 15000);
      await o.call("StartRecord");
      if (!(await started)) throw new Error("OBS did not report that the recording started.");
      t0 = new Date();
      await o.tryCall("StartReplayBuffer");
      log(`recording started; t0 = ${t0.toISOString()}`);
      // The game capture has to show a picture from t0 on, measured on OBS's own rendering of that source, not
      // assumed: a window capture stayed black for the first 116 s of a run while the game was
      // being played, and nothing in OBS's log said so. Black after a rebind means no recording of the game, and
      // then the run does not start (the caller stops and discards the recording).
      await assertWriting(o, { seconds: options.writingSeconds ?? 10 });
      if (gamePlugin?.processName) await assertPicture(o, `${names.prefix} Game Window`, { seconds: options.pictureSeconds ?? 10 });
      return { t0 };
    },
    async onEvent(event) {
      if (!obs || !names) return;
      const at = t0 ? Math.max(0, (Date.parse(event.timestamp) - t0.getTime()) / 1000) : 0;
      switch (event.event) {
        case "game.phase": {
          const phase = event.data?.phase;
          await obs.tryCall("SetCurrentProgramScene", { sceneName: ["cinematic", "loading"].includes(phase) ? names.clean : names.game });
          break;
        }
        case "game.attempt":
          if (event.data?.phase !== "start") break;
          chapters.push({ at, label: `Attempt ${event.data.attempt ?? "?"}` });
          await obs.tryCall("CreateRecordChapter", { chapterName: `Attempt ${event.data.attempt ?? "?"}` });
          break;
        case "game.milestone":
          if (event.data?.chapter) {
            const label = String(event.data.label ?? "milestone");
            chapters.push({ at, label });
            await obs.tryCall("CreateRecordChapter", { chapterName: label });
          }
          break;
        case "game.highlight":
          await obs.tryCall("SaveReplayBuffer");
          break;
        case "game.playback":
          if (event.data?.phase === "start") await obs.tryCall("SetCurrentProgramScene", { sceneName: names.game });
          break;
        default:
      }
    },
    async stop() {
      const o = await connect();
      for (const t of timers) clearTimeout(t);
      await new Promise((r) => setTimeout(r, outroSeconds * 1000));
      const stopped = o.waitFor("RecordStateChanged", (e) => e.outputState === "OBS_WEBSOCKET_OUTPUT_STOPPED", 30000);
      const res = await o.call("StopRecord");
      const stoppedEvent = await stopped.catch(() => null);
      outputPath = res.outputPath ?? stoppedEvent?.outputPath ?? null;
      await o.tryCall("StopReplayBuffer");
      // Leave OBS pointing at its own recording folder again. OBS refuses the change while the output is still
      // stopping, so this waits for the stop above; a refusal is reported, not swallowed (measured 2026-09-17: the
      // folder of the last run stayed OBS's recording folder).
      // Somewhere that exists: what OBS had, or else the output location where the runs live. Never the folder of
      // the run that just finished, which is published and then gone.
      const back = previousRecordDir ?? (process.env.AAS_OUTPUT_DIR && fs.existsSync(toLocalPath(process.env.AAS_OUTPUT_DIR)) ? toWindowsPath(toLocalPath(process.env.AAS_OUTPUT_DIR)) : null);
      if (back) {
        await o.tryCall("SetRecordDirectory", { recordDirectory: back });
        const now = (await o.tryCall("GetRecordDirectory"))?.recordDirectory ?? null;
        if (now !== back) log(`OBS's recording folder could not be set to ${back} (it is ${now}); set it in OBS → Settings → Output`);
        else log(`OBS's recording folder set to ${back}`);
      } else log("OBS is left pointing at this run's recording folder: there is no other folder to point it at (set AAS_OUTPUT_DIR)");
      o.close();
      obs = null;
      const files = [outputPath, ...replayPaths].filter(Boolean).map(toLocalPath);
      log(`recording stopped: ${outputPath}`);
      return { files, t0: t0 ?? new Date(), chapters, outputPath, replayPaths };
    },
  };
}

export default createObsRecorder();
