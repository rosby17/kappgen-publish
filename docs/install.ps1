# Installe (ou met a jour) KappGen Publish sur Windows, dans TOUS les profils Chrome.
#   irm https://app.kappgen.com/extension/install.ps1 | iex   (renvoie vers ce fichier)
# Telecharge la derniere version dans %USERPROFILE%\KappGen-Publish, puis :
#  - met a jour l'extension dans chaque profil Chrome qui l'a deja, quel que
#    soit le dossier d'ou ce profil la charge (aucun clic) ;
#  - pour les profils qui ne l'ont pas encore, propose de l'y ajouter, un
#    profil apres l'autre (Chrome impose 3 clics par nouveau profil).
# Texte sans accents : PowerShell 5 les affiche mal quand le script vient du web.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$repo = 'rosby17/kappgen-publish'
# Dernière version demandée à l'API GitHub (toujours à jour). Le lien « releases/latest/download »
# est mis en cache plusieurs minutes après une publication : il ne sert qu'en secours.
$zipUrl = "https://github.com/$repo/releases/latest/download/kappgen-publish.zip"
try {
  $tag = (Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers @{ Accept = 'application/vnd.github+json' } -UseBasicParsing).tag_name
  if ($tag -match '^v[0-9]') { $zipUrl = "https://github.com/$repo/releases/download/$tag/kappgen-publish.zip" }
} catch { }
$shaUrl = $zipUrl + '.sha256'
$dir = Join-Path $env:USERPROFILE 'KappGen-Publish'

Write-Host ''
Write-Host '  KappGen Publish : installation et mise a jour'
Write-Host '  ---------------------------------------------'

$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $chrome) {
  Write-Host '  X Google Chrome n''est pas installe.' -ForegroundColor Red
  Write-Host '    Installe-le d''abord (gratuit) : https://www.google.com/chrome/'
  Write-Host '    puis relance la meme commande.'
  if ($env:KAPPGEN_SILENCIEUX) { throw 'Google Chrome n''est pas installe.' }
  Start-Process 'https://www.google.com/chrome/'
  return
}

Write-Host '  1/3  Telechargement de la derniere version...'
$tmp = Join-Path $env:TEMP ('kappgen-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
$zip = Join-Path $tmp 'k.zip'
Invoke-WebRequest -Uri $zipUrl -OutFile $zip -UseBasicParsing
$shaFile = Join-Path $tmp 'k.zip.sha256'
Invoke-WebRequest -Uri $shaUrl -OutFile $shaFile -UseBasicParsing
$expected = ((Get-Content $shaFile -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
$actual = (Get-FileHash -Path $zip -Algorithm SHA256).Hash.ToLowerInvariant()
if (-not $expected -or $expected -ne $actual) {
  throw 'Signature SHA-256 invalide : telechargement annule.'
}
$new = Join-Path $tmp 'x'
Expand-Archive -Path $zip -DestinationPath $new -Force
$manifestPath = Join-Path $new 'manifest.json'
if (-not (Test-Path $manifestPath)) { throw 'Archive telechargee incomplete.' }
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
if ($manifest.name -ne 'KappGen Publish') { throw 'Archive telechargee invalide.' }
$version = $manifest.version

# Replaces the content of an extension folder with the new version (same
# folder: Chrome keeps the extension, its settings and its connection).
function Set-KappVersion($target) {
  $full = [IO.Path]::GetFullPath([string]$target).TrimEnd('\')
  $userHome = [IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\')
  $driveRoot = ([IO.Path]::GetPathRoot($full)).TrimEnd('\')
  if (-not $full -or $full -eq $userHome -or $full -eq $driveRoot) {
    throw "Dossier de destination dangereux : $full"
  }
  if (Test-Path $full) {
    $item = Get-Item $full -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Lien symbolique non modifie : $full" }
    $existing = @(Get-ChildItem $full -Force)
    if ($existing.Count -gt 0) {
      $oldManifest = Join-Path $full 'manifest.json'
      if ((-not (Test-Path $oldManifest)) -or ((Get-Content $oldManifest -Raw) -notmatch '"name"\s*:\s*"KappGen Publish"')) {
        throw "Le dossier existe mais ne contient pas KappGen Publish : $full"
      }
    }
  }
  $parent = Split-Path $full -Parent
  $leaf = Split-Path $full -Leaf
  $stage = Join-Path $parent ('.' + $leaf + '.new.' + [guid]::NewGuid())
  $backup = Join-Path $parent ('.' + $leaf + '.backup.' + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
  Copy-Item -Path $new -Destination $stage -Recurse -Force
  if (Test-Path $full) { Move-Item -Path $full -Destination $backup }
  try {
    Move-Item -Path $stage -Destination $full
  } catch {
    if (Test-Path $backup) { Move-Item -Path $backup -Destination $full }
    throw
  }
  if (Test-Path $backup) { Remove-Item -Path $backup -Recurse -Force }
}

Write-Host "  2/3  Rangement dans $dir"
Set-KappVersion $dir

# Assistant de mise a jour en 1 clic : le bouton "Mettre a jour" du panneau
# demande a Chrome de lancer ce petit script (native messaging), qui relance
# cet installateur sans rien demander. Declare pour tous les profils Chrome.
function Install-KappHelper {
  $helperDir = Join-Path $env:LOCALAPPDATA 'KappGen-Publish'
  New-Item -ItemType Directory -Path $helperDir -Force | Out-Null
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  $ps1 = @'
# Assistant de mise a jour de KappGen Publish. Chrome le lance quand on clique
# "Mettre a jour" dans le panneau : il relance l'installateur de la derniere
# version sans rien demander, puis repond a l'extension, qui redemarre.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repo = 'rosby17/kappgen-publish'
$log = Join-Path $PSScriptRoot 'maj.log'
# Reponse au format de Chrome : longueur sur 4 octets, puis le JSON.
function Send-Reply($object) {
  $bytes = [Text.Encoding]::UTF8.GetBytes(($object | ConvertTo-Json -Compress))
  $out = [Console]::OpenStandardOutput()
  $out.Write([BitConverter]::GetBytes([int]$bytes.Length), 0, 4)
  $out.Write($bytes, 0, $bytes.Length)
  $out.Flush()
}
try {
  $in = [Console]::OpenStandardInput()
  $head = New-Object byte[] 4
  if ($in.Read($head, 0, 4) -eq 4) {
    $left = [BitConverter]::ToInt32($head, 0)
    $buffer = New-Object byte[] 4096
    while ($left -gt 0) { $read = $in.Read($buffer, 0, [Math]::Min($left, 4096)); if ($read -le 0) { break }; $left -= $read }
  }
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $tag = (Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers @{ Accept = 'application/vnd.github+json' } -UseBasicParsing).tag_name
  if ($tag -notmatch '^v[0-9]') { throw 'GitHub ne repond pas : verifie ta connexion Internet et reessaie.' }
  $script = Join-Path ([IO.Path]::GetTempPath()) ('kappgen-install-' + [guid]::NewGuid() + '.ps1')
  Invoke-WebRequest -Uri "https://raw.githubusercontent.com/$repo/$tag/docs/install.ps1" -OutFile $script -UseBasicParsing
  $env:KAPPGEN_SILENCIEUX = '1'
  try {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script *> $log
    $code = $LASTEXITCODE
  } finally {
    Remove-Item $script -Force -ErrorAction SilentlyContinue
  }
  $text = Get-Content $log -Raw -ErrorAction SilentlyContinue
  if ($code -ne 0) {
    # PowerShell ecrit l'erreur sous la forme "C:\...\script.ps1 : message".
    $reason = if ($text -match '(?m)\.ps1 : (.+)$') { $Matches[1].Trim() } else { "L'installation a echoue (details : $log)." }
    throw $reason
  }
  $version = if ($text -match 'Version ([0-9][0-9.]*) en place') { $Matches[1] } else { '' }
  Send-Reply @{ ok = $true; version = $version }
} catch {
  Send-Reply @{ ok = $false; error = [string]$_.Exception.Message }
}
'@
  [IO.File]::WriteAllText((Join-Path $helperDir 'assistant-maj.ps1'), $ps1, $utf8)
  # cmd lit un .bat au fur et a mesure : on ne le reecrit que s'il change.
  $bat = "@echo off`r`npowershell.exe -NoProfile -ExecutionPolicy Bypass -File `"%~dp0assistant-maj.ps1`"`r`n"
  $batPath = Join-Path $helperDir 'assistant-maj.bat'
  if (-not (Test-Path $batPath) -or (Get-Content $batPath -Raw) -ne $bat) { [IO.File]::WriteAllText($batPath, $bat, [Text.Encoding]::ASCII) }
  $hostJson = Join-Path $helperDir 'com.kappgen.publish.json'
  $manifestText = [ordered]@{
    name = 'com.kappgen.publish'
    description = 'KappGen Publish : mise a jour en 1 clic'
    path = $batPath
    type = 'stdio'
    allowed_origins = @('chrome-extension://ohgfmmejmlbdpflenlkikbnebgfegkic/')
  } | ConvertTo-Json
  [IO.File]::WriteAllText($hostJson, $manifestText, $utf8)
  $key = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.kappgen.publish'
  New-Item -Path $key -Force | Out-Null
  Set-Item -Path $key -Value $hostJson
}
try { Install-KappHelper } catch { Write-Host '  -  Assistant de mise a jour en 1 clic non installe (la commande reste possible).' }

# Every Chrome profile, and where it loads KappGen Publish from (if it has it).
$userData = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'
$profiles = @()
try {
  $cache = (Get-Content (Join-Path $userData 'Local State') -Raw | ConvertFrom-Json).profile.info_cache
  foreach ($p in $cache.PSObject.Properties) {
    $found = ''
    foreach ($file in @('Secure Preferences', 'Preferences')) {
      $prefPath = Join-Path (Join-Path $userData $p.Name) $file
      if (-not (Test-Path $prefPath)) { continue }
      try { $settings = (Get-Content $prefPath -Raw | ConvertFrom-Json).extensions.settings } catch { continue }
      if (-not $settings) { continue }
      foreach ($e in $settings.PSObject.Properties) {
        $path = $e.Value.path
        if ($found -or -not $path -or -not [IO.Path]::IsPathRooted($path)) { continue }
        $m = Join-Path $path 'manifest.json'
        if ((Test-Path $m) -and ((Get-Content $m -Raw) -match 'KappGen Publish')) { $found = $path }
      }
    }
    $profiles += [pscustomobject]@{ Dir = $p.Name; Name = [string]$p.Value.name; Path = $found }
  }
} catch { $profiles = @() }

$updated = @()
$missing = @()
foreach ($p in $profiles) {
  if ($p.Path) {
    if ($p.Path.TrimEnd('\') -ne $dir.TrimEnd('\')) {
      $inGitWorkTree = $false
      if (Get-Command git -ErrorAction SilentlyContinue) {
        & git -C $p.Path rev-parse --is-inside-work-tree *> $null
        $inGitWorkTree = $LASTEXITCODE -eq 0
      }
      if ($inGitWorkTree) {
        Write-Host "  -  $($p.Name) : dossier de developpement ($($p.Path)), non touche."
        continue
      }
      Set-KappVersion $p.Path
    }
    $updated += $p
  } else {
    $missing += $p
  }
}
Remove-Item -Path $tmp -Recurse -Force

Write-Host "  3/3  Version $version en place."
Write-Host ''
if ($updated.Count -gt 0) {
  Write-Host "  OK  MIS A JOUR dans $($updated.Count) profil(s) Chrome :" -ForegroundColor Green
  foreach ($p in $updated) { Write-Host "      - $($p.Name)  ($($p.Path))" }
  Write-Host '      KappGen Publish s''y recharge tout seul d''ici une minute, ou a la fin de la'
  Write-Host '      publication en cours. Pour tout de suite : ferme Chrome completement et rouvre-le.'
  Write-Host ''
}
# Launched by the "Mettre a jour" button: updating is all it does.
if ($env:KAPPGEN_SILENCIEUX) { return }
if ($profiles.Count -eq 0) { $missing = @([pscustomobject]@{ Dir = 'Default'; Name = 'ton profil Chrome'; Path = '' }) }
if ($missing.Count -eq 0) { return }

# Profiles without the extension: the creator picks which ones (none by default).
$chosen = @()
if ($updated.Count -eq 0 -and $missing.Count -eq 1) {
  $chosen = @($missing[0]) # first install, one profile: nothing to choose
} else {
  Write-Host '  Profils Chrome sans KappGen Publish :'
  $n = 0
  foreach ($p in $missing) { $n++; Write-Host "      $n. $($p.Name)" }
  Write-Host ''
  Write-Host '  Dans lesquels l''installer ? Tape leurs numeros (ex. 1 3), t pour tous,'
  $answer = Read-Host '  ou appuie juste sur Entree pour n''en ajouter aucun'
  if ($answer -match '^\s*(t|tous)\s*$') {
    $chosen = @($missing)
  } else {
    foreach ($m in [regex]::Matches([string]$answer, '\d+')) {
      $k = [int]$m.Value
      if ($k -ge 1 -and $k -le $missing.Count -and -not ($chosen -contains $missing[$k - 1])) { $chosen += $missing[$k - 1] }
    }
  }
  if ($chosen.Count -eq 0) {
    Write-Host '  D''accord, aucun profil ajoute. C''est termine.'
    Write-Host ''
    return
  }
}

$i = 0
foreach ($p in $chosen) {
  $i++
  Set-Clipboard -Value $dir
  Write-Host ''
  Write-Host ('  >  Profil "' + $p.Name + '" (' + $i + '/' + $chosen.Count + ') : Chrome s''ouvre sur ses extensions.') -ForegroundColor Cyan
  Start-Process -FilePath $chrome -ArgumentList @(('--profile-directory="' + $p.Dir + '"'), 'chrome://extensions/')
  Write-Host '    1. En haut a droite, allume "Mode developpeur" (il devient bleu).'
  Write-Host '    2. Clique "Charger l''extension non empaquetee".'
  Write-Host '    3. Clique dans la barre d''adresse tout en haut de la fenetre, appuie sur'
  Write-Host '       Ctrl + V  (le chemin est deja copie), puis  Entree , puis "Selectionner un dossier".'
  if ($i -lt $chosen.Count) { [void](Read-Host '  Appuie sur Entree quand c''est fait pour passer au profil suivant') }
}

Write-Host ''
Write-Host '  La carte "KappGen Publish" apparait dans le profil : c''est installe.'
Write-Host '  Ensuite, dans chaque profil : piece de puzzle en haut a droite de Chrome,'
Write-Host '  epingle KappGen Publish, puis clique son logo pour te connecter.'
Write-Host '  Prochaines mises a jour : bouton "Mettre a jour" dans le panneau'
Write-Host '  (ou relance cette commande) ; tous les profils suivent d''un coup.'
Write-Host ''
Write-Host "  Ne supprime pas le dossier $dir : Chrome s'en sert."
Write-Host ''
