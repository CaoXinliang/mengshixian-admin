[CmdletBinding()]
param([string]$EnvId = 'cloud1-d8gp843lt5454ada7', [switch]$DryRun)

$ErrorActionPreference = 'Stop'
if (-not (Get-Command tcb -ErrorAction SilentlyContinue)) { throw '未找到 CloudBase CLI（tcb）。' }
$collections = @(
  'users', 'addresses', 'cart_items', 'categories', 'products', 'product_skus', 'product_media', 'media_assets', 'banners', 'home_sections',
  'prices', 'warehouses', 'inventory', 'inventory_ledger', 'delivery_areas', 'freight_rules', 'delivery_slots',
  'orders', 'order_items', 'inventory_reservations', 'payments', 'refunds', 'groups', 'group_members', 'group_campaigns',
  'admin_users', 'admin_roles', 'admin_sessions', 'admin_login_limits', 'audit_logs', 'import_jobs', 'admin_media_uploads', 'customer_organizations', 'business_applications'
)

$listCommand = ConvertTo-Json -InputObject ([object[]]@(@{ TableName = 'users'; CommandType = 'COMMAND'; Command = '{"listCollections":1,"nameOnly":true}' })) -Compress
$raw = (& tcb db nosql execute -e $EnvId -c $listCommand --json 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0) { throw '无法读取 CloudBase 集合列表。' }
$start = $raw.IndexOf('{'); if ($start -lt 0) { throw '集合列表未返回 JSON。' }
$existing = @((($raw.Substring($start) | ConvertFrom-Json).data.results[0] | ForEach-Object { [string]$_.name }))
$missing = @($collections | Where-Object { $_ -notin $existing })
foreach ($collection in $missing) {
  if ($DryRun) { continue }
  $body = @{ EnvId = $EnvId; TableName = $collection } | ConvertTo-Json -Compress
  $result = (& tcb api tcb CreateTable --api-version 2018-06-08 --body $body -r ap-shanghai --json 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) { throw "CloudBase 集合创建失败：$collection`n$result" }
}
[pscustomobject]@{ envId = $EnvId; required = $collections.Count; created = $(if ($DryRun) { 0 } else { $missing.Count }); missing = $missing; alreadyExisted = $collections.Count - $missing.Count; dryRun = [bool]$DryRun } | ConvertTo-Json -Compress
