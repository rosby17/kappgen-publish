import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Régression (allon-viral, 04/11) : la vidéo avait déjà son lien, puis la fenêtre d'envoi de Studio a disparu (onglet sur
// Données analytiques). L'extension cherchait « Visibilité » pendant 3 minutes, puis laissait le brouillon à finir à la main.
const studio = readFileSync(new URL('../extension/studio.js', import.meta.url), 'utf8');
const fond = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');

function pageStudioSansFenetre() {
  let horloge = 0;
  const FausseDate = class extends Date {};
  FausseDate.now = () => (horloge += 1000); // chaque lecture de l'heure avance d'une seconde
  const document = {
    hidden: false, documentElement: { lang: 'fr' }, location: { pathname: '/channel/UC/analytics/tab-overview/period-default' },
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, body: { innerText: 'Données analytiques de la chaîne', querySelectorAll: () => [] },
  };
  const window = { KappRecipe: { sel: () => 'x', re: () => /x/ } };
  const contexte = { window, document, location: document.location, navigator: { language: 'fr' }, Date: FausseDate,
    setTimeout: (f) => setImmediate(f), chrome: { runtime: { getManifest: () => ({ version: 'essai' }) } }, MouseEvent: class {}, console };
  vm.runInNewContext(studio, contexte);
  return window.__kappgen;
}

test('sans fenêtre d’envoi, Visibilité rend la main en signalant la fenêtre perdue (pas 3 minutes de recherche)', async () => {
  const page = pageStudioSansFenetre();
  const resultat = await page.chooseVisibility({ visibility: 'PUBLIC', monetization: 'on' });
  assert.equal(resultat.fenetrePerdue, true);
  assert.match(resultat.detail, /AUCUNE fenêtre d’envoi/);
});

test('le service en fait une erreur reconnaissable, rattrapée quand la vidéo a déjà son lien', async () => {
  const debut = fond.indexOf('async function chooseVisibilityStep(');
  const corps = fond.slice(debut, fond.indexOf('\n}\n', debut) + 2);
  const etape = new Function('step', 'setJob', 'chrome', 'PERSON_WHAT', 'PERSON_NOTICE', 'PERSON_WAIT_MS', 'sleep', 'ensureNotCancelled',
    `${corps}; return chooseVisibilityStep;`)(async () => ({ fenetrePerdue: true, detail: ' Vu dans Studio' }), async () => {},
    { notifications: { clear: () => {} }, runtime: {} }, {}, 'n', 1000, async () => {}, () => {});
  await assert.rejects(etape(1, {}), (e) => e.fenetrePerdue === true && /s’est fermée avant l’étape « Visibilité »/.test(e.message));
  // publish() : seule une fenêtre perdue AVEC lien passe au rattrapage par la page de la vidéo.
  assert.match(fond, /if \(!error\.fenetrePerdue \|\| !early\) throw error;/);
  assert.match(fond, /if \(job\.dialogLost\) \{[\s\S]{0,200}applyVisibilityFromEdit\(tabId, youtubeId, visibility, scheduleAt\)/);
});
