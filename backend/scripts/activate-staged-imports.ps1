[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$CredentialFile,
  [string]$EnvId = 'mengshixian-demo-d7eaxgh8acf8655',
  [string]$FunctionName = 'api',
  [switch]$Apply
)

$runtimeNode = 'C:\Users\YEFAN\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$cliEntry = Join-Path $PSScriptRoot '..\..\.tools\cloudbase-cli\package\bin\tcb'
if (!(Test-Path -LiteralPath $runtimeNode) -or !(Test-Path -LiteralPath $cliEntry)) {
  throw '未找到项目本地 CloudBase CLI 或捆绑 Node.js。'
}
if (!(Test-Path -LiteralPath $CredentialFile)) { throw '管理员凭据文件不存在。' }

function Invoke-BusinessApi {
  param([string]$Action, [hashtable]$Payload)
  $request = @{
    action = $Action
    requestId = 'admin-batch-' + [Guid]::NewGuid().ToString('N')
    payload = $Payload
  } | ConvertTo-Json -Compress -Depth 8
  $requestFile = New-TemporaryFile
  try {
    [IO.File]::WriteAllText($requestFile.FullName, $request, [Text.UTF8Encoding]::new($false))
    $raw = (& $runtimeNode $cliEntry fn invoke $FunctionName -e $EnvId -d ('@' + $requestFile.FullName) --json 2>&1 | Out-String)
    $jsonStart = $raw.IndexOf('{')
    if ($jsonStart -lt 0) { throw 'CloudBase CLI 未返回 JSON。' }
    $outer = $raw.Substring($jsonStart) | ConvertFrom-Json
    $response = $outer.data.RetMsg | ConvertFrom-Json
    if (!$response.ok) {
      $code = if ($response.error.code) { $response.error.code } else { 'UNKNOWN_ERROR' }
      throw "[$code] $($response.error.message)"
    }
    return $response.data
  } finally {
    Remove-Item -LiteralPath $requestFile.FullName -Force -ErrorAction SilentlyContinue
    $request = $null
  }
}

$values = @{}
Get-Content -LiteralPath $CredentialFile | ForEach-Object {
  if ($_ -match '^([^=]+)=(.*)$') { $values[$matches[1]] = $matches[2] }
}
if (!$values.username -or !$values.password) { throw '凭据文件缺少 username 或 password。' }

$sessionToken = $null
try {
  $login = Invoke-BusinessApi 'admin.login' @{ username = $values.username; password = $values.password }
  $sessionToken = $login.token
  if (!$sessionToken) { throw '管理员登录成功但未返回会话令牌。' }

  $eligibleIds = [Collections.Generic.List[string]]::new()
  $page = 1
  do {
    $listed = Invoke-BusinessApi 'admin.imports.list' @{ adminToken = $sessionToken; page = $page; pageSize = 100 }
    foreach ($row in @($listed.rows)) {
      if ($row.status -in @('staged', 'reviewing', 'approved')) { $eligibleIds.Add([string]$row._id) }
    }
    $page += 1
  } while (($page - 1) * 100 -lt [int]$listed.total)

  if (!$Apply) {
    [pscustomobject]@{ mode = 'dry-run'; eligible = $eligibleIds.Count; changed = 0 } | ConvertTo-Json -Compress
    return
  }

  $activated = 0
  $failed = 0
  for ($offset = 0; $offset -lt $eligibleIds.Count; $offset += 10) {
    $last = [Math]::Min($offset + 9, $eligibleIds.Count - 1)
    $batch = @($eligibleIds[$offset..$last])
    $result = Invoke-BusinessApi 'admin.imports.activateBatch' @{ adminToken = $sessionToken; ids = $batch }
    $activated += @($result.activated).Count
    $failed += @($result.failed).Count
    Write-Output ("batch {0}/{1}: activated={2}, failed={3}" -f ([Math]::Ceiling(($offset + 1) / 10)), [Math]::Ceiling($eligibleIds.Count / 10), @($result.activated).Count, @($result.failed).Count)
    if (@($result.failed).Count) { throw '批量启用出现失败，脚本已停止；再次运行会从剩余草稿继续。' }
  }
  [pscustomobject]@{ mode = 'apply'; eligible = $eligibleIds.Count; activated = $activated; failed = $failed } | ConvertTo-Json -Compress
} finally {
  if ($sessionToken) {
    try { $null = Invoke-BusinessApi 'admin.logout' @{ adminToken = $sessionToken } } catch { Write-Warning '管理员会话注销失败，将由服务端过期机制回收。' }
  }
  $sessionToken = $null
  $values.Clear()
}
