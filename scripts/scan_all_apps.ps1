# Launch test target apps and run a live matrix-scan across every visible target window.
#
# NOTE: matrix-scan inspects ALL visible windows whose process name is in the companion's target
# set - including applications you already had open, not just the ones this script launches.

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot

# The temp path can contain spaces, so it is always passed as its own argument element.
$testFile = Join-Path $env:TEMP "readbridge_test.txt"
"The quick brown fox jumps over the lazy dog. Windows UI Automation enables precise text highlighting across desktop applications. Multi-line wrapped text requires accurate bounding rectangle extraction." | Out-File -FilePath $testFile -Encoding utf8

# Track everything we launch so cleanup can be complete rather than Notepad-only.
$launched = @()

function Start-Target {
    param([string]$Name, [string]$Path, [string[]]$Arguments = @())

    if (-not (Test-Path $Path)) {
        Write-Host "Skipping $Name - not installed at '$Path'." -ForegroundColor Yellow
        return
    }

    Write-Host "Launching $Name..."
    try {
        if ($Arguments.Count -gt 0) {
            $script:launched += Start-Process -FilePath $Path -ArgumentList $Arguments -PassThru
        }
        else {
            $script:launched += Start-Process -FilePath $Path -PassThru
        }
    }
    catch {
        Write-Host "Skipping $Name - launch failed: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

Start-Target -Name "Notepad" -Path "$env:SystemRoot\notepad.exe" -Arguments @($testFile)
Start-Target -Name "VS Code" -Path "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe" -Arguments @($testFile)
Start-Target -Name "Chrome" -Path "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" -Arguments @("https://en.wikipedia.org/wiki/Speech_synthesis")
Start-Target -Name "Brave" -Path "$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe" -Arguments @("https://en.wikipedia.org/wiki/Screen_reader")

Write-Host "Waiting 6 seconds for windows to initialize and render the accessibility tree..."
Start-Sleep -Seconds 6

Write-Host "`nRunning matrix-scan across all active windows..."
Push-Location $repoRoot
try {
    dotnet run --project native/ReadBridge.Companion -- matrix-scan
}
finally {
    Pop-Location
}

Write-Host "`nCleaning up test processes..."
foreach ($p in $launched) {
    if ($p -and -not $p.HasExited) {
        try { $p.Kill() } catch { Write-Host "Could not stop pid $($p.Id): $($_.Exception.Message)" -ForegroundColor Yellow }
    }
}
