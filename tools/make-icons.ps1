# Generate Nightlatch extension icons (16/32/48/128 PNG) with System.Drawing.
# Design: deep night-blue rounded tile, a padlock as the hero shape (reads at
# 16px, which a stylised latch does not), crescent moon as the night accent.
#   powershell -ExecutionPolicy Bypass -File tools/make-icons.ps1
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root 'icons'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

function New-Icon([int]$S, [string]$Path) {
    # Render at 4x then downsample — gives clean edges at 16px.
    $R = $S * 4
    $bmp = New-Object System.Drawing.Bitmap($R, $R, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    $u = $R / 128.0   # design on a 128 grid

    $silver = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 238, 241, 246))
    $moonBlue = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 138, 180, 248))

    # --- rounded tile, night gradient -------------------------------------
    # Arcs joined by explicit lines: relying on GraphicsPath's implicit
    # connectors produced a crossed (bow-tie) figure at this scale.
    $rad = [single]($R * 0.22)
    $d = [single]($rad * 2)
    $Rf = [single]$R
    $tile = New-Object System.Drawing.Drawing2D.GraphicsPath
    $tile.AddArc([single]0, [single]0, $d, $d, 180, 90)
    $tile.AddLine($rad, [single]0, [single]($Rf-$rad), [single]0)
    $tile.AddArc([single]($Rf-$d), [single]0, $d, $d, 270, 90)
    $tile.AddLine($Rf, $rad, $Rf, [single]($Rf-$rad))
    $tile.AddArc([single]($Rf-$d), [single]($Rf-$d), $d, $d, 0, 90)
    $tile.AddLine([single]($Rf-$rad), $Rf, $rad, $Rf)
    $tile.AddArc([single]0, [single]($Rf-$d), $d, $d, 90, 90)
    $tile.CloseFigure()
    $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.Point(0,0)),
        (New-Object System.Drawing.Point($R,$R)),
        [System.Drawing.Color]::FromArgb(255, 26, 33, 54),
        [System.Drawing.Color]::FromArgb(255, 9, 11, 20))
    $g.FillPath($grad, $tile)

    # --- crescent moon, upper right ---------------------------------------
    $moonR  = 21 * $u
    $moonCx = 95 * $u
    $moonCy = 33 * $u
    $moonPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $moonPath.AddEllipse($moonCx-$moonR, $moonCy-$moonR, $moonR*2, $moonR*2)
    $bite = New-Object System.Drawing.Drawing2D.GraphicsPath
    $biteR = 18 * $u
    $bite.AddEllipse($moonCx-$biteR-(8*$u), $moonCy-$biteR-(5*$u), $biteR*2, $biteR*2)
    $reg = New-Object System.Drawing.Region($moonPath)
    $reg.Exclude($bite)
    $g.FillRegion($moonBlue, $reg)

    # --- padlock: shackle then body ---------------------------------------
    # Shackle: thick arc, drawn before the body so the body overlaps its feet.
    $shR = 21 * $u                 # shackle radius (centre-line)
    $shCx = 54 * $u
    $shCy = 52 * $u
    $penW = 11 * $u
    $pen = New-Object System.Drawing.Pen($silver.Color, $penW)
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawArc($pen, $shCx-$shR, $shCy-$shR, $shR*2, $shR*2, 180, 180)
    # straight legs down into the body
    $g.DrawLine($pen, [single]($shCx-$shR), [single]$shCy, [single]($shCx-$shR), [single]($shCy + 10*$u))
    $g.DrawLine($pen, [single]($shCx+$shR), [single]$shCy, [single]($shCx+$shR), [single]($shCy + 10*$u))
    $pen.Dispose()

    # Body
    $bodyW = 66 * $u
    $bodyH = 52 * $u
    $bodyX = $shCx - $bodyW/2
    $bodyY = 58 * $u
    $br = 12 * $u
    $body = New-Object System.Drawing.Drawing2D.GraphicsPath
    $body.AddArc($bodyX, $bodyY, $br*2, $br*2, 180, 90)
    $body.AddArc($bodyX+$bodyW-$br*2, $bodyY, $br*2, $br*2, 270, 90)
    $body.AddArc($bodyX+$bodyW-$br*2, $bodyY+$bodyH-$br*2, $br*2, $br*2, 0, 90)
    $body.AddArc($bodyX, $bodyY+$bodyH-$br*2, $br*2, $br*2, 90, 90)
    $body.CloseFigure()
    $g.FillPath($silver, $body)

    # Keyhole punched out of the body, in the night colour
    $khR = 7 * $u
    $khCx = $shCx
    $khCy = $bodyY + 20*$u
    $night = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 16, 20, 34))
    $g.FillEllipse($night, $khCx-$khR, $khCy-$khR, $khR*2, $khR*2)
    $g.FillRectangle($night, [single]($khCx - 3.5*$u), [single]$khCy, [single](7*$u), [single](17*$u))

    $g.Dispose()

    # downsample to target size
    $out = New-Object System.Drawing.Bitmap($S, $S, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $go = [System.Drawing.Graphics]::FromImage($out)
    $go.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $go.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $go.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $go.DrawImage($bmp, (New-Object System.Drawing.Rectangle(0, 0, $S, $S)))
    $go.Dispose(); $bmp.Dispose()
    $out.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $out.Dispose()
    Write-Output ("  {0,3}px -> {1}" -f $S, (Split-Path -Leaf $Path))
}

foreach ($size in 16, 32, 48, 128) {
    New-Icon $size (Join-Path $outDir ("icon{0}.png" -f $size))
}
Write-Output "icons written to $outDir"
