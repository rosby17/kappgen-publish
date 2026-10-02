# KappGen Publish

Extension Chrome qui **publie toute seule tes vidéos finies sur YouTube (et Facebook)** à partir d'un dossier de ton ordinateur : elle trouve la vidéo, son titre, sa description, ses mots-clés et sa miniature, remplit YouTube Studio à ta place et suit l'envoi jusqu'au bout.

## ⬇️ Télécharger

**[Télécharger la dernière version (kappgen-uploader.zip)](https://github.com/rosby17/kappgen-uploader/releases/latest/download/kappgen-uploader.zip)**

Ce lien donne toujours la version la plus récente. Historique des versions : [Releases](https://github.com/rosby17/kappgen-uploader/releases).

## Installer (2 minutes)

1. Télécharge le fichier ci-dessus et **décompresse-le** (double-clic) : tu obtiens un dossier `kappgen-uploader`.
2. Dans Chrome, ouvre l'adresse `chrome://extensions`.
3. En haut à droite, active **« Mode développeur »**.
4. Clique **« Charger l'extension non empaquetée »** et choisis le dossier `kappgen-uploader`.
5. Épingle l'extension (icône puzzle 🧩 → punaise), puis clique sur son icône : le panneau KappGen Publish s'ouvre à droite.
6. Connecte-toi à ton compte KappGen ([app.kappgen.com](https://app.kappgen.com)), puis **« Choisir le dossier des vidéos »** → le dossier où tu ranges tes vidéos finies → **« Autoriser à chaque visite »**.

Garde le dossier décompressé à sa place : Chrome l'utilise en permanence.

### Mettre à jour
À partir de la 1.16.1, l'extension prévient (notification) quand une nouvelle version sort. Télécharge à nouveau le zip, remplace l'ancien dossier par le nouveau (même emplacement), puis sur `chrome://extensions` clique la flèche **↻** de KappGen Publish. Tes réglages sont conservés.

## Ranger tes vidéos

**Un dossier = une publication.** Range chaque vidéo finie dans son propre dossier, avec son image et un petit fichier texte. Les noms sont libres, et tu peux ranger comme tu veux (par mois, par thème…) : l'extension descend dans tous les sous-dossiers.

```
Mes vidéos/
├── Recette du pain/
│   ├── video.mp4        ← la vidéo
│   ├── image.jpg        ← la miniature (1280×720, moins de 2 Mo)
│   └── texte.txt        ← 1re ligne = titre, le reste = description
└── Octobre/
    └── Astuce frigo/
        ├── astuce.mp4
        ├── miniature.png
        ├── legende.txt
        └── short.mp4    ← (facultatif) version verticale : Short / Reel
```

- Seules les vidéos ajoutées **après** le choix du dossier partent toutes seules ; les autres attendent un clic.
- Un dossier qui commence par `_` est ignoré (brouillons, travail en cours).
- Après publication, `DEJA-PUBLIEE.txt` apparaît dans le dossier (ne l'efface pas).
- Plusieurs chaînes : un profil Chrome par chaîne.

Tout est aussi expliqué dans l'onglet **Aide** du panneau. Règles complètes : **[NORME-PUBLICATION.md](NORME-PUBLICATION.md)**.

## Ce qu'elle fait
- Envoie chaque nouvelle vidéo prête (non répertoriée par défaut, ou publique, privée, programmée aux heures choisies), chaîne par chaîne.
- Met YouTube à jour toute seule quand tu modifies la fiche ou la miniature d'une vidéo déjà envoyée.
- Ne renvoie jamais une vidéo déjà envoyée (suivi dans un fichier `.kappgen.json` à côté de chaque vidéo : ne pas l'effacer).
- Facebook : publie aussi la vidéo (ou sa version verticale en Reel) sur la page de la chaîne si tu l'actives.

Chrome doit rester ouvert et connecté au compte Google de tes chaînes YouTube (et à Facebook si besoin).

## Confidentialité
L'extension lit uniquement le dossier que tu choisis et n'envoie tes vidéos qu'à YouTube / Facebook, depuis ton propre navigateur. Détails : [politique de confidentialité](PRIVACY.md).

## Pour le développeur
- Code de l'extension : `extension/` (Manifest V3, aucun code distant).
- Publier une nouvelle version : augmenter `version` dans `extension/manifest.json`, puis `./publier-version.sh` (crée la Release GitHub avec `kappgen-uploader.zip` ; pour le Chrome Web Store, envoyer `dist/kappgen-uploader-chrome-web-store.zip`, le même sans `key`).
- `key` dans `manifest.json` fixe l'identifiant de l'extension (`ohgfmmejmlbdpflenlkikbnebgfegkic`) quel que soit le dossier d'où elle est chargée : ses réglages, dossiers choisis et connexion sont gardés d'une mise à jour à l'autre et d'un dossier à l'autre. Ne pas la retirer ni la changer.
- Fiche Chrome Web Store (textes, justifications, images) : `store/`.

## Recette de publication (protection, 1.17.0)
Les sélecteurs et noms des boutons de YouTube Studio, Facebook, TikTok et Instagram ne sont PAS dans l'extension : le serveur KappGen les envoie (`GET /api/publish/recipe`, fichier `src/publish/recipe.json` du backend) aux seuls comptes en essai ou abonnés, marqués par compte. Les scripts de page les lisent avec `S('clé')` / `X('clé')` (lib/recette.js). RÈGLE : tout nouveau sélecteur ou texte de bouton va dans recipe.json (serveur), jamais en dur dans un script. Quand un site change : corriger recipe.json et redéployer le serveur, sans nouvelle version de l'extension.

## Règle : une mise à jour ne perd JAMAIS les réglages d'un utilisateur (Roosevelt, 02/10)
Dossiers choisis, liens des pages, réseaux cochés, groupes, horaires, abonnement : tout ce que l'utilisateur a réglé doit survivre à n'importe quelle mise à jour.
- Ne jamais changer ni retirer la clé `"key"` du manifest (elle fixe l'identifiant de l'extension : un autre identifiant = une extension neuve, réglages perdus).
- Ne jamais vider `chrome.storage.local` ni la base IndexedDB des dossiers. Une nouvelle version qui change la forme d'un réglage le CONVERTIT (lit l'ancien format, écrit le nouveau), elle ne l'efface pas.
- Un nouveau réglage a une valeur par défaut raisonnable : l'utilisateur n'a rien à refaire.
- La mise à jour se fait en remplaçant les fichiers dans le même dossier (commande d'installation), jamais en supprimant puis réinstallant l'extension.

