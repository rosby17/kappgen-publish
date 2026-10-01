# Fiche Chrome Web Store — KappGen Uploader

Tout ce qu'il faut copier dans le tableau de bord développeur : https://chrome.google.com/webstore/devconsole

## 0. Avant de commencer (à faire par toi)
1. Créer le compte développeur Chrome Web Store avec ton compte Google (frais uniques de 5 $).
2. Renseigner l'adresse e-mail de contact et la vérifier.
3. « Nouvel élément » → envoyer **`kappgen-uploader.zip`** (le même fichier que la Release GitHub : https://github.com/rosby17/kappgen-uploader/releases/latest/download/kappgen-uploader.zip).

## 1. Fiche du Store

**Nom** (repris du manifeste) : `KappGen Uploader`

**Résumé** (132 caractères max, repris du manifeste) :
```
Publie automatiquement tes vidéos finies sur YouTube (et Facebook) depuis un dossier de ton ordinateur.
```

**Description** :
```
KappGen Uploader publie toute seule tes vidéos finies sur YouTube, et sur Facebook si tu le souhaites, à partir d'un dossier de ton ordinateur.

Range chaque vidéo dans son dossier avec sa fiche (titre, description, mots-clés) et sa miniature : l'extension s'occupe du reste.

• Envoi automatique de chaque nouvelle vidéo prête, chaîne par chaîne
• Visibilité au choix : non répertoriée, publique, privée ou programmée aux heures que tu fixes
• Titre, description, mots-clés, miniature et « non conçue pour les enfants » remplis à ta place dans YouTube Studio
• Mise à jour automatique sur YouTube quand tu modifies la fiche ou la miniature d'une vidéo déjà envoyée
• Jamais de double envoi : chaque vidéo garde la trace de sa publication
• Facebook : publication de la vidéo, ou de sa version verticale en Reel, sur la page de ta chaîne
• Fonctionne avec les vidéos de n'importe quel outil de montage

Tout se passe dans ton propre navigateur, avec tes comptes déjà connectés : l'extension ne voit jamais tes mots de passe et n'envoie tes vidéos qu'à YouTube et Facebook.

Un compte KappGen (gratuit à créer sur app.kappgen.com) est nécessaire.
Mode d'emploi et règles de rangement : https://github.com/rosby17/kappgen-uploader
```

**Catégorie** : Outils (ou « Productivité » / « Workflow et planification » selon la liste proposée)
**Langue** : Français

**Images** (dossier `store/`) :
- Icône 128×128 : `icone-128x128.png`
- Petite vignette promotionnelle 440×280 : `petite-vignette-440x280.png`
- Grande vignette 1400×560 (facultative) : `grande-vignette-1400x560.png`
- **Captures d'écran 1280×800 (au moins 1, jusqu'à 5)** : à faire — envoie à Claude 2 ou 3 captures du panneau (onglets Vidéos, YouTube, Chaînes) sans e-mail visible, il les met au bon format.

**Site web** : `https://github.com/rosby17/kappgen-uploader`
**Assistance** : `https://github.com/rosby17/kappgen-uploader/issues`

## 2. Onglet « Pratiques de confidentialité »

**Objectif unique** :
```
Publier sur YouTube (et éventuellement Facebook) les vidéos finies que l'utilisateur range dans un dossier de son ordinateur, en remplissant pour lui le formulaire d'envoi de YouTube Studio avec le titre, la description, les mots-clés et la miniature trouvés dans ce dossier.
```

**Justification des autorisations** :

| Autorisation | Justification à coller |
|---|---|
| `sidePanel` | Toute l'interface de l'extension (compte, dossier, vidéos, réglages des chaînes) est affichée dans le panneau latéral. |
| `storage` | Enregistrer localement les réglages de l'utilisateur par chaîne (visibilité, heures, page Facebook) et l'état de l'envoi en cours. |
| `offscreen` | Lire le dossier de vidéos choisi par l'utilisateur (File System Access) depuis le service worker, qui n'a pas accès à cette API. |
| `scripting` | Injecter le script qui remplit le formulaire d'envoi de YouTube Studio (titre, description, visibilité) et le formulaire de publication Facebook, uniquement dans les onglets ouverts par l'extension pour une publication demandée par l'utilisateur. |
| `tabs` | Ouvrir l'onglet YouTube Studio de la chaîne pour l'envoi, suivre son chargement, le refermer à la fin, et garder un onglet épinglé qui maintient l'accès au dossier. |
| `alarms` | Vérifier toutes les 5 minutes si une nouvelle vidéo prête attend dans le dossier (publication automatique choisie par l'utilisateur). |
| `notifications` | Prévenir l'utilisateur quand Chrome demande à nouveau l'accès au dossier, pour que la publication automatique ne s'arrête pas sans qu'il le sache. |
| `debugger` (facultative, demandée seulement au clic) | Uniquement pour les vidéos produites par l'application KappGen locale : transmettre le fichier vidéo à YouTube Studio par son chemin sur le disque, sans le charger en mémoire. Jamais utilisée pour le mode dossier. |
| Accès aux sites `studio.youtube.com`, `www.youtube.com` | Remplir le formulaire d'envoi de YouTube Studio et lire la liste des vidéos publiques de la chaîne de l'utilisateur. |
| Accès aux sites `facebook.com` | Publier la vidéo sur la page Facebook de l'utilisateur quand il active cette option. |
| Accès à `api.kappgen.com`, `app.kappgen.com` | Vérifier la connexion de l'utilisateur à son compte KappGen. |
| Accès à `localhost` / `127.0.0.1` | Version locale de l'application KappGen installée sur l'ordinateur de l'utilisateur (facultative). |

**Code distant** : Non, je n'utilise pas de code distant.

**Utilisation des données** — cocher :
- Informations d'authentification (session du compte KappGen)
- Contenu du site web (fichiers vidéo, miniatures et textes envoyés à YouTube / Facebook)

Et cocher les trois déclarations : pas de vente à des tiers, pas d'utilisation sans rapport avec l'objectif unique, pas d'utilisation pour la solvabilité ou le prêt.

**URL de la politique de confidentialité** :
```
https://github.com/rosby17/kappgen-uploader/blob/main/PRIVACY.md
```

## 3. Instructions pour l'examen (onglet « Distribution » / « Instructions de test »)

Google doit pouvoir se connecter : crée un **compte KappGen de test** (e-mail + mot de passe) et colle-le ici. Ne mets jamais ton compte personnel.
```
1. Cliquez sur l'icône de l'extension : le panneau latéral s'ouvre.
2. Connectez-vous avec le compte de test : <e-mail> / <mot de passe> (section « Ou avec un mot de passe »).
3. « Choisir le dossier » : choisissez un dossier contenant MA-CHAINE/VIDEO/01-test/ avec une vidéo MP4 (plus de 5 Mo), un fichier publication.md (## Titre ...) et miniature.jpg.
4. La vidéo apparaît dans l'onglet « Vidéos » ; « Envoyer » ouvre YouTube Studio (il faut être connecté à une chaîne YouTube) et remplit le formulaire d'envoi en non répertorié.
```

## 4. Visibilité
- **Non répertoriée** au début (seules les personnes qui ont le lien la voient) : idéal pour tes amis et testeurs.
- Publique ensuite, quand tout est validé.

Délai d'examen : de quelques jours à 2-3 semaines. Les mises à jour se font en envoyant un nouveau zip (version augmentée) : les utilisateurs du Store les reçoivent automatiquement.
