param(
  [Parameter(Mandatory)][string]$Directory,
  [Parameter(Mandatory)][ValidateSet('Block', 'Restore')][string]$Action
)

$ErrorActionPreference = 'Stop'
$directoryInfo = Get-Item -LiteralPath $Directory
$fixture = $directoryInfo.Parent
if (!$directoryInfo.PSIsContainer -or $directoryInfo.Name -ne 'logs' -or
    $fixture.Parent.FullName -ne [IO.Path]::GetTempPath().TrimEnd('\') -or
    $fixture.Name -notmatch '^whomi-(runtime-error-logs|test-log-install)-[a-zA-Z0-9]+$' -or
    ($fixture.Attributes -band [IO.FileAttributes]::ReparsePoint) -or ($directoryInfo.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
  throw 'Select the isolated test log directory.'
}
$sid = '*' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if ($Action -eq 'Block') { & icacls.exe $directoryInfo.FullName /deny (${sid} + ':(OI)(CI)(WD)') }
else { & icacls.exe $directoryInfo.FullName /remove:d $sid }
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
