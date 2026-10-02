# Installe (ou met a jour) KappGen Publish sur Windows.
#   irm https://rosby17.github.io/kappgen-uploader/install.ps1 | iex
# Telecharge la derniere version dans %USERPROFILE%\KappGen-Publish, copie ce
# chemin dans le presse-papiers et ouvre la page des extensions de Chrome.
# Chrome interdit d'installer une extension sans un clic de l'utilisateur :
# les 3 derniers clics restent a faire (affiches a la fin).
# Texte sans accents : PowerShell 5 les affiche mal quand le script vient du web.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$zipUrl = 'https://github.com/rosby17/kappgen-uploader/releases/latest/download/kappgen-uploader.zip'
$dir = Join-Path $env:USERPROFILE 'KappGen-Publish'

Write-Host ''
Write-Host '  KappGen Publish : installation'
Write-Host '  ------------------------------'

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

$deja = Test-Path (Join-Path $dir 'manifest.json')

Write-Host '  1/3  Telechargement de la derniere version...'
$tmp = Join-Path $env:TEMP ('kappgen-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
$zip = Join-Path $tmp 'k.zip'
Invoke-WebRequest -Uri $zipUrl -OutFile $zip -UseBasicParsing
Expand-Archive -Path $zip -DestinationPath (Join-Path $tmp 'x') -Force
if (-not (Test-Path (Join-Path $tmp 'x\manifest.json'))) {
  Write-Host '  X Fichier telecharge incomplet, reessaie dans un instant.' -ForegroundColor Red
  return
}

Write-Host "  2/3  Rangement dans $dir"
# Meme dossier a chaque fois : Chrome garde l'extension et ses reglages.
New-Item -ItemType Directory -Path $dir -Force | Out-Null
Get-ChildItem -Path $dir -Force | Remove-Item -Recurse -Force
Copy-Item -Path (Join-Path $tmp 'x\*') -Destination $dir -Recurse -Force
Remove-Item -Path $tmp -Recurse -Force
$version = (Get-Content (Join-Path $dir 'manifest.json') -Raw | ConvertFrom-Json).version

if ($deja) {
  Write-Host "  3/3  Termine : version $version en place."
  Write-Host ''
  Write-Host '  OK  MISE A JOUR FAITE. Rien d''autre a faire :' -ForegroundColor Green
  Write-Host '      KappGen Publish se recharge tout seul dans Chrome d''ici une minute.'
  Write-Host ''
  return
}

Set-Clipboard -Value $dir
Write-Host '  3/3  Ouverture de Chrome...'
Start-Process -FilePath $chrome -ArgumentList 'chrome://extensions/'

Write-Host ''
Write-Host "  OK  Version $version telechargee. Plus que 3 clics dans Chrome :" -ForegroundColor Green
Write-Host ''
Write-Host '    1. En haut a droite, allume "Mode developpeur" (il devient bleu).'
Write-Host '    2. Clique "Charger l''extension non empaquetee".'
Write-Host '    3. Dans la fenetre qui s''ouvre, clique dans la barre d''adresse'
Write-Host '       tout en haut, appuie sur  Ctrl + V  (le chemin est deja copie),'
Write-Host '       puis  Entree , puis clique "Selectionner un dossier".'
Write-Host ''
Write-Host '  La carte "KappGen Publish" apparait : c''est installe.'
Write-Host '  Ensuite : clique la piece de puzzle en haut a droite de Chrome,'
Write-Host '  epingle KappGen Publish, puis clique son logo pour te connecter.'
Write-Host ''
Write-Host "  Ne supprime pas le dossier $dir : Chrome s'en sert."
Write-Host ''
