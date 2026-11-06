// Reprendre une mise en ligne interrompue dans YouTube Studio (Roosevelt, 06/11 : « je ne retrouve pas la vidéo dans les
// chemins, le nom de la vidéo est différent du nom des dossiers »). Studio demande le fichier sous le nom que KappGen Publish
// lui a donné : le nom du DOSSIER de la vidéo (« 2026-11-03_038_jesus-de-miguel-tenerife.mp4 », « …-short.mp4 » pour le Short,
// voir nomPourStudio dans studio.js), alors que le fichier s'appelle « bv-38-….mp4 » dans 06-rendu. L'extension retrouve le
// fichier à partir de ce nom et le remet elle-même à Studio. Décisions pures (testées sans Chrome).
(function (root) {
  const EXTENSIONS = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;

  // Nom du fichier que Studio demande, lu dans le texte de la ligne (« …puis sélectionnez X pour continuer »,
  // « …then select X to continue »). null si la ligne n'en donne pas.
  function nomDemande(texte) {
    const t = String(texte || '').replace(/\s+/g, ' ');
    const m = t.match(/(?:s[ée]lectionnez|select|choisissez|choose)\s+["«“]?(.+?\.(?:mp4|mov|m4v|webm|mkv|avi))["»”]?\s+(?:pour|to)\s+(?:continuer|continue)/i);
    if (m) return m[1].trim();
    const seul = t.match(/([^\s"«»“”/\\]+\.(?:mp4|mov|m4v|webm|mkv|avi))/i);
    return seul ? seul[1] : null;
  }

  const base = (p) => String(p || '').split('/').filter(Boolean).pop() || '';
  const dossiers = (p) => String(p || '').split('/').filter(Boolean).slice(0, -1);

  // Le fichier du dossier qui correspond au nom demandé : { path, short } ou null.
  // 1) nom du dossier de la vidéo (+ « -short » pour la version verticale) ; 2) nom réel du fichier (envoi sans renommage).
  function cheminPour(nom, videos) {
    const demande = String(nom || '').trim();
    if (!demande || !EXTENSIONS.test(demande)) return null;
    const tige = demande.replace(EXTENSIONS, '');
    const court = /-short$/i.test(tige);
    const dossier = court ? tige.replace(/-short$/i, '') : tige;
    const liste = (Array.isArray(videos) ? videos : []).filter((v) => v && v.relative_path);
    const egal = (a, b) => a.toLowerCase() === b.toLowerCase();
    for (const v of liste) {
      if (!dossiers(v.relative_path).some((d) => egal(d, dossier))) continue;
      if (court && v.vertical_path) return { path: v.vertical_path, short: true, title: v.title || '' };
      if (!court) return { path: v.relative_path, short: false, title: v.title || '' };
    }
    // Studio garde aussi le nom réel quand le fichier n'a pas été renommé (vidéo hors dossier de travail).
    for (const v of liste) {
      if (egal(base(v.relative_path), demande)) return { path: v.relative_path, short: false, title: v.title || '' };
      if (v.vertical_path && egal(base(v.vertical_path), demande)) return { path: v.vertical_path, short: true, title: v.title || '' };
    }
    return null;
  }

  const api = Object.freeze({ nomDemande, cheminPour });
  root.KappReprise = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
