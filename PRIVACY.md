# Politique de confidentialité — KappGen Publish

Dernière mise à jour : 3 octobre 2026

KappGen Publish est une extension Chrome éditée par KappGen. Elle aide l’utilisateur à publier les contenus qu’il a préparés vers YouTube, Facebook, TikTok, Instagram, X et LinkedIn.

## Données traitées

| Donnée | Finalité | Destination |
|---|---|---|
| Vidéos, images, textes et fichiers de configuration dans les dossiers choisis | Détecter et préparer les publications demandées | Lus localement ; le média et son texte sont remis uniquement au site du réseau choisi au moment de la publication |
| État des publications, identifiants YouTube, erreurs et réglages | Éviter les doublons, reprendre un travail et appliquer la programmation | Fichiers `.kappgen.json` / `.kappgen-publications.json`, `publication.json`, IndexedDB et `chrome.storage` sur l’ordinateur |
| Session et profil du compte KappGen | Connexion, essai, abonnement, paiement et programme de parrainage | `api.kappgen.com` ou `app.kappgen.com` ; en développement local, `localhost` ou `127.0.0.1` |
| Configuration déclarative de publication | Adapter les sélecteurs aux interfaces des plateformes | Téléchargée depuis l’API KappGen, validée puis mise en cache local jusqu’à sept jours ; elle ne contient pas de JavaScript exécutable |
| Résultat quotidien des publications, si le bilan par e-mail est activé | Envoyer un seul récapitulatif quotidien | API KappGen : jour, heure locale, réseau, titre, résultat, erreur éventuelle et lien YouTube éventuel |
| Version de l’extension | Signaler une mise à jour disponible | Consultation de la dernière release publique GitHub, au plus périodiquement |

L’extension peut aussi consulter la page publique d’une chaîne YouTube pour reconnaître des vidéos déjà publiées. Les plateformes reçoivent naturellement les médias et textes que l’utilisateur choisit d’y publier, selon leurs propres politiques.

Si l’utilisateur choisit la connexion KappGen par mot de passe dans le panneau, son adresse e-mail et son mot de passe sont transmis directement à l’API KappGen configurée afin d’ouvrir la session. Le mot de passe n’est pas conservé par l’extension. La connexion via le site KappGen réutilise uniquement la session créée par ce site.

## Accès aux comptes sociaux

KappGen Publish utilise les sessions déjà ouvertes dans Chrome. Elle ne lit ni ne stocke les mots de passe Google, YouTube, Facebook, TikTok, Instagram, X ou LinkedIn, et ne copie pas leurs cookies. Elle agit uniquement dans les onglets nécessaires à la publication.

Chaque lecture d’un fichier local par une page sociale utilise une autorisation aléatoire à usage unique, liée à l’onglet demandeur et expirant après deux minutes. Le chemin du fichier n’est pas inclus dans l’URL accessible au site.

Pour une vidéo provenant directement de l’application KappGen locale, l’autorisation Chrome `debugger` sert uniquement à transmettre à YouTube Studio le fichier désigné par son chemin. Cette fonction est techniquement refusée lorsque le serveur configuré n’est pas `localhost` ou `127.0.0.1`. L’extension s’attache seulement à l’onglet Studio concerné et se détache immédiatement après cette opération. Chrome ne permet pas de déclarer cette autorisation comme facultative ; elle figure donc dans les autorisations d’installation, mais le mode dossier ne l’utilise pas.

## Choix de l’utilisateur

- L’utilisateur choisit explicitement chaque dossier et peut retirer son autorisation dans les réglages de Chrome.
- Chaque réseau peut être désactivé dans l’extension.
- La publication automatique peut être mise en pause à tout moment.
- Le bilan quotidien par e-mail est désactivé par défaut.
- Les anciens fichiers présents lors du choix d’un dossier ne sont jamais envoyés automatiquement.

## Conservation et suppression

Les réglages et états locaux restent sur l’ordinateur jusqu’à leur suppression par l’utilisateur ou la désinstallation de l’extension. Les fichiers de suivi écrits dans le dossier choisi restent après désinstallation ; les supprimer peut rendre un contenu éligible à une nouvelle publication.

Les données de compte, d’abonnement, de paiement et les bilans envoyés à KappGen sont conservés uniquement pour fournir ces services et respecter les obligations applicables. Une demande d’accès ou de suppression peut être adressée par les canaux ci-dessous.

## Ce que KappGen Publish ne fait pas

- aucun accès à un dossier non choisi par l’utilisateur ;
- aucune vente ou location de données ;
- aucune publicité ciblée ni collecte de l’historique de navigation ;
- aucun usage des données à des fins de crédit ou de solvabilité ;
- aucun téléchargement ni exécution de code JavaScript distant.

## Contact

Pour toute question, demande d’accès ou suppression : [ouvrir une demande GitHub](https://github.com/rosby17/kappgen-uploader/issues) ou utiliser le contact disponible sur [app.kappgen.com](https://app.kappgen.com).

KappGen Publish applique les exigences d’utilisation limitée des données utilisateur du Chrome Web Store.
