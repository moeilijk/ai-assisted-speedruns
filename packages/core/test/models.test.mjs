import { test } from "node:test";
import assert from "node:assert/strict";
import { modelParts } from "../src/models.mjs";

test("a model id is split into name, variant, version and snapshot; an unknown id has no parts", () => {
  assert.deepEqual(modelParts("claude-sonnet-5"), { name: "claude", variant: "sonnet", version: "5", snapshot: null });
  assert.deepEqual(modelParts("claude-fable-5-1"), { name: "claude", variant: "fable", version: "5.1", snapshot: null });
  assert.deepEqual(modelParts("claude-haiku-4-5-20251001"), { name: "claude", variant: "haiku", version: "4.5", snapshot: "20251001" });
  assert.deepEqual(modelParts("claude-3-5-sonnet-20241022"), { name: "claude", variant: "sonnet", version: "3.5", snapshot: "20241022" });
  assert.deepEqual(modelParts("gpt-5.6-luna"), { name: "gpt", variant: "luna", version: "5.6", snapshot: null });
  assert.deepEqual(modelParts("gpt-5.5"), { name: "gpt", variant: null, version: "5.5", snapshot: null });
  for (const id of ["claude-sonnet-5[1m]", "o3", "gemini-3-pro", "<synthetic>", "stub-model"]) assert.equal(modelParts(id), null, id);
});
