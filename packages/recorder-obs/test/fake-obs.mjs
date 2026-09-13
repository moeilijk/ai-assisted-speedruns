// A fake obs-websocket v5 server for tests: RFC 6455 handshake and text
// frames on Node's http module (Node has no built-in WebSocket server),
// the v5 Hello/Identify/Identified handshake with sha256 auth, and enough
// requests to exercise the recorder: scene collections, scenes, inputs,
// record start/stop with RecordStateChanged events, chapters, replay buffer.
import http from "node:http";
import zlib from "node:zlib";
/** A 2x2 RGBA PNG, mid grey: what a source that shows a picture looks like to the recorder's check. */
function pngOf(pixels, width, height) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, "ascii"), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const rows = []; for (let y = 0; y < height; y += 1) rows.push(Buffer.from([0, ...pixels.slice(y * width * 4, (y + 1) * width * 4)]));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}
export const GREY_PNG = pngOf(Array(2 * 2).fill([128, 128, 128, 255]).flat(), 2, 2);
export const BLACK_PNG = pngOf(Array(2 * 2).fill([0, 0, 0, 255]).flat(), 2, 2);
import { createHash } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function decodeFrames(buffer) {
  const frames = [];
  let off = 0;
  while (off + 2 <= buffer.length) {
    const fin = buffer[off] & 0x80, opcode = buffer[off] & 0x0f;
    let len = buffer[off + 1] & 0x7f, masked = buffer[off + 1] & 0x80, p = off + 2;
    if (len === 126) { len = buffer.readUInt16BE(p); p += 2; } else if (len === 127) { len = Number(buffer.readBigUInt64BE(p)); p += 8; }
    let mask = null;
    if (masked) { mask = buffer.subarray(p, p + 4); p += 4; }
    if (p + len > buffer.length) break;
    const payload = Buffer.from(buffer.subarray(p, p + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    frames.push({ fin, opcode, payload });
    off = p + len;
  }
  return { frames, rest: buffer.subarray(off) };
}
function encodeText(text) {
  const data = Buffer.from(text, "utf8");
  let header;
  if (data.length < 126) header = Buffer.from([0x81, data.length]);
  else if (data.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(data.length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(data.length), 2); }
  return Buffer.concat([header, data]);
}

export async function startFakeObs({ password = "secret", inputs = [], specialInputs = {}, collections = ["Untitled"], recordDirectory = "D:\\Recordings", supportsChapters = true } = {}) {
  const state = { collections: new Map(collections.map((c) => [c, { scenes: ["Scene"], inputs: [...inputs] }])), current: collections[0], scene: "Scene", recording: false, outputPath: null, recordDirectory, chapters: [], replays: 0, calls: [] };
  const clients = new Set();
  const send = (socket, op, d) => socket.write(encodeText(JSON.stringify({ op, d })));
  const broadcastEvent = (eventType, eventData) => { for (const c of clients) send(c, 5, { eventType, eventIntent: 64, eventData }); };
  const col = () => state.collections.get(state.current);

  function handle(type, data) {
    state.calls.push({ type, data });
    switch (type) {
      case "GetVersion": return { obsVersion: "32.2.2", obsWebSocketVersion: "5.7.4", rpcVersion: 1, platform: "windows" };
      case "GetInputList": return { inputs: col().inputs.map((i) => ({ inputName: i.inputName, inputKind: i.inputKind, unversionedInputKind: i.inputKind.replace(/_v\d+$/, ""), inputUuid: "u" })) };
      case "GetSpecialInputs": return { desktop1: null, desktop2: null, mic1: null, mic2: null, mic3: null, mic4: null, ...(col().special ?? specialInputs) };
      case "RemoveInput": { const i = col().inputs.findIndex((x) => x.inputName === data.inputName); if (i === -1 && !Object.values(col().special ?? specialInputs).includes(data.inputName)) throw Object.assign(new Error("no such input"), { code: 600 }); if (i !== -1) col().inputs.splice(i, 1); col().special = Object.fromEntries(Object.entries(col().special ?? specialInputs).map(([k, v]) => [k, v === data.inputName ? null : v])); return {}; }
      case "GetSceneCollectionList": return { currentSceneCollectionName: state.current, sceneCollections: [...state.collections.keys()] };
      case "CreateSceneCollection": state.collections.set(data.sceneCollectionName, { scenes: ["Scene"], inputs: [{ inputName: "Mic/Aux", inputKind: "wasapi_input_capture" }], special: { mic1: "Mic/Aux", desktop1: "Desktop Audio" } }); state.current = data.sceneCollectionName; return {};
      case "SetCurrentSceneCollection": if (!state.collections.has(data.sceneCollectionName)) throw Object.assign(new Error("no such collection"), { code: 600 }); state.current = data.sceneCollectionName; return {};
      case "GetSceneList": return { currentProgramSceneName: state.scene, scenes: col().scenes.map((s, i) => ({ sceneName: s, sceneIndex: i })) };
      case "CreateScene": col().scenes.push(data.sceneName); return {};
      case "CreateInput": col().inputs.push({ inputName: data.inputName, inputKind: data.inputKind, settings: data.inputSettings ?? {}, scenes: [data.sceneName] }); return { inputUuid: "u", sceneItemId: col().inputs.length };
      case "CreateSceneItem": { const i = col().inputs.find((x) => x.inputName === data.sourceName); if (!i) throw Object.assign(new Error("no such source"), { code: 600 }); i.scenes.push(data.sceneName); return { sceneItemId: 1 }; }
      case "SetInputSettings": { const i = col().inputs.find((x) => x.inputName === data.inputName); if (!i) throw Object.assign(new Error("no such input"), { code: 600 }); Object.assign(i.settings, data.inputSettings); return {}; }
      case "GetSceneItemList": return { sceneItems: col().inputs.filter((i) => (i.scenes ?? []).includes(data.sceneName)).map((i, k) => ({ sceneItemId: k + 1, sourceName: i.inputName })) };
      case "SetSceneItemTransform": { const i = col().inputs.filter((x) => (x.scenes ?? []).includes(data.sceneName))[data.sceneItemId - 1]; if (!i) throw Object.assign(new Error("no such item"), { code: 600 }); i.transform = data.sceneItemTransform; return {}; }
      case "GetInputPropertiesListPropertyItems": return { propertyItems: data.propertyName === "window" ? [{ itemName: "[hl2.exe]: Portal", itemValue: "Portal:Valve001:hl2.exe", itemEnabled: true }, { itemName: "[LiveSplit.exe]: LiveSplit", itemValue: "LiveSplit:WindowsForms10.Window.8.app.0:LiveSplit.exe", itemEnabled: true }] : [] };
      case "SetSceneItemIndex": { const list = col().inputs.filter((x) => (x.scenes ?? []).includes(data.sceneName)); const i = list[data.sceneItemId - 1]; if (!i) throw Object.assign(new Error("no such item"), { code: 600 }); i.index = data.sceneItemIndex; return {}; }
      case "GetVideoSettings": return { baseWidth: 3840, baseHeight: 2160, outputWidth: 1920, outputHeight: 1080, fpsNumerator: 60, fpsDenominator: 1 };
      case "SetCurrentProgramScene": if (!col().scenes.includes(data.sceneName)) throw Object.assign(new Error("no such scene"), { code: 600 }); state.scene = data.sceneName; return {};
      case "GetSourceScreenshot": { if (!col().inputs.find((x) => x.inputName === data.sourceName)) throw Object.assign(new Error("no such source"), { code: 600 }); return { imageData: `data:image/png;base64,${state.screenshot ?? GREY_PNG}` }; }
      case "GetRecordStatus": return { outputActive: state.recording, outputPaused: false, outputTimecode: "00:00:00.000", outputDuration: 0, outputBytes: 0 };
      case "SetRecordDirectory": state.recordDirectory = data.recordDirectory; return {};
      case "GetRecordDirectory": return { recordDirectory: state.recordDirectory };
      case "SetProfileParameter": state[`profile:${data.parameterCategory}.${data.parameterName}`] = data.parameterValue; return {};
      case "StartRecord": {
        if (state.recording) throw Object.assign(new Error("already recording"), { code: 500 });
        state.recording = true; state.outputPath = `${state.recordDirectory}\\${state["profile:Output.FilenameFormatting"] ?? "rec"}.mp4`;
        setTimeout(() => broadcastEvent("RecordStateChanged", { outputActive: true, outputState: "OBS_WEBSOCKET_OUTPUT_STARTED", outputPath: state.outputPath }), 20);
        return {};
      }
      case "StopRecord": {
        if (!state.recording) throw Object.assign(new Error("not recording"), { code: 501 });
        state.recording = false;
        setTimeout(() => broadcastEvent("RecordStateChanged", { outputActive: false, outputState: "OBS_WEBSOCKET_OUTPUT_STOPPED", outputPath: state.outputPath }), 20);
        return { outputPath: state.outputPath };
      }
      case "CreateRecordChapter": if (!supportsChapters) throw Object.assign(new Error("unsupported"), { code: 204 }); state.chapters.push(data.chapterName); return {};
      case "StartReplayBuffer": case "StopReplayBuffer": return {};
      case "SaveReplayBuffer": { state.replays++; const p = `${state.recordDirectory}\\Replay_${state.replays}.mp4`; setTimeout(() => broadcastEvent("ReplayBufferSaved", { savedReplayPath: p }), 10); return {}; }
      default: throw Object.assign(new Error(`unknown request ${type}`), { code: 204 });
    }
  }

  const server = http.createServer((_, res) => { res.writeHead(426); res.end(); });
  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    const accept = createHash("sha1").update(key + GUID).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: obswebsocket.json\r\n\r\n`);
    clients.add(socket);
    const salt = "c2FsdA==", challenge = "Y2hhbGxlbmdl";
    send(socket, 0, { obsWebSocketVersion: "5.7.4", rpcVersion: 1, authentication: { challenge, salt } });
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const { frames, rest } = decodeFrames(buf);
      buf = rest;
      for (const f of frames) {
        if (f.opcode === 8) { socket.end(); return; }
        if (f.opcode !== 1) continue;
        const msg = JSON.parse(f.payload.toString("utf8"));
        if (msg.op === 1) {
          const secret = createHash("sha256").update(password + salt).digest("base64");
          const expected = createHash("sha256").update(secret + challenge).digest("base64");
          if (msg.d.authentication !== expected) { socket.end(); return; }
          send(socket, 2, { negotiatedRpcVersion: 1 });
        } else if (msg.op === 6) {
          const { requestType, requestId, requestData } = msg.d;
          try {
            const responseData = handle(requestType, requestData ?? {});
            send(socket, 7, { requestType, requestId, requestStatus: { result: true, code: 100 }, responseData });
          } catch (e) {
            send(socket, 7, { requestType, requestId, requestStatus: { result: false, code: e.code ?? 500, comment: e.message } });
          }
        }
      }
    });
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, url: `ws://127.0.0.1:${server.address().port}`, state, close: () => new Promise((r) => { for (const c of clients) c.destroy(); server.close(() => r()); }) };
}
