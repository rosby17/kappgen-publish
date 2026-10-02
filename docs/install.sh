#!/bin/bash
# Installe (ou met à jour) KappGen Publish sur Mac.
#   curl -fsSL https://rosby17.github.io/kappgen-uploader/install.sh | bash
# Télécharge la dernière version dans ~/KappGen-Publish, copie ce chemin dans
# le presse-papiers et ouvre la page des extensions de Chrome. Chrome interdit
# d'installer une extension sans un clic de l'utilisateur : les 3 derniers
# clics restent à faire (affichés à la fin).
set -e
ZIP_URL="https://github.com/rosby17/kappgen-uploader/releases/latest/download/kappgen-uploader.zip"
DIR="$HOME/KappGen-Publish"

echo ""
echo "  KappGen Publish : installation"
echo "  ------------------------------"

CHROME=""
for app in "/Applications/Google Chrome.app" "$HOME/Applications/Google Chrome.app"; do
  [ -d "$app" ] && CHROME="$app"
done
if [ -z "$CHROME" ]; then
  echo "  ✗ Google Chrome n'est pas installé."
  echo "    Installe-le d'abord (gratuit) : https://www.google.com/chrome/"
  echo "    puis relance la même commande."
  open "https://www.google.com/chrome/" 2>/dev/null || true
  exit 1
fi

DEJA=""
[ -f "$DIR/manifest.json" ] && DEJA=1

echo "  1/3  Téléchargement de la dernière version…"
TMP=$(mktemp -d)
curl -fsSL -o "$TMP/k.zip" "$ZIP_URL"
mkdir -p "$TMP/x"
unzip -q "$TMP/k.zip" -d "$TMP/x"
[ -f "$TMP/x/manifest.json" ] || { echo "  ✗ Fichier téléchargé incomplet, réessaie dans un instant."; exit 1; }

echo "  2/3  Rangement dans $DIR"
# Même dossier à chaque fois : Chrome garde l'extension et ses réglages.
mkdir -p "$DIR"
find "$DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
cp -R "$TMP/x/." "$DIR/"
rm -rf "$TMP"
VERSION=$(sed -n 's/.*"version"[^"]*"\([^"]*\)".*/\1/p' "$DIR/manifest.json" | head -1)

if [ -n "$DEJA" ]; then
  echo "  3/3  Terminé : version $VERSION en place."
  echo ""
  echo "  ✓ MISE À JOUR FAITE. Rien d'autre à faire :"
  echo "    KappGen Publish se recharge tout seul dans Chrome d'ici une minute."
  echo ""
  exit 0
fi

printf '%s' "$DIR" | pbcopy
echo "  3/3  Ouverture de Chrome…"
open -a "$CHROME" "chrome://extensions/"

cat <<EOF

  ✓ Version $VERSION téléchargée. Plus que 3 clics dans Chrome :

    1. En haut à droite, allume « Mode développeur » (il devient bleu).
    2. Clique « Charger l'extension non empaquetée ».
    3. Dans la fenêtre qui s'ouvre, appuie sur  Cmd + Maj + G ,
       puis  Cmd + V  (le chemin est déjà copié), puis  Entrée ,
       puis clique « Sélectionner ».

  La carte « KappGen Publish » apparaît : c'est installé.
  Ensuite : clique la pièce de puzzle en haut à droite de Chrome,
  épingle KappGen Publish, puis clique son logo pour te connecter.

  Ne supprime pas le dossier $DIR : Chrome s'en sert.

EOF
