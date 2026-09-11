[CmdletBinding()]
param(
  [string]$CategoryDirectory = (Join-Path $PSScriptRoot '..\..\wechat-miniprogram\miniapp\assets\categories'),
  [int]$Size = 512,
  [int]$Quality = 82
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if (!(Test-Path -LiteralPath $CategoryDirectory)) { throw '分类素材目录不存在。' }
if ($Size -lt 128 -or $Size -gt 2048) { throw 'Size 必须在 128 到 2048 之间。' }
if ($Quality -lt 30 -or $Quality -gt 95) { throw 'Quality 必须在 30 到 95 之间。' }

$sourceFiles = Get-ChildItem -LiteralPath $CategoryDirectory -Filter '*-ai-v1.png'
if (!$sourceFiles.Count) { throw '未找到待优化的 AI 分类 PNG。' }

$jpegCodec = [Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object MimeType -eq 'image/jpeg'
$qualityEncoder = [Drawing.Imaging.Encoder]::Quality
$encoderParameters = [Drawing.Imaging.EncoderParameters]::new(1)
$encoderParameters.Param[0] = [Drawing.Imaging.EncoderParameter]::new($qualityEncoder, [long]$Quality)
$outputs = @()

try {
  foreach ($sourceFile in $sourceFiles) {
    $targetPath = [IO.Path]::ChangeExtension($sourceFile.FullName, '.jpg')
    if (Test-Path -LiteralPath $targetPath) { throw "拒绝覆盖已有文件：$targetPath" }

    $sourceImage = [Drawing.Image]::FromFile($sourceFile.FullName)
    try {
      $canvas = [Drawing.Bitmap]::new($Size, $Size)
      try {
        $graphics = [Drawing.Graphics]::FromImage($canvas)
        try {
          $graphics.Clear([Drawing.Color]::White)
          $graphics.CompositingQuality = [Drawing.Drawing2D.CompositingQuality]::HighQuality
          $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
          $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::HighQuality
          $graphics.DrawImage($sourceImage, 0, 0, $Size, $Size)
        } finally { $graphics.Dispose() }
        $canvas.Save($targetPath, $jpegCodec, $encoderParameters)
      } finally { $canvas.Dispose() }
    } finally { $sourceImage.Dispose() }

    $output = Get-Item -LiteralPath $targetPath
    if ($output.Length -gt 204800) { throw "优化后图片仍超过 200 KB：$($output.Name)" }
    $outputs += $output
  }
} finally {
  $encoderParameters.Dispose()
}

$outputs | Sort-Object Name | Select-Object Name, Length | ConvertTo-Json -Compress
