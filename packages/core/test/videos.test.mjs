// The videos a runner may upload, as the bundle lists them (summary.recording.videos, schema 8).
import { test } from "node:test";
import assert from "node:assert/strict";
import { recordingVideos, viewerLabel } from "../src/videos.mjs";

const timeline = {
  segments: [{ index: 0, offset: 0, seconds: 302.936, file: "recording/AAS_portal-02_1.mp4" }, { index: 1, offset: 302.936, seconds: 328.585, file: "recording/AAS_portal-02_2.mp4" }],
  sections: [{ label: "Start", start_rta: 0 }, { label: "Human: resumed from save aas_portal_02_001 after stopped (claude -p exited with 1; 84 assistant turns; cost $1.58; error_max_turns)", start_rta: 316.128 }],
  totals: { cut_video: 199.354 },
  cut_chapters: [{ at: 0, label: "Start" }, { at: 130.844, label: "Human: resumed from save aas_portal_02_001 after stopped (claude -p exited with 1)" }],
  keep: [[0, 199.354]],
};

test("a resumed run lists one video per segment and the cut, each with its own length, line and chapters", () => {
  const videos = recordingVideos({ runId: "portal-02", fingerprint: "bc91c3b4666f43a9ffff", durationSeconds: 632, files: ["recording/AAS_portal-02_1.mp4", "recording/AAS_portal-02_2.mp4"], timeline });
  assert.deepEqual(videos.map((v) => [v.kind, v.part, v.parts, v.seconds, v.line]), [
    ["segment", 1, 2, 302.936, "AAS portal-02 · fingerprint bc91c3b4666f43a9 · 303 s"],
    ["segment", 2, 2, 328.585, "AAS portal-02 · fingerprint bc91c3b4666f43a9 · 329 s"],
    ["cut", null, null, 199.354, "AAS portal-02 · fingerprint bc91c3b4666f43a9 · 199 s"],
  ]);
  assert.deepEqual(videos[0].chapters, [{ at: 0, label: "Start" }]);
  assert.deepEqual(videos[1].chapters, [{ at: 13.192, label: "Human: resumed after stopped" }], "on the segment's own clock, without the harness's details");
  assert.equal(videos[2].file, "recording/AAS_portal-02_1.cut.mp4");
  assert.equal(videos[2].chapters[1].label, "Human: resumed after stopped");
});

test("a run in one file lists the whole recording and the cut", () => {
  const one = { ...timeline, segments: [timeline.segments[0]], sections: [timeline.sections[0]] };
  const videos = recordingVideos({ runId: "portal-01", fingerprint: "a6dbe5f577346982", durationSeconds: 1356, files: ["recording/AAS_portal-01.mp4"], timeline: one });
  assert.deepEqual(videos.map((v) => [v.kind, v.seconds, v.line]), [["whole", 1356, "AAS portal-01 · fingerprint a6dbe5f577346982 · 1356 s"], ["cut", 199.354, "AAS portal-01 · fingerprint a6dbe5f577346982 · 199 s"]]);
});

test("viewer labels drop the save name and the resumed session's details", () => {
  assert.equal(viewerLabel("Human: resumed from save x after failed (claude -p exited with 1; cost $77.53; success)"), "Human: resumed after failed");
  assert.equal(viewerLabel("Act 1 boss"), "Act 1 boss");
});
