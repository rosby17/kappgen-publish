# Norme de publication (extension KappGen : YouTube + Facebook)

Une vidéo rangée selon cette norme est publiée **toute seule** par l'extension KappGen : elle trouve la chaîne, la vidéo, le titre, la description, les mots-clés et la miniature, puis l'envoie sur YouTube et, si la chaîne le demande, sur Facebook.

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
| `youtube.heures` | créneaux pour `programmee` : une vidéo par créneau libre, ex. `["09:00", "18:00"]` |
| `youtube.auto` | `true` = envoi automatique dès qu'une vidéo est prête ; `false` = bouton seulement |
| `youtube.monetisation` | `oui` (annonces activées + « None of the above ») · `non` · `manuel` (tu termines dans Studio) |
| `facebook.publier` | `video` = la vidéo longue sur la page · `reel` = le fichier `short.mp4` en Reel (+ Short YouTube) · `non` |
| `facebook.page` | lien de la page Facebook où publier |

Ordre : YouTube d'abord ; Facebook juste après, une fois l'envoi YouTube terminé.

## 4. Dans le panneau de l'extension

- Dossier à choisir : **`YOUTUBE`** (toutes les chaînes) ou le dossier d'**une chaîne**. Pas `VIDEO/` : la chaîne et ses réglages ne seraient plus reconnus.
- Le suivi des envois est écrit dans le dossier de chaque vidéo (`.kappgen.json`) : changer de dossier dans le panneau ne fait plus repartir une vidéo déjà envoyée.
- Choisir le dossier = publier ce qu'il contient : toute vidéo prête part toute seule, ancienne ou nouvelle, sans question. Une vidéo dont le titre existe déjà sur la chaîne (page publique) est reconnue comme déjà publiée et n'est pas renvoyée.
- Un envoi interrompu (Studio fermé, extension rechargée) n'est **jamais** relancé tout seul : la vidéo affiche « envoi précédent interrompu ». Vérifie dans YouTube Studio qu'elle n'y est pas déjà, puis relance-la à la main.
- Chrome doit rester ouvert, connecté au bon compte YouTube (et à Facebook si la chaîne publie sur Facebook). L'onglet YouTube Studio ouvert par l'extension ne doit pas être fermé pendant l'envoi.

## 5. Posts Facebook (photo, texte, Reel) à heure fixe

```
<CHAÎNE>/FACEBOOK/
├── planning.json            ← "page": lien de la page Facebook ; créneaux du jour
└── A-PUBLIER/
    └── 2026-10-02-0800-sujet/
        ├── publication.json ← {"date_locale": "2026-10-02", "heure_prevue": "08:00", "statut": "a_publier"}
        ├── texte.txt        ← le texte du post
        └── image.jpg        ← facultatif : post photo (sinon post texte ; un .mp4 vertical = Reel)
```

- L'extension publie chaque post **à son heure** (au plus un toutes les 5 minutes), sur la page de `planning.json` (ou de `publication.json`, ou du réglage `facebook.page` de la chaîne).
- Après publication, elle écrit `"statut": "publie"` et `published_at` dans `publication.json`. Un post en échec passe en `"statut": "echec"` avec l'erreur, et n'est **jamais** relancé tout seul (pas de double post) : bouton « Publier maintenant » dans le panneau.
- Les vidéos YouTube passent avant les posts quand les deux sont prêts en même temps.
