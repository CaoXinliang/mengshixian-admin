[CmdletBinding()]
param(
  [string]$EnvId = 'mengshixian-demo-d7eaxgh8acf8655',
  [string]$FunctionName = 'api',
  [string]$ManifestPath,
  [string]$MiniappRoot,
  [string]$CredentialFile,
  [string]$ProtectedCredentialFile,
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$ManifestPath = if ($ManifestPath) { $ManifestPath } else { Join-Path $PSScriptRoot '..\data\category-media-draft.json' }
$MiniappRoot = if ($MiniappRoot) { $MiniappRoot } else { Join-Path $projectRoot 'wechat-miniprogram\miniapp' }
$runtimeNode = 'C:\Users\YEFAN\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$cliEntry = Join-Path $projectRoot '.tools\cloudbase-cli\package\bin\tcb'

function Read-JsonOutput {
  param([string]$Raw, [string]$Label)
  $jsonStart = $Raw.IndexOf('{')
  if ($jsonStart -lt 0) { $jsonStart = $Raw.IndexOf('[') }
  if ($jsonStart -lt 0) { throw "$Label 未返回 JSON。" }
  $jsonEnd = if ($Raw[$jsonStart] -eq '{') { $Raw.LastIndexOf('}') } else { $Raw.LastIndexOf(']') }
  if ($jsonEnd -lt $jsonStart) { throw "$Label 返回的 JSON 不完整。" }
  try { return $Raw.Substring($jsonStart, $jsonEnd - $jsonStart + 1) | ConvertFrom-Json } catch { throw "$Label 返回的 JSON 无法解析。" }
}

function Get-MimeType {
  param([string]$Path)
  switch ([IO.Path]::GetExtension($Path).ToLowerInvariant()) {
    '.jpg' { return 'image/jpeg' }
    '.jpeg' { return 'image/jpeg' }
    '.png' { return 'image/png' }
    default { throw "不支持的分类素材格式：$Path" }
  }
}

if (!(Test-Path -LiteralPath $ManifestPath)) { throw "分类素材清单不存在：$ManifestPath" }
if (!(Test-Path -LiteralPath $MiniappRoot)) { throw "小程序素材目录不存在：$MiniappRoot" }
$miniappRootFull = (Resolve-Path $MiniappRoot).Path.TrimEnd('\')
$manifest = [IO.File]::ReadAllText((Resolve-Path $ManifestPath), [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
if (!$manifest.items -or @($manifest.items).Count -eq 0) { throw '分类素材清单为空。' }

$seenCategories = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$plan = foreach ($item in @($manifest.items)) {
  $categoryName = [string]$item.categoryName
  $assetKey = [string]$item.assetKey
  $relativePath = [string]$item.miniappPath
  if (!$categoryName -or !$assetKey -or !$relativePath.StartsWith('/assets/categories/')) { throw '分类素材清单存在缺失字段或非分类运行路径。' }
  if (!$seenCategories.Add($categoryName)) { throw "分类素材清单存在重复分类：$categoryName" }
  if ($item.source -notin @('client', 'ai_generated', 'demo', 'admin_upload')) { throw "分类素材来源不合法：$categoryName" }
  if ($item.temporary -ne $true) { throw "分类临时素材必须明确标记 temporary=true：$categoryName" }
  $localPath = Join-Path $miniappRootFull $relativePath.TrimStart('/')
  if (!(Test-Path -LiteralPath $localPath -PathType Leaf)) { throw "分类素材文件不存在：$localPath" }
  $resolvedPath = (Resolve-Path $localPath).Path
  if (!$resolvedPath.StartsWith($miniappRootFull, [StringComparison]::OrdinalIgnoreCase)) { throw "拒绝读取运行目录外文件：$resolvedPath" }
  $file = Get-Item -LiteralPath $resolvedPath
  if ($file.Length -gt 204800) { throw "分类素材超过 200 KB：$($file.Name)" }
  [pscustomobject]@{
    categoryName = $categoryName
    assetKey = $assetKey
    source = [string]$item.source
    temporary = [bool]$item.temporary
    version = [int]$item.version
    localPath = $resolvedPath
    extension = [IO.Path]::GetExtension($resolvedPath).ToLowerInvariant()
    mimeType = Get-MimeType $resolvedPath
    sizeBytes = [int]$file.Length
    checksum = (Get-FileHash -LiteralPath $resolvedPath -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}

if (!$Apply) {
  [pscustomobject]@{ mode = 'dry-run'; envId = $EnvId; items = @($plan).Count; categories = @($plan | Select-Object -ExpandProperty categoryName); maxSizeBytes = [int](($plan | Measure-Object -Property sizeBytes -Maximum).Maximum); changed = 0 } | ConvertTo-Json -Compress
  return
}

if (!(Test-Path -LiteralPath $runtimeNode) -or !(Test-Path -LiteralPath $cliEntry)) { throw '未找到项目本地 CloudBase CLI 或捆绑 Node.js。' }
if ($CredentialFile -and $ProtectedCredentialFile) { throw '只能提供一种管理员凭据文件。' }
if (!$CredentialFile -and !$ProtectedCredentialFile) { throw 'Apply 模式必须提供本机管理员凭据文件。' }
if ($CredentialFile -and !(Test-Path -LiteralPath $CredentialFile -PathType Leaf)) { throw '管理员凭据文件不存在。' }
if ($ProtectedCredentialFile -and !(Test-Path -LiteralPath $ProtectedCredentialFile -PathType Leaf)) { throw '受保护的管理员凭据文件不存在。' }

function Invoke-BusinessApi {
  param([string]$Action, [hashtable]$Payload)
  $request = @{ action = $Action; requestId = 'category-media-' + [Guid]::NewGuid().ToString('N'); payload = $Payload } | ConvertTo-Json -Compress -Depth 12
  $requestFile = New-TemporaryFile
  try {
    [IO.File]::WriteAllText($requestFile.FullName, $request, [Text.UTF8Encoding]::new($false))
    $raw = (& $runtimeNode $cliEntry fn invoke $FunctionName -e $EnvId -d ('@' + $requestFile.FullName) --json 2>&1 | Out-String)
    $outer = Read-JsonOutput $raw 'CloudBase 云函数调用'
    $response = $outer.data.RetMsg | ConvertFrom-Json
    if (!$response.ok) { throw "[$($response.error.code)] $($response.error.message)" }
    return $response.data
  } finally {
    Remove-Item -LiteralPath $requestFile.FullName -Force -ErrorAction SilentlyContinue
    $request = $null
  }
}

function Get-AllAdminRows {
  param([string]$Action, [string]$SessionToken)
  $rows = [Collections.Generic.List[object]]::new(); $page = 1
  do {
    $result = Invoke-BusinessApi $Action @{ adminToken = $SessionToken; page = $page; pageSize = 100 }
    foreach ($row in @($result.rows)) { $rows.Add($row) }
    $page += 1
  } while (($page - 1) * 100 -lt [int]$result.total)
  return @($rows)
}

function Get-StorageBucket {
  $raw = (& $runtimeNode $cliEntry env detail -e $EnvId --json 2>&1 | Out-String)
  $detail = Read-JsonOutput $raw 'CloudBase 环境详情'
  $resourceRoot = if ($detail.data -and $detail.data.resources) { $detail.data.resources } elseif ($detail.resources) { $detail.resources } else { $detail }
  $storages = @($resourceRoot.storages) + @($resourceRoot.Storages)
  $storage = @($storages | Where-Object { $_ }) | Select-Object -First 1
  $bucket = ''
  if ($storage) {
    $bucket = [string]$storage.Bucket
    if (!$bucket) { $bucket = [string]$storage.bucket }
  }
  if (!$bucket) { throw '未能从 CloudBase 环境详情中取得文件存储桶。' }
  return $bucket
}

function Read-CredentialValues {
  param([string]$PlainFile, [string]$ProtectedFile)
  $credentialText = $null
  $secureCredential = $null
  $credentialBstr = [IntPtr]::Zero
  try {
    if ($ProtectedFile) {
      $secureCredential = Get-Content -Raw -LiteralPath $ProtectedFile | ConvertTo-SecureString
      $credentialBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureCredential)
      $credentialText = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($credentialBstr)
    } else {
      $credentialText = Get-Content -Raw -LiteralPath $PlainFile
    }
    $values = @{}
    $credentialText -split "`r?`n" | ForEach-Object { if ($_ -match '^([^=]+)=(.*)$') { $values[$matches[1]] = $matches[2] } }
    return $values
  } finally {
    if ($credentialBstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($credentialBstr) }
    $credentialText = $null
    $secureCredential = $null
  }
}

$credentialValues = Read-CredentialValues -PlainFile $CredentialFile -ProtectedFile $ProtectedCredentialFile
if (!$credentialValues.username -or !$credentialValues.password) { throw '管理员凭据文件缺少 username 或 password。' }

$sessionToken = $null
try {
  $login = Invoke-BusinessApi 'admin.login' @{ username = $credentialValues.username; password = $credentialValues.password }
  $sessionToken = $login.token
  if (!$sessionToken) { throw '管理员登录成功但未返回会话令牌。' }
  $categories = @(Get-AllAdminRows 'admin.categories.list' $sessionToken)
  $mediaRows = [Collections.Generic.List[object]]::new()
  foreach ($row in @(Get-AllAdminRows 'admin.media.list' $sessionToken)) { $mediaRows.Add($row) }
  $bucket = Get-StorageBucket
  $changed = 0; $uploaded = 0; $reused = 0

  foreach ($entry in $plan) {
    $category = @($categories | Where-Object { $_.name -eq $entry.categoryName }) | Select-Object -First 1
    if (!$category) { throw "云端未找到分类：$($entry.categoryName)" }
    $previous = @($mediaRows | Where-Object { $_.assetKey -eq $entry.assetKey } | Sort-Object version -Descending) | Select-Object -First 1
    if ($previous -and $previous.checksum -eq $entry.checksum -and $previous.enabled -ne $false) {
      $mediaId = $previous._id
      $reused += 1
    } else {
      $nextVersion = if ($previous) { [int]$previous.version + 1 } else { [Math]::Max(1, $entry.version) }
      $cloudPath = "mengshixian/media/categories/$($entry.assetKey)/v$nextVersion/$($entry.checksum.Substring(0, 16))$($entry.extension)"
      # CloudBase CLI 的成功进度会写入 stderr；在 Windows PowerShell 的 Stop 策略下不能直接合并 stderr，
      # 否则已经成功的上传也会被当成 NativeCommandError 中止。以退出码和 JSON 结果作为唯一判断依据。
      $previousErrorActionPreference = $ErrorActionPreference
      try {
        $ErrorActionPreference = 'Continue'
        $uploadRaw = (& $runtimeNode $cliEntry storage upload $entry.localPath $cloudPath -e $EnvId --json 2>&1 | Out-String)
        $uploadExitCode = $LASTEXITCODE
      } finally {
        $ErrorActionPreference = $previousErrorActionPreference
      }
      if ($uploadExitCode -ne 0) { throw "分类素材上传失败：$($entry.categoryName)" }
      $uploadOuter = Read-JsonOutput $uploadRaw "上传分类素材 $($entry.categoryName)"
      $uploadResult = if ($uploadOuter.data) { $uploadOuter.data } else { $uploadOuter }
      if ([int]$uploadResult.failedCount -ne 0 -or [int]$uploadResult.successCount -ne 1) { throw "分类素材上传失败：$($entry.categoryName)" }
      $fileId = "cloud://$EnvId.$bucket/$cloudPath"
      $payload = @{ adminToken = $sessionToken; name = "$($entry.categoryName) 分类临时素材 v$nextVersion"; assetKey = $entry.assetKey; type = 'image'; source = $entry.source; temporary = $entry.temporary; checksum = $entry.checksum; targetPlatforms = @('miniapp', 'web'); fileId = $fileId; mimeType = $entry.mimeType; sizeBytes = $entry.sizeBytes }
      if ($previous) {
        $versionPayload = @{}
        foreach ($key in $payload.Keys) { $versionPayload[$key] = $payload[$key] }
        $versionPayload.replacesMediaAssetId = $previous._id
        $media = Invoke-BusinessApi 'admin.media.createVersion' $versionPayload
      } else {
        $media = Invoke-BusinessApi 'admin.media.upsert' $payload
      }
      $mediaId = $media._id
      $mediaRows.Add($media)
      $uploaded += 1
    }
    if ($category.imageMediaId -ne $mediaId) {
      $null = Invoke-BusinessApi 'admin.categories.upsert' @{ adminToken = $sessionToken; id = $category._id; name = $category.name; parentId = $category.parentId; imageMediaId = $mediaId; sort = [int]$category.sort; status = $category.status }
      $changed += 1
    }
  }
  [pscustomobject]@{ mode = 'apply'; envId = $EnvId; items = @($plan).Count; uploaded = $uploaded; reused = $reused; categoryReferencesUpdated = $changed } | ConvertTo-Json -Compress
} finally {
  if ($sessionToken) {
    try { $null = Invoke-BusinessApi 'admin.logout' @{ adminToken = $sessionToken } } catch { Write-Warning '管理员会话注销失败，将由服务端过期机制回收。' }
  }
  $sessionToken = $null
  $credentialValues.Clear()
}
