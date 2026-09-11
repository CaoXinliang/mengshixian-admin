[CmdletBinding()]
param([string]$EnvId = 'cloud1-d8gp843lt5454ada7', [string]$FunctionName = 'api', [int]$Timeout = 30)

$ErrorActionPreference = 'Stop'
$runtimeNode = 'C:\Users\YEFAN\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$cliEntry = Join-Path $PSScriptRoot '..\..\.tools\cloudbase-cli\package\bin\tcb'
$raw = (& $runtimeNode $cliEntry fn detail $FunctionName -e $EnvId --json 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0 -or $raw.IndexOf('{') -lt 0) { throw '无法读取云函数配置。' }
$detail = ($raw.Substring($raw.IndexOf('{')) | ConvertFrom-Json).data
$variables = [ordered]@{}; foreach ($item in @($detail.Environment.Variables)) { $variables[$item.Key] = [string]$item.Value }
$temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) ('mengshixian-timeout-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
$configFile = Join-Path $temporaryDirectory 'cloudbaserc.json'
try {
  $config = [ordered]@{ '$schema' = 'https://static.cloudbase.net/cli/cloudbaserc.schema.json'; envId = $EnvId; functionRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\cloudbase\functions')).Path; functions = @([ordered]@{ name = $FunctionName; type = [string]$detail.Type; timeout = $Timeout; memorySize = [int]$detail.MemorySize; runtime = [string]$detail.Runtime; handler = [string]$detail.Handler; installDependency = ([string]$detail.InstallDependency -eq 'TRUE'); envVariables = $variables }) }
  [IO.File]::WriteAllText($configFile, ($config | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
  $update = (& $runtimeNode $cliEntry --yes --config-file $configFile config update fn $FunctionName -e $EnvId --json 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) { throw '云函数超时配置更新失败。' }
} finally { Remove-Item -LiteralPath $configFile -Force -ErrorAction SilentlyContinue; Remove-Item -LiteralPath $temporaryDirectory -Force -ErrorAction SilentlyContinue }
$verifiedRaw = (& $runtimeNode $cliEntry fn detail $FunctionName -e $EnvId --json 2>&1 | Out-String)
$verified = ($verifiedRaw.Substring($verifiedRaw.IndexOf('{')) | ConvertFrom-Json).data
[pscustomobject]@{ envId = $EnvId; functionName = $FunctionName; timeout = [int]$verified.Timeout; status = [string]$verified.Status; secretValuePrinted = $false } | ConvertTo-Json -Compress
