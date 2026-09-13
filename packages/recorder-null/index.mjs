// Recorder that records nothing. For developing games and runtimes; a run
// made with it is never a valid AI Assisted Speedrun.
export default {
  id: "null",
  version: "0.1.0",
  async preflight() {},
  async start() {
    return { t0: new Date() };
  },
  async onEvent() {},
  async stop() {
    return { files: [], t0: new Date(), chapters: [] };
  },
};
