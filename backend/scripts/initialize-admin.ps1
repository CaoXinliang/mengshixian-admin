[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$BootstrapToken,
  [Parameter(Mandatory = $true)][string]$Username,
  [Parameter(Mandatory = $true)][string]$DisplayName,
  [Parameter(Mandatory = $true)][securestring]$Password,
  [string]$EnvId = 'mengshixian-demo-d7eaxgh8acf8655',
  [string]$FunctionName = 'api'
)

$runtimeNode = 'C:\Users\YEFAN\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$cliEntry = Join-Path $PSScriptRoot '..\..\.tools\cloudbase-cli\package\bin\tcb'
if (!(Test-Path -LiteralPath $runtimeNode) -or !(Test-Path -LiteralPath $cliEntry)) { throw '未找到项目本地 CloudBase CLI 或捆绑 Node.js。' }

$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Password)
try {
  $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  if ($plainPassword.Length -lt 12) { throw '管理员密码至少需要 12 位。' }
  $body = @{ action = 'admin.bootstrap'; requestId = ('bootstrap-' + [Guid]::NewGuid().ToString('N')); payload = @{ bootstrapToken = $BootstrapToken; username = $Username; displayName = $DisplayName; password = $plainPassword } } | ConvertTo-Json -Compress
  & $runtimeNode $cliEntry fn invoke $FunctionName -e $EnvId -d $body --json
} finally {
  if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}
