#!/usr/bin/env node
// Windows: read the attached displays with their real position and size (EnumDisplayDevices +
// EnumDisplaySettings). The launcher places the game window on the display the recording runs on, using
// these bounds rather than typed coordinates: a display can shift by a pixel, and then part of the window
// falls off the screen and the taskbar ends up in the recording.
//
//   node games/slay-the-spire/primary-display.mjs list
import { execFileSync } from "node:child_process";

const CSHARP = `
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class AasDisplay {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct DISPLAY_DEVICE { public int cb;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string DeviceName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string DeviceString;
    public int StateFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string DeviceID;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string DeviceKey; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string dmDeviceName;
    public short dmSpecVersion; public short dmDriverVersion; public short dmSize; public short dmDriverExtra;
    public int dmFields; public int dmPositionX; public int dmPositionY; public int dmDisplayOrientation; public int dmDisplayFixedOutput;
    public short dmColor; public short dmDuplex; public short dmYResolution; public short dmTTOption; public short dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string dmFormName;
    public short dmLogPixels; public int dmBitsPerPel; public int dmPelsWidth; public int dmPelsHeight;
    public int dmDisplayFlags; public int dmDisplayFrequency; public int dmICMMethod; public int dmICMIntent;
    public int dmMediaType; public int dmDitherType; public int dmReserved1; public int dmReserved2;
    public int dmPanningWidth; public int dmPanningHeight; }
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool EnumDisplayDevices(string dev, uint num, ref DISPLAY_DEVICE d, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool EnumDisplaySettings(string dev, int mode, ref DEVMODE dm);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int ChangeDisplaySettingsEx(string dev, ref DEVMODE dm, IntPtr wnd, uint flags, IntPtr p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="ChangeDisplaySettingsExW")] public static extern int ChangeDisplaySettingsExNull(string dev, IntPtr dm, IntPtr wnd, uint flags, IntPtr p);
}
'@
function Get-AasDisplays {
  $list = @()
  for ($i = 0; $i -lt 16; $i++) {
    $d = New-Object AasDisplay+DISPLAY_DEVICE
    $d.cb = [System.Runtime.InteropServices.Marshal]::SizeOf([type][AasDisplay+DISPLAY_DEVICE])
    # PowerShell turns $null into an empty string for string parameters; the API needs a real NULL.
    if (-not [AasDisplay]::EnumDisplayDevices([NullString]::Value, $i, [ref]$d, 0)) { break }
    if (($d.StateFlags -band 0x1) -eq 0) { continue }
    $dm = New-Object AasDisplay+DEVMODE
    $dm.dmSize = [int16][System.Runtime.InteropServices.Marshal]::SizeOf([type][AasDisplay+DEVMODE])
    [AasDisplay]::EnumDisplaySettings($d.DeviceName, -1, [ref]$dm) | Out-Null
    $list += [pscustomobject]@{ Name=$d.DeviceName; Primary=(($d.StateFlags -band 0x4) -ne 0); X=$dm.dmPositionX; Y=$dm.dmPositionY; W=$dm.dmPelsWidth; H=$dm.dmPelsHeight }
  }
  return $list
}
`;

const run = (script) => execFileSync("powershell.exe", ["-NoProfile", "-Command", `${CSHARP}\n${script}`], { encoding: "utf8" }).replace(/\r/g, "").trim();

/** All attached displays with their position, size and whether they are primary. */
export function listDisplays() {
  const out = run(`Get-AasDisplays | ForEach-Object { $_.Name + '|' + $_.Primary + '|' + $_.X + '|' + $_.Y + '|' + $_.W + '|' + $_.H }`);
  return out.split("\n").filter(Boolean).map((l) => {
    const [name, primary, x, y, w, h] = l.split("|");
    return { name, primary: primary === "True", x: Number(x), y: Number(y), width: Number(w), height: Number(h) };
  });
}

if (process.argv[1]?.endsWith("primary-display.mjs")) {
  for (const d of listDisplays()) console.log(`${d.name}${d.primary ? " (primary)" : ""} ${d.width}x${d.height} at ${d.x},${d.y}`);
}
