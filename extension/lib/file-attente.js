// Plusieurs vidéos lancées à la suite (Roosevelt, 05/11 : « je ne peux pas lancer l'autre sans que celle-ci soit finie »).
// Un clic sur « Publier » pendant qu'une publication tourne ne renvoie plus « Un envoi est déjà en cours » : la vidéo entre
// dans une file d'attente (chrome.storage.local « fileAttente ») et part dès que la précédente a fini de se régler dans Studio.
// Le transfert du fichier, lui, continue en arrière-plan (MAX_TRANSFERTS à la fois) : plusieurs vidéos montent en même temps.
//
// Profil sans accès à YouTube Studio (Roosevelt, 05/11 : deux profils « Americas Kickoff », l'un sans la chaîne, marquait
// chaque vidéo « en échec » et la bloquait pour l'autre). La vidéo est rendue aux autres profils au lieu d'être notée en
// échec, et ce profil arrête ses envois YouTube automatiques pendant PAUSE_SANS_ACCES_MS.
// Décisions pures (testées sans Chrome).
(function (root) {
  const MAX_FILE = 30;
  const PAUSE_SANS_ACCES_MS = 6 * 3600000;
  // Studio passe parfois par accounts.google.com pour rafraîchir la session, puis revient seul : rien n'est conclu avant.
  const ATTENTE_CONNEXION_MS = 20000;

  const cle = (item) => `${item.source || 'app'}|${item.videoId}`;

  // Ajoute une vidéo à la file (une seule fois). Rend { file, position } (position à partir de 1, 0 = refusée).
  function ajouter(file, item, now = Date.now()) {
    const liste = Array.isArray(file) ? file.filter((x) => x && x.videoId != null) : [];
    if (!item || item.videoId == null || item.videoId === '') return { file: liste, position: 0 };
    const deja = liste.findIndex((x) => cle(x) === cle(item));
    if (deja >= 0) return { file: liste, position: deja + 1 };
    if (liste.length >= MAX_FILE) return { file: liste, position: 0 };
    const suivant = [...liste, { source: item.source || 'app', videoId: item.videoId, visibility: item.visibility || null, at: now }];
    return { file: suivant, position: suivant.length };
  }

  // La prochaine vidéo à lancer, et la file sans elle.
  function prendre(file) {
    const liste = Array.isArray(file) ? file.filter((x) => x && x.videoId != null) : [];
    if (!liste.length) return { item: null, file: [] };
    return { item: liste[0], file: liste.slice(1) };
  }

  function retirer(file, source, videoId) {
    const liste = Array.isArray(file) ? file : [];
    return liste.filter((x) => x && cle(x) !== cle({ source, videoId }));
  }

  function position(file, source, videoId) {
    const liste = Array.isArray(file) ? file : [];
    return liste.findIndex((x) => x && cle(x) === cle({ source, videoId })) + 1;
  }

  // Page vue pendant l'ouverture de Studio : 'ok' (Studio), 'attendre' (connexion Google en cours) ou 'sans-acces'.
  function etatConnexion(url, depuis, now = Date.now()) {
    if (!String(url || '').startsWith('https://accounts.google.com')) return 'ok';
    if (depuis == null) return 'attendre';
    return now - depuis >= ATTENTE_CONNEXION_MS ? 'sans-acces' : 'attendre';
  }

  // Ce profil a-t-il arrêté ses envois YouTube automatiques (pas d'accès à Studio constaté il y a moins de 6 h) ?
  function youtubeEnPause(sansAcces, now = Date.now()) {
    return !!(sansAcces && Number.isFinite(sansAcces.at) && now - sansAcces.at < PAUSE_SANS_ACCES_MS && now >= sansAcces.at);
  }

  const api = Object.freeze({ MAX_FILE, PAUSE_SANS_ACCES_MS, ATTENTE_CONNEXION_MS, ajouter, prendre, retirer, position, etatConnexion, youtubeEnPause });
  root.KappFileAttente = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
