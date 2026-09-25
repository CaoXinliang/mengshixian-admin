[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$EnvId,
  [string]$FunctionName = 'api',
  [string]$RecoveryFunctionName = 'admin-password-recovery',
  [string]$CredentialFile = (Join-Path $env:LOCALAPPDATA 'MengshixianTest\demo-admin-credential.dpapi')
)

$ErrorActionPreference = 'Stop'
$runtimeNode = 'C:\Users\YEFAN\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$cliEntry = Join-Path $PSScriptRoot '..\..\.tools\cloudbase-cli\package\bin\tcb'

if (!(Test-Path -LiteralPath $runtimeNode) -or !(Test-Path -LiteralPath $cliEntry)) {
  throw '未找到项目本地 CloudBase CLI 或捆绑 Node.js。'
}
if (!(Test-Path -LiteralPath $CredentialFile)) { throw '未找到本机受保护的管理员凭据。' }

function Unprotect-Text([string]$Path) {
  $secure = Get-Content -Raw -LiteralPath $Path | ConvertTo-SecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

function Convert-SecureStringToPlain([securestring]$Value) {
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

function Invoke-CloudFunction([string]$Name, [hashtable]$Body) {
  $requestFile = New-TemporaryFile
  try {
    [IO.File]::WriteAllText($requestFile.FullName, ($Body | ConvertTo-Json -Depth 8 -Compress), [Text.UTF8Encoding]::new($false))
    $raw = (& $runtimeNode $cliEntry fn invoke $Name -e $EnvId -d ('@' + $requestFile.FullName) --json 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) { throw 'CloudBase 云函数调用失败。' }
    $jsonStart = $raw.IndexOf('{')
    if ($jsonStart -lt 0) { throw 'CloudBase CLI 未返回 JSON。' }
    $response = (($raw.Substring($jsonStart) | ConvertFrom-Json).data.RetMsg | ConvertFrom-Json)
    if (!$response.ok) { throw "[$($response.error.code)] $($response.error.message)" }
    if ($null -ne $response.data) { return $response.data }
    return $response
  } finally {
    Remove-Item -LiteralPath $requestFile.FullName -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-AdminApi([hashtable]$Body) {
  return Invoke-CloudFunction $FunctionName $Body
}

$credentialText = Unprotect-Text $CredentialFile
$credential = @{}
$credentialText -split "`r?`n" | ForEach-Object {
  if ($_ -match '^([^=]+)=(.*)$') { $credential[$matches[1]] = $matches[2] }
}
if (!$credential.username -or !$credential.password) { throw '本机受保护凭据格式无效。' }

$secureNewPassword = Read-Host '请输入新的管理员密码（至少 12 位，输入不会显示）' -AsSecureString
$newPassword = Convert-SecureStringToPlain $secureNewPassword
if ($newPassword.Length -lt 12) { throw '管理员密码至少需要 12 位。' }

try {
  try {
    $login = Invoke-AdminApi @{
      action = 'admin.login'
      requestId = 'password-reset-login-' + [Guid]::NewGuid().ToString('N')
      payload = @{ username = $credential.username; password = $credential.password }
    }
    $changed = Invoke-AdminApi @{
      action = 'admin.password.change'
      requestId = 'password-reset-change-' + [Guid]::NewGuid().ToString('N')
      payload = @{ adminToken = $login.token; currentPassword = $credential.password; newPassword = $newPassword }
    }
    $recoveryUsed = $false
  } catch {
    if ($_.Exception.Message -notmatch 'ADMIN_LOGIN_FAILED') { throw }
    $changed = Invoke-CloudFunction $RecoveryFunctionName @{
      username = $credential.username
      newPassword = $newPassword
      requestId = 'password-recovery-' + [Guid]::NewGuid().ToString('N')
    }
    $recoveryUsed = $true
  }
  $verified = Invoke-AdminApi @{
    action = 'admin.login'
    requestId = 'password-reset-verify-' + [Guid]::NewGuid().ToString('N')
    payload = @{ username = $credential.username; password = $newPassword }
  }

  $updatedCredentialText = "username=$($credential.username)`npassword=$newPassword`n"
  $protected = ConvertTo-SecureString $updatedCredentialText -AsPlainText -Force | ConvertFrom-SecureString
  $temporaryCredentialFile = $CredentialFile + '.new'
  [IO.File]::WriteAllText($temporaryCredentialFile, $protected, [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporaryCredentialFile -Destination $CredentialFile -Force

  [pscustomobject]@{
    passwordChanged = [bool]$changed.passwordChanged
    loginVerified = [bool]$verified.token
    username = $verified.admin.username
    recoveryUsed = $recoveryUsed
    localProtectedCredentialUpdated = $true
    secretValuePrinted = $false
  } | ConvertTo-Json -Compress
} finally {
  $credentialText = $null
  $newPassword = $null
  $updatedCredentialText = $null
  $protected = $null
  $secureNewPassword = $null
  $recoveryUsed = $null
  if ($credential) { $credential.Clear() }
}
