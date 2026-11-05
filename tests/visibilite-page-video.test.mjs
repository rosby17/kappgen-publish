import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Régression (Dharma Vivant, 02/11 et 05/11) : la fenêtre d'envoi s'est fermée, l'extension a fini la vidéo depuis sa page
// (studio.youtube.com/video/<id>/edit) et n'y a pas trouvé le réglage Visibilité : Studio le range maintenant dans une carte
// de la colonne de droite, sans l'élément ytcp-video-metadata-visibility de la recette. La vidéo était déjà « Non répertoriée ».
const studio = readFileSync(new URL('../extension/studio.js', import.meta.url), 'utf8');

class Texte {
  constructor(valeur) { this.nodeValue = valeur; this.parentElement = null; }
  get textContent() { return this.nodeValue; }
}

class Element {
  constructor(tag, attributs = {}, enfants = []) {
    this.tagName = tag.toUpperCase();
    this.id = attributs.id || '';
    this.attributs = attributs;
    this.parentElement = null;
    this.childNodes = enfants.map((e) => (typeof e === 'string' ? new Texte(e) : e));
    for (const e of this.childNodes) e.parentElement = this;
  }
  get textContent() { return this.childNodes.map((e) => e.textContent).join(' '); }
  get innerText() { return this.textContent; }
  getAttribute(nom) { return this.attributs[nom] ?? null; }
  hasAttribute(nom) { return nom in this.attributs; }
  getClientRects() { return [1]; }
  scrollIntoView() {}
  click() { journal.push(this.textContent.trim() || this.attributs['aria-label'] || this.tagName); if (this.auClic) this.auClic(); }
  matches(liste) {
    return liste.split(',').map((s) => s.trim()).some((s) => {
      if (/\s/.test(s)) return false;                                // les sélecteurs composés de la recette : absents de la nouvelle page
      const role = /^\[role="([^"]+)"\]$/.exec(s);
      if (role) return this.attributs.role === role[1];
      if (s.startsWith('#')) return this.id === s.slice(1);
      if (s === '[hidden]') return 'hidden' in this.attributs;
      if (s.startsWith('[')) return false;
      return this.tagName === s.toUpperCase();
    });
  }
  closest(liste) {
    for (let el = this; el; el = el.parentElement) if (el.matches(liste)) return el;
    return null;
  }
  *descendants() {
    for (const e of this.childNodes) if (e instanceof Element) { yield e; yield* e.descendants(); }
  }
  *textes() {
    for (const e of this.childNodes) if (e instanceof Element) yield* e.textes(); else yield e;
  }
  querySelectorAll(liste) { return [...this.descendants()].filter((e) => e.matches(liste)); }
  querySelector(liste) { return this.querySelectorAll(liste)[0] || null; }
}

let journal = [];
const el = (tag, attributs, ...enfants) => new Element(tag, attributs, enfants);

function pageVideo(corps) {
  journal = [];
  let horloge = 0;
  const FausseDate = class extends Date {};
  FausseDate.now = () => (horloge += 1000);
  const body = el('body', {}, corps);
  const document = {
    hidden: false, body, documentElement: { lang: 'fr' }, location: { pathname: '/video/5cSaVyu0Uu4/edit' },
    querySelector: (s) => body.querySelector(s), querySelectorAll: (s) => body.querySelectorAll(s), getElementById: () => null,
    createTreeWalker: (racine) => { const it = racine.textes(); return { nextNode: () => it.next().value || null }; },
    execCommand: () => {},
  };
  const recette = {
    visibilityTrigger: 'ytcp-video-metadata-visibility #select-button, ytcp-video-metadata-visibility ytcp-dropdown-trigger',
    visibilityRadio: 'tp-yt-paper-radio-button[name="{name}"]',
    buttons: 'ytcp-button, button, tp-yt-paper-button, [role="button"]',
    saveEditButtons: 'ytcp-button#save, #save, ytcp-button, button',
    dialog: 'ytcp-uploads-dialog',
  };
  const motifs = { done: /^(Done|OK|Termin[ée]|Valider|Enregistrer|Save)$/i, save: /^(Save|Enregistrer)$/i };
  const window = { KappRecipe: { sel: (r, cle) => recette[cle], re: (r, cle) => motifs[cle] || /x/ } };
  const contexte = { window, document, location: document.location, navigator: { language: 'fr' }, Date: FausseDate, NodeFilter: { SHOW_TEXT: 4 },
    setTimeout: (f) => setImmediate(f), chrome: { runtime: { getManifest: () => ({ version: 'essai' }) } }, MouseEvent: class {}, Event: class {}, console };
  vm.runInNewContext(studio, contexte);
  return window.__kappgen;
}

// La carte telle que Studio l'affiche le 05/11 : titre, état, chevron.
const carte = (etat) => el('div', { class: 'carte' }, el('span', {}, 'Visibilité'), el('span', {}, etat), el('div', { role: 'button', 'aria-label': 'chevron' }));

test('vidéo déjà dans la visibilité voulue : rien à cliquer, rien à enregistrer', async () => {
  const page = pageVideo(el('main', {}, el('h1', {}, 'Détails de la vidéo'), carte('Non répertoriée'), el('button', {}, 'Enregistrer')));
  const resultat = await page.setVisibilityOnEdit({ visibility: 'UNLISTED' });
  assert.deepEqual({ ...resultat }, { deja: true });
  assert.deepEqual(journal, []);
});

test('autre visibilité : la carte trouvée par son titre est ouverte, le choix fait, puis Enregistrer', async () => {
  const page = pageVideo(el('main', {},
    carte('Privée'),
    el('div', { role: 'radio' }, 'Non répertoriée'),
    el('button', {}, 'Terminé'),
    el('button', {}, 'Enregistrer')));
  assert.equal(await page.setVisibilityOnEdit({ visibility: 'UNLISTED' }), true);
  assert.deepEqual(journal, ['chevron', 'Non répertoriée', 'Terminé', 'Enregistrer']);
});

test('« Programmée … publique » n’est pas « Publique » : la vidéo est bien rendue publique', async () => {
  const page = pageVideo(el('main', {},
    carte('Programmée : sera publique le 8 nov.'),
    el('div', { role: 'radio' }, 'Publique'),
    el('button', {}, 'Terminé'),
    el('button', {}, 'Enregistrer')));
  assert.equal(await page.setVisibilityOnEdit({ visibility: 'PUBLIC' }), true);
  assert.deepEqual(journal, ['chevron', 'Publique', 'Terminé', 'Enregistrer']);
});

test('carte introuvable : le message dit ce qui était sur la page', async () => {
  const page = pageVideo(el('main', {}, el('h1', {}, 'Petit problème… Une erreur s’est produite.')));
  await assert.rejects(page.setVisibilityOnEdit({ visibility: 'UNLISTED' }),
    (e) => /Visibilité de la page de la vidéo introuvable/.test(e.message) && /Vu sur la page : \/video\/5cSaVyu0Uu4\/edit \| aucun titre « Visibilité »/.test(e.message));
});
