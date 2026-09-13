// The brightness reader the recorder judges a capture by: a black image reads 0, a grey one its grey value,
// and the five PNG scanline filters all decode to the same pixels.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pngMeanLuma } from "../png-luma.mjs";
import { BLACK_PNG, GREY_PNG } from "./fake-obs.mjs";

test("black is 0, mid grey is 128", () => {
  assert.equal(pngMeanLuma(BLACK_PNG), 0);
  assert.equal(pngMeanLuma(GREY_PNG), 128);
});

test("a PNG that is not 8-bit RGB/RGBA is refused, not misjudged", () => {
  const png = Buffer.from(GREY_PNG, "base64");
  png[24] = 16; // bit depth
  assert.throws(() => pngMeanLuma(png), /only 8-bit/);
});
