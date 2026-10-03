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
SHA_URL="$ZIP_URL.sha256"
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
trap 'rm -rf -- "$TMP"' EXIT
curl -fsSL -o "$TMP/k.zip" "$ZIP_URL"
curl -fsSL -o "$TMP/k.zip.sha256" "$SHA_URL"
EXPECTED=$(awk 'NR == 1 { print $1 }' "$TMP/k.zip.sha256")
ACTUAL=$(shasum -a 256 "$TMP/k.zip" | awk '{ print $1 }')
[ -n "$EXPECTED" ] && [ "$EXPECTED" = "$ACTUAL" ] || { echo "  ✗ Signature SHA-256 invalide : téléchargement annulé."; exit 1; }
mkdir -p "$TMP/x"
unzip -q "$TMP/k.zip" -d "$TMP/x"
[ -f "$TMP/x/manifest.json" ] && grep -q '"name"[[:space:]]*:[[:space:]]*"KappGen Publish"' "$TMP/x/manifest.json" \
  || { echo "  ✗ Archive téléchargée invalide, installation annulée."; exit 1; }
VERSION=$(sed -n 's/.*"version"[^"]*"\([^"]*\)".*/\1/p' "$TMP/x/manifest.json" | head -1)

# Replaces the content of an extension folder with the new version (same
# folder: Chrome keeps the extension, its settings and its connection).
put_version() {
  TARGET=$1
  case "$TARGET" in ""|/|"$HOME") echo "  ✗ Dossier de destination dangereux : $TARGET"; return 1 ;; esac
  case "$TARGET" in /*) ;; *) echo "  ✗ Le dossier doit être un chemin absolu : $TARGET"; return 1 ;; esac
  [ ! -L "$TARGET" ] || { echo "  ✗ Le dossier est un lien symbolique, non modifié : $TARGET"; return 1; }
  if [ -d "$TARGET" ] && [ -n "$(find "$TARGET" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    [ -f "$TARGET/manifest.json" ] && grep -q '"name"[[:space:]]*:[[:space:]]*"KappGen Publish"' "$TARGET/manifest.json" \
      || { echo "  ✗ Le dossier existe mais ne contient pas KappGen Publish : $TARGET"; return 1; }
  fi
  PARENT=$(dirname "$TARGET")
  BASE=$(basename "$TARGET")
  STAGE="$PARENT/.${BASE}.new.$$"
  BACKUP="$PARENT/.${BASE}.backup.$$"
  mkdir -p "$PARENT"
  cp -R "$TMP/x" "$STAGE"
  if [ -e "$TARGET" ]; then mv "$TARGET" "$BACKUP"; fi
  if ! mv "$STAGE" "$TARGET"; then
    [ ! -e "$BACKUP" ] || mv "$BACKUP" "$TARGET"
    return 1
  fi
  [ ! -e "$BACKUP" ] || rm -rf -- "$BACKUP"
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
rm -rf -- "$TMP"
trap - EXIT

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

# The command is piped into bash: answers are read from the keyboard (/dev/tty).
ASK=""
if ( : </dev/tty ) 2>/dev/null; then exec 3</dev/tty; ASK=1; fi

# Profiles without the extension: the creator picks which ones (none by default).
CHOSEN=()
if [ ${#UPDATED[@]} -eq 0 ] && [ ${#MISSING_DIRS[@]} -eq 1 ]; then
  CHOSEN=(0) # first install, one profile: nothing to choose
else
  echo "  Profils Chrome sans KappGen Publish :"
  i=0
  for n in "${MISSING_NAMES[@]}"; do i=$((i + 1)); echo "      $i. $n"; done
  echo ""
  if [ -z "$ASK" ]; then
    echo "  Pour l'ajouter dans l'un d'eux, relance cette commande dans le Terminal et choisis-le."
    exit 0
  fi
  echo "  Dans lesquels l'installer ? Tape leurs numéros (ex. 1 3), t pour tous,"
  printf "  ou appuie juste sur Entrée pour n'en ajouter aucun : "
  read -r REPLY <&3 || REPLY=""
  case "$REPLY" in
    t|T|tous|TOUS) i=0; for _ in "${MISSING_DIRS[@]}"; do CHOSEN+=("$i"); i=$((i + 1)); done ;;
    *) for n in $(echo "$REPLY" | tr -c '0-9' ' '); do
         [ "$n" -ge 1 ] 2>/dev/null && [ "$n" -le ${#MISSING_DIRS[@]} ] && CHOSEN+=("$((n - 1))")
       done ;;
  esac
  if [ ${#CHOSEN[@]} -eq 0 ]; then
    echo "  D'accord, aucun profil ajouté. C'est terminé."
    echo ""
    exit 0
  fi
fi

k=0
for idx in "${CHOSEN[@]}"; do
  PDIR="${MISSING_DIRS[$idx]}"
  PNAME="${MISSING_NAMES[$idx]}"
  k=$((k + 1))
  printf '%s' "$DIR" | pbcopy
  echo ""
  echo "  ▶ Profil « $PNAME » ($k/${#CHOSEN[@]}) : Chrome s'ouvre sur ses extensions."
  open -na "$CHROME" --args --profile-directory="$PDIR" "chrome://extensions/"
  clicks
  if [ -n "$ASK" ] && [ $k -lt ${#CHOSEN[@]} ]; then
    printf "  Appuie sur Entrée quand c'est fait pour passer au profil suivant : "
    read -r REPLY <&3 || true
  fi
done

cat <<EOF

  La carte « KappGen Publish » apparaît dans le profil : c'est installé.
  Ensuite, dans chaque profil : pièce de puzzle en haut à droite de Chrome,
  épingle KappGen Publish, puis clique son logo pour te connecter.
  Les prochaines mises à jour : relance juste cette commande, tous les
  profils sont mis à jour d'un coup, sans clic.

  Ne supprime pas le dossier $DIR : Chrome s'en sert.

EOF
