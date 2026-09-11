[CmdletBinding()]
param(
  [string]$EnvId = 'mengshixian-demo-d7eaxgh8acf8655',
  [string]$FunctionName = 'api',
  [string]$ManifestPath,
  [string]$CredentialFile,
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$ManifestPath = if ($ManifestPath) { $ManifestPath } else { Join-Path $PSScriptRoot '..\data\home-content-draft.json' }
$miniappRoot = Join-Path $projectRoot 'wechat-miniprogram\miniapp'
$nodeRuntime = 'C:\Users\YEFAN\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$cliEntry = Join-Path $projectRoot '.tools\cloudbase-cli\package\bin\tcb'

function Read-JsonOutput { param([string]$Raw, [string]$Label) $start = $Raw.IndexOf('{'); $end = $Raw.LastIndexOf('}'); if ($start -lt 0 -or $end -lt $start) { throw "$Label did not return complete JSON." }; try { return $Raw.Substring($start, $end - $start + 1) | ConvertFrom-Json } catch { throw "$Label returned invalid JSON." } }
function Get-MimeType { param([string]$Path) if ([IO.Path]::GetExtension($Path).ToLowerInvariant() -notin @('.jpg', '.jpeg')) { throw "Unsupported home asset format: $Path" }; return 'image/jpeg' }
function Invoke-Api { param([string]$Action, [hashtable]$Payload) $body = @{ action = $Action; requestId = 'home-content-' + [Guid]::NewGuid().ToString('N'); payload = $Payload } | ConvertTo-Json -Compress -Depth 12; $file = New-TemporaryFile; try { [IO.File]::WriteAllText($file.FullName, $body, [Text.UTF8Encoding]::new($false)); $raw = (& $nodeRuntime $cliEntry fn invoke $FunctionName -e $EnvId -d ('@' + $file.FullName) --json 2>&1 | Out-String); if ($LASTEXITCODE -ne 0) { throw "CloudBase invocation failed for $Action." }; $outer = Read-JsonOutput $raw "CloudBase invocation for $Action"; $response = $outer.data.RetMsg | ConvertFrom-Json; if (!$response.ok) { throw "[$($response.error.code)] $($response.error.message)" }; return $response.data } finally { Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue } }
function Get-AllRows { param([string]$Action, [string]$Token) $all = [Collections.Generic.List[object]]::new(); $page = 1; do { $result = Invoke-Api $Action @{ adminToken = $Token; page = $page; pageSize = 100 }; foreach ($row in @($result.rows)) { $all.Add($row) }; $page += 1 } while (($page - 1) * 100 -lt [int]$result.total); return @($all) }
function Get-Bucket { $raw = (& $nodeRuntime $cliEntry env detail -e $EnvId --json 2>&1 | Out-String); $detail = Read-JsonOutput $raw 'CloudBase environment detail'; $root = if ($detail.data.resources) { $detail.data.resources } elseif ($detail.resources) { $detail.resources } else { $detail }; $storage = @($root.storages) + @($root.Storages) | Where-Object { $_ } | Select-Object -First 1; $bucket = if ($storage.Bucket) { [string]$storage.Bucket } else { [string]$storage.bucket }; if (!$bucket) { throw 'CloudBase storage bucket not found.' }; return $bucket }

if (!(Test-Path -LiteralPath $ManifestPath) -or !(Test-Path -LiteralPath $miniappRoot)) { throw 'Missing home-content manifest or mini-program asset directory.' }
$manifest = [IO.File]::ReadAllText((Resolve-Path $ManifestPath), [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
$assetKeys = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$plan = foreach ($asset in @($manifest.assets)) {
  if (!$asset.assetKey -or !$asset.name -or !$asset.miniappPath -or $asset.source -notin @('demo', 'ai_generated', 'client', 'admin_upload') -or $asset.temporary -ne $true) { throw 'Invalid home asset manifest entry.' }
  if (!$assetKeys.Add([string]$asset.assetKey)) { throw "Duplicate home asset key: $($asset.assetKey)" }
  $path = Join-Path $miniappRoot ([string]$asset.miniappPath).TrimStart('/')
  if (!(Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing home asset: $path" }
  $file = Get-Item -LiteralPath $path
  if ($file.Length -gt 204800) { throw "Home asset exceeds 200 KB: $($file.Name)" }
  [pscustomobject]@{ assetKey = [string]$asset.assetKey; name = [string]$asset.name; source = [string]$asset.source; temporary = [bool]$asset.temporary; version = [int]$asset.version; localPath = $file.FullName; extension = $file.Extension.ToLowerInvariant(); mimeType = Get-MimeType $file.FullName; sizeBytes = [int]$file.Length; checksum = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
}
foreach ($banner in @($manifest.banners)) { if (!$banner.contentKey -or !$banner.title -or !$assetKeys.Contains([string]$banner.assetKey)) { throw 'Invalid banner manifest entry.' } }
foreach ($section in @($manifest.homeSections)) { if (!$section.contentKey -or !$section.title -or [string]$section.moduleType -notin @('news', 'special', 'group')) { throw 'Invalid home section manifest entry.' } }
if (!$Apply) { [pscustomobject]@{ mode = 'dry-run'; envId = $EnvId; assets = @($plan).Count; banners = @($manifest.banners).Count; homeSections = @($manifest.homeSections).Count; changed = 0 } | ConvertTo-Json -Compress; return }
if (!(Test-Path -LiteralPath $nodeRuntime) -or !(Test-Path -LiteralPath $cliEntry) -or !$CredentialFile -or !(Test-Path -LiteralPath $CredentialFile)) { throw 'Apply requires the project-local CLI and a local administrator credential file.' }
$credential = @{}; Get-Content -LiteralPath $CredentialFile | ForEach-Object { if ($_ -match '^([^=]+)=(.*)$') { $credential[$matches[1]] = $matches[2] } }; if (!$credential.username -or !$credential.password) { throw 'Credential file must contain username and password.' }
$token = $null
try {
  $token = (Invoke-Api 'admin.login' @{ username = $credential.username; password = $credential.password }).token
  if (!$token) { throw 'Admin login did not return a session token.' }
  $mediaRows = [Collections.Generic.List[object]]::new(); foreach ($row in @(Get-AllRows 'admin.media.list' $token)) { $mediaRows.Add($row) }
  $mediaIds = @{}; $bucket = Get-Bucket; $uploaded = 0
  foreach ($asset in $plan) {
    $existing = @($mediaRows | Where-Object { $_.assetKey -eq $asset.assetKey } | Sort-Object version -Descending | Select-Object -First 1)
    if ($existing -and $existing[0].checksum -eq $asset.checksum -and $existing[0].enabled -ne $false) { $media = $existing[0] } else {
      $nextVersion = if ($existing) { [int]$existing[0].version + 1 } else { [Math]::Max(1, $asset.version) }
      $cloudPath = "mengshixian/media/home/$($asset.assetKey)/v$nextVersion/$($asset.checksum.Substring(0,16))$($asset.extension)"
      $oldPreference = $ErrorActionPreference; try { $ErrorActionPreference = 'Continue'; $raw = (& $nodeRuntime $cliEntry storage upload $asset.localPath $cloudPath -e $EnvId --json 2>&1 | Out-String); $uploadExit = $LASTEXITCODE } finally { $ErrorActionPreference = $oldPreference }
      if ($uploadExit -ne 0) { throw "Home asset upload failed: $($asset.assetKey)" }
      $result = Read-JsonOutput $raw "Home asset upload $($asset.assetKey)"; $data = if ($result.data) { $result.data } else { $result }; if ([int]$data.successCount -ne 1 -or [int]$data.failedCount -ne 0) { throw "Home asset upload failed: $($asset.assetKey)" }
      $payload = @{ adminToken = $token; name = "$($asset.name) v$nextVersion"; assetKey = $asset.assetKey; type = 'image'; source = $asset.source; temporary = $asset.temporary; checksum = $asset.checksum; targetPlatforms = @('miniapp', 'web'); fileId = "cloud://$EnvId.$bucket/$cloudPath"; mimeType = $asset.mimeType; sizeBytes = $asset.sizeBytes }
      if ($existing) {
        $versionPayload = @{ replacesMediaAssetId = $existing[0]._id }
        foreach ($key in $payload.Keys) { $versionPayload[$key] = $payload[$key] }
        $media = Invoke-Api 'admin.media.createVersion' $versionPayload
      } else {
        $media = Invoke-Api 'admin.media.upsert' $payload
      }
      $mediaRows.Add($media); $uploaded += 1
    }
    $mediaIds[$asset.assetKey] = $media._id
  }
  $existingBanners = @(Get-AllRows 'admin.banners.list' $token); $existingSections = @(Get-AllRows 'admin.homeSections.list' $token); $writtenBanners = 0; $writtenSections = 0
  foreach ($banner in @($manifest.banners)) { $old = @($existingBanners | Where-Object { $_.contentKey -eq $banner.contentKey -or (!$_.contentKey -and $_.title -eq $banner.title) } | Select-Object -First 1); $payload = @{ adminToken = $token; contentKey = [string]$banner.contentKey; title = [string]$banner.title; mediaAssetId = $mediaIds[[string]$banner.assetKey]; jumpType = 'none'; jumpTarget = ''; sort = [int]$banner.sort; enabled = $true; targetPlatforms = @('miniapp', 'web') }; if ($old) { $payload.id = $old[0]._id }; $null = Invoke-Api 'admin.banners.upsert' $payload; $writtenBanners += 1 }
  foreach ($section in @($manifest.homeSections)) { $old = @($existingSections | Where-Object { $_.contentKey -eq $section.contentKey -or (!$_.contentKey -and $_.moduleType -eq $section.moduleType -and $_.title -eq $section.title) } | Select-Object -First 1); $payload = @{ adminToken = $token; contentKey = [string]$section.contentKey; moduleType = [string]$section.moduleType; title = [string]$section.title; subtitle = [string]$section.subtitle; linkText = [string]$section.linkText; mediaAssetId = ''; jumpType = 'none'; jumpTarget = ''; sort = [int]$section.sort; enabled = $true; targetPlatforms = @('miniapp', 'web') }; if ($old) { $payload.id = $old[0]._id }; $null = Invoke-Api 'admin.homeSections.upsert' $payload; $writtenSections += 1 }
  [pscustomobject]@{ mode = 'apply'; envId = $EnvId; assetsUploaded = $uploaded; bannersWritten = $writtenBanners; homeSectionsWritten = $writtenSections } | ConvertTo-Json -Compress
} finally { if ($token) { try { $null = Invoke-Api 'admin.logout' @{ adminToken = $token } } catch { Write-Warning 'Admin logout failed; server expiry will clear the session.' } }; $credential.Clear() }
