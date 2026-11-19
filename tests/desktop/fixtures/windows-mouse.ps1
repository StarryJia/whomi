param(
  [Parameter(Mandatory)][long]$WindowHandle,
  [Parameter(Mandatory)][int]$X,
  [Parameter(Mandatory)][int]$Y,
  [int]$ToX = $X,
  [int]$ToY = $Y
)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class WhomiMouse {
    [StructLayout(LayoutKind.Sequential)]
    private struct Point { public int X, Y; }

    [DllImport("user32.dll")]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    private static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")]
    public static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extraInfo);

    public static bool IsOverWindow(int x, int y, IntPtr window) {
        return GetAncestor(WindowFromPoint(new Point { X = x, Y = y }), 2) == window;
    }
}
'@

[void][WhomiMouse]::SetProcessDpiAwarenessContext([IntPtr](-4))
$target = [IntPtr]$WindowHandle
if ([WhomiMouse]::GetForegroundWindow() -ne $target -or ![WhomiMouse]::IsOverWindow($X, $Y, $target)) {
  throw 'The test window must be in front of the pointer.'
}
if (![WhomiMouse]::SetCursorPos($X, $Y)) { throw 'Could not move the Windows pointer.' }
Start-Sleep -Milliseconds 80
[WhomiMouse]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
try {
  Start-Sleep -Milliseconds 100
  if ($X -ne $ToX -or $Y -ne $ToY) {
    for ($step = 1; $step -le 8; $step++) {
      $nextX = [int]($X + ($ToX - $X) * $step / 8)
      $nextY = [int]($Y + ($ToY - $Y) * $step / 8)
      if (![WhomiMouse]::SetCursorPos($nextX, $nextY)) { throw 'Could not drag the Windows pointer.' }
      Start-Sleep -Milliseconds 30
    }
  }
}
finally { [WhomiMouse]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero) }
