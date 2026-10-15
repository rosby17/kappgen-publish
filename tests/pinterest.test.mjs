import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const p = require('../extension/lib/pinterest.js');

test('le titre est la première ligne, coupée proprement à 100 caractères', () => {
  const { title } = p.pinTexts('  Ma première ligne  \nSuite du texte');
  assert.equal(title, 'Ma première ligne');
  const long = `${'mot '.repeat(40)}fin`;
  const cutTitle = p.pinTexts(long).title;
  assert.ok(cutTitle.length <= p.TITLE_MAX, `titre trop long : ${cutTitle.length}`);
  assert.ok(cutTitle.endsWith('…'));
  assert.doesNotMatch(cutTitle, / …$/);
});

test('la description garde le texte entier, sans dépasser 500 caractères', () => {
  const text = 'Une phrase.\n\nUne autre phrase.';
  assert.equal(p.pinTexts(text).description, 'Une phrase. Une autre phrase.');
  const description = p.pinTexts('x '.repeat(400)).description;
  assert.ok(description.length <= p.DESCRIPTION_MAX);
});

test('texte vide : titre et description vides, sans erreur', () => {
  assert.deepEqual(p.pinTexts(''), { title: '', description: '' });
  assert.deepEqual(p.pinTexts(null), { title: '', description: '' });
});

test('2:3 et 9:16 sont verticaux ; carré et paysage ne le sont pas', () => {
  assert.equal(p.formatOf(1000, 1500), '2:3');
  assert.equal(p.formatOf(1080, 1920), '9:16');
  assert.equal(p.formatOf(1080, 1350), null, '4:5 n’est pas un format Pinterest accepté ici');
  assert.equal(p.formatOf(1080, 1080), null);
  assert.equal(p.formatOf(1920, 1080), null);
  assert.equal(p.formatOf(0, 1920), null);
  assert.equal(p.formatOf(undefined, undefined), null);
});

test('une légère différence d’encodage reste acceptée', () => {
  assert.equal(p.formatOf(1078, 1920), '9:16');
  assert.equal(p.formatOf(1002, 1500), '2:3');
});

test('checkFormat : refuse un fichier horizontal avec ses dimensions, laisse passer les dimensions inconnues', () => {
  const ok = p.checkFormat(1080, 1920);
  assert.equal(ok.ok, true);
  assert.equal(ok.format, '9:16');
  const bad = p.checkFormat(1920, 1080);
  assert.equal(bad.ok, false);
  assert.match(bad.message, /2:3 ou 9:16/);
  assert.match(bad.message, /1920 × 1080 px/);
  assert.equal(p.checkFormat(null, null).ok, true);
});

test('les origines demandées restent celles de Pinterest', () => {
  assert.deepEqual(p.ORIGINS, ['https://www.pinterest.com/*']);
  assert.match(p.CREATION_URL, /^https:\/\/www\.pinterest\.com\//);
});
