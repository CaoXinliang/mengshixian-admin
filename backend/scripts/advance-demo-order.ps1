[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$OrderId,
  [Parameter(Mandatory = $true)][string]$EnvId,
  [string]$CredentialFile = (Join-Path $env:LOCALAPPDATA 'MengshixianTest\demo-admin-credential.dpapi')
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$nodeRuntime = 'C:\Users\YEFAN\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$cliEntry = Join-Path $projectRoot '.tools\cloudbase-cli\package\bin\tcb'
if (!(Test-Path -LiteralPath $CredentialFile) -or !(Test-Path -LiteralPath $nodeRuntime) -or !(Test-Path -LiteralPath $cliEntry)) { throw '缺少本机受保护管理员凭据或 CloudBase CLI。' }

function UnprotectText([string]$Path) {
  $secure = Get-Content -Raw -LiteralPath $Path | ConvertTo-SecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}
function Invoke-Api([string]$Action, [hashtable]$Payload) {
  $request = @{ action = $Action; requestId = ('advance-demo-' + [Guid]::NewGuid().ToString('N')); payload = $Payload } | ConvertTo-Json -Compress -Depth 10
  $requestFile = New-TemporaryFile
  try {
    [IO.File]::WriteAllText($requestFile.FullName, $request, [Text.UTF8Encoding]::new($false))
    $raw = (& $nodeRuntime $cliEntry fn invoke api -e $EnvId -d ('@' + $requestFile.FullName) --json 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) { throw "云函数调用失败：$Action" }
    $outer = $raw.Substring($raw.IndexOf('{')) | ConvertFrom-Json
    $response = $outer.data.RetMsg | ConvertFrom-Json
    if (!$response.ok) { throw "[$($response.error.code)] $Action：$($response.error.message)" }
    return $response.data
  } finally { Remove-Item -LiteralPath $requestFile.FullName -Force -ErrorAction SilentlyContinue }
}

$credentialText = UnprotectText $CredentialFile
$credential = @{}
$credentialText -split "`n" | ForEach-Object { if ($_ -match '^([^=]+)=(.*)$') { $credential[$matches[1]] = $matches[2] } }
$token = $null
try {
  $token = (Invoke-Api 'admin.login' @{ username = $credential.username; password = $credential.password }).token
  $order = @(Invoke-Api 'admin.orders.list' @{ adminToken = $token; page = 1; pageSize = 100 }).rows | Where-Object { $_._id -eq $OrderId } | Select-Object -First 1
  if (!$order) { throw '演示订单不存在或不在本次可查询范围内。' }
  if ([string]$order.paymentMethod -ne 'demo') { throw '拒绝推进非演示订单。' }
  $fromStatus = [string]$order.status
  $targetStatuses = @('picking', 'shipping', 'delivered')
  $statusOrder = @('pending_payment', 'pending_confirmation', 'picking', 'shipping', 'delivered', 'completed')
  $currentIndex = $statusOrder.IndexOf($fromStatus)
  foreach ($status in $targetStatuses) {
    if ($statusOrder.IndexOf($status) -gt $currentIndex) {
      $result = Invoke-Api 'admin.orders.transition' @{ adminToken = $token; id = $OrderId; status = $status }
      $currentIndex = $statusOrder.IndexOf([string]$result.order.status)
    }
  }
  [pscustomobject]@{ orderId = $OrderId; fromStatus = $fromStatus; toStatus = $statusOrder[$currentIndex]; secretValuePrinted = $false } | ConvertTo-Json -Compress
} finally {
  if ($token) { try { $null = Invoke-Api 'admin.logout' @{ adminToken = $token } } catch {} }
  $credentialText = $null
  $credential.Clear()
}
