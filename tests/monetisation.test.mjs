import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const m = require('../extension/lib/monetisation.js');

test('la file de mise en ligne n’est jamais un choix (échec Ballon Viral du 14/10)', () => {
  assert.equal(m.isUploadRow('bv-23-lens-sporting-0-2.mp4 Mise en ligne effectuée à 1 %'), true);
  assert.equal(m.matches('bv-23-lens-sporting-0-2.mp4 Mise en ligne effectuée à 1 %', 'on'), false);
  assert.equal(m.matches('Activée 2 %', 'on'), false);
});

test('Activée / Désactivée, sous leurs différentes formes', () => {
  for (const t of ['Activée', 'Activé', 'Activer', 'On', 'Activée Diffuser des annonces sur cette vidéo', 'Activado']) assert.equal(m.matches(t, 'on'), true, t);
  for (const t of ['Désactivée', 'Desactivée', 'Désactiver', 'Off', 'Désactivée Aucune annonce']) assert.equal(m.matches(t, 'off'), true, t);
  assert.equal(m.matches('Désactivée', 'on'), false);
  assert.equal(m.matches('Activée', 'off'), false);
  assert.equal(m.matches('Sélectionner', 'on'), false);
  assert.equal(m.matches('Ongoing', 'on'), false);
});

test('la recette du serveur reste prioritaire', () => {
  assert.equal(m.matches('Monétiser', 'on', /^Monétiser$/), true);
  assert.equal(m.matches('x'.repeat(201), 'on', /x/), false);
});
