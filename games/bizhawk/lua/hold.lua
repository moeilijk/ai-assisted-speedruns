-- Holds the buttons the harness names for every frame, set inside the frame (event.onframestart runs after BizHawk has
-- cleared the previous frame's overrides), so they reach the game. The harness names them with userdata "aas_held",
-- a "+"-separated list such as "Right+B", through bizhawk-mcp-native's userdata_set. Reset and Power are console
-- buttons and are set without a controller number.
event.onframestart(function()
  local held = userdata.get("aas_held") or ""
  local pad, console = {}, {}
  for b in string.gmatch(held, "[^+]+") do
    if b == "Reset" or b == "Power" then console[b] = true else pad[b] = true end
  end
  joypad.set(pad, 1)
  if next(console) then joypad.set(console) end
end, "aas-hold")
