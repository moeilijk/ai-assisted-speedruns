// A stand-in for bizhawk-mcp-native (the external tool inside EmuHawk) with the answers measured on the real one
// (BizHawk 2.11.1, v0.3.0, 2026-09-23): the tools the plugin calls, JSON-RPC `tools/call` over HTTP, text results,
// and a screenshot that comes back as a resource.
import http from "node:http";

export async function startFakeBizHawk({ romHash = "8FCC5798252370C63A98E7421131ABF3EB22BFCF", memory = {} } = {}) {
  const state = { romHash, framecount: 0, paused: false, pressed: [], calls: [], memory: { ...memory }, onFrame: null };
  const text = (v) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v) }], isError: false });
  const tools = {
    ping: () => "pong",
    get_info: () => ({ rom_name: "NES15 2011-01-04NTSC by Matthew Brenaman (PD)", rom_hash: state.romHash, system_id: "NES", framecount: state.framecount, paused: state.paused }),
    pause: () => { state.paused = true; return { paused: true }; },
    reboot: () => { state.framecount = 0; return "rebooted"; },
    press_buttons: (a) => { state.pressed.push({ frame: state.framecount, buttons: a.buttons }); return `joypad set for next frame: ${Object.keys(a.buttons).join(", ")}`; },
    frame_advance: (a) => { for (let i = 0; i < (a.count ?? 1); i += 1) { state.framecount += 1; state.onFrame?.(state); } return `advanced ${a.count ?? 1} frame(s) (was paused; pause restored)`; },
    read_memory: (a) => ({ value: state.memory[`${a.domain}:${a.address}`] ?? 0, requested: a.address, address: a.address }),
    get_joypad: () => ({ buttons: { "P1 Up": false, "P1 Down": false, "P1 Left": false, "P1 Right": false, "P1 Start": false, "P1 Select": false, "P1 B": false, "P1 A": false, Reset: false, Power: false } }),
    screenshot: () => ({ path: "C:/temp/shot.png", resource: "bizhawk://shot-1" }),
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const msg = JSON.parse(body);
      const reply = (result) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })); };
      if (msg.method === "resources/read") return reply({ contents: [{ uri: msg.params.uri, mimeType: "image/png", blob: Buffer.from("fake-png").toString("base64") }] });
      const { name, arguments: args } = msg.params;
      state.calls.push(name);
      const tool = tools[name];
      if (!tool) return reply({ content: [{ type: "text", text: `unknown tool ${name}` }], isError: true });
      reply(text(tool(args ?? {})));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  state.url = `http://127.0.0.1:${server.address().port}/mcp/`;
  state.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  return state;
}
