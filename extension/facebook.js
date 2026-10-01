// Injected into Facebook by background.js.  It uses the existing
// Facebook session in this Chrome profile; no password or cookie is read by
// the extension.  Meta changes Business Suite markup often, so every action
// has a clear timeout and leaves the tab open for manual completion.
(() => {
  if (window.__kappgen) return;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const visible = (node) => !!node && node.getClientRects().length > 0 && !node.closest('[hidden]');
  const textOf = (node) => (node.textContent || '').replace(/\s+/g, ' ').trim();
  const click = (node) => { node.scrollIntoView({ block: 'center' }); node.click(); };
  const waitFor = async (finder, timeout = 30000, what = 'élément') => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const result = finder();
      if (result) return result;
      await sleep(500);
    }
    throw new Error(`Facebook : ${what} introuvable. Termine l’action dans l’onglet Facebook resté ouvert.`);
  };
  const buttons = 'button, [role="button"], a[role="button"]';
  const byText = (pattern) => [...document.querySelectorAll(buttons)].find((node) => visible(node) && pattern.test(textOf(node)));

  async function receiveFile({ src, path }) {
    const input = await waitFor(() => [...document.querySelectorAll('input[type="file"]')].find(visible), 60000, 'le sélecteur de fichier du Reel');
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
    const create = await waitFor(() => byText(/create\s+(a\s+)?reel|cr[eé]er\s+(un\s+)?r[eé]el|nouveau\s+r[eé]el/i), 45000, 'le bouton Créer un Reel');
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
    const field = await waitFor(() => [...document.querySelectorAll('textarea, [contenteditable="true"]')].find(visible), 30000, 'le champ de description');
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
    const button = await waitFor(() => byText(/publish|publier|share now|partager maintenant|publier maintenant/i), 60000, 'le bouton Publier');
    click(button);
    await sleep(3000);
    return true;
  }

  window.__kappgen = { openReel, receiveFile, fillCaption, publish };
})();
