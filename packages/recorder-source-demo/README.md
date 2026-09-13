# @aas/recorder-source-demo

Recorder plugin for Source games with portal-agent's SPT patch: the recording is the in-game demo that `start_run` / `stop_run` drive. The Portal game plugin sends those commands over the SPT IPC (`prepareRun` / `endRun`, called by `aas run` after the recorder started and after the agent stopped); this recorder only notes which `<gameRoot>/portal/agent_runs/<timestamp>/` directory is new and collects its `.dem` files into `<run>/recording/`.

Set `AAS_PORTAL_GAME_ROOT` to the Source Unpack folder. A Source demo only contains simulated ticks, so the agent's thinking pauses are not in it; it is the exact record of the run, not a video. The YouTube-style video comes from the OBS recorder plus `aas render`.
