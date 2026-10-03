# KappGen Publish

KappGen Publish est une extension Chrome Manifest V3 qui publie des vidéos et des posts depuis un dossier local vers YouTube, Facebook, TikTok, Instagram, X et LinkedIn. Elle détecte les médias prêts, lit leur fiche, respecte leur programmation et garde une trace locale pour éviter les doublons.

## Installation

Prérequis : Google Chrome 116 ou plus récent et un compte KappGen avec un essai ou un abonnement actif.

1. Télécharge [la dernière archive](https://github.com/rosby17/kappgen-publish/releases/latest/download/kappgen-publish.zip).
2. Vérifie facultativement son empreinte avec le fichier `.sha256` publié à côté.
3. Décompresse l’archive dans un emplacement permanent.
4. Ouvre `chrome://extensions`, active le mode développeur, puis choisis « Charger l’extension non empaquetée ».
5. Ouvre KappGen Publish, connecte-toi et sélectionne le dossier principal. Dans la boîte de dialogue Chrome, choisis « Autoriser à chaque visite ».

Les installateurs guidés sont disponibles sur la [page d’installation](https://rosby17.github.io/kappgen-publish/). Ils vérifient l’empreinte SHA-256 et remplacent une version existante de manière atomique.

> L’édition Chrome Web Store et l’édition installée manuellement peuvent avoir des identifiants différents. Le stockage Chrome et les autorisations de dossiers ne migrent pas automatiquement entre ces éditions. N’active pas les automatisations dans les deux en même temps.

## Organisation minimale

Un dossier contenant une vidéo représente une publication. Les noms sont libres et KappGen descend dans les sous-dossiers.

```text
Mes vidéos/
└── Recette du pain/
    ├── video.mp4        # vidéo d’au moins 5 Mo
    ├── image.jpg        # miniature, moins de 2 Mo
    ├── texte.txt        # première ligne = titre, suite = description
    └── short.mp4        # facultatif : Short/Reel vertical
```

Règles de sécurité :

- Une vidéo sans titre reste manuelle.
- Une vidéo modifiée depuis moins de dix minutes est considérée comme incomplète.
- Seules les vidéos terminées après le choix du dossier sont éligibles à l’automatisation ; les fichiers déjà présents attendent un clic.
- Un dossier ou fichier commençant par `.` ou `_` est ignoré.
- Les états `.kappgen.json`, `.kappgen-publications.json` et `DEJA-PUBLIEE.txt` empêchent les doubles envois : ne les supprime pas.
- Un fichier d’état illisible ou corrompu bloque la file au lieu d’être assimilé à un historique vide.
- Un `publication.json` invalide bloque le post concerné et affiche son erreur ; il n’est jamais publié avec des valeurs implicites.

La spécification complète se trouve dans [NORME-PUBLICATION.md](NORME-PUBLICATION.md).

## Fonctions

- YouTube : vidéos longues, Shorts, titres, descriptions, tags, miniatures, visibilité et créneaux de quinze minutes.
- Facebook : vidéos, Reels, posts texte/photo/vidéo et partage prudent dans neuf groupes maximum.
- TikTok et Instagram : vidéos et Reels depuis les médias verticaux ou les dossiers propres au réseau.
- X et LinkedIn : posts, médias compatibles et relais des vidéos YouTube.
- Un dossier principal ou un dossier dédié par réseau.
- Une seule publication active à la fois ; une publication termine sa distribution avant le passage à la suivante.
- Les actions automatiques utilisent un onglet dédié en arrière-plan afin de ne pas écraser un brouillon ouvert par l’utilisateur.
- Mise à jour automatique des métadonnées YouTube lorsque la fiche ou la miniature change.
- Bilan quotidien par e-mail uniquement si l’utilisateur l’active.
- Pour une vidéo issue de l’application KappGen locale, l’autorisation Chrome `debugger` remet à YouTube Studio le fichier désigné par son chemin, puis l’extension se détache immédiatement. Cette voie est refusée si le serveur configuré n’est pas `localhost` ou `127.0.0.1`. Chrome impose que l’autorisation figure dans l’installation ; le mode dossier ne l’utilise jamais.

Chrome doit rester ouvert et les comptes des réseaux choisis doivent déjà être connectés dans ce profil Chrome. Les interfaces des plateformes peuvent changer ; en cas d’échec, l’extension conserve l’onglet et affiche l’étape à terminer ou à relancer.

## Confidentialité et sécurité

L’accès au disque est limité aux dossiers explicitement choisis. Lors d’un envoi, le fichier est remis à la page du réseau par une autorisation à usage unique, liée à l’onglet et valable deux minutes ; aucun chemin local n’est exposé au site. L’extension ne lit pas les mots de passe des réseaux.

KappGen télécharge une configuration de publication déclarative (sélecteurs et expressions régulières), validée avant utilisation et conservée sept jours au maximum pour la continuité hors ligne. Aucun JavaScript distant n’est téléchargé ou exécuté. Voir la [politique de confidentialité](PRIVACY.md) et [SECURITY.md](SECURITY.md).

## Développement

Le code de l’extension se trouve dans `extension/`. Aucun paquet d’exécution n’est nécessaire.

```bash
npm run check
```

Cette commande vérifie le manifeste, les scripts, les ressources HTML et exécute les tests métier. La CI lance les mêmes contrôles à chaque push et pull request.

Pour publier :

1. augmente les versions de `extension/manifest.json` et `package.json` ;
2. exécute `npm run check` ;
3. commite tous les fichiers ;
4. lance `./publier-version.sh "Notes de version"`.

Le script refuse un dépôt sale ou en retard, construit l’archive manuelle et l’archive Chrome Web Store sans `key`, génère leurs SHA-256, pousse le commit et crée la release GitHub. La clé du manifeste manuel fixe l’identifiant `ohgfmmejmlbdpflenlkikbnebgfegkic` : ne la remplace pas.

## Mise à jour des données locales

Une mise à jour ne doit jamais effacer `chrome.storage.local` ni la base IndexedDB qui contient les autorisations de dossiers. Toute évolution de schéma doit lire l’ancien format, le convertir et conserver des valeurs par défaut compatibles.
