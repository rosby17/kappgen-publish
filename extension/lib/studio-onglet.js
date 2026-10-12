// Un onglet YouTube Studio qui envoie encore le fichier d'une vidéo ne doit jamais être fermé : le fermer coupe
// l'envoi et laisse dans Studio un brouillon « Mise en ligne interrompue — Reprendre l'importation » (1.21.6).
// Décision pure (testée sans Chrome) : le service worker relève le texte de l'onglet, cette fonction tranche.
(function (root) {
  // Pourcentage d'envoi encore affiché…
  const POURCENTAGE = /\d{1,3}\s*%/;
  // …sauf quand il dit que l'envoi est fini (traitement, vérifications : Studio n'a plus besoin de l'onglet).
  const ENVOI_FINI = /(100\s*%|termin|complete|traitement|processing|v[ée]rification|checking)/i;
  // Texte de la page pendant un envoi (FR / EN).
  const ENVOI_DANS_LA_PAGE = /(Uploading|Importation|Mise en ligne|Envoi)\s*(en cours|:)?\s*\d{1,3}\s*%/i;
  // Au-delà, l'onglet est fermé quoi qu'il affiche.
  const GARDE_MAX_MS = 8 * 3600000;

  // progress : texte des barres de progression de Studio ; stillUploading : réponse de studio.js si chargé (sinon null) ;
  // body : texte de la page.
  function envoiEnCours({ progress = '', stillUploading = null, body = '' } = {}) {
    if (POURCENTAGE.test(progress) && !ENVOI_FINI.test(progress)) return true;
    if (stillUploading !== null && stillUploading !== undefined) return !!stillUploading;
    return ENVOI_DANS_LA_PAGE.test(body);
  }

  const api = Object.freeze({ GARDE_MAX_MS, envoiEnCours });
  root.KappStudioOnglet = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
