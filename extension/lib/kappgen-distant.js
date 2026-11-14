// Le dossier d'une marque, prêté par KappGen ouvert sur cet ordinateur (Roosevelt, 14/11 : « l'extension ne détecte pas le dossier »).
//
// Chrome n'ouvre jamais un dossier par son chemin, et depuis Chrome 157 (Windows) « Choisir le dossier » s'annule tout seul dans le
// panneau. KappGen, lui, voit les marques : il sert leurs fichiers à KappGen Publish (api/kappgen2/extension_fichiers.py, seulement
// à cette extension et sur cet ordinateur). Ce module en fait un « dossier » qui se comporte comme celui que donne Chrome
// (FileSystemDirectoryHandle : entries, getDirectoryHandle, getFileHandle, createWritable, removeEntry…) : le reste de l'extension
// (lib/dossier.js) n'y voit aucune différence.
//
// La marque choisie dans le panneau est gardée dans chrome.storage.local « marqueKappgen » : { id, nom, dossier, port }.
const KappDistant = (() => {
  const CLE = 'marqueKappgen';
  const FRAICHEUR_MS = 3000;          // l'arborescence est relue au plus toutes les 3 s (une lecture du dossier en fait des centaines)
  const PING_MS = 10000;
  const TYPES = { json: 'application/json', md: 'text/markdown', txt: 'text/plain', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    png: 'image/png', webp: 'image/webp', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };
  const typeDe = (nom) => TYPES[(String(nom).split('.').pop() || '').toLowerCase()] || '';
  const introuvable = (nom) => new DOMException(`${nom} : introuvable.`, 'NotFoundError');
  const joindre = (a, b) => (a ? `${a}/${b}` : b);

  async function reglage() {
    try { const { [CLE]: m } = await chrome.storage.local.get(CLE); return m && m.id && m.port ? m : null; } catch { return null; }
  }
  const choisir = (marque) => chrome.storage.local.set({ [CLE]: marque });
  const oublier = () => chrome.storage.local.remove(CLE);

  function url(m, route, chemin, extra = {}) {
    const q = new URLSearchParams({ marque: m.id, chemin: chemin || '', ...extra });
    return `http://localhost:${m.port}/api/extension/${route}?${q}`;
  }

  async function appel(m, route, chemin, { methode = 'GET', corps, extra } = {}) {
    let r;
    try {
      r = await fetch(url(m, route, chemin, extra), { method: methode, body: corps, credentials: 'omit', cache: 'no-store' });
    } catch {
      throw new Error('KappGen ne répond pas : ouvre KappGen sur cet ordinateur (il prête les fichiers de ta marque à l’extension).');
    }
    if (r.status === 404) throw introuvable(chemin || m.dossier);
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.erreur || `KappGen a refusé (${r.status}).`);
    }
    return r;
  }

  // Un fichier vu dans l'arborescence : sa taille et sa date sont connues sans le télécharger (une lecture du dossier ne charge pas les
  // vidéos). text() / arrayBuffer() le lisent quand on en a besoin ; fichierComplet() donne un vrai File (envoi, aperçu).
  class FichierLu {
    constructor(racine, chemin, nom, taille, modif) {
      Object.assign(this, { _racine: racine, _chemin: chemin, name: nom, size: taille, lastModified: modif, type: typeDe(nom) });
    }
    async _blob() { return (await appel(this._racine._m, 'fichier', this._chemin)).blob(); }
    async text() { return (await this._blob()).text(); }
    async arrayBuffer() { return (await this._blob()).arrayBuffer(); }
  }

  class Fichier {
    constructor(racine, chemin, nom, taille = 0, modif = Date.now(), existe = true) {
      Object.assign(this, { _racine: racine, _chemin: chemin, name: nom, kind: 'file', _taille: taille, _modif: modif, _existe: existe });
    }
    async getFile() {
      if (!this._existe) throw introuvable(this.name);
      return new FichierLu(this._racine, this._chemin, this.name, this._taille, this._modif);
    }
    async fichierComplet() {
      const blob = await (await appel(this._racine._m, 'fichier', this._chemin)).blob();
      return new File([blob], this.name, { type: typeDe(this.name) || blob.type, lastModified: this._modif });
    }
    async createWritable() {
      const morceaux = [];
      const racine = this._racine, chemin = this._chemin, fichier = this;
      return {
        async write(donnees) {
          const d = donnees && typeof donnees === 'object' && 'type' in donnees && donnees.type === 'write' ? donnees.data : donnees;
          morceaux.push(d instanceof FichierLu ? await d._blob() : d);
        },
        async close() {
          await appel(racine._m, 'ecrire', chemin, { methode: 'POST', corps: new Blob(morceaux) });
          fichier._existe = true;
          racine._perime();
        },
        async abort() { morceaux.length = 0; },
      };
    }
    async isSameEntry(autre) { return !!autre && autre._racine && autre._racine._m.id === this._racine._m.id && autre._chemin === this._chemin; }
    async queryPermission() { return this._racine.queryPermission(); }
    async requestPermission() { return this._racine.queryPermission(); }
  }

  class Dossier {
    constructor(racine, chemin, nom) {
      Object.assign(this, { _racine: racine || this, _chemin: chemin, name: nom, kind: 'directory' });
    }
    async _enfants() {
      const noeud = await this._racine._noeud(this._chemin);
      if (!noeud) throw introuvable(this.name);
      return noeud.e;
    }
    async *entries() {
      for (const e of await this._enfants()) {
        const chemin = joindre(this._chemin, e[0]);
        yield [e[0], e[1] === 'd' ? new Dossier(this._racine, chemin, e[0]) : new Fichier(this._racine, chemin, e[0], e[2], e[3])];
      }
    }
    async *values() { for await (const [, h] of this.entries()) yield h; }
    async *keys() { for await (const [nom] of this.entries()) yield nom; }
    [Symbol.asyncIterator]() { return this.entries(); }
    async getDirectoryHandle(nom, { create = false } = {}) {
      const e = (await this._enfants()).find((x) => x[0] === nom);
      if (e && e[1] === 'd') return new Dossier(this._racine, joindre(this._chemin, nom), nom);
      if (e) throw new DOMException(`${nom} n’est pas un dossier.`, 'TypeMismatchError');
      if (!create) throw introuvable(nom);
      await appel(this._racine._m, 'creer-dossier', joindre(this._chemin, nom), { methode: 'POST' });
      this._racine._perime();
      return new Dossier(this._racine, joindre(this._chemin, nom), nom);
    }
    async getFileHandle(nom, { create = false } = {}) {
      const e = (await this._enfants()).find((x) => x[0] === nom);
      if (e && e[1] === 'f') return new Fichier(this._racine, joindre(this._chemin, nom), nom, e[2], e[3]);
      if (e) throw new DOMException(`${nom} est un dossier.`, 'TypeMismatchError');
      if (!create) throw introuvable(nom);
      return new Fichier(this._racine, joindre(this._chemin, nom), nom, 0, Date.now(), false);   // écrit à la fermeture (createWritable)
    }
    async removeEntry(nom, { recursive = false } = {}) {
      await appel(this._racine._m, 'supprimer', joindre(this._chemin, nom), { methode: 'POST', extra: recursive ? { recursif: '1' } : {} });
      this._racine._perime();
    }
    async resolve(enfant) {
      if (!enfant || !enfant._racine || enfant._racine._m.id !== this._racine._m.id) return null;
      if (enfant._chemin === this._chemin) return [];
      const base = this._chemin ? `${this._chemin}/` : '';
      return enfant._chemin.startsWith(base) ? enfant._chemin.slice(base.length).split('/') : null;
    }
    async isSameEntry(autre) { return !!autre && autre.kind === 'directory' && !!autre._racine && autre._racine._m.id === this._racine._m.id && autre._chemin === this._chemin; }
    async queryPermission() { return this._racine.queryPermission(); }
    async requestPermission() { return this._racine.queryPermission(); }
  }

  // La racine : le dossier de la marque. Elle garde l'arborescence lue (relue après FRAICHEUR_MS ou après une écriture).
  class Racine extends Dossier {
    constructor(m) {
      super(null, '', m.nomDossier || m.nom);
      this._racine = this;
      this._m = m;
      this._arbre = null;
      this._lu = 0;
      this._enCours = null;
      this._ping = { t: 0, etat: 'denied' };
      this.distant = true;
      this.nomMarque = m.nom;
    }
    _perime() { this._lu = 0; }
    async _arborescence() {
      if (this._arbre && Date.now() - this._lu < FRAICHEUR_MS) return this._arbre;
      if (!this._enCours) {
        this._enCours = appel(this._m, 'arbre', '').then((r) => r.json()).then((a) => {
          this._arbre = a; this._lu = Date.now(); return a;
        }).finally(() => { this._enCours = null; });
      }
      return this._enCours;
    }
    async _noeud(chemin) {
      let noeud = await this._arborescence();
      for (const part of (chemin ? chemin.split('/') : [])) {
        const e = noeud.e.find((x) => x[0] === part && x[1] === 'd');
        if (!e) return null;
        noeud = e[3];
      }
      return noeud;
    }
    // « Accès » au dossier : KappGen répond et connaît la marque.
    async queryPermission() {
      if (Date.now() - this._ping.t < PING_MS) return this._ping.etat;
      let etat = 'denied';
      try { await this._arborescence(); etat = 'granted'; } catch { etat = 'denied'; }
      this._ping = { t: Date.now(), etat };
      return etat;
    }
  }

  let memo = null;
  async function racine() {
    const m = await reglage();
    if (!m) { memo = null; return null; }
    if (!memo || memo._m.id !== m.id || memo._m.port !== m.port) memo = new Racine(m);
    return memo;
  }

  // Les marques que KappGen peut prêter : [{ id, nom, dossier, nom_dossier }] (null : KappGen absent ou trop ancien).
  async function marques(port) {
    try {
      const r = await fetch(`http://localhost:${port}/api/extension/marques`, { credentials: 'omit', cache: 'no-store' });
      return r.ok ? (await r.json()).marques || [] : null;
    } catch { return null; }
  }

  return { racine, reglage, choisir, oublier, marques, CLE, _Racine: Racine };
})();
if (typeof module !== 'undefined') module.exports = { KappDistant };
