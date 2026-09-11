[CmdletBinding()]
param(
  [string]$EnvId = 'mengshixian-demo-d7eaxgh8acf8655',
  [string]$FunctionName = 'api',
  [string]$CredentialFile
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$nodeRuntime = 'C:\Users\YEFAN\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$cliEntry = Join-Path $projectRoot '.tools\cloudbase-cli\package\bin\tcb'
if (!(Test-Path -LiteralPath $nodeRuntime) -or !(Test-Path -LiteralPath $cliEntry) -or !$CredentialFile -or !(Test-Path -LiteralPath $CredentialFile)) { throw 'This read-only report requires the project-local CLI and a local administrator credential file.' }

function Read-JsonOutput { param([string]$Raw) $start = $Raw.IndexOf('{'); $end = $Raw.LastIndexOf('}'); if ($start -lt 0 -or $end -lt $start) { throw 'CloudBase CLI did not return complete JSON.' }; return $Raw.Substring($start, $end - $start + 1) | ConvertFrom-Json }
function Invoke-Api { param([string]$Action, [hashtable]$Payload) $body = @{ action = $Action; requestId = 'commerce-readiness-' + [Guid]::NewGuid().ToString('N'); payload = $Payload } | ConvertTo-Json -Compress -Depth 8; $file = New-TemporaryFile; try { [IO.File]::WriteAllText($file.FullName, $body, [Text.UTF8Encoding]::new($false)); $raw = (& $nodeRuntime $cliEntry fn invoke $FunctionName -e $EnvId -d ('@' + $file.FullName) --json 2>&1 | Out-String); if ($LASTEXITCODE -ne 0) { throw "CloudBase invocation failed for $Action." }; $outer = Read-JsonOutput $raw; $response = $outer.data.RetMsg | ConvertFrom-Json; if (!$response.ok) { throw "[$($response.error.code)] $($response.error.message)" }; return $response.data } finally { Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue } }

$credential = @{}; Get-Content -LiteralPath $CredentialFile | ForEach-Object { if ($_ -match '^([^=]+)=(.*)$') { $credential[$matches[1]] = $matches[2] } }; if (!$credential.username -or !$credential.password) { throw 'Credential file must contain username and password.' }
$token = $null
try {
  $token = (Invoke-Api 'admin.login' @{ username = $credential.username; password = $credential.password }).token
  if (!$token) { throw 'Admin login did not return a session token.' }
  $report = Invoke-Api 'admin.readiness' @{ adminToken = $token }
  [pscustomobject]@{ ok = $true; envId = $EnvId; counts = $report.counts; catalogReady = [bool]$report.catalogReady; quoteAndOrderDataReady = [bool]$report.quoteAndOrderDataReady; groupDataReady = [bool]$report.groupDataReady; blockers = @($report.blockers); manualLinkVerificationRequired = [bool]$report.manualLinkVerificationRequired; secretValuePrinted = $false } | ConvertTo-Json -Compress -Depth 6
} finally { if ($token) { try { $null = Invoke-Api 'admin.logout' @{ adminToken = $token } } catch { Write-Warning 'Admin logout failed; server expiry will clear the session.' } }; $credential.Clear() }
