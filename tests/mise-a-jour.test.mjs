import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const maj = require('../extension/lib/mise-a-jour.js');
const now = Date.UTC(2026, 9, 13, 12);

test('aucune publication en cours : la nouvelle version s’installe tout de suite', () => {
  assert.equal(maj.canReload({ job: null, pending: null, now }).ok, true);
  assert.equal(maj.canReload({ job: { running: false, updatedAt: now }, pending: null, now }).ok, true);
});

test('jamais pendant un envoi : publication en cours ou envoi YouTube à reprendre', () => {
  assert.equal(maj.canReload({ job: { running: true, updatedAt: now - 60e3 }, pending: null, now }).ok, false);
  assert.equal(maj.canReload({ job: null, pending: { stage: 'saved' }, now }).ok, false);
});

test('une publication bloquée depuis plus de 3 h n’empêche plus la mise à jour', () => {
  assert.equal(maj.canReload({ job: { running: true, updatedAt: now - maj.STALE_JOB_MS - 1 }, pending: null, now }).ok, true);
  assert.equal(maj.canReload({ job: { running: true, startedAt: now - maj.STALE_JOB_MS + 60e3 }, pending: null, now }).ok, false);
});

test('panneau : version téléchargée en attente, puis « mise à jour » pendant 24 h', () => {
  assert.equal(maj.label({ current: '1.21.18', waiting: { version: '1.21.19' }, now }).state, 'waiting');
  assert.equal(maj.label({ current: '1.21.18', waiting: { version: '1.21.19' }, now }).text, 'v1.21.18 → v1.21.19');
  assert.equal(maj.label({ current: '1.21.18', waiting: { version: '1.21.18' }, now }).state, 'ok');
  assert.equal(maj.label({ current: '1.21.18', justUpdated: { version: '1.21.18', at: now - 3600e3 }, now }).state, 'updated');
  assert.equal(maj.label({ current: '1.21.18', justUpdated: { version: '1.21.18', at: now - 25 * 3600e3 }, now }).state, 'ok');
  assert.equal(maj.label({ current: '1.21.18', now }).text, 'v1.21.18');
});

test('vérification au Chrome Web Store toutes les 3 h', () => {
  assert.equal(maj.CHECK_MINUTES, 180);
});
