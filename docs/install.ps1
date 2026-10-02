# Installe (ou met a jour) KappGen Publish sur Windows, dans TOUS les profils Chrome.
#   irm https://rosby17.github.io/kappgen-uploader/install.ps1 | iex
# Telecharge la derniere version dans %USERPROFILE%\KappGen-Publish, puis :
#  - met a jour l'extension dans chaque profil Chrome qui l'a deja, quel que
#    soit le dossier d'ou ce profil la charge (aucun clic) ;
#  - pour les profils qui ne l'ont pas encore, propose de l'y ajouter, un
#    profil apres l'autre (Chrome impose 3 clics par nouveau profil).
# Texte sans accents : PowerShell 5 les affiche mal quand le script vient du web.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$zipUrl = 'https://github.com/rosby17/kappgen-uploader/releases/latest/download/kappgen-uploader.zip'
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
  Start-Process 'https://www.google.com/chrome/'
  return
}

Write-Host '  1/3  Telechargement de la derniere version...'
$tmp = Join-Path $env:TEMP ('kappgen-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
$zip = Join-Path $tmp 'k.zip'
Invoke-WebRequest -Uri $zipUrl -OutFile $zip -UseBasicParsing
$new = Join-Path $tmp 'x'
Expand-Archive -Path $zip -DestinationPath $new -Force
if (-not (Test-Path (Join-Path $new 'manifest.json'))) {
  Write-Host '  X Fichier telecharge incomplet, reessaie dans un instant.' -ForegroundColor Red
  return
}
$version = (Get-Content (Join-Path $new 'manifest.json') -Raw | ConvertFrom-Json).version

# Replaces the content of an extension folder with the new version (same
# folder: Chrome keeps the extension, its settings and its connection).
function Set-KappVersion($target) {
  New-Item -ItemType Directory -Path $target -Force | Out-Null
  Get-ChildItem -Path $target -Force | Remove-Item -Recurse -Force
  Copy-Item -Path (Join-Path $new '*') -Destination $target -Recurse -Force
}

Write-Host "  2/3  Rangement dans $dir"
Set-KappVersion $dir

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
      if (Test-Path (Join-Path (Split-Path $p.Path -Parent) '.git')) {
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
  foreach ($p in $updated) { Write-Host "      - $($p.Name)" }
  Write-Host '      Rien d''autre a faire : KappGen Publish s''y recharge tout seul d''ici une minute.'
  Write-Host ''
}
if ($profiles.Count -eq 0) { $missing = @([pscustomobject]@{ Dir = 'Default'; Name = 'ton profil Chrome'; Path = '' }) }
if ($missing.Count -eq 0) { return }

Write-Host "  KappGen Publish n'est pas encore dans $($missing.Count) profil(s) :"
foreach ($p in $missing) { Write-Host "      - $($p.Name)" }
Write-Host ''
if ($updated.Count -gt 0) {
  $answer = Read-Host '  L''ajouter aussi dans ces profils ? (o = oui, n = non) [o]'
  if ($answer -match '^(n|non)$') { Write-Host '  D''accord. Relance la commande quand tu veux l''ajouter.'; return }
}

$i = 0
foreach ($p in $missing) {
  $i++
  Set-Clipboard -Value $dir
  Write-Host ''
  Write-Host ('  >  Profil "' + $p.Name + '" (' + $i + '/' + $missing.Count + ') : Chrome s''ouvre sur ses extensions.') -ForegroundColor Cyan
  Start-Process -FilePath $chrome -ArgumentList @(('--profile-directory="' + $p.Dir + '"'), 'chrome://extensions/')
  Write-Host '    1. En haut a droite, allume "Mode developpeur" (il devient bleu).'
  Write-Host '    2. Clique "Charger l''extension non empaquetee".'
  Write-Host '    3. Clique dans la barre d''adresse tout en haut de la fenetre, appuie sur'
  Write-Host '       Ctrl + V  (le chemin est deja copie), puis  Entree , puis "Selectionner un dossier".'
  if ($i -lt $missing.Count) { [void](Read-Host '  Appuie sur Entree quand c''est fait pour passer au profil suivant') }
}

Write-Host ''
Write-Host '  La carte "KappGen Publish" apparait dans chaque profil : c''est installe.'
Write-Host '  Ensuite, dans chaque profil : piece de puzzle en haut a droite de Chrome,'
Write-Host '  epingle KappGen Publish, puis clique son logo pour te connecter.'
Write-Host '  Prochaines mises a jour : relance juste cette commande, tous les profils'
Write-Host '  sont mis a jour d''un coup, sans clic.'
Write-Host ''
Write-Host "  Ne supprime pas le dossier $dir : Chrome s'en sert."
Write-Host ''
