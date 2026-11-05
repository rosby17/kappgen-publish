import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const fa = require('../extension/lib/file-attente.js');
const bg = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const panel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const dossier = readFileSync(new URL('../extension/lib/dossier.js', import.meta.url), 'utf8');

test('plusieurs vidéos lancées à la suite entrent dans la file, dans l’ordre, une seule fois chacune', () => {
  let r = fa.ajouter([], { source: 'folder', videoId: 'a.mp4', visibility: 'PUBLIC' }, 1);
  assert.equal(r.position, 1);
  r = fa.ajouter(r.file, { source: 'folder', videoId: 'b.mp4' }, 2);
  assert.equal(r.position, 2);
  r = fa.ajouter(r.file, { source: 'folder', videoId: 'a.mp4' }, 3);
  assert.equal(r.position, 1, 'un deuxième clic ne la remet pas en file');
  assert.equal(r.file.length, 2);
  const { item, file } = fa.prendre(r.file);
  assert.equal(item.videoId, 'a.mp4');
  assert.equal(item.visibility, 'PUBLIC');
  assert.deepEqual(file.map((x) => x.videoId), ['b.mp4']);
  assert.equal(fa.position(file, 'folder', 'b.mp4'), 1);
  assert.deepEqual(fa.retirer(file, 'folder', 'b.mp4'), []);
  assert.equal(fa.prendre([]).item, null);
  assert.equal(fa.prendre(undefined).item, null);
});

test('la file a une limite', () => {
  let file = [];
  for (let i = 0; i < fa.MAX_FILE; i += 1) file = fa.ajouter(file, { source: 'folder', videoId: `v${i}` }).file;
  assert.equal(fa.ajouter(file, { source: 'folder', videoId: 'trop' }).position, 0);
});

test('un passage par accounts.google.com n’est pas pris pour une déconnexion avant 20 s', () => {
  assert.equal(fa.etatConnexion('https://studio.youtube.com/channel/UC/videos/upload', null, 0), 'ok');
  assert.equal(fa.etatConnexion('https://accounts.google.com/ServiceLogin?passive=true', null, 1000), 'attendre');
  assert.equal(fa.etatConnexion('https://accounts.google.com/ServiceLogin', 1000, 1000 + 19000), 'attendre');
  assert.equal(fa.etatConnexion('https://accounts.google.com/v3/signin/identifier', 1000, 1000 + 20000), 'sans-acces');
});

test('un profil sans accès à Studio arrête ses envois YouTube automatiques 6 h', () => {
  const now = 10 * 3600000;
  assert.equal(fa.youtubeEnPause(null, now), false);
  assert.equal(fa.youtubeEnPause({ at: now - 3600000 }, now), true);
  assert.equal(fa.youtubeEnPause({ at: now - 6 * 3600000 }, now), false);
  assert.equal(fa.youtubeEnPause({ at: 'x' }, now), false);
});

test('« Publier » pendant un envoi met la vidéo en file au lieu de la refuser', () => {
  const handler = bg.slice(bg.indexOf('    publish: async () => {'), bg.indexOf('    unqueue: async () => {'));
  assert.ok(handler.includes('KappFileAttente.ajouter'), 'la vidéo entre dans la file');
  assert.ok(!handler.includes("throw new Error('Un envoi est déjà en cours.')"), 'plus de refus « déjà en cours »');
  assert.ok(bg.includes("importScripts('lib/file-attente.js')"));
  assert.ok(/async function autoPass\(\) \{\n[^]*?fileAttenteSuivante\(\)/.test(bg), 'la file passe en premier');
  assert.ok(/patch\.running === false\) \{\n\s+const \{ fileAttente \}/.test(bg), 'la fin d’un envoi lance la suivante');
  assert.ok(panel.includes("go.dataset.publish = 'file'"), 'le bouton reste cliquable pendant un envoi');
  assert.ok(panel.includes('data.queued'));
});

test('un profil sans accès ne note plus la vidéo en échec : il la rend aux autres profils', () => {
  const fin = bg.slice(bg.indexOf('async function publish(source, videoId'), bg.indexOf('// Link of the video being uploaded'));
  assert.ok(fin.includes("status: 'release'"), 'marque « en cours » retirée');
  assert.ok(fin.includes('youtubeSansAcces'), 'pause YouTube du profil');
  assert.ok(bg.includes('throw sansAccesYoutube(PAS_CONNECTE_YOUTUBE)'));
  assert.ok(!/startsWith\('https:\/\/accounts\.google\.com'\)\) \{?\s*throw/.test(bg), 'plus d’échec immédiat sur accounts.google.com');
  assert.ok(/!youtubeBloque && networkOn\(settings, 'youtube'\)/.test(bg), 'envois automatiques arrêtés');
  assert.ok(dossier.includes("status === 'release'"));
  assert.ok(panel.includes("autoStatus.state === 'noaccess'"));
});
