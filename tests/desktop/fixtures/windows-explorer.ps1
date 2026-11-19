param(
  [Parameter(Mandatory)][string]$Directory,
  [Parameter(Mandatory)][string]$Screenshot
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class WhomiExplorer {
    [StructLayout(LayoutKind.Sequential)]
    public struct Rect { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr window, out Rect bounds);
    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr window, IntPtr destination, uint flags);
}
'@

[void][WhomiExplorer]::SetProcessDpiAwarenessContext([IntPtr](-4))
$shell = New-Object -ComObject Shell.Application
for ($attempt = 0; $attempt -lt 40; $attempt++) {
  foreach ($window in $shell.Windows()) {
    try { $path = $window.Document.Folder.Self.Path } catch { continue }
    if ($path -ne $Directory) { continue }
    $target = [IntPtr]([long]$window.HWND)
    $bounds = New-Object WhomiExplorer+Rect
    if (![WhomiExplorer]::GetWindowRect($target, [ref]$bounds)) { throw 'Explorer bounds unavailable.' }
    $bitmap = New-Object Drawing.Bitmap ($bounds.Right - $bounds.Left), ($bounds.Bottom - $bounds.Top)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    try {
      $destination = $graphics.GetHdc()
      try {
        if (![WhomiExplorer]::PrintWindow($target, $destination, 2)) { continue }
      } finally { $graphics.ReleaseHdc($destination) }
      $bitmap.Save($Screenshot, [Drawing.Imaging.ImageFormat]::Png)
    } finally { $graphics.Dispose(); $bitmap.Dispose() }
    Write-Output $path
    exit 0
  }
  Start-Sleep -Milliseconds 250
}
throw "Explorer did not open the expected directory: $Directory"
