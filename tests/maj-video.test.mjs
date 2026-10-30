import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const maj = require('../extension/lib/maj-video.js');
const fond = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const panneau = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');

const video = { youtube_id: 'abcdefghijk', title: 'Titre', description: 'Desc', tags: ['a'], thumbnail_path: 'C/E/miniature.jpg' };

test('mettre à jour un seul champ n’applique que ce champ (Roosevelt, 19/10)', () => {
  assert.deepEqual({ ...maj.champsAMettreAJour(['thumbnail'], video) }, { thumbnail: true, title: false, description: false, tags: false, tout: false });
  assert.deepEqual({ ...maj.champsAMettreAJour(['title'], video) }, { thumbnail: false, title: true, description: false, tags: false, tout: false });
  assert.deepEqual({ ...maj.champsAMettreAJour(['description'], video) }, { thumbnail: false, title: false, description: true, tags: false, tout: false });
  const tout = maj.champsAMettreAJour(null, video);
  assert.equal(tout.tout && tout.thumbnail && tout.title && tout.description && tout.tags, true);
});

test('un champ absent du dossier est dit clairement, sans ouvrir Studio pour rien', () => {
  assert.match(maj.champsAMettreAJour(['thumbnail'], { ...video, thumbnail_path: null }).erreur, /Aucune miniature/);
  assert.match(maj.champsAMettreAJour(['thumbnail'], { ...video, thumbnail_path: null, preview_path: 'x.png', thumbnail_warning: '2 Mo' }).erreur, /plus de 2 Mo/);
  assert.match(maj.champsAMettreAJour(['title'], { ...video, title: null }).erreur, /Aucun titre/);
  assert.match(maj.champsAMettreAJour(['description'], { ...video, description: '' }).erreur, /Aucune description/);
  assert.match(maj.champsAMettreAJour(null, {}).erreur, /Aucune fiche ni miniature/);
  assert.match(maj.champsAMettreAJour(['inconnu'], video).erreur, /inconnu/);
});

test('vidéo partie sans miniature : à compléter si elle en a (ou devait en avoir) une', () => {
  assert.equal(maj.miniatureAComplete({ thumbnailPath: 'm.jpg', envoyee: true }), false);
  assert.equal(maj.miniatureAComplete({ thumbnailPath: 'm.jpg', envoyee: false }), true);   // champ Miniature absent, fichier illisible
  assert.equal(maj.miniatureAComplete({ previewPath: 'm.png', envoyee: false }), true);     // plus de 2 Mo
  assert.equal(maj.miniatureAComplete({ kind: 'kappgen', envoyee: false }), true);          // envoi manuel avant la miniature
  assert.equal(maj.miniatureAComplete({ kind: 'vrac', envoyee: false }), false);            // vidéo sans miniature prévue
});

test('la miniature en attente est réessayée seule : 3 fois, à 20 min d’écart', () => {
  const now = 10 * 3600e3;
  const v = { youtube_id: 'abcdefghijk', thumb_pending: true, thumbnail_path: 'm.jpg', thumb_tries: 0, applied_at: now };
  assert.equal(maj.miniatureARetenter(v, now), true);
  assert.equal(maj.miniatureARetenter({ ...v, thumb_tries: 1, applied_at: now - 5 * 60000 }, now), false);
  assert.equal(maj.miniatureARetenter({ ...v, thumb_tries: 1, applied_at: now - 21 * 60000 }, now), true);
  assert.equal(maj.miniatureARetenter({ ...v, thumb_tries: 3, applied_at: 0 }, now), false);
  assert.equal(maj.miniatureARetenter({ ...v, thumbnail_path: null }, now), false);       // pas encore de miniature lisible
  assert.equal(maj.miniatureARetenter({ ...v, thumb_pending: false }, now), false);
});

test('« Frame with ID 0 was removed » est reconnu comme une page rechargée, et jamais montré en anglais', () => {
  assert.equal(maj.pageRechargee('Frame with ID 0 was removed.'), true);
  assert.equal(maj.pageRechargee(new Error('Frame with ID 12 was removed.')), true);
  assert.equal(maj.pageRechargee('Frame with ID 0 is showing error page'), false);       // connexion : autre message
  assert.match(maj.MESSAGE_PAGE_RECHARGEE, /YouTube Studio a rechargé la page pendant la mise à jour : réessaie/);
  // step() réinjecte studio.js et réessaie (essais bornés) ; updateVideo traduit l'erreur
  const etape = fond.slice(fond.indexOf('async function step('), fond.indexOf('function friendly('));
  assert.match(etape, /KappMajVideo\.pageRechargee\(error\)/);
  assert.match(etape, /STEP_RELOAD_TRIES/);
  const maj2 = fond.slice(fond.indexOf('async function updateVideo('), fond.indexOf('// Publish only the detected Facebook derivative.'));
  assert.match(maj2, /MESSAGE_PAGE_RECHARGEE/);
  assert.match(maj2, /'saveEdit', \{\}, 'studio\.js', \{ relance: false \}/);
});

test('le menu ⋮ de « Déjà publiés » propose chaque champ, tout, et le lien YouTube, sans fenêtre native', () => {
  const menu = panneau.slice(panneau.indexOf('function updateEntries('), panneau.indexOf('function shortItem('));
  for (const libelle of ['Mettre à jour la miniature', 'Mettre à jour le titre', 'Mettre à jour la description', 'Tout mettre à jour', 'Indiquer le lien YouTube']) {
    assert.ok(menu.includes(libelle), libelle);
  }
  assert.match(menu, /champs: \['thumbnail'\]|run\(\['thumbnail'\]/);
  const nouveau = menu.slice(0, menu.indexOf('function sentItem('));
  assert.doesNotMatch(nouveau, /\b(confirm|alert|prompt)\(/);
});

test('l’envoi marque la miniature à compléter au lieu d’un simple avertissement', () => {
  const bloc = fond.slice(fond.indexOf("step(tabId, 'waitForThumbnailPicker')"), fond.indexOf('const early = await earlyLink'));
  assert.match(bloc, /KappMajVideo\.miniatureAComplete/);
  assert.match(bloc, /thumbPending: true/);
  assert.match(fond, /status: 'started', data: \{ owner \}/);
});

// Roosevelt, 30/10 : Dharma Vivant 013 et 016 en ligne avec une image de la vidéo, alors que l'envoi passait pour réussi.
test('miniature contrôlée sur YouTube : quand comparer', () => {
  const now = 100 * 86400000;
  const base = { youtube_id: 'abcdefghijk', thumbnail_path: 'C/E/miniature.png', thumb_sig: 'miniature.png|10|1', published_at: now - 3600000 };
  assert.equal(maj.miniatureAVerifier(base, now), true);
  assert.equal(maj.miniatureAVerifier({ ...base, thumb_ok_sig: base.thumb_sig }, now), false, 'déjà vue sur YouTube');
  assert.equal(maj.miniatureAVerifier({ ...base, thumb_ok_sig: 'miniature.png|11|2' }, now), true, 'fichier changé : on recontrôle');
  assert.equal(maj.miniatureAVerifier({ ...base, published_at: now - 60000 }, now), false, 'YouTube n’a pas encore traité');
  assert.equal(maj.miniatureAVerifier({ ...base, applied_at: now - 60000 }, now), false, 'réappliquée il y a une minute');
  assert.equal(maj.miniatureAVerifier({ ...base, thumb_checked_at: now - 60000 }, now), false, 'contrôlée il y a une minute');
  assert.equal(maj.miniatureAVerifier({ ...base, thumb_pending: true }, now), false, 'déjà en attente de réapplication');
  assert.equal(maj.miniatureAVerifier({ ...base, youtube_draft: true }, now), false);
  assert.equal(maj.miniatureAVerifier({ ...base, thumb_misses: maj.VERIF_MAX }, now), false, 'abandon après 3 essais');
  assert.equal(maj.miniatureAVerifier({ ...base, published_at: now - 40 * 86400000 }, now), false, 'vieille vidéo jamais touchée');
  assert.equal(maj.miniatureAVerifier({ ...base, thumbnail_path: null }, now), false);
});

test('miniature contrôlée sur YouTube : même image ou pas', () => {
  const image = Array.from({ length: 256 }, (_, i) => (i * 37) % 255);
  const proche = image.map((g, i) => g + (i % 5) - 2);
  const autre = Array.from({ length: 256 }, (_, i) => (i * 91 + 40) % 255);
  const a = maj.empreinte(image);
  assert.equal(maj.miniatureDifferente(maj.ecartEmpreintes(a, maj.empreinte(image))), false);
  assert.equal(maj.miniatureDifferente(maj.ecartEmpreintes(a, maj.empreinte(proche))), false);
  assert.equal(maj.miniatureDifferente(maj.ecartEmpreintes(a, maj.empreinte(autre))), true);
  assert.equal(maj.miniatureDifferente(null), false, 'rien de comparable : pas de réapplication');
});

test('le passage automatique contrôle la miniature sans ouvrir Studio', () => {
  assert.match(fond, /KappMajVideo\.miniatureAVerifier\(v, Date\.now\(\)\)/);
  const bloc = fond.slice(fond.indexOf('async function verifyThumb'), fond.indexOf('// "Chrome connecté"'));
  assert.match(bloc, /folder\('thumbCheck'/);
  assert.match(bloc, /status: 'thumbCheck'/);
  assert.doesNotMatch(bloc, /studio\.js|chrome\.tabs|injectScripts/);
});
