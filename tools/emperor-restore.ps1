# ============================================================
# ВОССТАНОВЛЕНИЕ ИМПЕРАТОРСКОГО КОШЕЛЬКА ИЗ МНЕМОНИКИ.
# Слова и пароль вводятся скрыто; эха нет.
# Работает на любой машине через годы: Node >= 18 + tools/.
# ============================================================
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Join-Path $PSScriptRoot '..')

$sw = Read-Host -Prompt 'Мнемоника (12/24 слова, ввод скрыт, через пробел)' -AsSecureString
$sp = Read-Host -Prompt 'Пароль ХРАНИЛИЩА для восстановленного кошелька (новый, скрыт)' -AsSecureString
$sp2 = Read-Host -Prompt 'Повторите новый пароль' -AsSecureString
$bs = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sw)
$bp = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sp)
$bp2 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sp2)
$words = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bs)
$pass1 = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bp)
$pass2 = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bp2)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bs)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bp)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bp2)
if ([string]::IsNullOrWhiteSpace($pass1) -or $pass1.Length -lt 8) { Write-Host 'ОШИБКА: пароль пустой или короче 8 символов.'; exit 2 }
if ($pass1 -cne $pass2) { Write-Host 'ОШИБКА: пароли не совпали.'; exit 2 }

$outPath = Read-Host -Prompt 'Куда сохранить файл хранилища [data-emperor/restored.empw]'
if (-not $outPath) { $outPath = 'data-emperor/restored.empw' }

$tmp = New-TemporaryFile
try {
  [IO.File]::WriteAllText($tmp.FullName, "PASS:$pass1`nPASS2:$pass2`nWORDS:$words`n")
  Get-Content -LiteralPath $tmp.FullName | node tools/emperor-wallet.mjs restore --file $outPath
  $code = $LASTEXITCODE
} finally {
  Remove-Item -LiteralPath $tmp.FullName -Force | Out-Null
  [GC]::Collect()
}
exit $code
