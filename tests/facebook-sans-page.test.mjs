import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// ownOf et networkOn sont extraits de background.js tels quels (le service worker ne s'importe pas).
const fond = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const bout = (debut, fin) => { const i = fond.indexOf(debut); const j = fond.indexOf(fin, i); assert.ok(i >= 0 && j > i, debut); return fond.slice(i, j + fin.length); };
const source = `${bout('const DEFAULT_ON', '};')}\n${bout('function ownOf(', '\n  return own;\n}')}\nthis.ownOf = ownOf;`;
const contexte = vm.createContext({});
vm.runInContext(source, contexte);
const { ownOf } = contexte;

const video = { channel_key: './dharma-vivant', channel_config: {} };

test('chaîne sans page Facebook : Facebook est ignoré après YouTube, sans erreur (Dharma Vivant, 05/11)', () => {
  assert.equal(ownOf({ channels: {} }, video).facebook, false);
  assert.equal(ownOf({ channels: {}, facebookFromYoutube: true }, { ...video, channel_config: { facebook: true } }).facebook, false);
});

test('avec une page (panneau ou dossier de la chaîne), Facebook reste actif', () => {
  assert.equal(ownOf({ channels: {}, facebookPageUrl: 'https://www.facebook.com/dharmavivant' }, video).facebook, true);
  const own = ownOf({ channels: {} }, { ...video, channel_config: { facebook: true, facebookPageUrl: 'https://www.facebook.com/dharmavivant' } });
  assert.equal(own.facebook, true);
  assert.equal(own.facebookPageUrl, 'https://www.facebook.com/dharmavivant');
});

test('les choix existants gagnent toujours : publier « non » ou réseau Facebook décoché', () => {
  const page = 'https://www.facebook.com/dharmavivant';
  assert.equal(ownOf({ channels: {}, facebookPageUrl: page }, { ...video, channel_config: { facebook: false } }).facebook, false);
  assert.equal(ownOf({ channels: {}, facebookPageUrl: page, networks: { facebook: false } }, video).facebook, false);
});
