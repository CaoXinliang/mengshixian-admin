[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$CredentialFile,
  [string]$EnvId = 'mengshixian-demo-d7eaxgh8acf8655',
  [string]$FunctionName = 'api'
)

$runtimeNode = 'C:\Users\YEFAN\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$cliEntry = Join-Path $PSScriptRoot '..\..\.tools\cloudbase-cli\package\bin\tcb'
if (!(Test-Path -LiteralPath $runtimeNode) -or !(Test-Path -LiteralPath $cliEntry)) {
  throw '未找到项目本地 CloudBase CLI 或捆绑 Node.js。'
}
if (!(Test-Path -LiteralPath $CredentialFile)) { throw '管理员凭据文件不存在。' }

$values = @{}
Get-Content -LiteralPath $CredentialFile | ForEach-Object {
  if ($_ -match '^([^=]+)=(.*)$') { $values[$matches[1]] = $matches[2] }
}
if (!$values.username -or !$values.password) { throw '凭据文件缺少 username 或 password。' }

$request = @{
  action = 'admin.login'
  requestId = 'verify-admin-login-' + [Guid]::NewGuid().ToString('N')
  payload = @{ username = $values.username; password = $values.password }
} | ConvertTo-Json -Compress -Depth 5
$requestFile = New-TemporaryFile

try {
  [IO.File]::WriteAllText($requestFile.FullName, $request, [Text.UTF8Encoding]::new($false))
  $raw = (& $runtimeNode $cliEntry fn invoke $FunctionName -e $EnvId -d ('@' + $requestFile.FullName) --json 2>&1 | Out-String)
  $jsonStart = $raw.IndexOf('{')
  if ($jsonStart -lt 0) { throw 'CloudBase CLI 未返回 JSON。' }
  $outer = $raw.Substring($jsonStart) | ConvertFrom-Json
  $response = $outer.data.RetMsg | ConvertFrom-Json
  [pscustomobject]@{
    ok = [bool]$response.ok
    errorCode = if ($response.error) { $response.error.code } else { $null }
    errorMessage = if ($response.error) { $response.error.message } else { $null }
    username = if ($response.ok) { $response.data.admin.username } else { $null }
    tokenReturned = [bool]($response.ok -and $response.data.token)
  } | ConvertTo-Json -Compress
} finally {
  Remove-Item -LiteralPath $requestFile.FullName -Force -ErrorAction SilentlyContinue
  $request = $null
  $values.Clear()
}
