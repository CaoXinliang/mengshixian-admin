[CmdletBinding()]
param(
  [string]$EnvId = 'mengshixian-demo-d7eaxgh8acf8655',
  [string]$FunctionName = 'api'
)

$ErrorActionPreference = 'Stop'
$runtimeNode = 'C:\Users\YEFAN\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$cliEntry = Join-Path $projectRoot '.tools\cloudbase-cli\package\bin\tcb'
if (!(Test-Path -LiteralPath $runtimeNode) -or !(Test-Path -LiteralPath $cliEntry)) { throw '未找到项目本地 CloudBase CLI 或捆绑 Node.js。' }

function Read-JsonOutput {
  param([string]$Raw, [string]$Label)
  $start = $Raw.IndexOf('{')
  if ($start -lt 0) { throw "$Label 未返回 JSON。" }
  $end = $Raw.LastIndexOf('}')
  if ($end -lt $start) { throw "$Label 返回的 JSON 不完整。" }
  try { return $Raw.Substring($start, $end - $start + 1) | ConvertFrom-Json } catch { throw "$Label 返回的 JSON 无法解析。" }
}

function Invoke-PublicApi {
  param([string]$Action, [hashtable]$Payload)
  $request = @{ action = $Action; requestId = 'verify-category-media-' + [Guid]::NewGuid().ToString('N'); payload = $Payload } | ConvertTo-Json -Compress -Depth 8
  $requestFile = New-TemporaryFile
  try {
    [IO.File]::WriteAllText($requestFile.FullName, $request, [Text.UTF8Encoding]::new($false))
    $raw = (& $runtimeNode $cliEntry fn invoke $FunctionName -e $EnvId -d ('@' + $requestFile.FullName) --json 2>&1 | Out-String)
    $outer = Read-JsonOutput $raw "调用 $Action"
    $response = $outer.data.RetMsg | ConvertFrom-Json
    if (!$response.ok) { throw "[$($response.error.code)] $($response.error.message)" }
    return $response.data
  } finally {
    Remove-Item -LiteralPath $requestFile.FullName -Force -ErrorAction SilentlyContinue
    $request = $null
  }
}

$categories = Invoke-PublicApi 'catalog.categories' @{ page = 1; pageSize = 100 }
$rows = @($categories.rows)
$mediaIds = @($rows | ForEach-Object { [string]$_.imageMediaId } | Where-Object { $_ } | Select-Object -Unique)
$miniapp = if ($mediaIds.Count) { Invoke-PublicApi 'content.media.resolve' @{ ids = $mediaIds; platform = 'miniapp' } } else { @{ rows = @() } }
$web = if ($mediaIds.Count) { Invoke-PublicApi 'content.media.resolve' @{ ids = $mediaIds; platform = 'web' } } else { @{ rows = @() } }
$miniappIds = [Collections.Generic.HashSet[string]]::new([string[]]@($miniapp.rows | ForEach-Object { [string]$_.id; [string]$_.'_id' } | Where-Object { $_ }))
$webIds = [Collections.Generic.HashSet[string]]::new([string[]]@($web.rows | ForEach-Object { [string]$_.id; [string]$_.'_id' } | Where-Object { $_ }))
$missingMiniapp = @($mediaIds | Where-Object { !$miniappIds.Contains($_) })
$missingWeb = @($mediaIds | Where-Object { !$webIds.Contains($_) })
[pscustomobject]@{
  ok = ($rows.Count -eq $mediaIds.Count -and !$missingMiniapp.Count -and !$missingWeb.Count)
  categoriesTotal = [int]$categories.total
  categoriesWithImage = $mediaIds.Count
  resolvedMiniappMedia = @($miniapp.rows).Count
  resolvedWebMedia = @($web.rows).Count
  missingMiniappMediaIds = $missingMiniapp
  missingWebMediaIds = $missingWeb
  secretValuePrinted = $false
} | ConvertTo-Json -Compress
