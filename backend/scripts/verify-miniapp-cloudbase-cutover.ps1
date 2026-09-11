[CmdletBinding()]
param(
  [string]$EnvId = 'mengshixian-demo-d7eaxgh8acf8655',
  [string]$ExpectedAppId = 'wx27547adf77c95bde',
  [string]$FunctionName = 'api'
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$runtimeNode = 'C:\Users\YEFAN\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$cliEntry = Join-Path $projectRoot '.tools\cloudbase-cli\package\bin\tcb'
$projectConfigPath = Join-Path $projectRoot 'wechat-miniprogram\project.config.json'
$runtimeConfigPath = Join-Path $projectRoot 'wechat-miniprogram\miniapp\services\config.js'

if (!(Test-Path -LiteralPath $runtimeNode) -or !(Test-Path -LiteralPath $cliEntry)) {
  throw 'Missing the project-local CloudBase CLI or bundled Node.js runtime.'
}
if (!(Test-Path -LiteralPath $projectConfigPath) -or !(Test-Path -LiteralPath $runtimeConfigPath)) {
  throw 'Missing mini-program configuration files.'
}

function Read-JsonOutput {
  param([string]$Raw, [string]$Label)
  $start = $Raw.IndexOf('{')
  $end = $Raw.LastIndexOf('}')
  if ($start -lt 0 -or $end -lt $start) { throw "$Label did not return complete JSON." }
  try { return $Raw.Substring($start, $end - $start + 1) | ConvertFrom-Json } catch { throw "$Label returned invalid JSON." }
}

function Invoke-PublicApi {
  param([string]$Action, [hashtable]$Payload)
  $request = @{ action = $Action; requestId = 'verify-miniapp-cutover-' + [Guid]::NewGuid().ToString('N'); payload = $Payload } | ConvertTo-Json -Compress -Depth 8
  $requestFile = New-TemporaryFile
  try {
    [IO.File]::WriteAllText($requestFile.FullName, $request, [Text.UTF8Encoding]::new($false))
    $raw = (& $runtimeNode $cliEntry fn invoke $FunctionName -e $EnvId -d ('@' + $requestFile.FullName) --json 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) { throw "CloudBase invocation failed for $Action." }
    $outer = Read-JsonOutput $raw "CloudBase invocation for $Action"
    $response = $outer.data.RetMsg | ConvertFrom-Json
    if (!$response.ok) { throw "[$($response.error.code)] $($response.error.message)" }
    return $response.data
  } finally {
    Remove-Item -LiteralPath $requestFile.FullName -Force -ErrorAction SilentlyContinue
  }
}

$projectConfigText = Get-Content -Raw -Encoding utf8 -LiteralPath $projectConfigPath
$appIdMatch = [regex]::Match($projectConfigText, '"appid"\s*:\s*"(?<appid>wx[a-zA-Z0-9]+)"')
$runtimeConfig = Get-Content -Raw -LiteralPath $runtimeConfigPath
$providerMatch = [regex]::Match($runtimeConfig, "provider:\s*'(?<provider>mock|cloudbase)'")
$envMatch = [regex]::Match($runtimeConfig, "cloudEnvId:\s*'(?<env>[^']*)'")
if (!$appIdMatch.Success -or !$providerMatch.Success -or !$envMatch.Success) { throw 'Could not parse mini-program runtime configuration.' }

$health = Invoke-PublicApi 'health' @{}
$categories = Invoke-PublicApi 'catalog.categories' @{ page = 1; pageSize = 100 }
$products = Invoke-PublicApi 'catalog.products' @{ page = 1; pageSize = 1 }
$homeContent = Invoke-PublicApi 'content.home' @{ platform = 'miniapp' }
$webHomeContent = Invoke-PublicApi 'content.home' @{ platform = 'web' }
$runtimeProvider = $providerMatch.Groups['provider'].Value
$runtimeEnvId = $envMatch.Groups['env'].Value
$projectAppId = $appIdMatch.Groups['appid'].Value
$appIdMatches = ($projectAppId -eq $ExpectedAppId)
$backendReady = ([string]$health.status -eq 'ok')
$catalogReady = ([int]$categories.total -gt 0 -and [int]$products.total -gt 0)
$bannerTotal = [int]$homeContent.banners.total
$sectionTotal = [int]$homeContent.sections.total
$bannerMediaIds = @($homeContent.banners.rows | ForEach-Object { [string]$_.mediaAssetId } | Where-Object { $_ } | Select-Object -Unique)
$resolvedBannerMedia = if ($bannerMediaIds.Count) { Invoke-PublicApi 'content.media.resolve' @{ ids = $bannerMediaIds; platform = 'miniapp' } } else { @{ rows = @() } }
$resolvedBannerMediaIds = [Collections.Generic.HashSet[string]]::new([string[]]@($resolvedBannerMedia.rows | ForEach-Object { [string]$_.id; [string]$_.'_id' } | Where-Object { $_ }))
$missingBannerMediaIds = @($bannerMediaIds | Where-Object { !$resolvedBannerMediaIds.Contains($_) })
$webBannerMediaIds = @($webHomeContent.banners.rows | ForEach-Object { [string]$_.mediaAssetId } | Where-Object { $_ } | Select-Object -Unique)
$resolvedWebBannerMedia = if ($webBannerMediaIds.Count) { Invoke-PublicApi 'content.media.resolve' @{ ids = $webBannerMediaIds; platform = 'web' } } else { @{ rows = @() } }
$resolvedWebBannerMediaIds = [Collections.Generic.HashSet[string]]::new([string[]]@($resolvedWebBannerMedia.rows | ForEach-Object { [string]$_.id; [string]$_.'_id' } | Where-Object { $_ }))
$missingWebBannerMediaIds = @($webBannerMediaIds | Where-Object { !$resolvedWebBannerMediaIds.Contains($_) })

[pscustomobject]@{
  ok = ($appIdMatches -and $backendReady -and $catalogReady)
  projectAppId = $projectAppId
  expectedAppId = $ExpectedAppId
  appIdMatches = $appIdMatches
  runtimeProvider = $runtimeProvider
  runtimeCloudEnvId = $runtimeEnvId
  safeToKeepMock = ($runtimeProvider -eq 'mock' -and [string]::IsNullOrEmpty($runtimeEnvId))
  cloudBackendReady = $backendReady
  catalogCategories = [int]$categories.total
  catalogProducts = [int]$products.total
  homeBanners = $bannerTotal
  homeSections = $sectionTotal
  homeBannerMediaResolved = @($resolvedBannerMedia.rows).Count
  missingHomeBannerMediaIds = $missingBannerMediaIds
  webHomeBanners = [int]$webHomeContent.banners.total
  webHomeSections = [int]$webHomeContent.sections.total
  webHomeBannerMediaResolved = @($resolvedWebBannerMedia.rows).Count
  missingWebHomeBannerMediaIds = $missingWebBannerMediaIds
  cloudHomeContentReady = ($bannerTotal -gt 0 -and $sectionTotal -gt 0 -and !$missingBannerMediaIds.Count -and [int]$webHomeContent.banners.total -gt 0 -and [int]$webHomeContent.sections.total -gt 0 -and !$missingWebBannerMediaIds.Count)
  miniProgramAssociation = 'manual-verification-required'
  cutoverAllowed = $false
  nextRequiredAction = 'A mini-program administrator must complete the AppID-to-CloudBase environment association, then compile and verify in WeChat DevTools before changing provider.'
  secretValuePrinted = $false
} | ConvertTo-Json -Compress
