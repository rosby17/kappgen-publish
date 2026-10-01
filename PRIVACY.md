# Politique de confidentialité — KappGen Publish

Dernière mise à jour : 1er octobre 2026

KappGen Publish est une extension Chrome éditée par KappGen. Elle publie sur YouTube (et, si l'utilisateur l'active, sur Facebook) des vidéos rangées dans un dossier de son ordinateur.

## Données traitées

| Donnée | Pourquoi | Où elle va |
|---|---|---|
| Fichiers du dossier choisi par l'utilisateur (vidéos, miniatures, fiches `publication.md`, réglages) | Trouver les vidéos prêtes et leurs informations de publication | Lus localement. Les vidéos et miniatures sont transmises **uniquement** à YouTube Studio / Facebook, dans l'onglet de l'utilisateur, au moment de la publication |
| Suivi des envois (identifiant YouTube, date, statut) | Ne jamais publier deux fois la même vidéo, mettre à jour une vidéo déjà envoyée | Fichiers `.kappgen.json` / `.kappgen-publications.json` dans le dossier de l'utilisateur, et stockage local de l'extension |
| Réglages des chaînes (visibilité, heures, page Facebook) | Appliquer les choix de l'utilisateur | Stockage local de l'extension (`chrome.storage`) |
| Session du compte KappGen (cookie de kappgen.com) | Vérifier que l'utilisateur est connecté à son compte KappGen | Envoyée uniquement à `api.kappgen.com` / `app.kappgen.com` |

## Ce que l'extension ne fait pas
- Elle ne lit aucun fichier en dehors du dossier choisi par l'utilisateur.
- Elle ne lit ni ne stocke les mots de passe YouTube, Google ou Facebook : elle utilise la session déjà ouverte dans le navigateur de l'utilisateur.
- Elle ne vend, ne loue et ne partage aucune donnée avec des tiers, et ne sert à aucune publicité.
- Elle ne collecte aucune donnée de navigation, et n'exécute aucun code téléchargé à distance.

## Conservation et suppression
Les données restent sur l'ordinateur de l'utilisateur. Désinstaller l'extension supprime son stockage local ; les fichiers de suivi `.kappgen.json` restent dans le dossier de l'utilisateur, qui peut les supprimer à tout moment (une vidéo pourrait alors être republiée).

## Contact
Pour toute question : ouvrir une demande sur https://github.com/rosby17/kappgen-uploader/issues ou écrire via https://app.kappgen.com.

Cette extension respecte les [règles d'utilisation des données utilisateur du Chrome Web Store](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), y compris les exigences d'utilisation limitée.
