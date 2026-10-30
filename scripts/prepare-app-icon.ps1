param([string]$Source = (Join-Path $PSScriptRoot '..\build\icon-source.png'))
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$targetDirectory = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\build'))
[System.IO.Directory]::CreateDirectory($targetDirectory) | Out-Null
$sourceImage = [System.Drawing.Bitmap]::new([System.IO.Path]::GetFullPath($Source))
$frames = [System.Collections.Generic.List[byte[]]]::new()
$sizes = @(16, 20, 24, 32, 40, 48, 64, 96, 128, 256)
try {
    $left = $sourceImage.Width; $top = $sourceImage.Height; $right = -1; $bottom = -1
    for ($y = 0; $y -lt $sourceImage.Height; $y++) {
        for ($x = 0; $x -lt $sourceImage.Width; $x++) {
            if ($sourceImage.GetPixel($x, $y).A -ge 128) {
                $left = [Math]::Min($left, $x); $top = [Math]::Min($top, $y)
                $right = [Math]::Max($right, $x); $bottom = [Math]::Max($bottom, $y)
            }
        }
    }
    if ($right -lt $left) { throw '源图标没有可见图形。' }
    # 按实心底板测量，保留少量边缘供阴影与抗锯齿使用。
    $edge = [Math]::Max(1, [int]([Math]::Max($sourceImage.Width, $sourceImage.Height) / 128))
    $left = [Math]::Max(0, $left - $edge); $top = [Math]::Max(0, $top - $edge)
    $right = [Math]::Min($sourceImage.Width - 1, $right + $edge); $bottom = [Math]::Min($sourceImage.Height - 1, $bottom + $edge)
    $sourceRectangle = [System.Drawing.RectangleF]::new($left, $top, $right - $left + 1, $bottom - $top + 1)
    foreach ($size in @($sizes + 512)) {
        $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $stream = [System.IO.MemoryStream]::new()
        try {
            $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $margin = [Math]::Max(0.5, $size / 64.0)
            $scale = ($size - 2 * $margin) / [Math]::Max($sourceRectangle.Width, $sourceRectangle.Height)
            $width = $sourceRectangle.Width * $scale; $height = $sourceRectangle.Height * $scale
            $destination = [System.Drawing.RectangleF]::new(($size - $width) / 2, ($size - $height) / 2, $width, $height)
            $graphics.DrawImage($sourceImage, $destination, $sourceRectangle, [System.Drawing.GraphicsUnit]::Pixel)
            $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
            if ($size -eq 512) { $pngBytes = $stream.ToArray() }
            else { $frames.Add($stream.ToArray()) }
        } finally { $stream.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
    }
} finally { $sourceImage.Dispose() }
[System.IO.File]::WriteAllBytes((Join-Path $targetDirectory 'icon.png'), $pngBytes)
$iconStream = [System.IO.File]::Create((Join-Path $targetDirectory 'icon.ico'))
$writer = [System.IO.BinaryWriter]::new($iconStream)
try {
    $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$frames.Count)
    $offset = 6 + 16 * $frames.Count
    for ($index = 0; $index -lt $frames.Count; $index++) {
        $dimension = if ($sizes[$index] -eq 256) { 0 } else { $sizes[$index] }
        $writer.Write([byte]$dimension); $writer.Write([byte]$dimension)
        $writer.Write([byte]0); $writer.Write([byte]0)
        $writer.Write([uint16]1); $writer.Write([uint16]32)
        $writer.Write([uint32]$frames[$index].Length); $writer.Write([uint32]$offset)
        $offset += $frames[$index].Length
    }
    foreach ($frame in $frames) { $writer.Write($frame) }
} finally { $writer.Dispose() }
Write-Output '应用图标已生成。'
