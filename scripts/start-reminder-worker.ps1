$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$python = Join-Path $projectRoot ".venv\Scripts\python.exe"
$logDir = Join-Path $projectRoot "tmp"
$outLog = Join-Path $logDir "reminder-worker.log"
$errLog = Join-Path $logDir "reminder-worker-error.log"

if (-not (Test-Path $python)) {
    throw "Virtual environment was not found at $python"
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$existingWorker = Get-CimInstance Win32_Process |
    Where-Object {
        $_.ProcessId -ne $PID -and
        $_.CommandLine -match [regex]::Escape($python) -and
        $_.CommandLine -match "manage.py\s+send_due_reminders" -and
        $_.CommandLine -notmatch [regex]::Escape($MyInvocation.MyCommand.Path)
    } |
    Select-Object -First 1

if ($existingWorker) {
    Add-Content -Path $outLog -Value "$(Get-Date -Format o) Reminder worker already running as PID $($existingWorker.ProcessId); skipping duplicate start."
    exit 0
}

Set-Location $projectRoot
Add-Content -Path $outLog -Value "$(Get-Date -Format o) Starting reminder worker."
& $python manage.py send_due_reminders --loop --interval 5 1>> $outLog 2>> $errLog
$exitCode = $LASTEXITCODE
Add-Content -Path $outLog -Value "$(Get-Date -Format o) Reminder worker exited with code $exitCode."
exit $exitCode
