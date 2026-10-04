# Fiche Chrome Web Store — KappGen Publish

Ce document prépare les informations à reporter dans le tableau de bord du Chrome Web Store. Vérifie-les à chaque version.

## Archive

Envoie uniquement `dist/kappgen-publish-chrome-web-store.zip`, produite par `./publier-version.sh`. Cette archive ne contient pas la clé utilisée par l’édition manuelle. N’envoie pas `kappgen-publish.zip` au Store.

## Fiche publique

Nom : `KappGen Publish`

Résumé (= champ `description` du manifest ; jamais de liste de réseaux ni de marques : refusé le 04/10 pour « spam dans les mots clés », cas Yellow Argon) :

```text
Publie automatiquement sur tes réseaux sociaux les vidéos et posts rangés dans un dossier de ton ordinateur.
```

Description :

```text
KappGen Publish transforme un dossier de ton ordinateur en file de publication pour tes réseaux sociaux.

Range chaque contenu avec son texte, sa miniature ou sa vidéo. L’extension détecte les fichiers prêts, respecte leur horaire et publie avec les comptes déjà connectés dans Chrome.

• YouTube : vidéos, Shorts, titre, description, tags, miniature et programmation
• Facebook : vidéos, Reels et posts texte, photo ou vidéo
• TikTok et Instagram : vidéos et formats verticaux
• X et LinkedIn : posts, médias compatibles et relais des vidéos YouTube
• Un dossier principal ou un dossier propre à chaque réseau
• Une publication à la fois et suivi local contre les doublons
• Pause globale et erreurs explicites, sans relance automatique d’un échec

Les fichiers déjà présents lors du choix du dossier ne sont pas publiés automatiquement. Un compte KappGen avec un essai ou un abonnement actif est nécessaire. Chrome 116 minimum.

Mode d’emploi : https://github.com/rosby17/kappgen-publish
```

Catégorie : Productivité.

Langue principale : français.

Site web : `https://github.com/rosby17/kappgen-publish`

Assistance : `https://github.com/rosby17/kappgen-publish/issues`

Politique de confidentialité : `https://github.com/rosby17/kappgen-publish/blob/main/PRIVACY.md`

Assets disponibles dans `store/` : icône 128 × 128, vignette 440 × 280 et vignette 1400 × 560. Les captures du panneau doivent masquer toute adresse e-mail, tout chemin local et tout identifiant de compte.

## Objectif unique

```text
Préparer, programmer et publier vers les réseaux sociaux choisis par l’utilisateur les vidéos, images et textes placés dans les dossiers locaux qu’il a explicitement autorisés.
```

## Justification des autorisations

| Autorisation | Justification |
|---|---|
| `sidePanel` | Afficher l’interface persistante de configuration, de suivi et de publication. |
| `storage` | Conserver localement les réglages, l’état des tâches, les autorisations temporaires de fichiers et la continuité hors ligne. |
| `offscreen` | Accéder, depuis un document d’extension, aux dossiers explicitement choisis avec File System Access, cette API n’étant pas disponible dans le service worker. |
| `scripting` | Injecter les scripts locaux de l’extension qui remplissent les formulaires des réseaux dans les onglets de publication. |
| `tabs` | Ouvrir et suivre l’onglet de publication, détecter la connexion requise et fermer les onglets automatiques terminés. |
| `alarms` | Réveiller périodiquement le service worker pour contrôler les publications arrivées à échéance. |
| `notifications` | Signaler une mise à jour disponible ou une autorisation de dossier à renouveler. |
| `debugger` | Pour une vidéo issue de l’application KappGen locale uniquement, remettre à YouTube Studio le fichier désigné par son chemin sans le charger en mémoire. Le code refuse cet usage hors de `localhost`/`127.0.0.1`, s’attache seulement à l’onglet Studio de cette publication et se détache immédiatement ; le mode dossier ne l’utilise pas. Chrome interdit de déclarer cette autorisation comme facultative. |
| `nativeMessaging` | Dialoguer avec un petit assistant installé volontairement par l’utilisateur sur son ordinateur (installation hors Store), uniquement pour installer une mise à jour de l’extension quand celle-ci est chargée manuellement. Sans cet assistant, l’autorisation n’est jamais utilisée ; la version du Store se met à jour par Chrome. |
| Hôtes KappGen | Authentification, contrôle de l’essai ou de l’abonnement, paiement, parrainage, bilan facultatif et configuration déclarative de publication. |
| YouTube / YouTube Studio | Lire la page publique de la chaîne, remplir les formulaires de vidéo, Short ou mise à jour, et, si l’utilisateur a coché l’option, poster puis épingler sous sa propre vidéo le commentaire écrit dans sa fiche. |
| Facebook | Publier les vidéos, Reels et posts demandés sur une Page ou dans les groupes choisis, et, si l’utilisateur a coché l’option, poster le commentaire prévu sous son propre post. |
| TikTok, Instagram, X et LinkedIn | Remplir le formulaire de publication du réseau sélectionné. |
| `localhost` / `127.0.0.1` | Autoriser l’édition locale de KappGen, uniquement si l’utilisateur la configure. |
| `api.github.com` | Lire uniquement la version de la dernière release publique afin d’afficher l’avis de mise à jour. |

L’autorisation `management` n’est pas demandée. L’extension ne désactive et ne modifie aucune autre extension. L’autorisation `debugger` est strictement limitée à la remise d’un fichier de l’application locale dans l’onglet YouTube Studio concerné ; elle n’est jamais utilisée pour inspecter l’historique, les mots de passe ou les autres onglets.

## Code distant

Réponse : non.

Tous les scripts exécutables sont inclus dans l’archive. L’API KappGen fournit seulement une configuration déclarative : chaînes de sélecteurs CSS et expressions régulières utilisées pour reconnaître des boutons. Cette structure est limitée en taille et profondeur, validée avant stockage et ne contient ni JavaScript, ni WebAssembly, ni URL de script.

## Données à déclarer

- Informations d’authentification : session du compte KappGen utilisée pour le service.
- Contenu utilisateur : vidéos, images et textes choisis pour publication.
- Activité de l’utilisateur : réseau, titre, résultat et erreur éventuelle, uniquement lorsque le bilan quotidien facultatif est activé.
- Informations de paiement : traitées par le prestataire de paiement via le flux KappGen ; l’extension ne stocke pas de numéro de carte.

Déclarations : aucune vente, aucun transfert à des fins publicitaires, aucun usage hors objectif unique, aucun usage de solvabilité.

## Instructions d’examen

Fournis un compte KappGen de test dédié et un petit dossier de démonstration sans donnée personnelle.

```text
1. Ouvrir l’extension : le panneau latéral apparaît.
2. Se connecter avec le compte de test communiqué dans le champ confidentiel de l’examen.
3. Dans Réglages > Dossiers, sélectionner un dossier contenant :
   DEMO/video.mp4 (> 5 Mo), DEMO/publication.md et DEMO/miniature.jpg.
4. Le fichier étant antérieur au choix du dossier, utiliser le bouton manuel Publier sur YouTube.
5. Dans un profil connecté à YouTube Studio, l’extension ouvre Studio et remplit les métadonnées.
6. Les autres réseaux peuvent être testés après connexion au site correspondant et activation du réseau dans Réglages.
```

Ne place jamais les identifiants du compte de test dans ce dépôt.
