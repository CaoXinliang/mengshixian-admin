[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$EnvId,
  [string]$FunctionName = 'api',
  [string]$BootstrapTokenFile = (Join-Path $env:LOCALAPPDATA 'MengshixianTest\admin-bootstrap-token.dpapi'),
  [string]$CredentialFile = (Join-Path $env:LOCALAPPDATA 'MengshixianTest\demo-admin-credential.dpapi')
)

$ErrorActionPreference = 'Stop'
$runtimeNode = 'C:\Users\YEFAN\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$cliEntry = Join-Path $PSScriptRoot '..\..\.tools\cloudbase-cli\package\bin\tcb'
if (!(Test-Path -LiteralPath $BootstrapTokenFile)) { throw '未找到受保护的管理员初始化令牌。' }

function Unprotect([string]$Path) {
  $secure = Get-Content -Raw -LiteralPath $Path | ConvertTo-SecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}
function Invoke-Api([hashtable]$Body) {
  $file = New-TemporaryFile
  try {
    [IO.File]::WriteAllText($file.FullName, ($Body | ConvertTo-Json -Depth 8 -Compress), [Text.UTF8Encoding]::new($false))
    $raw = (& $runtimeNode $cliEntry fn invoke $FunctionName -e $EnvId -d ('@' + $file.FullName) --json 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) { throw 'CloudBase 云函数调用失败。' }
    $start = $raw.IndexOf('{'); if ($start -lt 0) { throw '云函数未返回 JSON。' }
    $response = (($raw.Substring($start) | ConvertFrom-Json).data.RetMsg | ConvertFrom-Json)
    if (!$response.ok) { throw "[$($response.error.code)] $($response.error.message)" }
    return $response.data
  } finally { Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue }
}

if (Test-Path -LiteralPath $CredentialFile) {
  [pscustomobject]@{ initialized = $false; reason = 'local-credential-already-exists'; credentialProtectedForCurrentWindowsUser = $true; secretValuePrinted = $false } | ConvertTo-Json -Compress
  return
}

$bootstrapToken = Unprotect $BootstrapTokenFile
$rng = [Security.Cryptography.RandomNumberGenerator]::Create(); $bytes = [byte[]]::new(32); $rng.GetBytes($bytes); $rng.Dispose()
try {
  $password = [Convert]::ToBase64String($bytes) + 'Aa1!'
  $result = Invoke-Api @{ action = 'admin.bootstrap'; requestId = 'demo-bootstrap-' + [Guid]::NewGuid().ToString('N'); payload = @{ bootstrapToken = $bootstrapToken; username = 'demo_owner'; displayName = '梦食鲜演示管理员'; password = $password } }
  $credentialText = "username=demo_owner`npassword=$password`n"
  $protected = ConvertTo-SecureString $credentialText -AsPlainText -Force | ConvertFrom-SecureString
  [IO.File]::WriteAllText($CredentialFile, $protected, [Text.UTF8Encoding]::new($false))
  [pscustomobject]@{ initialized = $true; adminId = $result.admin.id; credentialProtectedForCurrentWindowsUser = $true; secretValuePrinted = $false } | ConvertTo-Json -Compress
} finally { [Array]::Clear($bytes, 0, $bytes.Length); $bootstrapToken = $null; $password = $null; $credentialText = $null; $protected = $null }
