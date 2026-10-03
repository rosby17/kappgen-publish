#!/bin/bash
# Valide, empaquette et publie la version de extension/manifest.json.
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$ROOT"

if [ -n "$(git status --porcelain --untracked-files=all)" ]; then
  echo "Le dépôt contient des changements non commités. Vérifie-les et commite-les avant de publier." >&2
  exit 1
fi

command -v node >/dev/null || { echo "Node.js 20+ est requis." >&2; exit 1; }
command -v npm >/dev/null || { echo "npm est requis." >&2; exit 1; }
command -v gh >/dev/null || { echo "GitHub CLI (gh) est requis." >&2; exit 1; }
command -v zip >/dev/null || { echo "zip est requis." >&2; exit 1; }

VERSION=$(node -p "require('./extension/manifest.json').version")
PACKAGE_VERSION=$(node -p "require('./package.json').version")
[ "$VERSION" = "$PACKAGE_VERSION" ] || { echo "Versions différentes : manifest=$VERSION, package=$PACKAGE_VERSION" >&2; exit 1; }
TAG="v$VERSION"

npm run check
git fetch --quiet origin
read -r BEHIND AHEAD <<EOF
$(git rev-list --left-right --count '@{upstream}...HEAD')
EOF
[ "$BEHIND" = "0" ] || { echo "La branche locale a $BEHIND commit(s) de retard sur son upstream." >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "Le tag $TAG existe déjà." >&2; exit 1; }
[ -z "$(git ls-remote --tags origin "refs/tags/$TAG")" ] || { echo "Le tag distant $TAG existe déjà." >&2; exit 1; }
gh release view "$TAG" >/dev/null 2>&1 && { echo "La release $TAG existe déjà." >&2; exit 1; }

DIST="$ROOT/dist"
mkdir -p "$DIST"
find "$DIST" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
TMP=$(mktemp -d)
trap 'rm -rf -- "$TMP"' EXIT

(cd extension && zip -rqX "$DIST/kappgen-publish.zip" . -x ".*" -x "*/.DS_Store")
unzip -q "$DIST/kappgen-publish.zip" -d "$TMP/store"
node -e "const fs=require('fs');const p='$TMP/store/manifest.json';const m=JSON.parse(fs.readFileSync(p));delete m.key;fs.writeFileSync(p,JSON.stringify(m,null,2)+'\\n')"
(cd "$TMP/store" && zip -rqX "$DIST/kappgen-publish-chrome-web-store.zip" . -x ".*" -x "*/.DS_Store")

hash_file() {
  if command -v shasum >/dev/null; then shasum -a 256 "$1"
  elif command -v sha256sum >/dev/null; then sha256sum "$1"
  else echo "Aucun outil SHA-256 disponible." >&2; return 1
  fi
}
(cd "$DIST" && hash_file kappgen-publish.zip > kappgen-publish.zip.sha256
  hash_file kappgen-publish-chrome-web-store.zip > kappgen-publish-chrome-web-store.zip.sha256)

git push --quiet origin HEAD
gh release create "$TAG" \
  "$DIST/kappgen-publish.zip" \
  "$DIST/kappgen-publish.zip.sha256" \
  "$DIST/kappgen-publish-chrome-web-store.zip" \
  "$DIST/kappgen-publish-chrome-web-store.zip.sha256" \
  --target "$(git rev-parse HEAD)" --title "KappGen Publish $VERSION" \
  --notes "${1:-Version $VERSION}" --latest

echo "Publiée : https://github.com/rosby17/kappgen-publish/releases/tag/$TAG"
