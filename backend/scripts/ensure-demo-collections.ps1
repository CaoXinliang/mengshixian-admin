[CmdletBinding()]
param([string]$EnvId = 'cloud1-d8gp843lt5454ada7')

$ErrorActionPreference = 'Stop'
$runtimeNode = 'C:\Users\YEFAN\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$cliEntry = Join-Path $PSScriptRoot '..\..\.tools\cloudbase-cli\package\bin\tcb'
$collections = @(
  'users', 'addresses', 'cart_items', 'categories', 'products', 'product_skus', 'product_media', 'media_assets',
  'prices', 'warehouses', 'inventory', 'inventory_ledger', 'delivery_areas', 'freight_rules', 'delivery_slots',
  'orders', 'order_items', 'inventory_reservations', 'payments', 'refunds', 'groups', 'group_members', 'group_campaigns',
  'admin_users', 'admin_roles', 'admin_sessions', 'admin_login_limits', 'audit_logs', 'import_jobs', 'customer_organizations', 'business_applications'
)

$raw = (& $runtimeNode $cliEntry db model list -e $EnvId --json 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0) { throw '无法读取 CloudBase 集合列表。' }
$start = $raw.IndexOf('{'); if ($start -lt 0) { throw '集合列表未返回 JSON。' }
$existing = @((($raw.Substring($start) | ConvertFrom-Json).data | ForEach-Object { [string]$_.name }))
$missing = @($collections | Where-Object { $_ -notin $existing })
if ($missing.Count) {
  $commands = [object[]]@($missing | ForEach-Object { @{ TableName = $_; CommandType = 'COMMAND'; Command = ('{"create":"' + $_ + '"}') } })
  $command = ConvertTo-Json -InputObject $commands -Compress
  $result = (& $runtimeNode $cliEntry db nosql execute -e $EnvId -c $command --json 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0 -and $result -notmatch 'NamespaceExists|already exists') { throw "CloudBase 集合创建失败：`n$result" }
}
[pscustomobject]@{ envId = $EnvId; required = $collections.Count; created = $missing.Count; alreadyExisted = $collections.Count - $missing.Count } | ConvertTo-Json -Compress
