# Launch test target apps and run live matrix-scan
$testFile = "$env:TEMP\readbridge_test.txt"
"The quick brown fox jumps over the lazy dog. Windows UI Automation enables precise text highlighting across desktop applications. Multi-line wrapped text requires accurate bounding rectangle extraction." | Out-File -FilePath $testFile -Encoding utf8

Write-Host "Launching Notepad..."
$np = Start-Process -FilePath "notepad.exe" -ArgumentList $testFile -PassThru

Write-Host "Launching VS Code..."
$codePath = "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe"
$code = $null
if (Test-Path $codePath) {
    $code = Start-Process -FilePath $codePath -ArgumentList "$testFile" -PassThru
}

Write-Host "Launching Chrome..."
$chromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$chrome = $null
if (Test-Path $chromePath) {
    $chrome = Start-Process -FilePath $chromePath -ArgumentList "https://en.wikipedia.org/wiki/Speech_synthesis" -PassThru
}

Write-Host "Launching Brave..."
$bravePath = "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"
$brave = $null
if (Test-Path $bravePath) {
    $brave = Start-Process -FilePath $bravePath -ArgumentList "https://en.wikipedia.org/wiki/Screen_reader" -PassThru
}

Write-Host "Waiting 6 seconds for windows to initialize and render AXTree..."
Start-Sleep -Seconds 6

Write-Host "`nRunning matrix-scan across all active windows..."
dotnet run --project native/ReadBridge.Companion -- matrix-scan

Write-Host "`nCleaning up test processes..."
if ($np -and !$np.HasExited) { $np.Kill() }
