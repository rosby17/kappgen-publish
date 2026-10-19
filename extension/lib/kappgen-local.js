// KappGen installé sur cet ordinateur : où sont les marques (Roosevelt, 19/10 : « l'extension doit trouver ce dossier toute seule »).
// KappGen répond à http://localhost:<port>/api/extension/dossier (seulement sur cet ordinateur, jamais à une page web) et pose un petit
// fichier caché « .kappgen-marques.json » à la racine des marques. Chrome ne laisse pas une extension ouvrir un dossier par son chemin :
// la personne choisit un dossier une fois, et l'extension se place d'elle-même sur la racine des marques si elle est dedans.
const KappLocal = (() => {
  const PORTS = [8000, 8001, 8080, 8888, 9000, 9100];       // ceux que KappGen essaie, dans le même ordre (api/kappgen2/__main__.py)
  const MARQUEUR = '.kappgen-marques.json';
  let trouve = null;

  async function dossier() {
    if (trouve) return trouve;
    const essais = PORTS.map(async (port) => {
      const stop = new AbortController();
      const minuterie = setTimeout(() => stop.abort(), 1200);
      try {
        const r = await fetch(`http://localhost:${port}/api/extension/dossier`, { signal: stop.signal, credentials: 'omit', cache: 'no-store' });
        const d = r.ok ? await r.json() : null;
        if (d && d.kappgen && d.dossier) return { ...d, port };
      } catch { /* pas de KappGen sur ce port */ } finally { clearTimeout(minuterie); }
      throw new Error('absent');
    });
    trouve = await Promise.any(essais).catch(() => null);
    return trouve;
  }

  async function estRacine(handle, marqueur) {
    try { await handle.getFileHandle(marqueur); return true; } catch { return false; }
  }

  // Le dossier des marques dans le dossier choisi : lui-même, ou un sous-dossier jusqu'à 4 niveaux (parcours en largeur, borné).
  async function racineDans(handle, marqueur = MARQUEUR) {
    let niveau = [handle], vus = 0;
    for (let profondeur = 0; profondeur <= 4 && niveau.length; profondeur += 1) {
      const suivant = [];
      for (const d of niveau) {
        if (await estRacine(d, marqueur)) return d;
        if (profondeur === 4) continue;
        try {
          for await (const [nom, h] of d.entries()) {
            if (h.kind !== 'directory' || /^[._]/.test(nom) || /^(node_modules|Library|Applications|contenus|\d+-[a-z]+)$/i.test(nom)) continue;
            suivant.push(h);
            if ((vus += 1) > 4000) return null;
          }
        } catch { /* dossier illisible : on passe */ }
      }
      niveau = suivant;
    }
    return null;
  }

  return { dossier, racineDans, MARQUEUR };
})();
if (typeof module !== 'undefined') module.exports = { KappLocal };
