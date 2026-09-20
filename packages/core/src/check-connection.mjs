#!/usr/bin/env node
// Smoke test of a game plugin through the real broker, sandboxed exactly as a
// runtime would start it. No model, no credentials. Derived in spirit from
// portal-agent tools/check-connection.mjs, made game-independent.
//
// Usage: node check-connection.mjs --game <plugin.mjs> --run-dir <dir> [--exercise]
import fs from "node:fs";
import path from "node:path";
import { CLIENT_VERSION, loadGamePlugin, startBroker } from "./mcp-client.mjs";

export async function checkConnection({ gameModule, runDir, exercise = false, log = console.log }) {
  const plugin = await loadGamePlugin(gameModule);
  fs.mkdirSync(runDir, { recursive: true });
  const scope = plugin.scopeName ?? "game";
  const client = startBroker({
    gameModule,
    runDir,
    readable: plugin.readable ?? [],
    endpoints: plugin.endpoints ?? [],
    passThrough: plugin.env ?? [],
  });
  try {
    const init = await client.initialize({ name: "aas-connection-check", version: CLIENT_VERSION });
    log(`PASS: MCP handshake (${init.serverInfo.name} ${init.serverInfo.version})`);
    const names = (await client.request("tools/list")).tools.map((t) => t.name).sort();
    const expected = [`${plugin.id}_documentation`, `${plugin.id}_exec`, `${plugin.id}_screenshot`];
    if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error(`Tools are ${names.join(", ")}; expected ${expected.join(", ")}`);
    const doc = await client.call(`${plugin.id}_documentation`);
    if (!doc.content[0]?.text?.trim()) throw new Error("Documentation is empty.");
    log("PASS: exactly three tools and API documentation");
    const observation = await client.call(`${plugin.id}_exec`, { code: `return await ${scope}.observe();` });
    const text = observation.content.find((c) => c.type === "text")?.text;
    if (!text) throw new Error("observe() returned no text.");
    log(`PASS: game observation\n${text}`);
    const image = (await client.call(`${plugin.id}_screenshot`)).content.find((c) => c.type === "image");
    if (!image) throw new Error("No screenshot image returned.");
    const bytes = Buffer.from(image.data, "base64");
    if (bytes.length < 4) throw new Error("Screenshot is empty.");
    const savePath = `connection-check-${Date.now()}.${image.mimeType === "image/png" ? "png" : "jpg"}`;
    await client.call(`${plugin.id}_screenshot`, { savePath });
    if (fs.statSync(path.join(runDir, savePath)).size < 4) throw new Error("Saved screenshot is empty.");
    log(`PASS: screenshot (${image.mimeType}, ${bytes.length} bytes) and permitted file save: ${path.join(runDir, savePath)}`);
    if (exercise) {
      for (const step of plugin.exercise ?? []) {
        const result = await client.call(`${plugin.id}_exec`, { code: step.code });
        const value = JSON.parse(result.content.find((c) => c.type === "text")?.text ?? "null");
        step.verify?.(value);
        log(`PASS: ${step.label}`);
      }
    }
    log("Connection check passed. The broker closed its game connection; you can now start the agent.");
    return true;
  } finally {
    client.close();
  }
}

if (import.meta.url === new URL(process.argv[1], "file://").href || process.argv[1]?.endsWith("check-connection.mjs")) {
  const args = process.argv.slice(2);
  const opts = { exercise: false };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--game") opts.gameModule = args[++i];
    else if (args[i] === "--run-dir") opts.runDir = args[++i];
    else if (args[i] === "--exercise") opts.exercise = true;
    else throw new Error("Usage: check-connection --game <plugin.mjs> --run-dir <dir> [--exercise]");
  }
  if (!opts.gameModule || !opts.runDir) throw new Error("--game and --run-dir are required.");
  opts.runDir = path.resolve(opts.runDir);
  try {
    await checkConnection(opts);
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}
