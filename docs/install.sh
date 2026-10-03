#!/bin/bash
# Installe (ou met à jour) KappGen Publish sur Mac et Linux, dans TOUS les profils Chrome.
#   curl -fsSL https://app.kappgen.com/extension/install.sh | bash   (renvoie vers ce fichier)
# Télécharge la dernière version dans ~/KappGen-Publish, puis :
#  - met à jour l'extension dans chaque profil Chrome qui l'a déjà, quel que
#    soit le dossier d'où ce profil la charge (aucun clic : elle se recharge
#    toute seule en une minute) ;
#  - pour les profils qui ne l'ont pas encore, propose de l'y ajouter, un
#    profil après l'autre. Chrome interdit d'ajouter une extension sans un
#    clic de l'utilisateur : 3 clics par nouveau profil.
set -e
REPO="rosby17/kappgen-publish"
# Dernière version demandée à l'API GitHub (toujours à jour). Le lien
# « releases/latest/download » est mis en cache plusieurs minutes et peut encore
# servir la version précédente juste après une publication : seulement en secours.
TAG=$(curl -fsSL -H "Accept: application/vnd.github+json" "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
  | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1 || true)
case "$TAG" in
  v[0-9]*) ZIP_URL="https://github.com/$REPO/releases/download/$TAG/kappgen-publish.zip" ;;
  *) ZIP_URL="https://github.com/$REPO/releases/latest/download/kappgen-publish.zip" ;;
esac
SHA_URL="$ZIP_URL.sha256"
DIR="$HOME/KappGen-Publish"
OS=$(uname -s)
if [ "$OS" = "Darwin" ]; then
  CHROME_DATA="$HOME/Library/Application Support/Google/Chrome"
  HELPER_DIR="$HOME/Library/Application Support/KappGen-Publish"
else
  CHROME_DATA="${XDG_CONFIG_HOME:-$HOME/.config}/google-chrome"
  HELPER_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/KappGen-Publish"
fi
sha256() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1"; else sha256sum "$1"; fi | awk '{ print $1 }'; }

echo ""
echo "  KappGen Publish : installation et mise à jour"
echo "  ---------------------------------------------"

CHROME=""
if [ "$OS" = "Darwin" ]; then
  for app in "/Applications/Google Chrome.app" "$HOME/Applications/Google Chrome.app"; do
    [ -d "$app" ] && CHROME="$app"
  done
else
  for bin in google-chrome google-chrome-stable; do
    command -v "$bin" >/dev/null 2>&1 && { CHROME=$(command -v "$bin"); break; }
  done
fi
if [ -z "$CHROME" ]; then
  echo "  ✗ Google Chrome n'est pas installé."
  echo "    Installe-le d'abord (gratuit) : https://www.google.com/chrome/"
  echo "    puis relance la même commande."
  [ -n "$KAPPGEN_SILENCIEUX" ] || { open "https://www.google.com/chrome/" 2>/dev/null || xdg-open "https://www.google.com/chrome/" >/dev/null 2>&1 || true; }
  exit 1
fi

echo "  1/3  Téléchargement de la dernière version…"
TMP=$(mktemp -d)
trap 'rm -rf -- "$TMP"' EXIT
curl -fsSL -o "$TMP/k.zip" "$ZIP_URL"
curl -fsSL -o "$TMP/k.zip.sha256" "$SHA_URL"
EXPECTED=$(awk 'NR == 1 { print $1 }' "$TMP/k.zip.sha256")
ACTUAL=$(sha256 "$TMP/k.zip")
[ -n "$EXPECTED" ] && [ "$EXPECTED" = "$ACTUAL" ] || { echo "  ✗ Signature SHA-256 invalide : téléchargement annulé."; exit 1; }
mkdir -p "$TMP/x"
if command -v unzip >/dev/null 2>&1; then unzip -q "$TMP/k.zip" -d "$TMP/x"
else python3 -m zipfile -e "$TMP/k.zip" "$TMP/x" || { echo "  ✗ Installe « unzip » (sudo apt install unzip) puis relance la commande."; exit 1; }
fi
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

# Assistant de mise à jour en 1 clic : le bouton « Mettre à jour » du panneau
# demande à Chrome de lancer ce petit script (native messaging), qui relance
# cet installateur sans rien demander. Déclaré pour tous les profils Chrome.
HOST_JSON="$CHROME_DATA/NativeMessagingHosts/com.kappgen.publish.json"
install_helper() {
  mkdir -p "$HELPER_DIR" "$(dirname "$HOST_JSON")"
  # Écrit à côté puis renommé : un assistant en cours d'exécution n'est jamais modifié.
  cat > "$HELPER_DIR/.assistant-maj.sh.$$" <<'HELPER'
#!/bin/bash
# Assistant de mise à jour de KappGen Publish. Chrome le lance quand on clique
# « Mettre à jour » dans le panneau : il relance l'installateur de la dernière
# version sans rien demander, puis répond à l'extension, qui redémarre.
export LC_ALL=C PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
LOG="$(cd "$(dirname "$0")" && pwd)/maj.log"
REPO="rosby17/kappgen-publish"
# Réponse au format de Chrome : longueur sur 4 octets, puis le JSON.
reply() {
  n=${#1}
  printf "$(printf '\\%03o\\%03o\\%03o\\%03o' $((n & 255)) $(((n >> 8) & 255)) $(((n >> 16) & 255)) $(((n >> 24) & 255)))"
  printf '%s' "$1"
}
# Message de Chrome lu octet par octet (dd), sans jamais attendre plus que sa longueur.
LEN=$(dd bs=1 count=4 2>/dev/null | od -An -tu4 | tr -dc '0-9')
[ -n "$LEN" ] && [ "$LEN" -gt 0 ] && dd bs=1 count="$LEN" >/dev/null 2>&1
TAG=$(curl -fsSL -H "Accept: application/vnd.github+json" "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
  | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
case "$TAG" in
  v[0-9]*) ;;
  *) reply '{"ok":false,"error":"GitHub ne répond pas : vérifie ta connexion Internet et réessaie."}'; exit 0 ;;
esac
SCRIPT=$(mktemp)
if ! curl -fsSL -o "$SCRIPT" "https://raw.githubusercontent.com/$REPO/$TAG/docs/install.sh"; then
  rm -f "$SCRIPT"
  reply '{"ok":false,"error":"Téléchargement de l installateur impossible : réessaie dans un instant."}'
  exit 0
fi
if KAPPGEN_SILENCIEUX=1 bash "$SCRIPT" </dev/null >"$LOG" 2>&1; then
  VERSION=$(sed -n 's/.*Version \([0-9][0-9.]*\) en place.*/\1/p' "$LOG" | tail -1)
  reply "{\"ok\":true,\"version\":\"$VERSION\"}"
else
  ERR=$(grep '✗' "$LOG" | tail -1 | sed 's/^[[:space:]]*✗[[:space:]]*//; s/[\"\\]/ /g' | tr -d '\000-\037')
  reply "{\"ok\":false,\"error\":\"${ERR:-L installation a échoué (détails : $LOG).}\"}"
fi
rm -f "$SCRIPT"
HELPER
  chmod 755 "$HELPER_DIR/.assistant-maj.sh.$$"
  mv -f "$HELPER_DIR/.assistant-maj.sh.$$" "$HELPER_DIR/assistant-maj.sh"
  cat > "$HOST_JSON" <<EOF
{
  "name": "com.kappgen.publish",
  "description": "KappGen Publish : mise à jour en 1 clic",
  "path": "$HELPER_DIR/assistant-maj.sh",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://ohgfmmejmlbdpflenlkikbnebgfegkic/"]
}
EOF
}
install_helper || echo "  •  Assistant de mise à jour en 1 clic non installé (la commande reste possible)."

# Inside a git work tree (a developer's copy)? Checked without the git command:
# on a Mac without developer tools, it would open an installation prompt.
in_git() {
  d=$1
  while [ -n "$d" ] && [ "$d" != "/" ]; do
    [ -e "$d/.git" ] && return 0
    d=$(dirname "$d")
  done
  return 1
}

# Every Chrome profile: "dossier<TAB>nom<TAB>chemin de KappGen Publish (vide si absent)".
# Read with JavaScript for Automation (built into macOS): Local State lists the
# profiles, each profile's (Secure) Preferences lists its extensions.
if [ "$OS" = "Darwin" ]; then
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
else
PROFILES=$(CHROME_DATA="$CHROME_DATA" python3 - <<'PY' 2>/dev/null || true
import json, os
root = os.environ['CHROME_DATA']
def load(path):
    try:
        with open(path, encoding='utf-8') as f: return json.load(f)
    except Exception: return {}
def manifest(path):
    try:
        with open(os.path.join(path, 'manifest.json'), encoding='utf-8') as f: return f.read()
    except Exception: return ''
cache = (load(os.path.join(root, 'Local State')).get('profile') or {}).get('info_cache') or {}
for d, info in cache.items():
    found = ''
    for name in ('Secure Preferences', 'Preferences'):
        settings = (load(os.path.join(root, d, name)).get('extensions') or {}).get('settings') or {}
        for ext in settings.values():
            path = (ext or {}).get('path') or ''
            if not found and path.startswith('/') and 'KappGen Publish' in manifest(path): found = path
    print('\t'.join([d, str(info.get('name') or d).replace('\t', ' ').replace('\n', ' '), found]))
PY
)
fi

UPDATED=()
MISSING_DIRS=()
MISSING_NAMES=()
while IFS=$'\t' read -r PDIR PNAME PPATH; do
  [ -z "$PDIR" ] && continue
  if [ -n "$PPATH" ]; then
    if [ "$PPATH" != "$DIR" ]; then
      if in_git "$PPATH"; then
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

# Launched by the « Mettre à jour » button: updating is all it does.
[ -z "$KAPPGEN_SILENCIEUX" ] || exit 0

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
EOF
  if [ "$OS" = "Darwin" ]; then
    echo "      3. Appuie sur  Cmd + Maj + G , puis  Cmd + V  (le chemin est déjà copié),"
    echo "         puis  Entrée , puis clique « Sélectionner »."
  else
    echo "      3. Appuie sur  Ctrl + L , colle ou tape  $DIR ,"
    echo "         puis  Entrée , puis clique « Sélectionner »."
  fi
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
  echo ""
  echo "  ▶ Profil « $PNAME » ($k/${#CHOSEN[@]}) : Chrome s'ouvre sur ses extensions."
  if [ "$OS" = "Darwin" ]; then
    printf '%s' "$DIR" | pbcopy
    open -na "$CHROME" --args --profile-directory="$PDIR" "chrome://extensions/"
  else
    printf '%s' "$DIR" | { wl-copy 2>/dev/null || xclip -selection clipboard 2>/dev/null || xsel -b 2>/dev/null || true; }
    nohup "$CHROME" --profile-directory="$PDIR" "chrome://extensions/" >/dev/null 2>&1 &
  fi
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
  Les prochaines mises à jour : bouton « Mettre à jour » dans le panneau
  (ou relance cette commande) ; tous les profils suivent d'un coup.

  Ne supprime pas le dossier $DIR : Chrome s'en sert.

EOF
