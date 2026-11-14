import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Roosevelt (14/11) : après une déconnexion du site ou un rafraîchissement, il fallait reconnecter l'extension, avec
// « Could not establish connection. Receiving end does not exist ». L'extension a maintenant son propre jeton par appareil,
// et le panneau réessaie quand le service de l'extension se réveille.
const fond = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const panneau = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const extraire = (source, debut) => {
  const i = source.indexOf(debut);
  assert.ok(i >= 0, `${debut} introuvable`);
  return source.slice(i, source.indexOf('\n}\n', i) + 2);
};
const ligne = (source, debut) => source.slice(source.indexOf(debut), source.indexOf('\n', source.indexOf(debut)));
const envoi = () => [ligne(panneau, 'const SERVICE_ENDORMI'), extraire(panneau, 'function sendOnce('), extraire(panneau, 'async function send(')].join('\n');

test('service endormi : le panneau réessaie au lieu d\'afficher une erreur de connexion', { timeout: 5000 }, async () => {
  let appels = 0;
  const chrome = { runtime: { lastError: null, sendMessage: (_m, rappel) => {
    appels += 1;
    if (appels < 3) { chrome.runtime.lastError = { message: 'Could not establish connection. Receiving end does not exist.' }; rappel(undefined); chrome.runtime.lastError = null; return; }
    rappel({ ok: true, data: { email: 'a@b.c' } });
  } } };
  const send = new Function('chrome', `${envoi()}; return send;`)(chrome);
  assert.deepEqual(await send({ type: 'account' }), { ok: true, data: { email: 'a@b.c' } });
  assert.equal(appels, 3);
});

function fondAvec(reponses) {
  const memoire = {};
  const appels = [];
  const chrome = { storage: { local: {
    get: async (k) => ({ [k]: memoire[k] }),
    set: async (o) => Object.assign(memoire, o),
    remove: async (k) => { for (const c of [].concat(k)) delete memoire[c]; },
  } } };
  const api = async (chemin, options = {}) => {
    appels.push([chemin, memoire.kgAppareil || '']);
    const r = reponses(chemin, memoire.kgAppareil || '', options);
    if (r instanceof Error) throw r;
    return r;
  };
  const localGet = (k) => chrome.storage.local.get(k);
  const code = [ligne(fond, 'const CLE_JETON'), extraire(fond, 'async function jetonAppareil('), extraire(fond, 'async function compteConnecte(')].join('\n');
  const compteConnecte = new Function('chrome', 'api', 'localGet', `${code}; return compteConnecte;`)(chrome, api, localGet);
  return { memoire, appels, compteConnecte };
}
const refus = () => Object.assign(new Error('Connecte-toi'), { status: 401 });

test('connecté sur le site : l\'extension prend son propre jeton, une fois', async () => {
  const f = fondAvec((chemin) => (chemin === '/auth/appareil' ? { ok: true, jeton: 'J1' } : { email: 'a@b.c' }));
  assert.deepEqual(await f.compteConnecte(), { email: 'a@b.c' });
  assert.equal(f.memoire.kgAppareil, 'J1');
  await f.compteConnecte();
  assert.equal(f.appels.filter(([c]) => c === '/auth/appareil').length, 1);
});

test('déconnecté du site, l\'extension reste connectée grâce à son jeton', async () => {
  const f = fondAvec((_c, jeton) => (jeton === 'J1' ? { email: 'a@b.c' } : refus()));
  f.memoire.kgAppareil = 'J1';
  assert.deepEqual(await f.compteConnecte(), { email: 'a@b.c' });
});

test('jeton révoqué (mot de passe changé) : effacé, puis la session du site prend le relais', async () => {
  const f = fondAvec((chemin, jeton) => (chemin === '/auth/appareil' ? { jeton: 'J2' } : jeton === 'VIEUX' ? refus() : { email: 'a@b.c' }));
  f.memoire.kgAppareil = 'VIEUX';
  assert.deepEqual(await f.compteConnecte(), { email: 'a@b.c' });
  assert.equal(f.memoire.kgAppareil, 'J2');
});

test('ni jeton ni site : écran de connexion', async () => {
  const f = fondAvec(() => refus());
  assert.equal(await f.compteConnecte(), null);
});

test('la connexion par e-mail demande un jeton d\'appareil et la déconnexion l\'efface', () => {
  assert.match(fond, /appareil: true/);
  assert.match(fond, /'X-KappGen-Appareil': jeton/);
  assert.match(extraire(fond, 'function commandes('), /remove\(\['publishAccess', 'pendingOrder', CLE_JETON\]\)/);
});
