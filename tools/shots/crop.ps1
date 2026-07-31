# Crop browser captures of shots.html down to exact Chrome Web Store size.
# The page scales the 1280x800 canvas to the viewport width, so the shot always
# occupies the top-left W x (W * 800/1280) of the capture.
#   powershell -File tools/shots/crop.ps1 -Src <capture.jpg> -Out <name.png>
param(
    [Parameter(Mandatory=$true)][string]$Src,
    [Parameter(Mandatory=$true)][string]$Out
)
Add-Type -AssemblyName System.Drawing

$img = [System.Drawing.Image]::FromFile((Resolve-Path $Src))
$w = $img.Width
$h = [int][Math]::Round($w * 800.0 / 1280.0)
if ($h -gt $img.Height) { $h = $img.Height }

$dst = New-Object System.Drawing.Bitmap(1280, 800, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$g = [System.Drawing.Graphics]::FromImage($dst)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.DrawImage($img,
    (New-Object System.Drawing.Rectangle(0, 0, 1280, 800)),
    (New-Object System.Drawing.Rectangle(0, 0, $w, $h)),
    [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose(); $img.Dispose()

$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$dst.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$dst.Dispose()
Write-Output ("{0}  ->  1280x800 PNG" -f (Split-Path -Leaf $Out))
