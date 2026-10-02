#!/bin/bash
# Crée la Release GitHub de la version indiquée dans extension/manifest.json,
# avec kappgen-uploader.zip (manifeste à la racine : sert aussi pour le Chrome Web Store).
# Lien fixe vers la dernière version :
#   https://github.com/rosby17/kappgen-uploader/releases/latest/download/kappgen-uploader.zip
set -e
cd "$(dirname "$0")"
V=$(python3 -c "import json;print(json.load(open('extension/manifest.json'))['version'])")
rm -rf dist && mkdir dist
(cd extension && zip -rqX ../dist/kappgen-uploader.zip . -x ".*" -x "*/.DS_Store")
# Chrome Web Store: same files, without "key" (the store refuses it and gives its own id).
rm -rf dist/store && mkdir dist/store && (cd dist/store && unzip -q ../kappgen-uploader.zip \
  && python3 -c "import json;p='manifest.json';m=json.load(open(p));m.pop('key',None);open(p,'w').write(json.dumps(m,ensure_ascii=False,indent=2)+'\\n')" \
  && zip -rqX ../kappgen-uploader-chrome-web-store.zip . ) && rm -rf dist/store
git diff --quiet && git diff --cached --quiet || { echo "Commite d'abord tes changements."; exit 1; }
git push -q origin HEAD
gh release create "v$V" dist/kappgen-uploader.zip --title "KappGen Publish $V" --notes "${1:-Version $V}" --latest
echo "Publiée : https://github.com/rosby17/kappgen-uploader/releases/tag/v$V"
