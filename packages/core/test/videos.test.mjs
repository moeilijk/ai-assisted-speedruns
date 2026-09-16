// The videos a runner may upload, as the bundle lists them (summary.recording.videos, schema 8).
import { test } from "node:test";
import assert from "node:assert/strict";
import { recordingVideos, viewerLabel } from "../src/videos.mjs";
import { momentLabel, videoDescription, videoMoments, videoTitle, youtubeChapters } from "../src/youtube-text.mjs";
import { modelDisplayName } from "../src/models.mjs";

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

test("timestamps are called chapters only when YouTube makes chapters of them", () => {
  const at = (...xs) => xs.map((x, i) => ({ at: x, label: `c${i}` }));
  assert.equal(youtubeChapters(at(0, 130), 199), false, "two timestamps are not enough");
  assert.equal(youtubeChapters(at(0, 60, 120), 199), true);
  assert.equal(youtubeChapters(at(5, 60, 120), 199), false, "the first is not 0:00");
  assert.equal(youtubeChapters(at(0, 60, 65), 199), false, "a chapter shorter than ten seconds");
  assert.equal(youtubeChapters(at(0, 60, 195), 199), false, "the last chapter is shorter than ten seconds");
});

test("moments read as sentences, and moments close together share a line", () => {
  const summary = { ends: [{ id: "act1", label: "Act 1 boss" }, { id: "act3", label: "Act 3 boss" }] };
  assert.equal(momentLabel("Human: resumed after stopped"), "A human restarted the agent after it stopped");
  assert.equal(momentLabel("Human: resumed after completed"), "A human restarted the agent after it reached its goal");
  assert.equal(momentLabel("Human: goal extended from act1 to act3", summary), "Goal extended from Act 1 boss to Act 3 boss");
  assert.equal(momentLabel("Act 1 boss"), "Act 1 boss");
  assert.deepEqual(videoMoments([
    { at: 0, label: "Start" }, { at: 675.516, label: "Act 1 boss" },
    { at: 678.031, label: "Human: resumed after completed" }, { at: 678.031, label: "Human: goal extended from act1 to act3" },
  ], summary), [
    { at: 0, label: "Start" },
    { at: 675.516, label: "Act 1 boss; a human restarted the agent after it reached its goal; goal extended from Act 1 boss to Act 3 boss" },
  ]);
  assert.deepEqual(videoMoments([{ at: 0, label: "Start" }]), [], "a start alone is not worth listing");
});

test("a model is named for people when its parts are known", () => {
  assert.equal(modelDisplayName("claude-sonnet-5"), "Claude Sonnet 5");
  assert.equal(modelDisplayName("claude-haiku-4-5-20251001"), "Claude Haiku 4.5");
  assert.equal(modelDisplayName("gpt-5.6-luna"), "GPT-5.6 Luna");
  assert.equal(modelDisplayName("stub-model"), "stub-model");
});

test("a video's text tells what that video shows, and nothing it does not", () => {
  const summary = {
    run_id: "sts-x", completed_at: "t", totals_to_completion: { igt_seconds: 177.48, rta_seconds: 1362.6 },
    models: [{ model: "claude-sonnet-5" }], game: { game: "Slay the Spire" },
    harness: { plugins: { runtime: { name: "Claude Code" }, recorder: { id: "obs" }, timer: { id: "livesplit" } } },
    category: { goal_end: { id: "act1", label: "Act 1 boss" }, human: "none" }, ends: [{ id: "act1", label: "Act 1 boss" }, { id: "act3", label: "Act 3 boss" }],
    recording: { duration_seconds: 1559, igt_seconds: 217.26, overlay: { shown: true, keys: false } },
  };
  const part1 = { kind: "segment", part: 1, parts: 2, seconds: 1368, line: "AAS sts-x · fingerprint f · 1368 s", chapters: [{ at: 0, label: "Start" }, { at: 1362.6, label: "Act 1 boss" }] };
  const part2 = { kind: "segment", part: 2, parts: 2, seconds: 191, line: "AAS sts-x · fingerprint f · 191 s", chapters: [{ at: 5, label: "Human: resumed after completed" }, { at: 5, label: "Human: goal extended from act1 to act3" }] };
  const one = videoDescription(summary, part1, { archiveUrl: "https://ai-assisted-speedruns.org" });
  const two = videoDescription(summary, part2, { archiveUrl: "https://ai-assisted-speedruns.org" });
  assert.equal(videoTitle(summary, part1), "Claude Sonnet 5 plays Slay the Spire (part 1 of 2) — reached the Act 1 boss in 2m 57.4s");
  assert.match(one, /^Claude Sonnet 5, a language model, plays Slay the Spire by itself\. Its goal was the Act 1 boss; it got there in 2m 57\.4s of game time \(22m 42\.6s of real time\)\./);
  assert.match(one, /Top left is LiveSplit/);
  assert.match(one, /Bottom left are the name of the current section, two clocks, real time \(RTA\) and game time \(IGT\), and the last command/);
  assert.match(one, /At 22:42 it reached the Act 1 boss\./);
  assert.doesNotMatch(one, /Act 3/, "the extension is not in part 1");
  assert.match(two, /At 0:05 a person started the model again with a new goal, the Act 3 boss, which it did not reach\./);
  assert.doesNotMatch(two + one, /Claude Code|https?:|Moments/);
  assert.equal(one.split("\n").at(-1), "AAS sts-x · fingerprint f · 1368 s");
  assert.equal(videoTitle({ ...summary, completed_at: null, category: { goal_end: { id: "credits", label: "End credits" } } }, { kind: "cut" }), "Claude Sonnet 5 plays Slay the Spire (cut) — stopped before the end credits");
});

test("a recording without a measured length lists no whole video, whose line nothing could back", () => {
  const one = { segments: [{ index: 0, offset: 0, seconds: 2.74, file: null }], sections: [], keep: [], totals: {} };
  assert.deepEqual(recordingVideos({ runId: "x", fingerprint: "f", durationSeconds: null, files: ["recording/a.dem"], timeline: one }), []);
});
