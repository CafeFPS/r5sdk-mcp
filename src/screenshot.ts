// Window capture of the running game through PrintWindow with
// PW_RENDERFULLCONTENT, so it works while the game is unfocused or covered.
// Runs in Windows PowerShell so the server needs no native modules.

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SCRIPT = String.raw`
param([string]$ProcName, [string]$OutPath, [int]$MaxWidth, [int]$Quality)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class R5Cap {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
}
"@
$p = Get-Process -Name $ProcName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Output "ERR $ProcName has no window (is the game running?)"; exit 0 }
$h = $p.MainWindowHandle
if ([R5Cap]::IsIconic($h)) { Write-Output "ERR game window is minimised"; exit 0 }
$r = New-Object R5Cap+RECT
[void][R5Cap]::GetWindowRect($h, [ref]$r)
$w = $r.R - $r.L; $ht = $r.B - $r.T
if ($w -le 0 -or $ht -le 0) { Write-Output "ERR window has no area"; exit 0 }
$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$dc = $g.GetHdc()
$ok = [R5Cap]::PrintWindow($h, $dc, 2)
$g.ReleaseHdc($dc); $g.Dispose()
if (-not $ok) { Write-Output "ERR PrintWindow failed"; exit 0 }
$outW = [Math]::Min($w, $MaxWidth); $outH = [int]($ht * $outW / $w)
$scaled = New-Object System.Drawing.Bitmap $outW, $outH
$g2 = [System.Drawing.Graphics]::FromImage($scaled)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.DrawImage($bmp, 0, 0, $outW, $outH); $g2.Dispose(); $bmp.Dispose()
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$ep = New-Object System.Drawing.Imaging.EncoderParameters 1
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([long]$Quality)
$scaled.Save($OutPath, $codec, $ep); $scaled.Dispose()
Write-Output "OK $w $ht $outW $outH"
`;

export interface Screenshot {
  data: string;
  mimeType: string;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  path: string;
}

let scriptPath: string | null = null;

function ensureScript(): string {
  if (scriptPath && fs.existsSync(scriptPath)) return scriptPath;
  const dir = path.join(os.tmpdir(), "r5sdk-mcp");
  fs.mkdirSync(dir, { recursive: true });
  scriptPath = path.join(dir, "capture.ps1");
  fs.writeFileSync(scriptPath, SCRIPT, "utf8");
  return scriptPath;
}

export async function captureGameWindow(
  processName: string,
  maxWidth = 1280,
  quality = 80,
  keepDir?: string
): Promise<Screenshot> {
  if (process.platform !== "win32") throw new Error("screenshots need Windows");
  const dir = keepDir ?? path.join(os.tmpdir(), "r5sdk-mcp");
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `shot_${Date.now()}.jpg`);

  const stdout: string = await new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ensureScript(), processName, out, String(maxWidth), String(quality)],
      { timeout: 20000, windowsHide: true },
      (err, so, se) => {
        if (err) reject(new Error(`capture failed: ${se || err.message}`));
        else resolve(so.trim());
      }
    );
  });

  const last = stdout.split(/\r?\n/).pop() ?? "";
  if (!last.startsWith("OK ")) throw new Error(last.replace(/^ERR /, "") || "capture failed");
  const [, sw, sh, w, h] = last.split(" ");
  const data = fs.readFileSync(out).toString("base64");
  if (!keepDir) fs.rmSync(out, { force: true });
  return {
    data,
    mimeType: "image/jpeg",
    width: Number(w),
    height: Number(h),
    sourceWidth: Number(sw),
    sourceHeight: Number(sh),
    path: keepDir ? out : "",
  };
}
