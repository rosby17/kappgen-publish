import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Régression (17/10) : la miniature partait sans prévenir quand Studio n'avait pas encore affiché le champ Miniature.
const fond = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const studio = readFileSync(new URL('../extension/studio.js', import.meta.url), 'utf8');

test('la publication attend le champ Miniature au lieu de le chercher une seule fois', () => {
  assert.match(studio, /async waitForThumbnailPicker\(\)/);
  assert.match(fond, /step\(tabId, 'waitForThumbnailPicker'\)/);
  assert.doesNotMatch(fond, /video\.thumbnail_path && await step\(tabId, 'hasThumbnailPicker'\)/);
});

test('une miniature non envoyée est signalée, jamais avalée', () => {
  const bloc = fond.slice(fond.indexOf("step(tabId, 'waitForThumbnailPicker')"), fond.indexOf("const early = await earlyLink"));
  assert.match(bloc, /Miniature non envoyée/);
  assert.doesNotMatch(bloc, /\.catch\(\(\) => \{\}\)/);
});
