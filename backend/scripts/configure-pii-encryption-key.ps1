[CmdletBinding()]
param(
  [string]$EnvId = 'mengshixian-demo-d7eaxgh8acf8655',
  [string]$FunctionName = 'api',
  [string]$SecretFile = (Join-Path $env:LOCALAPPDATA 'MengshixianTest\pii-encryption-key.dpapi'),
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$runtimeNode = 'C:\Users\YEFAN\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$cliEntry = Join-Path $PSScriptRoot '..\..\.tools\cloudbase-cli\package\bin\tcb'
if (!(Test-Path -LiteralPath $runtimeNode) -or !(Test-Path -LiteralPath $cliEntry)) {
  throw '未找到项目本地 CloudBase CLI 或捆绑 Node.js。'
}

function Get-FunctionDetail {
  $raw = (& $runtimeNode $cliEntry fn detail $FunctionName -e $EnvId --json 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) { throw '读取 CloudBase 云函数配置失败。' }
  $jsonStart = $raw.IndexOf('{')
  if ($jsonStart -lt 0) { throw 'CloudBase CLI 未返回函数配置 JSON。' }
  return ($raw.Substring($jsonStart) | ConvertFrom-Json).data
}

function Get-EnvironmentVariables($detail) {
  $values = [ordered]@{}
  foreach ($item in @($detail.Environment.Variables)) { $values[$item.Key] = [string]$item.Value }
  return $values
}

$before = Get-FunctionDetail
$beforeVariables = Get-EnvironmentVariables $before
$cloudKey = [string]$beforeVariables['MENGSHIXIAN_PII_ENCRYPTION_KEY']
$cloudConfigured = ![string]::IsNullOrWhiteSpace($cloudKey)

if (!$Apply) {
  [pscustomobject]@{
    mode = 'dry-run'
    envId = $EnvId
    functionName = $FunctionName
    cloudKeyConfigured = $cloudConfigured
    localProtectedKeyExists = (Test-Path -LiteralPath $SecretFile)
    plannedAction = if ($cloudConfigured) { 'verify-existing-key' } else { 'generate-protect-and-configure-key' }
    secretValuePrinted = $false
  } | ConvertTo-Json -Compress
  return
}

$secretDirectory = Split-Path -Parent $SecretFile
if (!(Test-Path -LiteralPath $secretDirectory)) {
  New-Item -ItemType Directory -Path $secretDirectory -Force | Out-Null
}

if (!(Test-Path -LiteralPath $SecretFile)) {
  if ($cloudConfigured) {
    throw '云端已存在 PII 密钥，但本机没有对应受保护副本；为避免破坏历史密文，拒绝自动轮换。'
  }
  $randomBytes = [Security.Cryptography.RandomNumberGenerator]::GetBytes(48)
  try {
    $generatedKey = [Convert]::ToBase64String($randomBytes)
    $protected = ConvertTo-SecureString $generatedKey -AsPlainText -Force | ConvertFrom-SecureString
    [IO.File]::WriteAllText($SecretFile, $protected, [Text.UTF8Encoding]::new($false))
  } finally {
    [Array]::Clear($randomBytes, 0, $randomBytes.Length)
    $generatedKey = $null
    $protected = $null
  }
}

$secureKey = Get-Content -Raw -LiteralPath $SecretFile | ConvertTo-SecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
$plainKey = $null
$temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) ('mengshixian-pii-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
$configFile = Join-Path $temporaryDirectory 'cloudbaserc.json'

try {
  $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  if ([string]::IsNullOrWhiteSpace($plainKey) -or $plainKey.Length -lt 32) {
    throw '本机受保护的 PII 密钥无效。'
  }

  if ($cloudConfigured) {
    $cloudHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($cloudKey)))
    $localHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($plainKey)))
    if ($cloudHash -ne $localHash) { throw '云端与本机 PII 密钥不一致；为避免历史密文失效，拒绝覆盖。' }
  } else {
    $beforeVariables['MENGSHIXIAN_ADMIN_BOOTSTRAP_TOKEN'] = [string]$beforeVariables['MENGSHIXIAN_ADMIN_BOOTSTRAP_TOKEN']
    $beforeVariables['MENGSHIXIAN_PII_ENCRYPTION_KEY'] = $plainKey
    $config = [ordered]@{
      '$schema' = 'https://static.cloudbase.net/cli/cloudbaserc.schema.json'
      envId = $EnvId
      functionRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\cloudbase\functions')).Path
      functions = @([ordered]@{
        name = $FunctionName
        type = [string]$before.Type
        timeout = [int]$before.Timeout
        memorySize = [int]$before.MemorySize
        runtime = [string]$before.Runtime
        handler = [string]$before.Handler
        installDependency = ([string]$before.InstallDependency -eq 'TRUE')
        envVariables = $beforeVariables
      })
    }
    [IO.File]::WriteAllText($configFile, ($config | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    $updateOutput = (& $runtimeNode $cliEntry --yes --config-file $configFile config update fn $FunctionName -e $EnvId --json 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) {
      $safeOutput = $updateOutput.Replace($plainKey, '[REDACTED]').Trim()
      throw "CloudBase 函数环境变量更新失败；临时配置已清除。$safeOutput"
    }
  }
} finally {
  if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  Remove-Item -LiteralPath $configFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $temporaryDirectory -Force -ErrorAction SilentlyContinue
  $plainKey = $null
  $cloudKey = $null
  $secureKey = $null
}

$after = $null
$afterVariables = $null
for ($attempt = 1; $attempt -le 5; $attempt += 1) {
  $after = Get-FunctionDetail
  $afterVariables = Get-EnvironmentVariables $after
  if (![string]::IsNullOrWhiteSpace([string]$afterVariables['MENGSHIXIAN_PII_ENCRYPTION_KEY'])) { break }
  if ($attempt -lt 5) { Start-Sleep -Seconds 1 }
}
$verifiedConfigured = ![string]::IsNullOrWhiteSpace([string]$afterVariables['MENGSHIXIAN_PII_ENCRYPTION_KEY'])
if (!$verifiedConfigured) { throw 'CloudBase CLI 未报错，但写后验证仍为空；拒绝标记为配置成功。' }
[pscustomobject]@{
  mode = 'apply'
  envId = $EnvId
  functionName = $FunctionName
  cloudKeyConfigured = $verifiedConfigured
  bootstrapTokenEmpty = [string]::IsNullOrWhiteSpace([string]$afterVariables['MENGSHIXIAN_ADMIN_BOOTSTRAP_TOKEN'])
  localKeyProtectedForCurrentWindowsUser = (Test-Path -LiteralPath $SecretFile)
  functionStatus = [string]$after.Status
  secretValuePrinted = $false
} | ConvertTo-Json -Compress
