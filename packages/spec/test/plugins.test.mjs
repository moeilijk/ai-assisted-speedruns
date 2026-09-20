// packages/spec/plugins.json is what says which plugin version belongs to which files. These tests fail while it
// is out of date, so a plugin cannot change without someone running the generator, and the generator refuses while
// a changed plugin still carries its old version. Together that is the rule: files change, the version changes.
import assert from "node:assert/strict";
import test from "node:test";
import { PLUGINS_FILE, pluginRows, readPublished, staleVersions } from "../make-plugins.mjs";

test("plugins.json holds every plugin in this checkout, as it is on disk", async () => {
  const published = readPublished();
  assert.ok(published, `${PLUGINS_FILE} is missing: run node packages/spec/make-plugins.mjs --write`);
  const rows = await pluginRows();
  assert.deepEqual(
    published.plugins,
    rows,
    "plugins.json is out of date: run node packages/spec/make-plugins.mjs --write (it refuses while a changed plugin keeps its version)",
  );
});

test("no plugin changed while keeping the version it had", async () => {
  const stale = staleVersions(await pluginRows());
  assert.deepEqual(stale.map((r) => r.dir), [], "these plugins changed and still carry their old version: give each the release you are making");
});

test("a changed plugin that keeps its version is what the guard catches", async () => {
  const rows = await pluginRows();
  const one = rows.find((r) => r.kind === "runtime");
  const published = { plugins: rows.map((r) => (r === one ? { ...r, sha256: "0".repeat(64) } : r)) };
  assert.deepEqual(staleVersions(rows, published).map((r) => r.dir), [one.dir], "a different hash with the same version is stale");
  const bumped = { plugins: published.plugins.map((r) => (r.dir === one.dir ? { ...r, version: "0.0.1-before" } : r)) };
  assert.deepEqual(staleVersions(rows, bumped), [], "a different hash with a different version is what a release looks like");
  const added = { plugins: published.plugins.filter((r) => r.dir !== one.dir) };
  assert.deepEqual(staleVersions(rows, added), [], "a plugin that is new here has nothing to be stale against");
});

test("every plugin that is not a stub carries a version, and the stubs are the ones at 0.0.0", async () => {
  for (const r of await pluginRows()) {
    assert.match(r.version ?? "", /^\d+\.\d+\.\d+$/, `${r.dir} has no version`);
    if (r.kind === "game" && r.stub) assert.equal(r.version, "0.0.0", `${r.dir} is a stub, so it has not been released`);
    else assert.notEqual(r.version, "0.0.0", `${r.dir} is not a stub, so 0.0.0 says nothing`);
  }
});
