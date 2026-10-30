param([string]$Version = (Get-Content (Join-Path $PSScriptRoot '..\package.json') -Raw | ConvertFrom-Json).version)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

Add-Type @"
  using System;
  using System.Text;
  using System.Collections.Generic;
  using System.Runtime.InteropServices;

  public class WinUtils {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBmp, uint nFlags);

    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
      public int Left;
      public int Top;
      public int Right;
      public int Bottom;
    }
  }
"@

function Capture-Window($hwnd, $outputPath) {
  $rect = New-Object WinUtils+RECT
  [WinUtils]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
  $w = [Math]::Max(100, $rect.Right - $rect.Left)
  $h = [Math]::Max(100, $rect.Bottom - $rect.Top)

  $bmp = New-Object System.Drawing.Bitmap ([int]$w), ([int]$h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  $ok = [WinUtils]::PrintWindow($hwnd, $hdc, 0)
  $g.ReleaseHdc($hdc)

  if ($ok) {
    $bmp.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Host "Screenshot saved to: $outputPath"
  }
  $g.Dispose()
  $bmp.Dispose()
}

$installerPath = (Resolve-Path (Join-Path $PSScriptRoot "..\release\Whomi Setup $Version.exe")).Path
Write-Host "Launching installer: $installerPath"

$proc = Start-Process -FilePath $installerPath -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 3

$foundHwnd = [IntPtr]::Zero
$foundTitle = ""

$enumProc = [WinUtils+EnumWindowsProc]{
  param([IntPtr]$hWnd, [IntPtr]$lParam)
  $ownerId = [uint32]0
  [WinUtils]::GetWindowThreadProcessId($hWnd, [ref]$ownerId) | Out-Null
  if ($ownerId -ne $proc.Id) { return $true }
  if ([WinUtils]::IsWindowVisible($hWnd)) {
    $titleBuf = New-Object System.Text.StringBuilder 256
    [WinUtils]::GetWindowText($hWnd, $titleBuf, 256) | Out-Null
    $t = $titleBuf.ToString()

    $classBuf = New-Object System.Text.StringBuilder 256
    [WinUtils]::GetClassName($hWnd, $classBuf, 256) | Out-Null
    $c = $classBuf.ToString()

    if ($t -match "Whomi" -or $c -match "#32770") {
      $rect = New-Object WinUtils+RECT
      [WinUtils]::GetWindowRect($hWnd, [ref]$rect) | Out-Null
      $w = $rect.Right - $rect.Left
      $h = $rect.Bottom - $rect.Top
      if ($w -gt 200 -and $h -gt 200) {
        $script:foundHwnd = $hWnd
        $script:foundTitle = $t
        return $false
      }
    }
  }
  return $true
}

[WinUtils]::EnumWindows($enumProc, [IntPtr]::Zero) | Out-Null

$evidenceDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\release\validation-$Version"))
[System.IO.Directory]::CreateDirectory($evidenceDir) | Out-Null
$dirScreenshotPath = Join-Path $evidenceDir "09-installer-directory-selection.png"

if ($foundHwnd -ne [IntPtr]::Zero) {
  Write-Host "Found installer window: HWND=$foundHwnd"

  $nextBtnHwnd = [IntPtr]::Zero
  $childProc = [WinUtils+EnumWindowsProc]{
    param([IntPtr]$hWnd, [IntPtr]$lParam)
    $titleBuf = New-Object System.Text.StringBuilder 256
    [WinUtils]::GetWindowText($hWnd, $titleBuf, 256) | Out-Null
    $t = $titleBuf.ToString()

    $classBuf = New-Object System.Text.StringBuilder 256
    [WinUtils]::GetClassName($hWnd, $classBuf, 256) | Out-Null
    $c = $classBuf.ToString()

    # Match Next button (e.g. Next or >)
    if ($t -match ">" -or $t -match "Next") {
      $script:nextBtnHwnd = $hWnd
    }
    return $true
  }
  [WinUtils]::EnumChildWindows($foundHwnd, $childProc, [IntPtr]::Zero) | Out-Null

  if ($nextBtnHwnd -ne [IntPtr]::Zero) {
    Write-Host "Clicking Next button (HWND=$nextBtnHwnd) to advance to directory selection..."
    # BM_CLICK = 0x00F5
    [WinUtils]::SendMessage($nextBtnHwnd, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    Start-Sleep -Seconds 1
  }

  Write-Host "--- Controls on Directory Selection Page ---"
  $childProc2 = [WinUtils+EnumWindowsProc]{
    param([IntPtr]$hWnd, [IntPtr]$lParam)
    $titleBuf = New-Object System.Text.StringBuilder 256
    [WinUtils]::GetWindowText($hWnd, $titleBuf, 256) | Out-Null
    $t = $titleBuf.ToString()

    $classBuf = New-Object System.Text.StringBuilder 256
    [WinUtils]::GetClassName($hWnd, $classBuf, 256) | Out-Null
    $c = $classBuf.ToString()

    if ($t.Length -gt 0 -or $c -eq "Edit") {
      Write-Host "  Control: Class=$c, Text=$t"
    }
    return $true
  }
  [WinUtils]::EnumChildWindows($foundHwnd, $childProc2, [IntPtr]::Zero) | Out-Null

  Capture-Window $foundHwnd $dirScreenshotPath

  # WM_CLOSE = 0x0010
  Write-Host "Cancelling installation via WM_CLOSE..."
  [WinUtils]::PostMessage($foundHwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
  Start-Sleep -Seconds 1
} else {
  Write-Warning "Could not find installer window"
}

if (!$proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
if ($foundHwnd -eq [IntPtr]::Zero) { throw '未找到本次启动的安装向导，请手动验收。' }
Write-Host "Installer verification completed."
