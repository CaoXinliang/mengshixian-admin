[CmdletBinding()]
param([string]$EnvId = 'cloud1-d8gp843lt5454ada7')

$ErrorActionPreference = 'Stop'
$runtimeNode = 'C:\Users\YEFAN\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$cliEntry = Join-Path $PSScriptRoot '..\..\.tools\cloudbase-cli\package\bin\tcb'
$nosqlRunner = Join-Path $PSScriptRoot 'tcb-nosql-execute.js'
$collections = @(
  'users', 'addresses', 'cart_items', 'categories', 'products', 'product_skus', 'product_media', 'media_assets',
  'prices', 'warehouses', 'inventory', 'inventory_ledger', 'delivery_areas', 'freight_rules', 'delivery_slots', 'pickup_sites',
  'orders', 'order_items', 'inventory_reservations', 'payments', 'refunds', 'groups', 'group_members', 'group_campaigns',
  'admin_users', 'admin_roles', 'admin_sessions', 'admin_login_limits', 'audit_logs', 'import_jobs', 'customer_organizations', 'business_applications',
  'bundles', 'coupon_templates', 'coupon_counters', 'user_coupons', 'points_accounts', 'points_ledger', 'membership_levels',
  'favorites', 'reviews', 'invoice_titles', 'invoices', 'stored_value_accounts', 'stored_value_ledger', 'stored_value_topup_intents'
)

$created = 0
$alreadyExisted = 0
foreach ($collection in $collections) {
  # The model-list command does not enumerate native NoSQL collections. Attempt
  # each idempotent create separately so one NamespaceExists result cannot stop
  # the remaining missing collections from being created.
  $commands = [object[]]@(@{ TableName = $collection; CommandType = 'COMMAND'; Command = ('{"create":"' + $collection + '"}') })
  $command = ConvertTo-Json -InputObject $commands -Compress
  # Pass JSON over stdin to avoid Windows PowerShell 5.1 native argument quote loss.
  $result = ($command | & $runtimeNode $nosqlRunner $runtimeNode $cliEntry $EnvId 2>&1 | Out-String)
  if ($LASTEXITCODE -eq 0) { $created += 1; continue }
  if ($result -match 'NamespaceExists|already exists') { $alreadyExisted += 1; continue }
  throw "CloudBase collection creation failed for ${collection}:`n$result"
}
[pscustomobject]@{ envId = $EnvId; required = $collections.Count; created = $created; alreadyExisted = $alreadyExisted } | ConvertTo-Json -Compress
