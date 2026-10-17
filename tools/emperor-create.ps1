# ============================================================
# СОЗДАНИЕ ИМПЕРАТОРСКОГО КОШЕЛЬКА — скрытый ввод пароля.
# Пароль вводится в этом окне самим владельцем; эха НЕТ
# (Read-Host -AsSecureString) → секрет не попадает в историю
# команд, логи, чат или скриншоты. Двойной ввод против опечатки.
# Мнемоника распечатывается ОДИН РАЗ — записать НА БУМАГУ.
# ============================================================
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Join-Path $PSScriptRoot '..')

$p1 = Read-Host -Prompt 'Пароль хранилища (ввод скрыт)' -AsSecureString
$p2 = Read-Host -Prompt 'Повторите пароль' -AsSecureString
$b1 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($p1)
$b2 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($p2)
$pass1 = [Runtime.InteropServices.Marshal]::PtrToStringAuto($b1)
$pass2 = [Runtime.InteropServices.Marshal]::PtrToStringAuto($b2)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b1)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b2)
if ([string]::IsNullOrWhiteSpace($pass1) -or $pass1.Length -lt 8) { Write-Host 'ОШИБКА: пароль пустой или короче 8 символов.'; exit 2 }
if ($pass1 -cne $pass2) { Write-Host 'ОШИБКА: пароли не совпали. Хранилище не создано.'; exit 2 }

$wordsN = Read-Host -Prompt 'Сколько слов мнемоники: 12 (компактно) или 24 (макс. стойкость) [12]'
if (-not $wordsN) { $wordsN = '12' }
$label = Read-Host -Prompt 'Метка кошелька [Император]'
if (-not $label) { $label = 'Император' }

# секреты передаются node ТОЛЬКО через stdin-маркеры (PASS:/PASS2:), не аргументами и не env-переменными
$tmp = New-TemporaryFile
try {
  [IO.File]::WriteAllText($tmp.FullName, "PASS:$pass1`nPASS2:$pass2`n")
  Get-Content -LiteralPath $tmp.FullName | node tools/emperor-wallet.mjs create --words $wordsN --label $label
  $code = $LASTEXITCODE
} finally {
  Remove-Item -LiteralPath $tmp.FullName -Force | Out-Null
  # перетираем память от копий секрета — best effort
  [GC]::Collect()
}
exit $code
