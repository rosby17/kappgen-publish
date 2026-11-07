import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { choisir } = require('../extension/lib/visibilite.js');
const at = (jour, h, m = 0) => new Date(2026, 10, jour, h, m, 0, 0).getTime();

test('Dharma Vivant n° 25 (05/11) : « Publier maintenant » le 04/11 garde la date de KappGen du 06/11', () => {
  // Panneau en « non répertoriée », reglages-publication.json en « programmee », programmation.json : 06/11 05:30.
  const choix = choisir({ demandee: 'UNLISTED', fichier: 'SCHEDULE', canal: 'UNLISTED', plannedAt: at(6, 5, 30), now: at(4, 18, 39) });
  assert.deepEqual(choix, { visibility: 'SCHEDULE', scheduleAt: at(6, 5, 30) });
});

test('date KappGen à venir : programmée à cette date, même pour un envoi automatique ou une chaîne en non répertoriée', () => {
  for (const demandee of ['CHANNEL', 'UNLISTED', 'PUBLIC']) {
    for (const fichier of [null, 'UNLISTED', 'PUBLIC', 'SCHEDULE']) {
      assert.deepEqual(choisir({ demandee, fichier, canal: 'UNLISTED', plannedAt: at(12, 8), now: at(5, 10) }),
        { visibility: 'SCHEDULE', scheduleAt: at(12, 8) }, `${demandee} / ${fichier}`);
    }
  }
});

test('date KappGen arrivée : publique (pas la « non répertoriée » du panneau), sauf réglage de chaîne contraire', () => {
  assert.deepEqual(choisir({ demandee: 'CHANNEL', canal: 'UNLISTED', plannedAt: at(5, 8), now: at(5, 8, 1) }), { visibility: 'PUBLIC', scheduleAt: null });
  assert.deepEqual(choisir({ demandee: 'CHANNEL', fichier: 'SCHEDULE', plannedAt: at(5, 8), now: at(5, 9) }), { visibility: 'PUBLIC', scheduleAt: null });
  assert.deepEqual(choisir({ demandee: 'CHANNEL', fichier: 'UNLISTED', plannedAt: at(5, 8), now: at(5, 9) }), { visibility: 'UNLISTED', scheduleAt: null });
  // à moins de 15 min de son heure, YouTube refuserait la programmation : elle part publique
  assert.equal(choisir({ demandee: 'CHANNEL', plannedAt: at(5, 8, 10), now: at(5, 8) }).visibility, 'PUBLIC');
  // une heure égale à 0 (1er janvier 1970) est une vraie date passée, pas une date absente
  assert.equal(choisir({ demandee: 'CHANNEL', canal: 'UNLISTED', plannedAt: 0, now: at(5, 8) }).visibility, 'PUBLIC');
});

test('« privée » l’emporte toujours', () => {
  assert.equal(choisir({ demandee: 'CHANNEL', fichier: 'PRIVATE', plannedAt: at(12, 8), now: at(5, 8) }).visibility, 'PRIVATE');
  assert.equal(choisir({ demandee: 'PRIVATE', plannedAt: at(12, 8), now: at(5, 8) }).visibility, 'PRIVATE');
});

test('sans date KappGen : heure choisie pour la vidéo, puis réglages de la chaîne, sinon publique', () => {
  assert.deepEqual(choisir({ demandee: 'CHANNEL', canal: 'UNLISTED', scheduleAt: at(7, 9), now: at(5, 9) }), { visibility: 'SCHEDULE', scheduleAt: at(7, 9) });
  assert.deepEqual(choisir({ demandee: 'CHANNEL', fichier: 'SCHEDULE', canal: 'UNLISTED', now: at(5, 9) }), { visibility: 'SCHEDULE', scheduleAt: null });
  assert.deepEqual(choisir({ demandee: 'CHANNEL', canal: 'PUBLIC', now: at(5, 9) }), { visibility: 'PUBLIC', scheduleAt: null });
  // 06/11 : plus de réglage du panneau ; sans réglage KappGen, publique (jamais « non répertoriée » par défaut).
  assert.deepEqual(choisir({ demandee: 'CHANNEL', canal: 'UNLISTED', now: at(5, 9) }), { visibility: 'PUBLIC', scheduleAt: null });
  assert.deepEqual(choisir({ demandee: 'CHANNEL', now: at(5, 9) }), { visibility: 'PUBLIC', scheduleAt: null });
  // « Publier maintenant » : le choix de la personne, sauf réglage de chaîne explicite (autre que « programmée »)
  assert.equal(choisir({ demandee: 'UNLISTED', fichier: 'PUBLIC', now: at(5, 9) }).visibility, 'PUBLIC');
  assert.equal(choisir({ demandee: 'PUBLIC', fichier: 'SCHEDULE', now: at(5, 9) }).visibility, 'PUBLIC');
  assert.equal(choisir({ demandee: 'UNLISTED', now: at(5, 9) }).visibility, 'UNLISTED');
});

test('l’envoi automatique et le bouton passent tous les deux par lib/visibilite.js', () => {
  const bg = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
  assert.match(bg, /importScripts\('lib\/visibilite\.js'\)/);
  assert.match(bg, /KappVisibilite\.choisir\(\{ demandee: visibility/);
  assert.doesNotMatch(bg, /next\.planned_at && vis === 'SCHEDULE'/);
  assert.doesNotMatch(bg, /if \(visibility === 'CHANNEL'\) visibility = fixed/);
});
