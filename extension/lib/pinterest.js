// Pinterest : ce qui ne dépend pas de la page (textes de l'épingle, format vertical, accès). Fonctions pures, testées sans
// navigateur (tests/pinterest.test.mjs). Les sélecteurs de la page Pinterest viennent de la recette du serveur (lib/recette.js),
// jamais d'ici. Aucun sélecteur n'a encore été vérifié sur un vrai compte Pinterest.
(function (root) {
  const TITLE_MAX = 100;          // titre d'une épingle (Pinterest affiche ~100 caractères)
  const DESCRIPTION_MAX = 500;    // description : Pinterest accepte jusqu'à 500 caractères
  const TOLERANCE = 0.03;         // écart toléré sur le rapport largeur/hauteur (arrondis des encodeurs)
  // Les deux formats verticaux acceptés : épingle standard 2:3 et format story 9:16.
  const FORMATS = [{ name: '2:3', ratio: 2 / 3 }, { name: '9:16', ratio: 9 / 16 }];
  const ORIGINS = ['https://www.pinterest.com/*'];
  const CREATION_URL = 'https://www.pinterest.com/pin-creation-tool/';

  // Coupe au dernier mot entier, avec « … » quand le texte dépasse la limite.
  function cut(text, max) {
    const body = String(text || '').replace(/\s+/g, ' ').trim();
    if (body.length <= max) return body;
    return `${body.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
  }

  // Titre = première ligne du texte ; description = le texte entier, coupé à 500 caractères.
  function pinTexts(text) {
    const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const title = cut(lines[0] || '', TITLE_MAX);
    const description = cut(String(text || '').trim(), DESCRIPTION_MAX);
    return { title, description };
  }

  // « 2:3 », « 9:16 » ou null (carré, paysage…).
  function formatOf(width, height) {
    const w = Number(width);
    const h = Number(height);
    if (!(w > 0) || !(h > 0)) return null;
    const ratio = w / h;
    const found = FORMATS.find((f) => Math.abs(ratio - f.ratio) / f.ratio <= TOLERANCE);
    return found ? found.name : null;
  }

  // Dimensions inconnues (fichier illisible côté navigateur) : on ne bloque pas, Pinterest refusera si besoin.
  function checkFormat(width, height) {
    if (!(Number(width) > 0) || !(Number(height) > 0)) return { ok: true, format: null, message: '' };
    const format = formatOf(width, height);
    if (format) return { ok: true, format, message: '' };
    return {
      ok: false,
      format: null,
      message: `Pinterest : l’épingle doit être verticale (2:3 ou 9:16). Ce fichier fait ${Math.round(width)} × ${Math.round(height)} px.`,
    };
  }

  const api = Object.freeze({ TITLE_MAX, DESCRIPTION_MAX, FORMATS, ORIGINS, CREATION_URL, cut, pinTexts, formatOf, checkFormat });
  root.KappPinterest = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
