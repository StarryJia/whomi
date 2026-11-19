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
}
'@

[void][WhomiExplorer]::SetProcessDpiAwarenessContext([IntPtr](-4))
$shell = New-Object -ComObject Shell.Application
for ($attempt = 0; $attempt -lt 40; $attempt++) {
  foreach ($window in $shell.Windows()) {
    try { $path = $window.Document.Folder.Self.Path } catch { continue }
    if ($path -ne $Directory) { continue }
    $bounds = New-Object WhomiExplorer+Rect
    if (![WhomiExplorer]::GetWindowRect([IntPtr]([long]$window.HWND), [ref]$bounds)) { throw 'Explorer bounds unavailable.' }
    $bitmap = New-Object Drawing.Bitmap ($bounds.Right - $bounds.Left), ($bounds.Bottom - $bounds.Top)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bitmap.Size)
      $bitmap.Save($Screenshot, [Drawing.Imaging.ImageFormat]::Png)
    } finally { $graphics.Dispose(); $bitmap.Dispose() }
    Write-Output $path
    exit 0
  }
  Start-Sleep -Milliseconds 250
}
throw "Explorer did not open the expected directory: $Directory"
