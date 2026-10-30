// Mise à jour d'une vidéo déjà sur YouTube, sans la renvoyer (Roosevelt, 19/10 : « je n'ai pas de bouton pour mettre à jour
// seulement la miniature, seulement le titre, seulement la description »), et miniature à compléter après un envoi où Studio
// ne l'a pas prise (« il y a encore des vidéos qui partent sans miniature »).
// Décisions pures (testées sans Chrome) : background.js relève l'état, ces fonctions tranchent.
(function (root) {
  // Ce qu'une mise à jour peut toucher sur la page d'édition de Studio. Sans liste : tout (le « Mettre à jour » d'avant).
  const CHAMPS = Object.freeze(['thumbnail', 'title', 'description', 'tags']);
  // Une miniature refusée pendant l'envoi est réessayée toute seule : 3 fois, à 20 min d'écart (Studio finit le traitement).
  const ESSAIS_MINIATURE = 3;
  const ECART_ESSAIS_MS = 20 * 60000;
  // executeScript quand Studio recharge ou change de page pendant une étape : la page (frame 0) n'existe plus.
  const PAGE_RECHARGEE = /frame with id \d+ was removed|frame was removed|no frame with id|execution context was destroyed|document (?:was|has been) unloaded/i;
  const MESSAGE_PAGE_RECHARGEE = 'YouTube Studio a rechargé la page pendant la mise à jour : réessaie.';

  // champs : null (tout) ou une liste parmi CHAMPS ; video : la vidéo publiée telle que la lit le dossier.
  // Rend ce qui sera appliqué, ou une erreur claire quand le dossier n'a rien pour ce champ.
  function champsAMettreAJour(champs, video = {}) {
    const voulus = Array.isArray(champs) && champs.length ? champs.filter((c) => CHAMPS.includes(c)) : CHAMPS;
    if (!voulus.length) return { erreur: 'Champ à mettre à jour inconnu.' };
    const seul = voulus.length === 1 ? voulus[0] : null;
    const plan = {
      thumbnail: voulus.includes('thumbnail') && !!video.thumbnail_path,
      title: voulus.includes('title') && !!video.title,
      description: voulus.includes('description') && !!video.description,
      tags: voulus.includes('tags') && !!(video.tags && video.tags.length),
      tout: voulus.length === CHAMPS.length,
    };
    // Une seule chose demandée et rien dans le dossier pour elle : le dire, plutôt qu'ouvrir Studio pour rien.
    if (seul === 'thumbnail' && !plan.thumbnail) {
      return { erreur: video.thumbnail_warning || video.preview_path
        ? 'La miniature du dossier fait plus de 2 Mo : YouTube la refuse. Réduis-la, puis réessaie.'
        : 'Aucune miniature dans le dossier de cette vidéo.' };
    }
    if (seul === 'title' && !plan.title) return { erreur: 'Aucun titre dans la fiche de cette vidéo.' };
    if (seul === 'description' && !plan.description) return { erreur: 'Aucune description dans la fiche de cette vidéo.' };
    if (!plan.thumbnail && !plan.title && !plan.description && !plan.tags) return { erreur: 'Aucune fiche ni miniature trouvée pour cette vidéo dans le dossier.' };
    return plan;
  }

  // Après un envoi : faut-il compléter la miniature plus tard ? Oui si la vidéo en a une (ou devait en avoir une : dossier KappGen)
  // et que Studio ne l'a pas prise (champ Miniature absent, fichier illisible, plus de 2 Mo…).
  function miniatureAComplete({ kind = null, thumbnailPath = null, previewPath = null, envoyee = false } = {}) {
    if (envoyee) return false;
    return !!(thumbnailPath || previewPath || kind === 'kappgen');
  }

  // Passage automatique : la miniature en attente d'une vidéo publiée doit-elle être appliquée maintenant ?
  // v : vidéo de « sent » (thumb_pending, thumbnail_path, thumb_tries, applied_at).
  function miniatureARetenter(v = {}, now = Date.now()) {
    if (!v.thumb_pending || !v.thumbnail_path || !v.youtube_id) return false;
    const essais = v.thumb_tries || 0;
    if (essais >= ESSAIS_MINIATURE) return false;
    return essais === 0 || now - (v.applied_at || 0) >= ECART_ESSAIS_MS;
  }

  // Miniature vérifiée sur YouTube (Roosevelt, 30/10 : Dharma Vivant 013 et 016 en ligne avec une image tirée de la vidéo).
  // Studio peut ignorer le fichier sans rien dire : l'envoi passait pour réussi. Après chaque envoi ou mise à jour, la miniature
  // que YouTube montre (i.ytimg.com, ouvert à tous) est comparée à celle du dossier ; différente → réappliquée toute seule.
  const VERIF_DELAI_MS = 15 * 60000;          // YouTube met quelques minutes à servir la nouvelle miniature
  const VERIF_ECART_MS = 30 * 60000;          // entre deux contrôles d'une même vidéo
  const VERIF_FENETRE_MS = 30 * 86400000;     // vidéos plus anciennes : jamais touchées (miniature changée à la main dans Studio)
  const VERIF_MAX = 3;                        // au-delà, on arrête de réappliquer et on le signale
  const SEUIL_ECART = 64;                     // sur 256 : même image ≈ 0 à 10, image différente ≈ 110 à 140

  // v : vidéo de « sent ». La miniature du dossier est-elle à comparer avec YouTube maintenant ?
  function miniatureAVerifier(v = {}, now = Date.now()) {
    if (!v.youtube_id || !v.thumbnail_path || !v.thumb_sig || v.youtube_draft || v.thumb_pending) return false;
    if (v.thumb_ok_sig === v.thumb_sig) return false;                       // déjà vue sur YouTube, fichier inchangé
    if ((v.thumb_misses || 0) >= VERIF_MAX) return false;
    const envoi = Math.max(Number(v.published_at) || 0, Number(v.applied_at) || 0);
    if (!envoi || now - envoi < VERIF_DELAI_MS) return false;
    if (now - (Number(v.published_at) || 0) > VERIF_FENETRE_MS) return false;
    return !v.thumb_checked_at || now - v.thumb_checked_at >= VERIF_ECART_MS;
  }

  // Empreinte d'une image réduite à 16 × 16 en gris (256 valeurs) : chaque point plus clair ou non que la moyenne.
  function empreinte(gris = []) {
    const moyenne = gris.reduce((a, b) => a + b, 0) / (gris.length || 1);
    return gris.map((g) => g > moyenne);
  }
  const ecartEmpreintes = (a = [], b = []) => a.reduce((n, x, i) => n + (x !== b[i] ? 1 : 0), 0) + Math.abs(a.length - b.length);
  const miniatureDifferente = (ecart) => Number.isFinite(ecart) && ecart >= SEUIL_ECART;

  const pageRechargee = (message) => PAGE_RECHARGEE.test(String((message && message.message) || message || ''));

  const api = Object.freeze({ CHAMPS, ESSAIS_MINIATURE, ECART_ESSAIS_MS, MESSAGE_PAGE_RECHARGEE,
    VERIF_DELAI_MS, VERIF_ECART_MS, VERIF_FENETRE_MS, VERIF_MAX, SEUIL_ECART,
    champsAMettreAJour, miniatureAComplete, miniatureARetenter, miniatureAVerifier, empreinte, ecartEmpreintes, miniatureDifferente, pageRechargee });
  root.KappMajVideo = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
