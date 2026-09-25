[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$EnvId,
  [string]$CredentialFile = (Join-Path $env:LOCALAPPDATA 'MengshixianTest\demo-admin-credential.dpapi'),
  [string]$FixtureFile = (Join-Path $PSScriptRoot '..\data\product-demo-50.json'),
  [int]$Limit = 50,
  [int]$Offset = 0,
  [switch]$NormalizeStock
)

$ErrorActionPreference = 'Stop'
$runtimeNode = 'C:\Users\YEFAN\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$cliEntry = Join-Path $PSScriptRoot '..\..\.tools\cloudbase-cli\package\bin\tcb'
function UnprotectText([string]$Path) { $secure = Get-Content -Raw -LiteralPath $Path | ConvertTo-SecureString; $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure); try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) } }
function Invoke-Api([string]$Action, [hashtable]$Payload) {
  $file = New-TemporaryFile
  try {
    $request = @{ action = $Action; requestId = ('seed-' + [Guid]::NewGuid().ToString('N')); payload = $Payload } | ConvertTo-Json -Depth 12 -Compress
    [IO.File]::WriteAllText($file.FullName, $request, [Text.UTF8Encoding]::new($false))
    $raw = (& $runtimeNode $cliEntry fn invoke api -e $EnvId -d ('@' + $file.FullName) --json 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) { throw "云函数调用失败：$Action" }
    $response = (($raw.Substring($raw.IndexOf('{')) | ConvertFrom-Json).data.RetMsg | ConvertFrom-Json)
    if (!$response.ok) { throw "[$($response.error.code)] $Action：$($response.error.message)" }
    $response.data
  } finally { Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue }
}
$plain = UnprotectText $CredentialFile; $cred = @{}; $plain -split "`n" | ForEach-Object { if ($_ -match '^([^=]+)=(.*)$') { $cred[$matches[1]] = $matches[2] } }
$fixture = Get-Content -Raw -LiteralPath $FixtureFile | ConvertFrom-Json
$token = $null
try {
  $token = (Invoke-Api 'admin.login' @{ username = $cred.username; password = $cred.password }).token
  $warehouse = @(Invoke-Api 'admin.warehouses.list' @{ adminToken = $token; page = 1; pageSize = 20 }).rows | Where-Object { $_.code -eq 'DEMO-ZG-COLDCHAIN-01' } | Select-Object -First 1
  if (!$warehouse) { throw '演示仓库不存在。' }
  $entries = @($fixture.rows | Select-Object -Skip $Offset -First $Limit | ForEach-Object { @{ sourceId = [string]$_.source.id; amountCent = [int]$_.demo.priceCent; initialStock = [int]$_.demo.initialStock; skus = @($_.demo.skus) } })
  $result = Invoke-Api 'admin.demo.seedCommerce' @{ adminToken = $token; warehouseId = $warehouse._id; sourceFile = 'product-demo-50.json'; entries = $entries; source = 'ai_generated'; temporary = $true; demoNote = $fixture.note; normalizeStock = [bool]$NormalizeStock }
  [pscustomobject]@{ envId = $EnvId; seededProducts = $result.seededProducts; seededSkus = $result.seededSkus; warehouseId = $warehouse._id; secretValuePrinted = $false } | ConvertTo-Json -Compress
} finally { if ($token) { try { $null = Invoke-Api 'admin.logout' @{ adminToken = $token } } catch {} }; $plain = $null; $cred.Clear() }
