// A timer for tests: keeps every event the harness gives it, in globalThis.aasTimerEvents.
export default {
  id: "recording-timer",
  async start() { globalThis.aasTimerEvents = []; },
  async onEvent(event) { globalThis.aasTimerEvents?.push(event); },
  async stop() { return { igt: null, times: null }; },
};
