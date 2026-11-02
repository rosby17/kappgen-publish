import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Régression (02/11) : Chrome ouvert depuis le 31/10, la mémoire de l'extension ne répondait plus dans tous les profils.
// Le panneau attendait la réponse « compte » sans fin et restait vide, sans rien dire.
const fond = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const panneau = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const page = readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');

const extraire = (source, debut) => {
  const i = source.indexOf(debut);
  assert.ok(i >= 0, `${debut} introuvable`);
  return source.slice(i, source.indexOf('\n}\n', i) + 2);
};
const jamais = () => new Promise(() => {});

test('le panneau abandonne un service qui ne répond jamais et le dit (stuck)', { timeout: 2000 }, async () => {
  const chrome = { runtime: { sendMessage: () => {}, lastError: null } };   // aucune réponse, jamais
  const send = new Function('chrome', `${extraire(panneau, 'function send(')}; return send;`)(chrome);
  const reponse = await send({ type: 'account' }, { timeout: 30 });
  assert.equal(reponse.ok, false);
  assert.equal(reponse.stuck, true);
});

test('une réponse arrivée à temps passe telle quelle', async () => {
  const chrome = { runtime: { sendMessage: (_m, rappel) => setTimeout(() => rappel({ ok: true, data: { email: 'a@b.c' } }), 5), lastError: null } };
  const send = new Function('chrome', `${extraire(panneau, 'function send(')}; return send;`)(chrome);
  assert.deepEqual(await send({ type: 'account' }, { timeout: 200 }), { ok: true, data: { email: 'a@b.c' } });
});

test('une mémoire de l\'extension bloquée lève une erreur « stuck » au lieu d\'attendre', { timeout: 2000 }, async () => {
  const chrome = { storage: { local: { get: jamais } } };
  const constante = fond.slice(fond.indexOf('const STUCK_MESSAGE'), fond.indexOf('\n', fond.indexOf('const STUCK_MESSAGE')));
  const localGet = new Function('chrome', `${constante}\n${extraire(fond, 'async function localGet(')}; return localGet;`)(chrome);
  await assert.rejects(localGet('appUrl', 20), (erreur) => erreur.stuck === true && /quitte complètement Chrome/.test(erreur.message));
});

test('le compte passe par les délais, et la réponse garde le drapeau stuck', () => {
  assert.match(extraire(fond, 'async function appUrl('), /await localGet\('appUrl'\)/);
  assert.match(fond, /error && error\.stuck \? \{ stuck: true \}/);
  assert.match(extraire(panneau, 'async function renderAccount('), /send\(\{ type: 'account' \}, \{ timeout: \d+ \}\)/);
  assert.match(page, /id="stuck"[^>]*hidden/);
});
