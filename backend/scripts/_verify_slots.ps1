[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$EnvId,
  [string]$FunctionName = 'api',
  [string]$CredentialFile = (Join-Path $env:LOCALAPPDATA 'MengshixianTest\demo-admin-credential.dpapi')
)

$ErrorActionPreference = 'Stop'
$runtimeNode = 'C:\Users\YEFAN\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$cliEntry = Join-Path $PSScriptRoot '..\..\.tools\cloudbase-cli\package\bin\tcb'
if (!(Test-Path -LiteralPath $CredentialFile)) { throw "Credential file not found: $CredentialFile" }

function UnprotectText([string]$Path) {
  $secure = Get-Content -Raw -LiteralPath $Path | ConvertTo-SecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}
function Invoke-Api([string]$Action, [hashtable]$Payload) {
  $request = @{ action = $Action; requestId = ('verify-' + [Guid]::NewGuid().ToString('N')); payload = $Payload } | ConvertTo-Json -Depth 12 -Compress
  $file = New-TemporaryFile
  try {
    [IO.File]::WriteAllText($file.FullName, $request, [Text.UTF8Encoding]::new($false))
    $raw = (& $runtimeNode $cliEntry fn invoke $FunctionName -e $EnvId -d ('@' + $file.FullName) --json 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) { throw "Cloud function failed: $Action" }
    $start = $raw.IndexOf('{'); if ($start -lt 0) { throw "No JSON returned: $Action" }
    $response = (($raw.Substring($start) | ConvertFrom-Json).data.RetMsg | ConvertFrom-Json)
    if (!$response.ok) { throw "[$($response.error.code)] $Action : $($response.error.message)" }
    return $response.data
  } finally { Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue }
}

$credentialText = UnprotectText $CredentialFile
$values = @{}; $credentialText -split "`n" | ForEach-Object { if ($_ -match '^([^=]+)=(.*)$') { $values[$matches[1]] = $matches[2] } }
$token = $null
try {
  Write-Host "Logging in..."
  $token = (Invoke-Api 'admin.login' @{ username = $values.username; password = $values.password }).token
  Write-Host "OK. token=$($token.Substring(0,8))..."

  Write-Host "`n=== DELIVERY AREAS ==="
  $areas = (Invoke-Api 'admin.deliveryAreas.list' @{ adminToken = $token; page = 1; pageSize = 100 }).rows
  Write-Host "Total areas: $($areas.Count)"
  foreach ($a in $areas) {
    Write-Host "  [$($a._id.Substring(0,12))...] name=$($a.name) status=$($a.status) codes=$($a.regionCodes.Count) warehouses=$($a.warehouseIds.Count)"
    Write-Host "    regionCodes=$($a.regionCodes -join ', ')"
  }

  Write-Host "`n=== DELIVERY SLOTS ==="
  $slots = (Invoke-Api 'admin.deliverySlots.list' @{ adminToken = $token; page = 1; pageSize = 100 }).rows
  Write-Host "Total slots: $($slots.Count)"
  foreach ($s in $slots) {
    Write-Host "  [$($s._id.Substring(0,12))...] name=$($s.name) areaId=$($s.deliveryAreaId) wh=$($s.warehouseId) $($s.startTime)-$($s.endTime) status=$($s.status)"
  }

  Write-Host "`n=== FREIGHT RULES ==="
  $rules = (Invoke-Api 'admin.freightRules.list' @{ adminToken = $token; page = 1; pageSize = 100 }).rows
  Write-Host "Total rules: $($rules.Count)"
  foreach ($r in $rules) {
    Write-Host "  [$($r._id.Substring(0,12))...] name=$($r.name) areaId=$($r.deliveryAreaId) wh=$($r.warehouseId) fee=$($r.baseFeeCent) status=$($r.status)"
  }

  Write-Host "`n=== WAREHOUSES ==="
  $whs = (Invoke-Api 'admin.warehouses.list' @{ adminToken = $token; page = 1; pageSize = 100 }).rows
  Write-Host "Total warehouses: $($whs.Count)"
  foreach ($w in $whs) {
    Write-Host "  [$($w._id.Substring(0,12))...] code=$($w.code) name=$($w.name) status=$($w.status)"
  }

  Write-Host "`n=== CROSS-REFERENCE CHECK ==="
  $areaIds = $areas | ForEach-Object { $_.code = $_.regionCodes -join ','; $_ }
  $areaMap = @{}; foreach ($a in $areas) { $areaMap[$a._id] = $a }
  
  foreach ($s in $slots) {
    $area = $areaMap[$s.deliveryAreaId]
    if ($area) {
      Write-Host "  SLOT '$($s.name)' -> AREA '$($area.name)' ($($area.regionCodes.Count) codes)  ✅"
    } else {
      Write-Host "  SLOT '$($s.name)' -> areaId=$($s.deliveryAreaId) NOT FOUND  ❌"
    }
  }
  foreach ($r in $rules) {
    $area = $areaMap[$r.deliveryAreaId]
    if ($area) {
      Write-Host "  FREIGHT '$($r.name)' -> AREA '$($area.name)' ($($area.regionCodes.Count) codes)  ✅"
    } else {
      Write-Host "  FREIGHT '$($r.name)' -> areaId=$($r.deliveryAreaId) NOT FOUND  ❌"
    }
  }

  Invoke-Api 'admin.logout' @{ adminToken = $token } | Out-Null
  Write-Host "`nDone."
} finally {
  if ($token) { try { Invoke-Api 'admin.logout' @{ adminToken = $token } | Out-Null } catch {} }
}
