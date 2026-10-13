// Mises à jour automatiques de l'extension (Roosevelt, 13/10 : « les gens n'ont même pas un signal que j'ai fait une mise à jour »).
// Chrome télécharge une nouvelle version du Chrome Web Store toutes les quelques heures, mais ne l'installe que quand
// l'extension est au repos ou au redémarrage de Chrome. KappGen Publish ne se met jamais au repos (battement, onglets
// suivis) : sans aide, la nouvelle version attendait la fermeture de Chrome, parfois des jours.
// Désormais : l'extension demande elle-même toutes les 3 h s'il y a du nouveau, et dès qu'une version est prête elle
// redémarre seule sur la nouvelle version, entre deux publications (jamais pendant un envoi).
// Fonctions pures (l'heure est passée en paramètre) pour être testées sans navigateur.
const KappUpdate = (() => {
  const CHECK_MINUTES = 180;        // demande au Chrome Web Store toutes les 3 h
  const RETRY_MINUTES = 2;          // publication en cours : on réessaie 2 min plus tard
  const STALE_JOB_MS = 3 * 3600e3;  // une publication « en cours » sans nouvelles depuis 3 h est bloquée : elle n'empêche plus la mise à jour

  // Peut-on redémarrer sur la nouvelle version maintenant ?
  //   job     : publication suivie par le panneau (chrome.storage.session « job »)
  //   pending : envoi YouTube Studio à reprendre après un redémarrage (chrome.storage.local « pending »)
  function canReload({ job, pending, now }) {
    if (pending) return { ok: false, why: 'Un envoi YouTube est en cours.' };
    if (job && job.running) {
      const last = job.updatedAt || job.startedAt || 0;
      if (now - last < STALE_JOB_MS) return { ok: false, why: 'Une publication est en cours.' };
    }
    return { ok: true };
  }

  // Texte affiché à côté du numéro de version, dans le panneau.
  function label({ current, waiting, justUpdated, now }) {
    if (waiting && waiting.version && waiting.version !== current) {
      return { text: `v${current} → v${waiting.version}`, title: `Nouvelle version ${waiting.version} téléchargée : elle s’installe toute seule dès que la publication en cours est finie.`, state: 'waiting' };
    }
    if (justUpdated && justUpdated.version === current && now - (justUpdated.at || 0) < 24 * 3600e3) {
      return { text: `v${current} · mise à jour`, title: `Mise à jour installée automatiquement${justUpdated.from ? ` (avant : v${justUpdated.from})` : ''}. Clique pour vérifier s’il y a encore plus récent.`, state: 'updated' };
    }
    return { text: `v${current}`, title: 'Version installée : les mises à jour s’installent toutes seules. Clique pour vérifier maintenant.', state: 'ok' };
  }

  const api = { CHECK_MINUTES, RETRY_MINUTES, STALE_JOB_MS, canReload, label };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
