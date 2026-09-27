// The chain between the tooling and the live Archive, tested end to end with the Archive's e2e account: every shared
// fixture uploaded and its verdict read back against verdicts.json; a mock and the hostile strings accepted, their
// hidden run page read (no raw tag survives) and 404 to the public; a run recorded with proof on the Archive's own
// tickets, uploaded, and its heads compared with what the Archive stored; hostile requests to the Archive; and
// everything the account made wiped at the end, with the counts. `npm run e2e:chain`; not part of `npm test`, because
// it needs the network and the e2e key, reached through .local/e2e-archive.mjs (skipped without it). The e2e account's
// runs are hidden, never listed, and wiped after 24 h by the Archive itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..");
const hook = path.join(root, ".local", "e2e-archive.mjs");
const skip = fs.existsSync(hook) ? false : "no .local/e2e-archive.mjs: the Archive's e2e account is not reachable from this machine";
const fixtures = path.join(root, "packages", "spec", "fixtures");
const at = () => new Date().toTimeString().slice(0, 8);
const log = (t) => process.stdout.write(`# ${at()} ${t}\n`);

test("the live Archive and the tooling agree on every fixture, the proof and the hidden run page", { skip, timeout: 900000 }, async () => {
  const { archiveFetch } = await import(pathToFileURL(hook).href);
  const { proofUrl, useArchiveFetch } = await import("../src/proof.mjs");
  const base = proofUrl();
  const call = async (method, p, { body = null, headers = {} } = {}) => {
    const res = await archiveFetch(`${base}${p}`, { method, headers: { Accept: "application/json", ...headers }, body, signal: AbortSignal.timeout(120000) });
    let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, json };
  };
  const upload = (file, name = path.basename(file)) => call("POST", "/api/v1/bundles", { body: fs.readFileSync(file), headers: { "Content-Type": "application/zip", "X-Filename": name } });

  // 1. From zero.
  let r = await call("DELETE", "/api/v1/e2e/");
  assert.equal(r.status, 200, JSON.stringify(r.json));
  log(`start: wiped ${JSON.stringify(r.json.removed)}`);

  // 2. Every fixture: the Archive's verdict is the table's.
  const table = JSON.parse(fs.readFileSync(path.join(fixtures, "verdicts.json"), "utf8"));
  const accepted = {};
  for (const c of table.classes) {
    r = await upload(path.join(fixtures, c.fixture));
    const want = c.archive;
    log(`${c.class}: ${r.status} ${r.json?.status} ${r.json?.code ?? ""} ${(r.json?.reasons ?? []).join("; ").slice(0, 120)}`);
    assert.equal(r.status, want.http, `${c.class}: HTTP ${r.status}, expected ${want.http}: ${JSON.stringify(r.json)}`);
    assert.equal(r.json?.status, want.status, `${c.class}: status`);
    if (want.code) assert.equal(r.json?.code, want.code, `${c.class}: code`);
    assert.equal(r.json?.test, true, `${c.class}: taken as a test`);
    if (r.json?.submission && want.status === "review") {
      const back = await call("GET", `/api/v1/e2e/submissions/${r.json.submission}`);
      assert.equal(back.status, 200, `${c.class}: readback`);
      if (want.unmet) for (const u of want.unmet) assert.ok((back.json.verdict?.unmet ?? []).some((x) => JSON.stringify(x).includes(u)), `${c.class}: unmet ${u} in ${JSON.stringify(back.json.verdict?.unmet)}`);
      if (want.mock) assert.equal(back.json.verdict?.mock, true, `${c.class}: the readback says mock`);
      accepted[c.class] = r.json.submission;
    }
  }

  // 3. Accept the mock and the hostile strings: hidden, and nothing raw on the rendered page.
  for (const cls of ["mock", "hostile-strings"]) {
    if (!accepted[cls]) continue;
    const acc = await call("POST", `/api/v1/e2e/submissions/${accepted[cls]}/accept`);
    assert.equal(acc.status, 200, `${cls}: accept ${JSON.stringify(acc.json)}`);
    assert.equal(acc.json.hidden, true, `${cls}: hidden`);
    const page = await call("GET", `/api/v1/e2e/runs/${encodeURIComponent(acc.json.run)}`);
    assert.equal(page.status, 200);
    assert.equal(page.json.hidden, true);
    if (cls === "hostile-strings") {
      // The hostile string sits in every field the pages show: it must be there, escaped, and nowhere raw.
      for (const [which, html] of [["run page", page.json.html], ["agent page", page.json.agent_html]]) {
        if (html === undefined) { log(`${cls}: the readback has no ${which} yet`); continue; }
        assert.doesNotMatch(html, /<script>alert\("aas"\)<\/script>|<img src=x onerror/i, `no hostile tag survives on the ${which}`);
        assert.match(html, /&lt;script&gt;alert\(/, `the hostile text is shown, escaped, on the ${which}`);
        assert.doesNotMatch(html, /href\s*=\s*["']?\s*javascript:/i, `no javascript: link on the ${which}`);
      }
    }
    const pub = await fetch(`${base}/runs/${encodeURIComponent(acc.json.run)}/`, { signal: AbortSignal.timeout(30000) });
    assert.equal(pub.status, 404, `${cls}: the public gets 404 for a hidden e2e run`);
    log(`${cls}: accepted as ${acc.json.run}, hidden, public 404`);
  }

  // 4. A run with proof on the Archive's own tickets, uploaded; the heads the Archive stored are the bundle's.
  useArchiveFetch(archiveFetch);
  const saved = Object.fromEntries(["AAS_PROOF", "XDG_CONFIG_HOME"].map((k) => [k, process.env[k]]));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "aas-e2e-chain-"));
  process.env.XDG_CONFIG_HOME = path.join(work, "config");
  process.env.AAS_PROOF = "anonymous";
  try {
    const { run } = await import("../src/run.mjs");
    const { publish } = await import("../src/publish.mjs");
    const { readState } = await import("../src/proof.mjs");
    const fake = path.join(root, "packages", "core", "test", "gui-game", "fake");
    const runDir = path.join(work, "proof-01");
    await run({ runtime: path.join(root, "packages", "runtime-scripted", "index.mjs"), game: path.join(fake, "plugin.mjs"), "run-dir": runDir, bot: path.join(fake, "bot.mjs"), recorder: "null", "keep-open": true }, { log() {} });
    await publish(runDir, path.join(work, "public", "proof-01"), { log() {} });
    const state = readState(runDir);
    assert.ok(state.tickets.length === 1 && state.heads.length >= 2, "one ticket, a start and an end head");
    r = await upload(path.join(work, "public", "proof-01-upload.zip"));
    log(`signed: ${r.status} ${r.json?.status} proof ${r.json?.proof}`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.proof, "signed", "the Archive checked the proof as signed");
    const t = await call("GET", `/api/v1/e2e/tickets/${state.tickets[0].ticket}`);
    assert.equal(t.status, 200);
    assert.deepEqual(t.json.heads.map((h) => h.head), state.heads.map((h) => h.head), "the Archive stored exactly the bundle's heads");
    // The run accepted, then a new revision of the same run: its tickets are its own, so the proof stays signed.
    const acc = await call("POST", `/api/v1/e2e/submissions/${r.json.submission}/accept`);
    assert.equal(acc.status, 200, `accept the signed run: ${JSON.stringify(acc.json)}`);
    await publish(runDir, path.join(work, "public", "proof-01-r2"), { log() {} });
    const again = await upload(path.join(work, "public", "proof-01-r2-upload.zip"), "proof-01-r2-upload.zip");
    log(`new revision, same run: ${again.status} ${again.json?.status} proof ${again.json?.proof}`);
    assert.equal(again.status, 200, JSON.stringify(again.json));
    assert.equal(again.json.proof, "signed", "a new revision of the same run keeps its signed proof");
    // The same logs and ticket under another run (another run id and run_uid): a ticket that was submitted with one
    // run shows up in a second one, and the proof goes to a reviewer with the reason.
    const { readZipEntries } = await import("../src/zip-read.mjs");
    const { asOwnRun, writeZip } = await import("../../spec/fixtures/make-fixtures.mjs");
    const other = asOwnRun(readZipEntries(path.join(work, "public", "proof-01-upload.zip")).map((e) => ({ name: e.name, data: e.data })), "proof-02", "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f");
    fs.writeFileSync(path.join(work, "proof-02.zip"), writeZip(other));
    const foreign = await upload(path.join(work, "proof-02.zip"));
    const back = foreign.json?.submission ? await call("GET", `/api/v1/e2e/submissions/${foreign.json.submission}`) : null;
    log(`ticket of another run: ${foreign.status} ${foreign.json?.status} ${foreign.json?.code ?? ""} proof ${JSON.stringify(back?.json?.verdict?.proof ?? foreign.json?.proof).slice(0, 200)}`);
    assert.equal(foreign.status, 200, JSON.stringify(foreign.json));
    assert.equal(back.json.verdict?.proof?.status, "review", "a ticket submitted with another run sends the proof to a reviewer");
    assert.ok((back.json.verdict?.proof?.review ?? []).length > 0, "with the reason");
  } finally {
    useArchiveFetch(null);
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }

  // 5. Hostile requests: each refused with a code, nothing kept.
  const bare = async (method, p, headers = {}, body = null) => { const res = await fetch(`${base}${p}`, { method, headers, body, signal: AbortSignal.timeout(30000) }); let j = null; try { j = await res.json(); } catch { /* */ } return { status: res.status, json: j }; };
  r = await bare("GET", "/api/v1/e2e/submissions/1", { "X-AAS-E2E": `${new Date().toISOString()} ${"A".repeat(86)}==` });
  assert.equal(r.status, 401, "a forged e2e signature is refused");
  assert.equal(r.json?.code, "auth.e2e");
  r = await bare("DELETE", "/api/v1/e2e/");
  assert.equal(r.status, 401, "the wipe without a signature is refused");
  r = await upload(path.join(fixtures, "mock.zip"), "../../etc/passwd.zip");
  log(`hostile filename: ${r.status} ${r.json?.code}`);
  assert.ok(r.status >= 400 || r.json?.code === null, "a filename that climbs out is refused or ignored");
  if (r.status >= 400) assert.equal(r.json?.code, "upload.filename");
  r = await call("GET", "/api/v1/e2e/tickets/00000000000000000000000000000000");
  assert.equal(r.status, 404, "another account's or no ticket: not found");

  // 6. Wipe, with the counts, and nothing left to read back.
  r = await call("DELETE", "/api/v1/e2e/");
  assert.equal(r.status, 200);
  log(`end: wiped ${JSON.stringify(r.json.removed)}`);
  assert.ok(r.json.removed.submissions >= Object.keys(accepted).length, "the fixtures' submissions were wiped");
  for (const id of Object.values(accepted)) assert.equal((await call("GET", `/api/v1/e2e/submissions/${id}`)).status, 404, "nothing to read back after the wipe");
});

// The Archive's read API and its OpenAPI document (the maintainer's order, 2026-09-27: "swagger and the API are part
// of the e2e"). The read side takes an API token made on the account page; the e2e account's token is kept next to
// its password in ~/.config/aas/e2e-login.json (`api_token`). A run the account accepted is read back through
// /api/v1/runs/<id> with the token and refused without one; the OpenAPI document lists the paths the tooling uses.
const loginFile = path.join(os.homedir(), ".config", "aas", "e2e-login.json");
const apiToken = (() => { try { return JSON.parse(fs.readFileSync(loginFile, "utf8")).api_token ?? null; } catch { return null; } })();
const skipApi = skip || (!apiToken ? "no api_token in ~/.config/aas/e2e-login.json: the e2e account's API token is not on this machine" : false);

test("the read API answers the token on runs, games and stats, refuses without one, keeps a hidden run 404 for everyone; the OpenAPI document lists the tooling's paths", { skip: skipApi, timeout: 300000 }, async () => {
  const { archiveFetch } = await import(pathToFileURL(hook).href);
  const { proofUrl } = await import("../src/proof.mjs");
  const base = proofUrl();
  const call = async (method, p, { body = null, headers = {}, plain = false } = {}) => {
    const res = await (plain ? fetch : archiveFetch)(`${base}${p}`, { method, headers: { Accept: "application/json", ...headers }, body, signal: AbortSignal.timeout(120000) });
    let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, json, headers: res.headers };
  };
  let r = await call("DELETE", "/api/v1/e2e/");
  assert.equal(r.status, 200, JSON.stringify(r.json));
  try {
    // A run the account accepted: the mock fixture, taken in for review and accepted (hidden, as every e2e run is).
    r = await call("POST", "/api/v1/bundles", { body: fs.readFileSync(path.join(fixtures, "mock.zip")), headers: { "Content-Type": "application/zip", "X-Filename": "mock.zip" } });
    assert.equal(r.status, 200, `upload: ${JSON.stringify(r.json)}`);
    const acc = await call("POST", `/api/v1/e2e/submissions/${r.json.submission}/accept`);
    assert.equal(acc.status, 200, `accept: ${JSON.stringify(acc.json)}`);
    const run = acc.json.run;
    log(`accepted as ${run}`);

    // The read API: with the token, the run; without one, 401 and the way to a token.
    const noToken = await call("GET", `/api/v1/runs/${encodeURIComponent(run)}`, { plain: true });
    assert.equal(noToken.status, 401, "the read API wants a token");
    assert.match(noToken.headers.get("www-authenticate") ?? "", /Bearer/, "WWW-Authenticate: Bearer");
    // With the token: the API shares only what the site shows everyone (the maintainer, 2026-09-27: "the API is for
    // outside queries; reviewer or owner makes no difference"). A hidden run, which every e2e run is, is 404 with the
    // token as without a session on the page; its own account reads it through the e2e endpoint.
    const withToken = await call("GET", `/api/v1/runs/${encodeURIComponent(run)}`, { plain: true, headers: { Authorization: `Bearer ${apiToken}` } });
    assert.equal(withToken.status, 404, `a hidden run with the token: ${JSON.stringify(withToken.json).slice(0, 200)}`);
    assert.match(withToken.json?.error?.message ?? "", /not published|No run is published/, "the 404 says the run is not published");
    const own = await call("GET", `/api/v1/e2e/runs/${encodeURIComponent(run)}`);
    assert.equal(own.status, 200);
    assert.equal(own.json.hidden, true);
    log(`the hidden run is 404 through the API, with the token too (the API shares only what is public); read back through the e2e endpoint`);
    for (const p of ["/api/v1/runs", "/api/v1/games", "/api/v1/stats"]) {
      const r2 = await call("GET", p, { plain: true, headers: { Authorization: `Bearer ${apiToken}` } });
      assert.equal(r2.status, 200, `${p} answers the token: ${JSON.stringify(r2.json).slice(0, 120)}`);
      const r3 = await call("GET", p, { plain: true });
      assert.equal(r3.status, 401, `${p} without a token`);
    }
    log("the read API answers the token on runs, games and stats, and refuses without one");

    // The OpenAPI document: every path the tooling calls is in it, with the method the tooling uses.
    const spec = await call("GET", "/api/openapi.json", { plain: true });
    assert.equal(spec.status, 200);
    assert.match(String(spec.json?.openapi ?? ""), /^3\./, "an OpenAPI 3 document");
    for (const [p, method] of [["/api/v1/tickets", "post"], ["/api/v1/tickets/{ticket}/heads", "post"], ["/api/v1/bundles", "post"], ["/api/v1/runs/{run}", "get"]]) {
      assert.ok(spec.json.paths?.[p], `${p} is in the OpenAPI document`);
      assert.ok(spec.json.paths[p][method], `${method.toUpperCase()} ${p} is in the OpenAPI document`);
    }
    log(`openapi ${spec.json.openapi}: ${Object.keys(spec.json.paths).length} paths, the tooling's four among them`);
    const docs = await fetch(`${base}/api/docs/`, { signal: AbortSignal.timeout(60000) });
    assert.equal(docs.status, 200, "Swagger UI answers");
    assert.match(await docs.text(), /swagger|openapi/i, "Swagger UI is the page at /api/docs/");
  } finally {
    r = await call("DELETE", "/api/v1/e2e/");
    log(`wiped ${JSON.stringify(r.json?.removed)}`);
  }
});
