param([Parameter(Mandatory)][string]$Directory)
$ErrorActionPreference = 'Stop'
$fixtureProfile = [IO.Path]::GetDirectoryName($Directory)
if ([IO.Path]::GetDirectoryName($fixtureProfile) -ne [IO.Path]::GetTempPath().TrimEnd('\') -or
    [IO.Path]::GetFileName($fixtureProfile) -notmatch '^whomi-runtime-error-logs-[a-zA-Z0-9]+$' -or
    [IO.Path]::GetFileName($Directory) -ne 'logs') { throw 'Expected a private test log directory.' }

$shell = New-Object -ComObject Shell.Application
$observed = $false
for ($attempt = 0; $attempt -lt 40; $attempt++) {
  $matched = $false
  foreach ($window in $shell.Windows()) {
    try { $url = [uri]$window.LocationURL } catch { continue }
    if (!$url.IsAbsoluteUri -or !$url.IsFile -or $url.LocalPath -ne $Directory) { continue }
    $matched = $true
    if (!$observed) { $observed = $true; $window.Quit() }
  }
  if ($observed -and !$matched) { Write-Output $Directory; exit 0 }
  Start-Sleep -Milliseconds 250
}
throw 'Could not verify that the test folder opened and closed in Explorer.'
