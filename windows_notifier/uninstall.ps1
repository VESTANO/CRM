$ErrorActionPreference = "Stop"
$task = Get-ScheduledTask -TaskName 'Vestano CRM Windows Reminders' -ErrorAction SilentlyContinue
if ($task) {
    Stop-ScheduledTask -TaskName 'Vestano CRM Windows Reminders' -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName 'Vestano CRM Windows Reminders' -Confirm:$false
}
Write-Host 'Windows reminder startup stopped and removed. Encrypted device state was retained.'
Write-Host 'Use Disconnect under Windows desktop reminders in CRM to revoke the device credential.'
