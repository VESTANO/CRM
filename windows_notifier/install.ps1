param([string]$CrmUrl = "https://vestano.github.io/CRM/")
$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$python = Join-Path $projectRoot ".venv\Scripts\pythonw.exe"
if (-not (Test-Path -LiteralPath $python)) { throw "The CRM Python environment is missing." }
$uri = [Uri]$CrmUrl
if (($uri.Scheme -ne 'https' -and -not ($uri.Scheme -eq 'http' -and $uri.Host -in @('localhost','127.0.0.1'))) -or $CrmUrl.Contains('"')) { throw "Use the HTTPS CRM URL or a local development URL." }
$installDir = Join-Path $env:LOCALAPPDATA "VestanoCRM\Reminders"
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "notifier.py") -Destination (Join-Path $installDir "notifier.py") -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "engine.py") -Destination (Join-Path $installDir "engine.py") -Force

# A current-user identity gives Windows notifications the CRM name.
$appKey = 'HKCU:\Software\Classes\AppUserModelId\Vestano.CRM.Reminders'
New-Item -Path $appKey -Force | Out-Null
New-ItemProperty -Path $appKey -Name DisplayName -Value 'Vestano CRM Reminders' -PropertyType String -Force | Out-Null
$account = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$entry = Join-Path $installDir "notifier.py"
$arguments = '"{0}" --crm-url "{1}"' -f $entry,$CrmUrl
$action = New-ScheduledTaskAction -Execute $python -Argument $arguments -WorkingDirectory $installDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $account
$principal = New-ScheduledTaskPrincipal -UserId $account -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'Vestano CRM Windows Reminders' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Shows this Windows user CRM reminders independently of Chrome.' -Force | Out-Null
Start-ScheduledTask -TaskName 'Vestano CRM Windows Reminders'
Write-Host 'Installed for the current Windows user. Approve the one-time connection in the CRM tab that opens.'
Write-Host 'No browser settings, attendance access, or administrator privileges were changed.'
