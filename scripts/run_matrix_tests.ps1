# Empirical Compatibility Test Harness for ReadBridge
# Launches and directly inspects Windows application processes via UIA.
#
# Resolve the companion relative to this script so the harness works from any clone.
# Run `yarn verify:build` first - the binary lives under a gitignored bin/ directory.

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$companionExe = Join-Path $repoRoot "native\ReadBridge.Companion\bin\Debug\net10.0-windows\ReadBridge.Companion.exe"

if (-not (Test-Path $companionExe)) {
    Write-Error "Companion binary not found at '$companionExe'. Run 'yarn verify:build' first."
    exit 1
}

function Test-AppByPid {
    param(
        [string]$AppName,
        [string]$ProcessPath,
        [string[]]$Arguments = @(),
        [int]$StartupWaitMs = 3500
    )

    Write-Host "`n=======================================================" -ForegroundColor Cyan
    Write-Host "TESTING TARGET APPLICATION: $AppName" -ForegroundColor Cyan
    Write-Host "=======================================================" -ForegroundColor Cyan

    if (-not ($ProcessPath -and (Test-Path $ProcessPath))) {
        Write-Host "Skipping $AppName - not installed at '$ProcessPath'." -ForegroundColor Yellow
        return
    }

    Write-Host "Launching: $ProcessPath $($Arguments -join ' ')"
    $proc = $null
    try {
        if ($Arguments.Count -gt 0) {
            $proc = Start-Process -FilePath $ProcessPath -ArgumentList $Arguments -PassThru
        }
        else {
            $proc = Start-Process -FilePath $ProcessPath -PassThru
        }
    }
    catch {
        Write-Host "Skipping $AppName - launch failed: $($_.Exception.Message)" -ForegroundColor Yellow
        return
    }

    if ($null -eq $proc) {
        Write-Host "Skipping $AppName - Start-Process returned no process object." -ForegroundColor Yellow
        return
    }

    Start-Sleep -Milliseconds $StartupWaitMs
    $proc.Refresh()

    # Single-instance apps (Chromium browsers, Word) hand off to an already-running instance and
    # exit immediately. The launcher pid is then a corpse and inspecting it proves nothing.
    if ($proc.HasExited) {
        Write-Host "Skipping $AppName - launcher process exited (an instance was probably already running; its windows are left open)." -ForegroundColor Yellow
        return
    }

    Write-Host "Process Name: $($proc.ProcessName), PID: $($proc.Id), HWND: 0x$($proc.MainWindowHandle.ToString('X'))"

    Write-Host "Running UIA inspection by PID..."
    & $companionExe "inspect-proc" "$($proc.Id)"

    if (-not $proc.HasExited) {
        Start-Sleep -Seconds 1
        $proc.Kill()
    }
}

# The temp path can contain spaces (e.g. a username with a space), so every argument that
# carries it is passed as its own array element rather than interpolated into one string.
$testFile = Join-Path $env:TEMP "readbridge_test.txt"
"The quick brown fox jumps over the lazy dog. Windows UI Automation enables precise text highlighting across desktop applications. Multi-line wrapped text requires accurate bounding rectangle extraction." | Out-File -FilePath $testFile -Encoding utf8

# 1. Notepad
Test-AppByPid -AppName "Windows Notepad" -ProcessPath "$env:SystemRoot\notepad.exe" -Arguments @($testFile) -StartupWaitMs 2500

# 2. Microsoft Word
Test-AppByPid -AppName "Microsoft Word" -ProcessPath "$env:ProgramFiles\Microsoft Office\root\Office16\WINWORD.EXE" -Arguments @("/q", $testFile) -StartupWaitMs 4500

# 3. Microsoft Edge (Browser & PDF)
Test-AppByPid -AppName "Microsoft Edge" -ProcessPath "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe" -Arguments @("--new-window", "https://en.wikipedia.org/wiki/Screen_reader") -StartupWaitMs 4500

# 4. Google Chrome
Test-AppByPid -AppName "Google Chrome" -ProcessPath "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" -Arguments @("--new-window", "https://en.wikipedia.org/wiki/Speech_synthesis") -StartupWaitMs 4500

# 5. Brave Browser
Test-AppByPid -AppName "Brave Browser" -ProcessPath "$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe" -Arguments @("--new-window", "https://en.wikipedia.org/wiki/Accessibility") -StartupWaitMs 4500
