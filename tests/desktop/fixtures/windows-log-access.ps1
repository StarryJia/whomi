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
$access = Get-Acl -LiteralPath $directoryInfo.FullName
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$rule = [Security.AccessControl.FileSystemAccessRule]::new(
  $sid, [Security.AccessControl.FileSystemRights]::CreateFiles, [Security.AccessControl.AccessControlType]::Deny)
if ($Action -eq 'Block') { $access.AddAccessRule($rule) }
else { $access.RemoveAccessRuleSpecific($rule) }
Set-Acl -LiteralPath $directoryInfo.FullName -AclObject $access
