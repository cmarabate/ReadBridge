# Empirical Compatibility Test Harness for ReadBridge
# Launches and directly inspects Windows application processes via UIA

$companionExe = "d:\_Dev\Apps\ReadBridge\native\ReadBridge.Companion\bin\Debug\net10.0-windows\ReadBridge.Companion.exe"

function Test-AppByPid {
    param(
        [string]$AppName,
        [string]$ProcessPath,
        [string]$Arguments = "",
        [int]$StartupWaitMs = 3500
    )

    Write-Host "`n=======================================================" -ForegroundColor Cyan
    Write-Host "TESTING TARGET APPLICATION: $AppName" -ForegroundColor Cyan
    Write-Host "=======================================================" -ForegroundColor Cyan

    $proc = $null
    if ($ProcessPath -and (Test-Path $ProcessPath)) {
        Write-Host "Launching: $ProcessPath $Arguments"
        $proc = Start-Process -FilePath $ProcessPath -ArgumentList $Arguments -PassThru
        Start-Sleep -Milliseconds $StartupWaitMs
    }

    # Refresh process to get MainWindowHandle
    $proc.Refresh()
    Write-Host "Process Name: $($proc.ProcessName), PID: $($proc.Id), HWND: 0x$($proc.MainWindowHandle.ToString('X'))"

    Write-Host "Running UIA inspection by PID..."
    & $companionExe "inspect-proc" "$($proc.Id)"

    if ($proc -and !$proc.HasExited) {
        Start-Sleep -Seconds 1
        $proc.Kill()
    }
}

# 1. Notepad
$testFile = "$env:TEMP\readbridge_test.txt"
"The quick brown fox jumps over the lazy dog. Windows UI Automation enables precise text highlighting across desktop applications. Multi-line wrapped text requires accurate bounding rectangle extraction." | Out-File -FilePath $testFile -Encoding utf8

Test-AppByPid -AppName "Windows Notepad" -ProcessPath "C:\Windows\notepad.exe" -Arguments $testFile -StartupWaitMs 2500

# 2. Microsoft Word
$wordPath = "C:\Program Files\Microsoft Office\root\Office16\WINWORD.EXE"
if (Test-Path $wordPath) {
    Test-AppByPid -AppName "Microsoft Word" -ProcessPath $wordPath -Arguments "/q $testFile" -StartupWaitMs 4500
}

# 3. Microsoft Edge (Browser & PDF)
$edgePath = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if (Test-Path $edgePath) {
    Test-AppByPid -AppName "Microsoft Edge" -ProcessPath $edgePath -Arguments "--new-window https://en.wikipedia.org/wiki/Screen_reader" -StartupWaitMs 4500
}

# 4. Google Chrome
$chromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (Test-Path $chromePath) {
    Test-AppByPid -AppName "Google Chrome" -ProcessPath $chromePath -Arguments "--new-window https://en.wikipedia.org/wiki/Speech_synthesis" -StartupWaitMs 4500
}

# 5. Brave Browser
$bravePath = "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"
if (Test-Path $bravePath) {
    Test-AppByPid -AppName "Brave Browser" -ProcessPath $bravePath -Arguments "--new-window https://en.wikipedia.org/wiki/Accessibility" -StartupWaitMs 4500
}
