$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$outputDirectory = Join-Path $PSScriptRoot '..\resources'
$bitmap = [Drawing.Bitmap]::new(256, 256)
$graphics = [Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([Drawing.Color]::Transparent)
$rounded = [Drawing.Drawing2D.GraphicsPath]::new()
$rounded.AddArc(0,0,76,76,180,90); $rounded.AddArc(180,0,76,76,270,90)
$rounded.AddArc(180,180,76,76,0,90); $rounded.AddArc(0,180,76,76,90,90); $rounded.CloseFigure()
$background = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml('#087f8c'))
$graphics.FillPath($background,$rounded)
$pen = [Drawing.Pen]::new([Drawing.Color]::White,12)
$pen.LineJoin = [Drawing.Drawing2D.LineJoin]::Round
$graphics.DrawEllipse($pen,68,69,130,119)
$tail = [Drawing.Point[]]@([Drawing.Point]::new(67,128),[Drawing.Point]::new(38,93),[Drawing.Point]::new(38,164),[Drawing.Point]::new(67,128))
$graphics.DrawLines($pen,$tail)
$graphics.DrawArc($pen,101,70,60,116,95,170)
$white = [Drawing.SolidBrush]::new([Drawing.Color]::White)
$graphics.FillEllipse($white,164,112,14,14)
$bitmap.Save((Join-Path $outputDirectory 'icon.png'),[Drawing.Imaging.ImageFormat]::Png)
$icon = [Drawing.Icon]::FromHandle($bitmap.GetHicon())
$stream = [IO.File]::Create((Join-Path $outputDirectory 'icon.ico'))
$icon.Save($stream); $stream.Dispose(); $icon.Dispose(); $graphics.Dispose(); $bitmap.Dispose(); $pen.Dispose(); $background.Dispose(); $white.Dispose(); $rounded.Dispose()
