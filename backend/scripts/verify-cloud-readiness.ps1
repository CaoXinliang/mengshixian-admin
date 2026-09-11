[CmdletBinding()]
param(
  [string]$EnvId = 'mengshixian-demo-d7eaxgh8acf8655',
  [string]$FunctionName = 'api'
)

$ErrorActionPreference = 'Stop'
$runtimeNode = 'C:\Users\YEFAN\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$cliEntry = Join-Path $PSScriptRoot '..\..\.tools\cloudbase-cli\package\bin\tcb'
if (!(Test-Path -LiteralPath $runtimeNode) -or !(Test-Path -LiteralPath $cliEntry)) {
  throw '未找到项目本地 CloudBase CLI 或捆绑 Node.js。'
}

$request = @{
  action = 'health'
  requestId = 'verify-cloud-readiness-' + [Guid]::NewGuid().ToString('N')
  payload = @{}
} | ConvertTo-Json -Compress
$requestFile = New-TemporaryFile

try {
  [IO.File]::WriteAllText($requestFile.FullName, $request, [Text.UTF8Encoding]::new($false))
  $raw = (& $runtimeNode $cliEntry fn invoke $FunctionName -e $EnvId -d ('@' + $requestFile.FullName) --json 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) { throw '调用 CloudBase 健康检查失败。' }
  $jsonStart = $raw.IndexOf('{')
  if ($jsonStart -lt 0) { throw 'CloudBase CLI 未返回 JSON。' }
  $outer = $raw.Substring($jsonStart) | ConvertFrom-Json
  $response = $outer.data.RetMsg | ConvertFrom-Json
  [pscustomobject]@{
    ok = [bool]$response.ok
    service = [string]$response.data.service
    status = [string]$response.data.status
    piiEncryption = [bool]$response.data.capabilities.piiEncryption
    paymentPrepare = [bool]$response.data.capabilities.paymentPrepare
    paymentNotify = [bool]$response.data.capabilities.paymentNotify
    refundNotify = [bool]$response.data.capabilities.refundNotify
    secretValuePrinted = $false
  } | ConvertTo-Json -Compress
} finally {
  Remove-Item -LiteralPath $requestFile.FullName -Force -ErrorAction SilentlyContinue
  $request = $null
}
