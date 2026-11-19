param(
  [Parameter(Mandatory)][string]$Executable,
  [string]$EntryScript,
  [Parameter(Mandatory)][string]$LogFile
)

$ErrorActionPreference = 'Stop'
$profile = $env:WHOMI_RUNTIME_TEST
if (!$profile -or ![IO.Path]::IsPathRooted($profile) -or !(Test-Path -LiteralPath $profile -PathType Container)) {
  throw 'WHOMI_RUNTIME_TEST must name an existing isolated profile.'
}

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class MonitorStartup
{
    [StructLayout(LayoutKind.Sequential)]
    private struct Point { public int X, Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo
    {
        public int Size;
        public IntPtr Reserved, Desktop, Title;
        public int X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
        public short ShowWindow, ReservedCount;
        public IntPtr ReservedBytes, StdInput, StdOutput, StdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct ProcessInfo
    {
        public IntPtr Process, Thread;
        public int Pid, Tid;
    }

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromPoint(Point point, uint flags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessW(string application, StringBuilder commandLine,
        IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags,
        IntPtr environment, string directory, ref StartupInfo startup, out ProcessInfo process);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr handle, out uint code);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool TerminateProcess(IntPtr handle, uint code);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hwnd, StringBuilder name, int capacity);

    public static bool IsChromiumWindow(IntPtr hwnd)
    {
        var name = new StringBuilder(128);
        return GetClassName(hwnd, name, name.Capacity) > 0 && name.ToString() == "Chrome_WidgetWin_1";
    }

    public static string ExitCode(IntPtr process)
    {
        uint code;
        if (!GetExitCodeProcess(process, out code))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return "0x" + code.ToString("X8");
    }

    public static ProcessInfo Launch(string executable, string entry, string profile, string log, out IntPtr monitor)
    {
        // Windows can pass a display identifier in hStdOutput when opening a shortcut.
        monitor = MonitorFromPoint(new Point(), 1); // MONITOR_DEFAULTTOPRIMARY
        if (monitor == IntPtr.Zero) throw new InvalidOperationException("No Windows monitor is available.");
        var startup = new StartupInfo {
            Size = Marshal.SizeOf(typeof(StartupInfo)),
            Flags = 0x100, // STARTF_USESTDHANDLES
            StdOutput = monitor
        };
        var command = new StringBuilder("\"" + executable + "\" --user-data-dir=\"" + profile
            + "\" --enable-logging=file --log-file=\"" + log + "\"");
        // The development entry uses the runtime-test flag to keep its database isolated.
        if (!String.IsNullOrEmpty(entry)) command.Append(" \"").Append(entry).Append("\" --whomi-runtime-test");
        ProcessInfo process;
        if (!CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, true,
                0x8, IntPtr.Zero, Path.GetDirectoryName(executable), ref startup, out process)) // DETACHED_PROCESS
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return process;
    }
}
'@

$started = [DateTimeOffset]::Now
$monitor = [IntPtr]::Zero
$child = [MonitorStartup]::Launch($Executable, $EntryScript, $profile, $LogFile, [ref]$monitor)
$seenWindow = $false
$terminated = $false
$startupExit = $null
try {
  $timer = [Diagnostics.Stopwatch]::StartNew()
  while ($timer.ElapsedMilliseconds -lt 12000) {
    if ([MonitorStartup]::WaitForSingleObject($child.Process, 100) -eq 0) {
      $startupExit = [MonitorStartup]::ExitCode($child.Process)
      break
    }
    $process = Get-Process -Id $child.Pid -ErrorAction SilentlyContinue
    if ($process -and [MonitorStartup]::IsChromiumWindow($process.MainWindowHandle)) {
      $seenWindow = $true
      $null = $process.CloseMainWindow()
      break
    }
  }
} finally {
  if ([MonitorStartup]::WaitForSingleObject($child.Process, 4000) -ne 0) {
    $terminated = $true
    $null = [MonitorStartup]::TerminateProcess($child.Process, 1)
    $null = [MonitorStartup]::WaitForSingleObject($child.Process, 1000)
  }
  $exitCode = [MonitorStartup]::ExitCode($child.Process)
  $null = [MonitorStartup]::CloseHandle($child.Thread)
  $null = [MonitorStartup]::CloseHandle($child.Process)
}

[ordered]@{
  executable = $Executable
  entry = $EntryScript
  processId = $child.Pid
  standardOutputMonitor = ('0x{0:X}' -f $monitor.ToInt64())
  started = $started.ToString('o')
  ended = [DateTimeOffset]::Now.ToString('o')
  sawChromiumWindow = $seenWindow
  startupExit = $startupExit
  exitCode = $exitCode
  terminatedByHarness = $terminated
} | ConvertTo-Json -Compress
