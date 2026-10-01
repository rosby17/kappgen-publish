// Injected into Facebook by background.js.  It uses the existing
// Facebook session in this Chrome profile; no password or cookie is read by
// the extension.  Meta changes Business Suite markup often, so every action
// has a clear timeout and leaves the tab open for manual completion.
(() => {
  if (window.__kappgen) return;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const visible = (node) => !!node && node.getClientRects().length > 0 && !node.closest('[hidden]');
  const textOf = (node) => (node.textContent || '').replace(/\s+/g, ' ').trim();
  // What a button says: its visible text, or its accessible name (icons).
  const labelsOf = (node) => [textOf(node), (node.getAttribute('aria-label') || '').trim()].filter(Boolean);
  const enabled = (node) => node.getAttribute('aria-disabled') !== 'true' && !node.disabled;
  const click = (node) => { node.scrollIntoView({ block: 'center' }); node.click(); };
  const waitFor = async (finder, timeout = 30000, what = 'élément') => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const result = finder();
      if (result) return result;
      await sleep(500);
    }
    // Says which buttons were on screen, so the next version can match them.
    const seen = [...new Set([...document.querySelectorAll(buttons)].filter(visible)
      .map((node) => labelsOf(node).sort((a, b) => a.length - b.length)[0]).filter((label) => label && label.length < 40))].slice(0, 25);
    throw new Error(`Facebook : ${what} introuvable. Termine l’action dans l’onglet Facebook resté ouvert. Boutons vus : ${seen.join(' | ') || 'aucun'}`);
  };
  const buttons = 'button, [role="button"], a[role="button"]';
  const byText = (pattern, { needEnabled = false } = {}) => [...document.querySelectorAll(buttons)]
    .find((node) => visible(node) && (!needEnabled || enabled(node)) && labelsOf(node).some((label) => pattern.test(label)));

  // kind "image": the photo input of the post composer is usually hidden,
  // so any file input accepting images is used.
  async function receiveFile({ src, path, kind }) {
    const pick = () => {
      const inputs = [...document.querySelectorAll('input[type="file"]')];
      if (kind === 'image') return inputs.filter((i) => /image|\*/.test(i.accept || '*')).pop();
      if (kind === 'video') return inputs.filter((i) => /video|\*/.test(i.accept || '*')).pop();
      return inputs.find(visible);
    };
    const input = await waitFor(pick, 60000, kind === 'image' ? 'l’ajout de photo' : 'le sélecteur de fichier du Reel');
    const file = await new Promise((resolve, reject) => {
      const frame = document.createElement('iframe');
      frame.style.display = 'none';
      const done = (fn, value) => { clearTimeout(timer); window.removeEventListener('message', onMessage); frame.remove(); fn(value); };
      const timer = setTimeout(() => done(reject, new Error('Le fichier vertical ne répond pas (accès au dossier à autoriser ?).')), 60000);
      function onMessage(event) {
        const data = event.data;
        if (event.source !== frame.contentWindow || !data || data.kappgen !== 'file' || data.path !== path) return;
        if (data.error) done(reject, new Error(data.error)); else done(resolve, data.file);
      }
      window.addEventListener('message', onMessage);
      frame.src = src;
      document.documentElement.append(frame);
    });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { name: file.name, size: file.size };
  }

  async function openReel() {
    const create = await waitFor(() => byText(/create\s+(a\s+)?reel|cr[eé]er\s+(un\s+)?r[eé]el|nouveau\s+r[eé]el/i)
      || byText(/^r[eé]els?$/i), 45000, 'le bouton Créer un Reel');
    click(create);
    await sleep(1200);
    // Some Business Suite versions first open a generic composer.
    const reel = byText(/reel|r[eé]el/i);
    if (reel && !document.querySelector('input[type="file"]')) click(reel);
    await waitFor(() => [...document.querySelectorAll('input[type="file"]')].some(visible), 60000, 'le sélecteur de fichier');
    return true;
  }

  async function fillCaption({ caption }) {
    if (!caption) return true;
    const field = await waitFor(() => [...document.querySelectorAll('[role="dialog"] [contenteditable="true"], textarea, [contenteditable="true"]')].find(visible), 30000, 'le champ de texte');
    field.focus();
    if (field.isContentEditable) {
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, caption);
    } else {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(field, caption);
    }
    field.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  async function publish() {
    // The Reel composer has one or two "Next" screens before "Publish".
    for (let i = 0; i < 3; i += 1) {
      const next = byText(/^(next|suivant)$/i, { needEnabled: true });
      if (!next || byText(/^(publish|publier|share|partager|post)$/i, { needEnabled: true })) break;
      click(next);
      await sleep(2500);
    }
    const button = await waitFor(() => byText(/^(publish|publier|share now|share|partager maintenant|partager|publier maintenant|post)$/i, { needEnabled: true }), 120000, 'le bouton Publier');
    click(button);
    await sleep(3000);
    return true;
  }

  // Opens the "Create post" composer of the Page (text, with or without photo).
  async function openPost({ photo }) {
    const create = await waitFor(
      () => byText(/^(create post|cr[eé]er une publication|cr[eé]er un post|nouvelle publication)$/i)
        || [...document.querySelectorAll('[role="button"]')].find((n) => visible(n) && /what'?s on your mind|que voulez-vous dire|exprimez-vous|[àa] quoi pensez-vous/i.test(textOf(n))),
      45000, 'le bouton Créer une publication');
    click(create);
    await waitFor(() => [...document.querySelectorAll('[role="dialog"] [contenteditable="true"], [contenteditable="true"][role="textbox"]')].find(visible), 30000, 'la fenêtre de publication');
    if (photo) {
      const add = byText(/^(photo\/vid[eé]o|photo\/video|photo|ajouter des photos|add photos)/i)
        || [...document.querySelectorAll('[aria-label]')].find((n) => visible(n) && /photo/i.test(n.getAttribute('aria-label')));
      if (add) { click(add); await sleep(1200); }
    }
    return true;
  }

  // Posts the composer: "Next" first when Facebook shows it, then "Post".
  async function sendPost() {
    const next = byText(/^(next|suivant)$/i);
    if (next) { click(next); await sleep(2000); }
    const button = await waitFor(() => byText(/^(post|publier|publish|share now|share|partager maintenant|partager|publier maintenant)$/i, { needEnabled: true }), 10 * 60000, 'le bouton Publier');
    click(button);
    await waitFor(() => !byText(/^(post|publier|publish)$/i), 5 * 60000, 'la fin de la publication');
    await sleep(2000);
    return true;
  }

  window.__kappgen = { openReel, openPost, receiveFile, fillCaption, publish, sendPost };
})();
