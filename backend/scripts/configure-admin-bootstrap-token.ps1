[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$EnvId,
  [string]$FunctionName = 'api',
  [string]$SecretFile = (Join-Path $env:LOCALAPPDATA 'MengshixianTest\admin-bootstrap-token.dpapi'),
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$runtimeNode = 'C:\Users\YEFAN\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$cliEntry = Join-Path $PSScriptRoot '..\..\.tools\cloudbase-cli\package\bin\tcb'
if (!(Test-Path -LiteralPath $runtimeNode) -or !(Test-Path -LiteralPath $cliEntry)) { throw '未找到项目本地 CloudBase CLI 或捆绑 Node.js。' }

function Get-FunctionDetail {
  $raw = (& $runtimeNode $cliEntry fn detail $FunctionName -e $EnvId --json 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) { throw '读取 CloudBase 云函数配置失败。' }
  $start = $raw.IndexOf('{'); if ($start -lt 0) { throw 'CloudBase CLI 未返回函数配置 JSON。' }
  return ($raw.Substring($start) | ConvertFrom-Json).data
}
function Get-Variables($detail) {
  $values = [ordered]@{}
  foreach ($item in @($detail.Environment.Variables)) { $values[$item.Key] = [string]$item.Value }
  return $values
}

$before = Get-FunctionDetail
$variables = Get-Variables $before
$cloudToken = [string]$variables['MENGSHIXIAN_ADMIN_BOOTSTRAP_TOKEN']
$demoModeConfigured = ([string]$variables['MENGSHIXIAN_DEMO_MODE'] -eq 'true')
if (!$Apply) {
  [pscustomobject]@{ mode = 'dry-run'; envId = $EnvId; functionName = $FunctionName; cloudTokenConfigured = ![string]::IsNullOrWhiteSpace($cloudToken); demoModeConfigured = $demoModeConfigured; localProtectedTokenExists = Test-Path -LiteralPath $SecretFile; secretValuePrinted = $false } | ConvertTo-Json -Compress
  return
}

$directory = Split-Path -Parent $SecretFile
if (!(Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
if (!(Test-Path -LiteralPath $SecretFile)) {
  if (![string]::IsNullOrWhiteSpace($cloudToken)) { throw '云端已有管理员初始化令牌，但本机没有对应受保护副本；拒绝覆盖。' }
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create(); $bytes = [byte[]]::new(48); $rng.GetBytes($bytes); $rng.Dispose()
  try {
    $value = [Convert]::ToBase64String($bytes)
    $protected = ConvertTo-SecureString $value -AsPlainText -Force | ConvertFrom-SecureString
    [IO.File]::WriteAllText($SecretFile, $protected, [Text.UTF8Encoding]::new($false))
  } finally { [Array]::Clear($bytes, 0, $bytes.Length); $value = $null; $protected = $null }
}

$secureToken = Get-Content -Raw -LiteralPath $SecretFile | ConvertTo-SecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
$plainToken = $null
$temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) ('mengshixian-bootstrap-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
$configFile = Join-Path $temporaryDirectory 'cloudbaserc.json'
try {
  $plainToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  if ([string]::IsNullOrWhiteSpace($plainToken) -or $plainToken.Length -lt 32) { throw '本机受保护的初始化令牌无效。' }
  if (![string]::IsNullOrWhiteSpace($cloudToken) -and $cloudToken -ne $plainToken) { throw '云端与本机初始化令牌不一致；拒绝覆盖。' }
  if ([string]::IsNullOrWhiteSpace($cloudToken) -or !$demoModeConfigured) {
    $variables['MENGSHIXIAN_ADMIN_BOOTSTRAP_TOKEN'] = $plainToken
    $variables['MENGSHIXIAN_DEMO_MODE'] = 'true'
    $config = [ordered]@{
      '$schema' = 'https://static.cloudbase.net/cli/cloudbaserc.schema.json'
      envId = $EnvId
      functionRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\cloudbase\functions')).Path
      functions = @([ordered]@{ name = $FunctionName; type = [string]$before.Type; timeout = [int]$before.Timeout; memorySize = [int]$before.MemorySize; runtime = [string]$before.Runtime; handler = [string]$before.Handler; installDependency = ([string]$before.InstallDependency -eq 'TRUE'); envVariables = $variables })
    }
    [IO.File]::WriteAllText($configFile, ($config | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    $output = (& $runtimeNode $cliEntry --yes --config-file $configFile config update fn $FunctionName -e $EnvId --json 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) { throw ('CloudBase 初始化令牌写入失败：' + $output.Replace($plainToken, '[REDACTED]').Trim()) }
  }
} finally {
  if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  Remove-Item -LiteralPath $configFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $temporaryDirectory -Force -ErrorAction SilentlyContinue
  $plainToken = $null; $cloudToken = $null; $secureToken = $null
}
$after = Get-FunctionDetail
$afterVariables = Get-Variables $after
[pscustomobject]@{ mode = 'apply'; envId = $EnvId; functionName = $FunctionName; cloudTokenConfigured = ![string]::IsNullOrWhiteSpace([string]$afterVariables['MENGSHIXIAN_ADMIN_BOOTSTRAP_TOKEN']); demoModeConfigured = ([string]$afterVariables['MENGSHIXIAN_DEMO_MODE'] -eq 'true'); localTokenProtectedForCurrentWindowsUser = Test-Path -LiteralPath $SecretFile; functionStatus = [string]$after.Status; secretValuePrinted = $false } | ConvertTo-Json -Compress
