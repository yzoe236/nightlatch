# Render the store screenshots at an exact 1280x800 with headless Chrome.
# Deterministic: no display-scaling / DPR maths, no cropping.
# Requires the dev server:  python -m http.server 8792  (from the repo root)
#   powershell -ExecutionPolicy Bypass -File tools/shots/capture.ps1
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) { throw "chrome.exe not found at $chrome" }

$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$outDir = Join-Path $root 'store'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

$shots = @(
    @{ n = 1; file = 'screenshot-1-lockscreen.png' },
    @{ n = 2; file = 'screenshot-2-per-device.png' },
    @{ n = 3; file = 'screenshot-3-settings.png' },
    @{ n = 4; file = 'screenshot-4-privacy.png' }
)

foreach ($s in $shots) {
    $out = Join-Path $outDir $s.file
    $url = "http://127.0.0.1:8792/tools/shots/shots.html?n=$($s.n)&raw=1"
    $tmpProfile = Join-Path $env:TEMP ("nl-shot-" + [guid]::NewGuid().ToString('N'))
    $args = @(
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        '--window-size=1280,800',
        "--user-data-dir=$tmpProfile",
        "--screenshot=$out",
        '--virtual-time-budget=3000',
        $url
    )
    & $chrome @args 2>$null | Out-Null
    if (Test-Path $out) {
        Add-Type -AssemblyName System.Drawing
        $img = [System.Drawing.Image]::FromFile($out)
        Write-Output ("  {0}  {1}x{2}" -f $s.file, $img.Width, $img.Height)
        $img.Dispose()
    } else {
        Write-Output ("  FAILED: {0}" -f $s.file)
    }
    Remove-Item -Recurse -Force $tmpProfile -ErrorAction SilentlyContinue
}
Write-Output "screenshots written to $outDir"
