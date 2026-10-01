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
Télécharge à nouveau le zip, remplace l'ancien dossier par le nouveau (même emplacement), puis sur `chrome://extensions` clique la flèche **↻** de KappGen Publish. Tes réglages sont conservés.

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
- Publier une nouvelle version : augmenter `version` dans `extension/manifest.json`, puis `./publier-version.sh` (crée la Release GitHub avec `kappgen-uploader.zip`, qui sert aussi pour le Chrome Web Store).
- Fiche Chrome Web Store (textes, justifications, images) : `store/`.
