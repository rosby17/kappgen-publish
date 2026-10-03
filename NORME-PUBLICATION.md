# Norme de publication — KappGen Publish

Une vidéo rangée selon cette norme peut être publiée par KappGen vers YouTube, Facebook, TikTok, Instagram, X et LinkedIn selon les réseaux activés.

## 0. La règle simple (pour tout le monde, depuis 1.11)

**Un dossier qui contient une vidéo = une publication.** Le rangement est libre : KappGen descend dans tous les sous-dossiers du dossier choisi.

| Dans le dossier | Rôle |
|---|---|
| une vidéo `.mp4` (5 Mo minimum) | la vidéo YouTube (la plus grosse s'il y en a plusieurs) |
| une vidéo dont le nom contient `short`, `reel` ou `vertical` | Short YouTube / Reel Facebook |
| une image | la miniature (de préférence `miniature.jpg`) |
| n'importe quel `.txt` / `.md` court | 1re ligne = titre, le reste = description |

- Sans texte, la vidéo s'affiche dans le panneau mais ne part jamais seule.
- Ne sont jamais pris comme texte : `script*`, `notes*`, `prompt*`, `journal*`, `chapitres*`, `transcri*`, `sous-titres*`, `modele*`, `readme*`, `planning*`, `voix*`, `sources*`, ni un fichier de plus de 12 000 caractères.
- **Seules les vidéos terminées après le choix du dossier partent toutes seules** ; celles qui y étaient déjà attendent un clic « Publier maintenant ».
- Dossiers ignorés : ceux qui commencent par `_` ou `.`, et les dossiers techniques (`build`, `cache`, `tmp`, `frames`, `rushes`, `brut`, `raw`, `bibliotheque`…).
- Quand publier (panneau, onglet Vidéos) : dès que c'est prêt (par défaut) ou à heures fixes. Chaque vidéo peut aussi être programmée à la main (« Programmer ») ou envoyée tout de suite (« Publier maintenant »).
- Facebook (onglet Facebook) : un seul lien de page ; un dossier à part pour les Reels et posts avec la même règle (un dossier = un post, texte publié tel quel). La date et l’heure viennent de `publication.json` ou du nom `AAAA-MM-JJ-HHMM-sujet` ; sans horaire, le post est prêt immédiatement.

- Commentaire programmé : le texte à poster sous la publication une fois sortie. Facebook : champ `commentaire` de `publication.json` ou fichier `commentaire.txt` dans le dossier du post (délai en minutes : `commentaire_delai`, 2 par défaut ; état écrit dans `commentaire_statut`). YouTube : la section « Commentaire épinglé » de la fiche de la vidéo, posté et épinglé quand la vidéo est publique (à l’heure programmée si elle l’est), délai réglable par chaîne avec `commentDelay` (minutes).

Le format détaillé ci-dessous reste compris (fiche `publication.md` avec `## Titre`, `FACEBOOK/A-PUBLIER`, `reglages-publication.json`).

## 1. Arborescence

```
YOUTUBE/
└── <NICHE>/[<SOUS-CATÉGORIE>/]<CHAÎNE>/          ← MAJUSCULES
    ├── reglages-publication.json                  ← réglages de publication de la chaîne (facultatif)
    ├── ADN/chaine.json                            ← "youtube": lien de la chaîne (lu aussi par l'extension)
    └── VIDEO/
        └── <NN>-<sujet-court>/                    ← un dossier = une vidéo, ex. 03-nycturie
            ├── <nom>.mp4                          ← la vidéo longue (16:9). Une seule vidéo longue par dossier.
            ├── publication.md                     ← la fiche (titre, description, mots-clés)
            ├── miniature.jpg                      ← la miniature (moins de 2 Mo, 1280×720)
            ├── short.mp4                          ← (facultatif) version verticale 9:16 → Short YouTube + Reel Facebook
            └── .kappgen.json                      ← écrit par l'extension : suivi de l'envoi. NE PAS EFFACER.
```

Règles :
- `VIDEO/<NN>-<sujet>/` est **le seul** endroit d'où une vidéo part. Les ateliers de montage (`_montage/`, `_archives/`, tout dossier qui commence par « _ » ou « . ») sont ignorés.
- Ne pas laisser de copie de la vidéo finie dans un autre dossier visible (`renders/` d'un atelier hors `_montage`, racine de la chaîne…). L'extension reconnaît une copie déjà envoyée (même nom et même taille) et l'écarte, mais une copie renommée ou réencodée repartirait.
- La vidéo doit peser au moins 5 Mo et ne plus avoir été modifiée depuis 10 minutes (sinon elle est considérée comme en cours d'écriture).
- Sans `publication.md` qui contient un titre, la vidéo n'est jamais envoyée automatiquement (bouton manuel seulement).

## 2. La fiche `publication.md`

~~~markdown
## Titre
```
Le titre exact (100 caractères maximum)
```

## Description
```
Le texte de la description, chapitres compris (5 000 caractères maximum).
```

## Mots-clés
```
mot 1, mot 2, mot 3
```

## Commentaire épinglé
```
(facultatif)
```
~~~

- Chaque section prend le contenu de son premier bloc de code (ou son texte s'il n'y a pas de bloc).
- « ## Titres proposés » suivi d'une liste numérotée : le n° 1 est utilisé.
- Autres formats acceptés : `metadata.json` (`{"title", "description", "tags"}`), ou `<nom-de-la-video>.md/.txt/.json` à côté de la vidéo.
- Modifier la fiche ou la miniature d'une vidéo déjà envoyée : l'extension met YouTube à jour toute seule (titre, description, mots-clés, miniature).

## 3. Les réglages de la chaîne : `reglages-publication.json`

À poser à la racine du dossier de la chaîne. Tout est facultatif. Ce qui est écrit ici **l'emporte** sur le panneau de l'extension (les réglages correspondants y apparaissent grisés).

```json
{
  "youtube": {
    "chaine": "https://www.youtube.com/channel/UCxxxxxxxxxxxxxxxxxxxxxx",
    "visibilite": "programmee",
    "heures": ["09:00"],
    "auto": true,
    "monetisation": "oui"
  },
  "facebook": {
    "publier": "video",
    "page": "https://www.facebook.com/NomDeLaPage"
  }
}
```

| Clé | Valeurs |
|---|---|
| `youtube.chaine` | lien ou identifiant `UC…` de la chaîne. Sinon lu dans `ADN/chaine.json` (`"youtube"`), sinon appris au premier envoi. |
| `youtube.visibilite` | `non-repertoriee` (défaut) · `publique` · `privee` · `programmee` |
| `youtube.heures` | créneaux au quart d’heure pour `programmee` : une vidéo par créneau libre, ex. `["09:00", "18:30"]` |
| `youtube.auto` | `true` = envoi automatique dès qu'une vidéo est prête ; `false` = bouton seulement |
| `youtube.monetisation` | `oui` (annonces activées + « None of the above ») · `non` · `manuel` (tu termines dans Studio) |
| `facebook.publier` | `video` = la vidéo longue sur la page · `reel` = le fichier `short.mp4` en Reel (+ Short YouTube) · `non` |
| `facebook.page` | lien HTTPS de la page Facebook où publier (`https://www.facebook.com/…`) |

Ordre : YouTube d'abord ; Facebook juste après, une fois l'envoi YouTube terminé.

## 4. Dans le panneau de l'extension

- Dossier à choisir : **`YOUTUBE`** (toutes les chaînes) ou le dossier d'**une chaîne**. Pas `VIDEO/` : la chaîne et ses réglages ne seraient plus reconnus.
- Le suivi des envois est écrit dans le dossier de chaque vidéo (`.kappgen.json`) : changer de dossier dans le panneau ne fait plus repartir une vidéo déjà envoyée.
- Seules les vidéos terminées après le choix du dossier partent automatiquement. Les vidéos déjà présentes restent visibles mais attendent un clic. Une vidéo dont le titre existe déjà sur la chaîne publique est reconnue comme déjà publiée et n'est pas renvoyée.
- Un envoi interrompu (Studio fermé, extension rechargée) n'est **jamais** relancé tout seul : la vidéo affiche « envoi précédent interrompu ». Vérifie dans YouTube Studio qu'elle n'y est pas déjà, puis relance-la à la main.
- Chrome doit rester ouvert, connecté au bon compte YouTube (et à Facebook si la chaîne publie sur Facebook). L'onglet YouTube Studio ouvert par l'extension ne doit pas être fermé pendant l'envoi.

## 5. Posts Facebook (photo, texte, Reel) à heure fixe

```
<CHAÎNE>/FACEBOOK/
├── planning.json            ← "page": lien HTTPS de la page Facebook par défaut
└── A-PUBLIER/
    └── 2026-10-02-0800-sujet/
        ├── publication.json ← {"date_locale": "2026-10-02", "heure_prevue": "08:00", "statut": "a_publier"}
        ├── texte.txt        ← le texte du post
        └── image.jpg        ← facultatif : post photo (sinon post texte ; un .mp4 vertical = Reel)
```

- L'extension publie chaque post **à son heure** (réveil à l'heure exacte, heure de l'ordinateur), sur la page de `publication.json`, puis de `planning.json`, puis du réglage `facebook.page` de la chaîne ou de « Destination Facebook » dans le panneau.
- Dans le modèle fourni, la valeur `[À COMPLÉTER — ou laisser l'extension utiliser la page déjà configurée dans son panneau]` signifie volontairement « aucune page définie ici » : l’adresse enregistrée dans le panneau est utilisée.
- Après publication confirmée par Facebook (message de succès ou apparition du nouveau post), elle écrit `"statut": "publie"` et `published_at` dans `publication.json`. La simple fermeture du compositeur et l’enregistrement d’un brouillon ne sont jamais considérés comme une publication. Si le clic final a pu aboutir mais que Facebook redirige vers l’Ad Center ou ne fournit aucune preuve, le post passe en `"statut": "a_verifier"` : aucun renvoi n’est proposé avant que l’utilisateur confirme sa présence ou son absence sur la Page et dans les brouillons. Un échec certain passe en `"statut": "echec"` avec l'erreur et n'est **jamais** relancé tout seul (pas de double post).
- Un post dont l'heure est arrivée passe avant une nouvelle vidéo YouTube.
- **Posts en retard** (Chrome fermé, ordinateur en veille…) : jamais tous d'un coup. Ils partent un par un, deux fois plus vite que l'écart habituel entre tes posts (2 min 30 au minimum), jusqu'à rattraper le retard, puis le rythme normal reprend, 24 h/24.
- **Groupes** (facultatif) : Réglages → « Groupes Facebook » → « Partager aussi mes posts Facebook dans des groupes » et le **nombre de groupes par publication** (9 par défaut). Pendant la publication, après « Suivant », l'extension clique « Partager dans les groupes » et attend obligatoirement l’écran titré « Sélectionnez des groupes » avant de cocher ce nombre de groupes (9 au plus, limite de Facebook) : d'abord ceux de ta liste de groupes préférés (facultative, « Trouver mes groupes » ou liens collés), puis **au hasard parmi les groupes que Facebook propose**. Les commutateurs « Booster », « Mention IA », « Story », audience et planification sont explicitement exclus. Elle clique ensuite « Terminé », attend le retour aux paramètres et clique « Publier ». Le bouton « Enregistrer », qui créerait un brouillon, est lui aussi exclu. Toute redirection vers l’Ad Center bloque la validation. Post par post : bouton « Groupes : oui / non », ou dans `publication.json` `"groupes": true` / `false` / une liste de liens. Résultat dans `"groupes_partages"`.

Un `publication.json` absent est facultatif ; sans date ni heure, le post est prêt immédiatement. S’il existe mais contient un JSON invalide, le post passe en « configuration invalide » et reste bloqué jusqu’à correction. Les dates doivent suivre `AAAA-MM-JJ`, les heures `HH:MM` et les pages Facebook doivent utiliser `https://www.facebook.com/…`. Un `planning.json`, `reglages-publication.json`, `ADN/chaine.json` ou fichier de suivi `.kappgen*.json` invalide bloque lui aussi les publications concernées au lieu d’appliquer silencieusement des valeurs par défaut.

## 6. Un dossier pour tous les réseaux, ou un dossier par réseau

Réglages → **Dossiers** :

- **Dossier principal** : il sert à tous les réseaux qui n'ont pas leur propre dossier.
- **Dossier de chaque réseau** (YouTube, Facebook, Instagram, TikTok, X, LinkedIn) : choisis-en un pour isoler son contenu. La croix ✕ le remet sur le dossier principal.
- Dans le dossier principal, chaque réseau peut aussi avoir sa propre file :

```text
<CHAÎNE>/
├── VIDEO/…                   # YouTube, puis relais activés
├── FACEBOOK/A-PUBLIER/…     # Facebook, puis relais activés
├── X/A-PUBLIER/…            # X uniquement
├── LINKEDIN/A-PUBLIER/…     # LinkedIn uniquement
├── INSTAGRAM/A-PUBLIER/…    # Instagram, vidéo verticale
└── TIKTOK/A-PUBLIER/…       # TikTok, vidéo
```

Les vidéos des files propres aux réseaux ne sont jamais prises pour des vidéos YouTube. L'état de chaque destination est enregistré séparément dans `publication.json`.

**Ordre de publication** : un contenu termine sa distribution sur tous les réseaux activés avant le contenu suivant. Une seule publication travaille à la fois. Les automatisations utilisent leurs propres onglets en arrière-plan ; un clic manuel peut réutiliser un onglet du réseau déjà ouvert.

Dans les onglets **X** et **LinkedIn**, les réglages déterminent si le réseau reçoit les vidéos YouTube, les posts Facebook et/ou sa file dédiée.
