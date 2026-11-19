param(
  [Parameter(Mandatory)][string]$Directory,
  [Parameter(Mandatory)][ValidateSet('Block', 'Restore')][string]$Action
)

$ErrorActionPreference = 'Stop'
$directoryInfo = Get-Item -LiteralPath $Directory
if (!$directoryInfo.PSIsContainer -or $directoryInfo.Name -ne 'logs' -or
    $directoryInfo.Parent.Name -notlike 'feedback-*' -or $directoryInfo.Parent.Parent.Name -ne 'desktop-log-fixtures') {
  throw 'Select the isolated test log directory.'
}
$sid = '*' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if ($Action -eq 'Block') { & icacls.exe $directoryInfo.FullName /deny (${sid} + ':(WD)') }
else { & icacls.exe $directoryInfo.FullName /remove:d $sid }
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
