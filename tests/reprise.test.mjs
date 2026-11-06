import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const rp = require('../extension/lib/reprise.js');
const studio = readFileSync(new URL('../extension/studio.js', import.meta.url), 'utf8');
const bg = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const nomPourStudio = new Function(`${studio.slice(studio.indexOf('function nomPourStudio'), studio.indexOf('if (typeof module'))}; return nomPourStudio;`)();

// Vidéos telles que les rend la lecture du dossier (Ballon Viral, 06/11).
const VIDEOS = [
  { title: 'Jesús de Miguel, 30 ans : le DRAME qui bouleverse le football',
    relative_path: 'SPORT/BALLON-VIRAL/contenus/2026-11-03_038_jesus-de-miguel-tenerife/06-rendu/bv-38-jesus-de-miguel-tenerife.mp4',
    vertical_path: 'SPORT/BALLON-VIRAL/contenus/2026-11-03_038_jesus-de-miguel-tenerife/06-rendu/short.mp4' },
  { title: 'Villarreal - PSG : avant-match',
    relative_path: 'SPORT/BALLON-VIRAL/contenus/2026-11-03_037_villarreal-psg-avant-match/06-rendu/bv-37-villarreal-psg.mp4',
    vertical_path: 'SPORT/BALLON-VIRAL/contenus/2026-11-03_037_villarreal-psg-avant-match/06-rendu/short.mp4' },
];

test('le nom demandé par Studio est lu dans la ligne « Mise en ligne interrompue » (texte de la capture du 06/11)', () => {
  const ligne = 'Jesús de Miguel, 30 ans : le DRAME q… Mise en ligne interrompue Cliquez sur "Reprendre la mise en ligne", puis sélectionnez 2026-11-03_038_jesus-de-miguel-tenerife.mp4 pour continuer Reprendre l\'importation Supprimer la vidéo';
  assert.equal(rp.nomDemande(ligne), '2026-11-03_038_jesus-de-miguel-tenerife.mp4');
  assert.equal(rp.nomDemande('Upload interrupted. Click "Resume upload", then select my clip.mp4 to continue'), 'my clip.mp4');
  assert.equal(rp.nomDemande('Mise en ligne interrompue'), null);
});

test('le fichier est retrouvé dans le dossier même si son nom diffère de celui demandé (vidéo et Short)', () => {
  const v = rp.cheminPour('2026-11-03_038_jesus-de-miguel-tenerife.mp4', VIDEOS);
  assert.equal(v.path, VIDEOS[0].relative_path);
  assert.equal(v.short, false);
  assert.equal(v.title, VIDEOS[0].title);
  const s = rp.cheminPour('2026-11-03_037_villarreal-psg-avant-match-short.mp4', VIDEOS);
  assert.equal(s.path, VIDEOS[1].vertical_path);
  assert.equal(s.short, true);
  assert.equal(rp.cheminPour('2026-11-04_040_inconnue.mp4', VIDEOS), null);
  assert.equal(rp.cheminPour('', VIDEOS), null);
});

test('chaque nom donné à Studio à l’envoi (nomPourStudio) ramène bien au même fichier', () => {
  for (const v of VIDEOS) {
    for (const chemin of [v.relative_path, v.vertical_path]) {
      const nom = nomPourStudio(chemin, chemin.split('/').pop()) || chemin.split('/').pop();
      assert.equal(rp.cheminPour(nom, VIDEOS).path, chemin, nom);
    }
  }
});

test('un fichier envoyé sans être renommé est retrouvé par son vrai nom', () => {
  const autres = [{ relative_path: 'PERSO/clips/mon-clip.mp4' }];
  assert.equal(rp.cheminPour('mon-clip.mp4', autres).path, 'PERSO/clips/mon-clip.mp4');
});

test('pendant une reprise, le sélecteur de fichier de Studio est gardé au lieu d’ouvrir la fenêtre du Mac', () => {
  const source = bg.slice(bg.indexOf('function relaisReprise'), bg.indexOf('async function reprendreInterrompues'));
  const attrs = new Map();
  const documentElement = { hasAttribute: (k) => attrs.has(k) };
  const body = { enfants: [], append(x) { this.enfants.push(x); x.isConnected = true; } };
  let ouvertures = 0;
  class HTMLInputElement {
    constructor(type) { this.type = type; this.isConnected = false; this.style = {}; this.a = {}; }
    setAttribute(k, v) { this.a[k] = v; }
    click() { ouvertures += 1; }
  }
  const window = {};
  new Function('window', 'document', 'HTMLInputElement', `${source}; relaisReprise(); relaisReprise();`)(window, { documentElement, body }, HTMLInputElement);
  const hors = new HTMLInputElement('file');
  hors.click();
  assert.equal(ouvertures, 1, 'hors reprise, Studio ouvre la fenêtre comme d’habitude');
  attrs.set('data-kappgen-reprise-attendue', '1');
  const pendant = new HTMLInputElement('file');
  pendant.click();
  assert.equal(ouvertures, 1, 'pendant une reprise, aucune fenêtre du Mac');
  assert.equal(pendant.a['data-kappgen-reprise'], '1');
  assert.equal(body.enfants[0], pendant, 'le sélecteur détaché est rangé dans la page pour recevoir le fichier');
  new HTMLInputElement('text').click();
  assert.equal(ouvertures, 2, 'les autres champs ne sont pas touchés');
});

test('le panneau a le bouton de reprise et le background sait reprendre', () => {
  const html = readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
  const panel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  assert.match(html, /id="resume-interrupted"/);
  assert.match(panel, /type: 'resumeInterrupted'/);
  assert.match(bg, /resumeInterrupted: async \(\) =>/);
  assert.match(bg, /'lib\/monetisation\.js', 'lib\/reprise\.js'/);
  assert.match(studio, /async reprendre\(\{ nom, src, path \}\)/);
});
