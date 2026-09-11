[CmdletBinding()]
param(
  [string]$EnvId = 'cloud1-d8gp843lt5454ada7',
  [string]$FunctionName = 'api',
  [string]$CredentialFile = (Join-Path $env:LOCALAPPDATA 'MengshixianTest\demo-admin-credential.dpapi'),
  [string]$FixtureFile = (Join-Path $PSScriptRoot '..\data\product-demo-50.json'),
  [string]$OperationsFile = (Join-Path $PSScriptRoot '..\data\demo-operations.json'),
  [ValidateSet('prepare', 'stock')][string]$Phase = 'prepare',
  [int]$StartIndex = 0,
  [int]$BatchSize = 50
)

$ErrorActionPreference = 'Stop'
$runtimeNode = 'C:\Users\YEFAN\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$cliEntry = Join-Path $PSScriptRoot '..\..\.tools\cloudbase-cli\package\bin\tcb'
if (!(Test-Path -LiteralPath $CredentialFile) -or !(Test-Path -LiteralPath $FixtureFile) -or !(Test-Path -LiteralPath $OperationsFile)) { throw '缺少受保护管理员凭据或演示数据文件。' }

function UnprotectText([string]$Path) {
  $secure = Get-Content -Raw -LiteralPath $Path | ConvertTo-SecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}
function Invoke-Api([string]$Action, [hashtable]$Payload) {
  $request = @{ action = $Action; requestId = ('demo-' + [Guid]::NewGuid().ToString('N')); payload = $Payload } | ConvertTo-Json -Depth 12 -Compress
  $file = New-TemporaryFile
  try {
    [IO.File]::WriteAllText($file.FullName, $request, [Text.UTF8Encoding]::new($false))
    $raw = (& $runtimeNode $cliEntry fn invoke $FunctionName -e $EnvId -d ('@' + $file.FullName) --json 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) { throw "云函数调用失败：$Action" }
    $start = $raw.IndexOf('{'); if ($start -lt 0) { throw "云函数未返回 JSON：$Action" }
    $response = (($raw.Substring($start) | ConvertFrom-Json).data.RetMsg | ConvertFrom-Json)
    if (!$response.ok) {
      $safeRaw = $raw -replace [regex]::Escape([string]$Payload.password), '[REDACTED]'
      throw "[$($response.error.code)] $Action：$($response.error.message)`n$safeRaw"
    }
    return $response.data
  } finally { Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue }
}

$credentialText = UnprotectText $CredentialFile
$values = @{}; $credentialText -split "`n" | ForEach-Object { if ($_ -match '^([^=]+)=(.*)$') { $values[$matches[1]] = $matches[2] } }
$fixture = Get-Content -Raw -LiteralPath $FixtureFile | ConvertFrom-Json
$ops = Get-Content -Raw -LiteralPath $OperationsFile | ConvertFrom-Json
$token = $null
try {
  $token = (Invoke-Api 'admin.login' @{ username = $values.username; password = $values.password }).token
  if (!$token) { throw '演示管理员登录未返回会话。' }
  $metadata = @{ source = [string]$fixture.source; temporary = [bool]$fixture.temporary; demoNote = [string]$fixture.note }

  $warehouseList = Invoke-Api 'admin.warehouses.list' @{ adminToken = $token; page = 1; pageSize = 100 }
  $warehouse = @($warehouseList.rows | Where-Object { $_.code -eq $ops.warehouse.code }) | Select-Object -First 1
  $warehousePayload = @{ adminToken = $token; code = $ops.warehouse.code; name = $ops.warehouse.name; address = $ops.warehouse.address; status = $ops.warehouse.status; sort = $ops.warehouse.sort } + $metadata
  if ($warehouse) { $warehousePayload.id = $warehouse._id }
  $warehouse = Invoke-Api 'admin.warehouses.upsert' $warehousePayload

  $areaList = Invoke-Api 'admin.deliveryAreas.list' @{ adminToken = $token; page = 1; pageSize = 100 }
  $area = @($areaList.rows | Where-Object { $_.name -eq $ops.deliveryArea.name }) | Select-Object -First 1
  $areaPayload = @{ adminToken = $token; name = $ops.deliveryArea.name; regionCodes = @($ops.deliveryArea.regionCodes); warehouseIds = @($warehouse._id); status = $ops.deliveryArea.status; sort = $ops.deliveryArea.sort } + $metadata
  if ($area) { $areaPayload.id = $area._id }
  $area = Invoke-Api 'admin.deliveryAreas.upsert' $areaPayload

  $freightList = Invoke-Api 'admin.freightRules.list' @{ adminToken = $token; page = 1; pageSize = 100 }
  $freight = @($freightList.rows | Where-Object { $_.name -eq $ops.freightRule.name }) | Select-Object -First 1
  $freightPayload = @{ adminToken = $token; name = $ops.freightRule.name; deliveryAreaId = $area._id; warehouseId = $warehouse._id; baseFeeCent = $ops.freightRule.baseFeeCent; additionalFeeCent = $ops.freightRule.additionalFeeCent; freeThresholdCent = $ops.freightRule.freeThresholdCent; status = $ops.freightRule.status } + $metadata
  if ($freight) { $freightPayload.id = $freight._id }
  $null = Invoke-Api 'admin.freightRules.upsert' $freightPayload

  $slotList = Invoke-Api 'admin.deliverySlots.list' @{ adminToken = $token; page = 1; pageSize = 100 }
  foreach ($slotInput in @($ops.deliverySlots)) {
    $slot = @($slotList.rows | Where-Object { $_.name -eq $slotInput.name }) | Select-Object -First 1
    $slotPayload = @{ adminToken = $token; name = $slotInput.name; deliveryAreaId = $area._id; warehouseId = $warehouse._id; startTime = $slotInput.startTime; endTime = $slotInput.endTime; capacity = $slotInput.capacity; status = $slotInput.status; sort = $slotInput.sort } + $metadata
    if ($slot) { $slotPayload.id = $slot._id }
    $null = Invoke-Api 'admin.deliverySlots.upsert' $slotPayload
  }

  if ($Phase -eq 'prepare') {
    $stage = Invoke-Api 'admin.imports.stage' @{ adminToken = $token; sourceFile = 'product-demo-50.json'; rows = @($fixture.rows) }
    $activationIds = @($stage.staged | ForEach-Object { [string]$_.id } | Select-Object -Unique)
    for ($offset = 0; $offset -lt $activationIds.Count; $offset += 10) {
      $last = [Math]::Min($offset + 9, $activationIds.Count - 1)
      $result = Invoke-Api 'admin.imports.activateBatch' @{ adminToken = $token; ids = @($activationIds[$offset..$last]) }
      if (@($result.failed).Count) { throw "商品启用失败：$($result.failed | ConvertTo-Json -Compress)" }
    }
    [pscustomobject]@{ phase = 'prepare'; envId = $EnvId; stagedOrExisting = $activationIds.Count; warehouseId = $warehouse._id; deliveryAreaId = $area._id; secretValuePrinted = $false } | ConvertTo-Json -Compress
    return
  }
  $demoBySourceId = @{}; foreach ($row in @($fixture.rows)) { $demoBySourceId[[string]$row.source.id] = $row.demo }
  $jobs = Invoke-Api 'admin.imports.list' @{ adminToken = $token; page = 1; pageSize = 100 }
  $demoJobs = @($jobs.rows | Where-Object { $_.sourceFile -eq 'product-demo-50.json' -and $_.status -eq 'imported' })
  $selectedJobs = @($demoJobs | Sort-Object sourceKey | Select-Object -Skip $StartIndex -First $BatchSize)
  $entries = @()
  foreach ($job in $selectedJobs) {
    $sourceId = ([string]$job.sourceKey).Split(':')[-1]
    $demo = $demoBySourceId[$sourceId]
    if (!$demo) { throw "找不到导入商品的演示数据：$sourceId" }
    $entries += @{ sourceId = $sourceId; amountCent = $demo.priceCent; initialStock = $demo.initialStock; skus = @($demo.skus) }
  }
  if ($entries.Count) { $null = Invoke-Api 'admin.demo.seedCommerce' (@{ adminToken = $token; warehouseId = $warehouse._id; sourceFile = 'product-demo-50.json'; entries = $entries } + $metadata) }
  $readiness = Invoke-Api 'admin.readiness' @{ adminToken = $token }
  [pscustomobject]@{ phase = 'stock'; envId = $EnvId; importedDemoProducts = $demoJobs.Count; processed = $selectedJobs.Count; startIndex = $StartIndex; warehouseId = $warehouse._id; deliveryAreaId = $area._id; readiness = $readiness; secretValuePrinted = $false } | ConvertTo-Json -Depth 8 -Compress
} finally {
  if ($token) { try { $null = Invoke-Api 'admin.logout' @{ adminToken = $token } } catch {} }
  $token = $null; $credentialText = $null; $values.Clear()
}
