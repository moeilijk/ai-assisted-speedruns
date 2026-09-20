// Recorder that records nothing. For developing games and runtimes; a run
// made with it is never a valid AI Assisted Speedrun.
export default {
  id: "null",
  name: "No recording (never a valid run)",
  version: "0.29.1",
  async preflight() {},
  async start() {
    return { t0: new Date() };
  },
  async onEvent() {},
  async stop() {
    return { files: [], t0: new Date(), chapters: [] };
  },
};
