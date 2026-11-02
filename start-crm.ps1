$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$backend = $root
$frontend = Join-Path $root "frontend"
$python = Join-Path $root ".venv\Scripts\python.exe"
$reminderWorker = Join-Path $root "scripts\start-reminder-worker.ps1"

if (-not (Test-Path $python)) {
    throw "Virtual environment was not found at $python"
}

function Start-CrmProcess {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Title,
        [Parameter(Mandatory = $true)]
        [string] $WorkingDirectory,
        [Parameter(Mandatory = $true)]
        [string] $Command
    )

    Start-Process powershell -WorkingDirectory $WorkingDirectory -ArgumentList @(
        "-NoExit",
        "-ExecutionPolicy", "Bypass",
        "-Command",
        "`$Host.UI.RawUI.WindowTitle = '$Title'; $Command"
    )
}

Start-CrmProcess -Title "Customer CRM - Django" -WorkingDirectory $backend -Command "`"$python`" manage.py runserver 0.0.0.0:8001"
Start-CrmProcess -Title "Customer CRM - Reminder Worker" -WorkingDirectory $backend -Command "powershell -NoProfile -ExecutionPolicy Bypass -File `"$reminderWorker`""
Start-CrmProcess -Title "Customer CRM - Vite" -WorkingDirectory $frontend -Command "npm run dev -- --host 0.0.0.0"

Write-Host "Customer CRM started."
Write-Host "Frontend: http://127.0.0.1:5173/"
Write-Host "Backend:  http://127.0.0.1:8001/"
Write-Host "Reminder worker is running in its own terminal, unless an existing worker was already active."
Write-Host "For automatic startup after Windows login, run: .\scripts\install-reminder-worker-task.ps1"
