#!/bin/bash
# Installe (ou met à jour) KappGen Publish sur Mac, dans TOUS les profils Chrome.
#   curl -fsSL https://rosby17.github.io/kappgen-uploader/install.sh | bash
# Télécharge la dernière version dans ~/KappGen-Publish, puis :
#  - met à jour l'extension dans chaque profil Chrome qui l'a déjà, quel que
#    soit le dossier d'où ce profil la charge (aucun clic : elle se recharge
#    toute seule en une minute) ;
#  - pour les profils qui ne l'ont pas encore, propose de l'y ajouter, un
#    profil après l'autre. Chrome interdit d'ajouter une extension sans un
#    clic de l'utilisateur : 3 clics par nouveau profil.
set -e
ZIP_URL="https://github.com/rosby17/kappgen-uploader/releases/latest/download/kappgen-uploader.zip"
DIR="$HOME/KappGen-Publish"
CHROME_DATA="$HOME/Library/Application Support/Google/Chrome"

echo ""
echo "  KappGen Publish : installation et mise à jour"
echo "  ---------------------------------------------"

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

echo "  1/3  Téléchargement de la dernière version…"
TMP=$(mktemp -d)
curl -fsSL -o "$TMP/k.zip" "$ZIP_URL"
mkdir -p "$TMP/x"
unzip -q "$TMP/k.zip" -d "$TMP/x"
[ -f "$TMP/x/manifest.json" ] || { echo "  ✗ Fichier téléchargé incomplet, réessaie dans un instant."; exit 1; }
VERSION=$(sed -n 's/.*"version"[^"]*"\([^"]*\)".*/\1/p' "$TMP/x/manifest.json" | head -1)

# Replaces the content of an extension folder with the new version (same
# folder: Chrome keeps the extension, its settings and its connection).
put_version() {
  mkdir -p "$1"
  find "$1" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  cp -R "$TMP/x/." "$1/"
}

echo "  2/3  Rangement dans $DIR"
put_version "$DIR"

# Every Chrome profile: "dossier<TAB>nom<TAB>chemin de KappGen Publish (vide si absent)".
# Read with JavaScript for Automation (built into macOS): Local State lists the
# profiles, each profile's (Secure) Preferences lists its extensions.
PROFILES=$(osascript -l JavaScript <<'JXA' 2>/dev/null || true
ObjC.import('Foundation');
const read = (p) => { const s = $.NSString.stringWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, null); return s.isNil() ? null : ObjC.unwrap(s); };
const json = (p) => { try { return JSON.parse(read(p) || '{}'); } catch (e) { return {}; } };
const root = ObjC.unwrap($.NSHomeDirectory()) + '/Library/Application Support/Google/Chrome';
const cache = ((json(root + '/Local State').profile) || {}).info_cache || {};
const lines = [];
for (const dir of Object.keys(cache)) {
  let found = '';
  for (const file of ['Secure Preferences', 'Preferences']) {
    const settings = ((json(root + '/' + dir + '/' + file).extensions) || {}).settings || {};
    for (const id of Object.keys(settings)) {
      const path = settings[id] && settings[id].path;
      if (!found && path && path.charAt(0) === '/' && (read(path + '/manifest.json') || '').indexOf('KappGen Publish') >= 0) found = path;
    }
  }
  lines.push([dir, String(cache[dir].name || dir).replace(/[\t\n]/g, ' '), found].join('\t'));
}
lines.join('\n');
JXA
)

UPDATED=()
MISSING_DIRS=()
MISSING_NAMES=()
while IFS=$'\t' read -r PDIR PNAME PPATH; do
  [ -z "$PDIR" ] && continue
  if [ -n "$PPATH" ]; then
    if [ "$PPATH" != "$DIR" ]; then
      if git -C "$PPATH" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        echo "  •  $PNAME : dossier de développement ($PPATH), non touché."
        continue
      fi
      put_version "$PPATH"
    fi
    UPDATED+=("$PNAME  ($PPATH)")
  else
    MISSING_DIRS+=("$PDIR")
    MISSING_NAMES+=("$PNAME")
  fi
done <<< "$PROFILES"
rm -rf "$TMP"

echo "  3/3  Version $VERSION en place."
echo ""
if [ ${#UPDATED[@]} -gt 0 ]; then
  echo "  ✓ MIS À JOUR dans ${#UPDATED[@]} profil(s) Chrome :"
  for n in "${UPDATED[@]}"; do echo "      - $n"; done
  echo "    Rien d'autre à faire : KappGen Publish s'y recharge tout seul d'ici une minute."
  echo ""
fi

# No profile found (Chrome never opened…): the default one.
if [ -z "$PROFILES" ]; then
  MISSING_DIRS=("Default")
  MISSING_NAMES=("ton profil Chrome")
fi
[ ${#MISSING_DIRS[@]} -eq 0 ] && exit 0

clicks() {
  cat <<EOF
      1. En haut à droite, allume « Mode développeur » (il devient bleu).
      2. Clique « Charger l'extension non empaquetée ».
      3. Appuie sur  Cmd + Maj + G , puis  Cmd + V  (le chemin est déjà copié),
         puis  Entrée , puis clique « Sélectionner ».
EOF
}

echo "  KappGen Publish n'est pas encore dans ${#MISSING_DIRS[@]} profil(s) :"
for n in "${MISSING_NAMES[@]}"; do echo "      - $n"; done
echo ""

# The command is piped into bash: questions are read from the keyboard (/dev/tty).
ASK=""
if ( : </dev/tty ) 2>/dev/null; then exec 3</dev/tty; ASK=1; fi

if [ -n "$ASK" ] && [ ${#UPDATED[@]} -gt 0 ]; then
  printf "  L'ajouter aussi dans ces profils ? (o = oui, n = non) [o] : "
  read -r REPLY <&3 || REPLY=n
  case "$REPLY" in n|N|non|NON) echo "  D'accord. Relance la commande quand tu veux l'ajouter."; exit 0 ;; esac
fi

i=0
for PDIR in "${MISSING_DIRS[@]}"; do
  PNAME="${MISSING_NAMES[$i]}"
  i=$((i + 1))
  printf '%s' "$DIR" | pbcopy
  echo ""
  echo "  ▶ Profil « $PNAME » ($i/${#MISSING_DIRS[@]}) : Chrome s'ouvre sur ses extensions."
  open -na "$CHROME" --args --profile-directory="$PDIR" "chrome://extensions/"
  clicks
  if [ -n "$ASK" ] && [ $i -lt ${#MISSING_DIRS[@]} ]; then
    printf "  Appuie sur Entrée quand c'est fait pour passer au profil suivant (s = sauter) : "
    read -r REPLY <&3 || true
  fi
done

cat <<EOF

  La carte « KappGen Publish » apparaît dans chaque profil : c'est installé.
  Ensuite, dans chaque profil : pièce de puzzle en haut à droite de Chrome,
  épingle KappGen Publish, puis clique son logo pour te connecter.
  Les prochaines mises à jour : relance juste cette commande, tous les
  profils sont mis à jour d'un coup, sans clic.

  Ne supprime pas le dossier $DIR : Chrome s'en sert.

EOF
