// Visibilité YouTube d'un envoi depuis le dossier, choisie au même endroit pour l'envoi automatique ET le bouton « Publier maintenant »
// (05/11/2026). Avant, le bouton prenait la visibilité du panneau (« non répertoriée ») et partait tout de suite : Dharma Vivant n° 25 et 26,
// programmées par KappGen les 06 et 07/11 (06-rendu/programmation.json), sont parties le 04/11 en non répertoriée, et le
// « programmee » de reglages-publication.json n'était pas lu.
// Règles, dans l'ordre :
//   1. « privée » (réglages de la chaîne ou choix de la personne) l'emporte toujours ;
//   2. date donnée par KappGen (programmation.json) encore à venir : envoyée « Programmée » à CETTE date, jamais publique avant ;
//   3. date KappGen passée : publique, sauf si les réglages de la chaîne disent « non répertoriée » ;
//   4. heure choisie dans le panneau pour cette vidéo : « Programmée » à cette heure ;
//   5. sinon : les réglages de la chaîne (reglages-publication.json) l'emportent sur le panneau, comme le dit NORME-PUBLICATION.md.
// 06/11/2026 (Roosevelt) : plus de réglage de visibilité dans le panneau. « Je veux que quand une vidéo vient, elle vient déjà avec
// son heure de publication : soit elle part directement, soit elle est programmée. » Le choix du panneau (canal) n'est plus lu ;
// sans réglage dans le dossier de la chaîne (KappGen), une vidéo part PUBLIQUE, jamais « non répertoriée » par défaut.
// Fonction pure (l'heure est passée en paramètre) pour être testée sans navigateur.
const KappVisibilite = (() => {
  const VISIBILITES = ['UNLISTED', 'PUBLIC', 'PRIVATE', 'SCHEDULE'];
  const MARGE_MS = 15 * 60000;   // YouTube refuse une programmation trop proche : en deçà, la vidéo part déjà à son heure
  const valide = (v) => (VISIBILITES.includes(v) ? v : null);

  // demandee : 'CHANNEL' (envoi automatique ou relance : visibilité de la chaîne) ou ce que la personne a choisi (PUBLIC, UNLISTED, PRIVATE)
  // fichier   : visibilité de reglages-publication.json (video.channel_config.visibility), canal : celle du panneau pour la chaîne
  // Renvoie { visibility, scheduleAt } ; visibility 'SCHEDULE' avec scheduleAt null = prochain créneau libre de la chaîne.
  function choisir({ demandee = 'CHANNEL', fichier = null, canal: _canal = null, plannedAt = null, scheduleAt = null, now = Date.now() } = {}) {
    const f = valide(fichier);
    if (f === 'PRIVATE' || demandee === 'PRIVATE') return { visibility: 'PRIVATE', scheduleAt: null };
    if (plannedAt !== null && plannedAt !== undefined) {   // 0 est une vraie heure : comparer à null
      if (plannedAt > now + MARGE_MS) return { visibility: 'SCHEDULE', scheduleAt: plannedAt };
      return { visibility: f === 'UNLISTED' ? 'UNLISTED' : 'PUBLIC', scheduleAt: null };
    }
    if (scheduleAt && scheduleAt > now + MARGE_MS) return { visibility: 'SCHEDULE', scheduleAt };
    if (demandee === 'CHANNEL' || !valide(demandee)) return { visibility: f || 'PUBLIC', scheduleAt: null };
    // Choix de la personne (« Publier maintenant ») : il part maintenant ; seuls des réglages de chaîne autres que « programmée » le changent.
    return { visibility: f && f !== 'SCHEDULE' ? f : demandee, scheduleAt: null };
  }

  const api = { VISIBILITES, MARGE_MS, choisir };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
