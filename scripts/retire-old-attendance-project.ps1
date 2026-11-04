# Defaults to a read-only status check. Pause only after a real direct punch
# has been verified in CRM. The fixed legacy reference prevents targeting CRM.
param(
  [ValidateSet('Status', 'Pause', 'Restore')]
  [string]$Action = 'Status',
  [switch]$DirectPunchVerified
)
$ErrorActionPreference = 'Stop'
$legacyProject = 'lorrfeyiqgdfxdjqnpmn'
$crmProject = 'qdtgrddhpbwrutvojpes'

if ($Action -eq 'Pause' -and -not $DirectPunchVerified) {
  throw 'Verify a real punch arrived directly in CRM before using -Action Pause -DirectPunchVerified.'
}

if (-not ('AttendanceRetirementCredential' -as [type])) {
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class AttendanceRetirementCredential {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct Credential {
    public uint Flags;
    public uint Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }
  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool Read(string target, uint type, uint reserved, out IntPtr credential);
  [DllImport("advapi32.dll")]
  public static extern void CredFree(IntPtr credential);
}
'@
}

$pointer = [IntPtr]::Zero
$secretBytes = $null
$accessToken = $null
$authorization = $null
try {
  if (-not [AttendanceRetirementCredential]::Read('Supabase CLI:supabase', 1, 0, [ref]$pointer)) {
    throw 'The existing Supabase CLI credential could not be read.'
  }
  $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($pointer, [type][AttendanceRetirementCredential+Credential])
  $secretBytes = New-Object byte[] $credential.CredentialBlobSize
  [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $secretBytes, 0, $secretBytes.Length)
  $accessToken = [Text.Encoding]::UTF8.GetString($secretBytes).Trim([char]0)
  if ($accessToken.Contains([char]0)) { $accessToken = [Text.Encoding]::Unicode.GetString($secretBytes).Trim([char]0) }
  if ($accessToken -notmatch '^sbp_[A-Za-z0-9_-]+$') { throw 'Supabase credential format was not recognized; no request sent.' }
  $authorization = @{Authorization=('Bearer '+$accessToken)}
  $legacyUrl = 'https://api.supabase.com/v1/projects/'+$legacyProject
  $project = Invoke-RestMethod -Method Get -Uri $legacyUrl -Headers $authorization -TimeoutSec 20
  if ($project.ref -ne $legacyProject -and $project.id -ne $legacyProject) { throw 'Legacy project identity mismatch.' }

  if ($Action -eq 'Pause' -and $project.status -eq 'ACTIVE_HEALTHY') {
    $organization = Invoke-RestMethod -Method Get -Uri ('https://api.supabase.com/v1/organizations/'+$project.organization_slug) -Headers $authorization -TimeoutSec 20
    if ($organization.plan -ne 'free') { throw 'Only Free projects can be paused; no project changes made.' }
    $crm = Invoke-RestMethod -Method Get -Uri ('https://api.supabase.com/v1/projects/'+$crmProject) -Headers $authorization -TimeoutSec 20
    if ($crm.status -ne 'ACTIVE_HEALTHY') { throw 'CRM project is not healthy; no project changes made.' }
    $null = Invoke-RestMethod -Method Post -Uri ($legacyUrl+'/pause') -Headers $authorization -TimeoutSec 30
    Write-Output 'Pause requested for the old Attendance project; no project data was deleted.'
    $project = Invoke-RestMethod -Method Get -Uri $legacyUrl -Headers $authorization -TimeoutSec 20
  } elseif ($Action -eq 'Restore' -and $project.status -eq 'INACTIVE') {
    $null = Invoke-RestMethod -Method Post -Uri ($legacyUrl+'/restore') -Headers $authorization -TimeoutSec 30
    Write-Output 'Restore requested for the old Attendance project.'
    $project = Invoke-RestMethod -Method Get -Uri $legacyUrl -Headers $authorization -TimeoutSec 20
  } elseif ($Action -ne 'Status') {
    Write-Output ('No request sent: project is currently '+$project.status+'.')
  }

  [pscustomobject]@{Project=$legacyProject; Name=$project.name; Status=$project.status; CheckedAtUtc=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json
} catch {
  # Never print request headers, credential contents, or server response bodies.
  if ($null -ne $_.Exception.Response) { throw ('Supabase management request failed with HTTP '+[int]$_.Exception.Response.StatusCode+'.') }
  throw ('Supabase retirement check failed: '+$_.Exception.Message)
} finally {
  if ($pointer -ne [IntPtr]::Zero) { [AttendanceRetirementCredential]::CredFree($pointer) }
  if ($null -ne $secretBytes) { [Array]::Clear($secretBytes, 0, $secretBytes.Length) }
  $authorization = $null
  $accessToken = $null
}
