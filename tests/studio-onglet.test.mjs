import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const onglet = require('../extension/lib/studio-onglet.js');

test('un onglet Studio qui envoie encore la vidéo est gardé ouvert', () => {
  assert.equal(onglet.envoiEnCours({ progress: 'Importation : 42 %' }), true);
  assert.equal(onglet.envoiEnCours({ progress: 'Uploading 7%' }), true);
  assert.equal(onglet.envoiEnCours({ body: 'Mise en ligne en cours 63 %' }), true);
  assert.equal(onglet.envoiEnCours({ stillUploading: true }), true);
});

test('un envoi terminé (traitement, vérifications) laisse fermer l’onglet', () => {
  assert.equal(onglet.envoiEnCours({ progress: 'Importation terminée 100 %' }), false);
  assert.equal(onglet.envoiEnCours({ progress: 'Traitement en cours 35 %' }), false);
  assert.equal(onglet.envoiEnCours({ progress: 'Checking 80%', stillUploading: false }), false);
  assert.equal(onglet.envoiEnCours({}), false);
});

test('la réponse de studio.js prime sur le texte de la page', () => {
  assert.equal(onglet.envoiEnCours({ stillUploading: false, body: 'Envoi : 50 %' }), false);
  assert.equal(onglet.envoiEnCours({ stillUploading: null, body: 'Envoi : 50 %' }), true);
});

test('un onglet n’est jamais gardé plus de 8 h', () => {
  assert.equal(onglet.GARDE_MAX_MS, 8 * 3600000);
});
