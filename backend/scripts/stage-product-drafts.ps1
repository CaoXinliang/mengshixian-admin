[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$AdminToken,
  [string]$EnvId = 'mengshixian-demo-d7eaxgh8acf8655',
  [string]$FunctionName = 'api',
  [string]$StagingFile = (Join-Path $PSScriptRoot '..\data\product-staging.json')
)

$runtimeNode = 'C:\Users\YEFAN\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$cliEntry = Join-Path $PSScriptRoot '..\..\.tools\cloudbase-cli\package\bin\tcb'
if (!(Test-Path -LiteralPath $runtimeNode) -or !(Test-Path -LiteralPath $cliEntry)) { throw '未找到项目本地 CloudBase CLI 或捆绑 Node.js。' }
if (!(Test-Path -LiteralPath $StagingFile)) { throw "未找到商品草稿文件：$StagingFile" }

$staging = Get-Content -Raw -LiteralPath $StagingFile | ConvertFrom-Json
$allRows = @($staging.rows)
if ($allRows.Count -eq 0) { throw '商品草稿文件没有可导入记录。' }

for ($start = 0; $start -lt $allRows.Count; $start += 50) {
  $end = [Math]::Min($start + 49, $allRows.Count - 1)
  $batch = @($allRows[$start..$end])
  $body = @{ action = 'admin.imports.stage'; requestId = ('stage-' + [Guid]::NewGuid().ToString('N')); payload = @{ adminToken = $AdminToken; sourceFile = (Split-Path -Leaf $StagingFile); rows = $batch } } | ConvertTo-Json -Depth 12 -Compress
  $temp = New-TemporaryFile
  try {
    [System.IO.File]::WriteAllText($temp.FullName, $body, [System.Text.UTF8Encoding]::new($false))
    & $runtimeNode $cliEntry fn invoke $FunctionName -e $EnvId -d "@$($temp.FullName)" --json
    if ($LASTEXITCODE -ne 0) { throw "第 $($start + 1) 至 $($end + 1) 条草稿写入失败。" }
    Write-Host "已处理 $($end + 1) / $($allRows.Count) 条商品草稿。"
  } finally {
    Remove-Item -LiteralPath $temp.FullName -Force -ErrorAction SilentlyContinue
  }
}
