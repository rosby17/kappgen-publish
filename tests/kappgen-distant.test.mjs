// Marque prêtée par KappGen (lib/kappgen-distant.js) : l'extension lit et écrit le dossier d'une marque sans « Choisir le dossier »
// (Roosevelt, 14/11/2026 : depuis Chrome 157, ce choix s'annule tout seul sur Windows).
//
// Un faux KappGen (mêmes routes que api/kappgen2/extension_fichiers.py) sert un dossier temporaire. Pour vérifier contre le vrai
// KappGen : KAPPGEN_TEST_PORT, KAPPGEN_TEST_MARQUE et KAPPGEN_TEST_DOSSIER (dossier de cette marque).
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, rmSync, renameSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGINE = 'chrome-extension://fdhnddichmknbbhbmgkgodnkclejokpi';

function arbre(dossier) {
  const e = [];
  for (const nom of readdirSync(dossier).sort()) {
    const p = join(dossier, nom);
    const st = statSync(p);
    if (st.isDirectory()) e.push([nom, 'd', Math.floor(st.mtimeMs), /^[._]/.test(nom) ? { e: [] } : arbre(p)]);
    else e.push([nom, 'f', st.size, Math.floor(st.mtimeMs)]);
  }
  return { e };
}

function fauxKappgen(dossier) {
  return createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const cible = join(dossier, ...(u.searchParams.get('chemin') || '').split('/').filter(Boolean));
    const fin = (code, corps) => { res.writeHead(code); res.end(typeof corps === 'string' || Buffer.isBuffer(corps) ? corps : JSON.stringify(corps)); };
    if (req.headers.origin !== ORIGINE) return fin(403, { erreur: 'refusé' });
    if (u.searchParams.get('marque') !== 'essai' && u.pathname !== '/api/extension/marques') return fin(404, { erreur: 'marque' });
    if (u.pathname === '/api/extension/marques') return fin(200, { marques: [{ id: 'essai', nom: 'Essai', dossier: 'ESSAI', nom_dossier: 'ESSAI' }] });
    if (u.pathname === '/api/extension/arbre') return fin(200, { ...arbre(cible), tronque: false });
    if (u.pathname === '/api/extension/fichier') return existsSync(cible) ? fin(200, readFileSync(cible)) : fin(404, { erreur: 'introuvable' });
    if (u.pathname === '/api/extension/creer-dossier') { mkdirSync(cible, { recursive: true }); return fin(200, { ok: true }); }
    if (u.pathname === '/api/extension/supprimer') { rmSync(cible, { recursive: u.searchParams.get('recursif') === '1' }); return fin(200, { ok: true }); }
    if (u.pathname === '/api/extension/ecrire') {
      const morceaux = [];
      req.on('data', (m) => morceaux.push(m));
      req.on('end', () => { writeFileSync(`${cible}.tmp`, Buffer.concat(morceaux)); renameSync(`${cible}.tmp`, cible); fin(200, { ok: true }); });
      return undefined;
    }
    return fin(404, { erreur: 'route' });
  });
}

// IndexedDB vide : aucun dossier choisi dans Chrome, seulement la marque prêtée par KappGen.
const indexedDBVide = {
  open() {
    const requete = {};
    setTimeout(() => {
      requete.result = {
        transaction() {
          const tx = {};
          tx.objectStore = () => ({ get() { const r = {}; setTimeout(() => { r.result = undefined; tx.oncomplete(); }); return r; } });
          return tx;
        },
      };
      requete.onsuccess();
    });
    return requete;
  },
};

function bibliotheque() {
  const stockage = {};
  const chrome = { storage: { local: {
    get: async (cle) => ({ [cle]: stockage[cle] }),
    set: async (o) => { Object.assign(stockage, o); },
    remove: async (cle) => { delete stockage[cle]; },
  } } };
  const fetchExtension = (url, options = {}) => fetch(url, { ...options, headers: { ...(options.headers || {}), Origin: ORIGINE } });
  const context = vm.createContext({ console, DOMException, indexedDB: indexedDBVide, chrome, fetch: fetchExtension, Blob, File, URLSearchParams, setTimeout });
  const source = ['fiches.js', 'kappgen-distant.js', 'dossier.js'].map((f) => readFileSync(join(root, 'extension/lib', f), 'utf8')).join('\n');
  vm.runInContext(`${source}\nthis.KappDossier = KappDossier; this.KappDistant = KappDistant;`, context);
  return context;
}

async function preparer() {
  let dossier = process.env.KAPPGEN_TEST_DOSSIER;
  let port = Number(process.env.KAPPGEN_TEST_PORT || 0);
  const marque = process.env.KAPPGEN_TEST_MARQUE || 'essai';
  let serveur = null;
  if (!dossier) {
    dossier = mkdtempSync(join(tmpdir(), 'kg-distant-'));
    serveur = fauxKappgen(dossier);
    await new Promise((ok) => serveur.listen(0, '127.0.0.1', ok));
    port = serveur.address().port;
  }
  const rendu = join(dossier, 'contenus', '2026-11-14_031_essai', '06-rendu');
  mkdirSync(rendu, { recursive: true });
  writeFileSync(join(rendu, 'essai.mp4'), Buffer.alloc(6 * 1024 * 1024, 7));
  writeFileSync(join(rendu, 'publication.md'), '## Titre\nVidéo d’essai\n\n## Description\nUne description.');
  return { dossier, port, marque, rendu, fermer: () => serveur && serveur.close() };
}

test('une marque prêtée par KappGen se lit, se publie et garde son suivi sans dossier choisi', async (t) => {
  const p = await preparer();
  t.after(p.fermer);
  const { KappDossier, KappDistant } = bibliotheque();
  assert.equal((await KappDossier.access()).state, 'none');                       // rien de choisi
  await KappDistant.choisir({ id: p.marque, nom: 'Essai', dossier: 'ESSAI', nomDossier: 'ESSAI', port: p.port });
  const acces = await KappDossier.access();
  assert.equal(acces.state, 'granted');
  assert.equal(acces.distant, true);

  const file = await KappDossier.scan({ watchSince: 0, now: Date.now() + 3600e3 });
  const video = file.videos.find((v) => v.relative_path.endsWith('/essai.mp4'));
  assert.ok(video, JSON.stringify(file.videos.map((v) => v.relative_path)));
  assert.equal(video.title, 'Vidéo d’essai');

  const fichier = await KappDossier.fileAt(video.relative_path);                  // le vrai fichier, pour YouTube Studio
  assert.equal(fichier.size, 6 * 1024 * 1024);
  assert.equal(fichier.name, 'essai.mp4');

  await KappDossier.mark(video.relative_path, 'published', { youtubeId: 'abcdefghijk' });
  const suivi = JSON.parse(readFileSync(join(p.rendu, '.kappgen.json'), 'utf8'));
  assert.equal(suivi['essai.mp4'].status, 'published');
  assert.equal(suivi['essai.mp4'].youtubeId, 'abcdefghijk');

  await KappDossier.exportState({ etat: 'ok' });                                   // pont avec KappGen : à la racine de la marque
  assert.equal(JSON.parse(readFileSync(join(p.dossier, '.kappgen-extension.json'), 'utf8')).etat, 'ok');

  const apres = await KappDossier.scan({ watchSince: 0, now: Date.now() + 3600e3 });
  assert.ok(apres.sent.some((v) => v.relative_path.endsWith('/essai.mp4')));        // relu depuis KappGen : déjà publiée
  assert.ok(!apres.videos.some((v) => v.relative_path.endsWith('/essai.mp4')));
  assert.equal(apres.folder, 'ESSAI');
});

test('KappGen fermé : la marque reste choisie mais n’est pas accessible, sans planter', async () => {
  const { KappDossier, KappDistant } = bibliotheque();
  await KappDistant.choisir({ id: 'essai', nom: 'Essai', dossier: 'ESSAI', nomDossier: 'ESSAI', port: 1 });
  const acces = await KappDossier.access();
  assert.equal(acces.state, 'denied');
  assert.equal(acces.distant, true);
  await assert.rejects(KappDossier.scan({ watchSince: 0 }), /Accès au dossier/);
});
