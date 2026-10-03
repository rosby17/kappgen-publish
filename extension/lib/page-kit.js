// Shared by the scripts that drive a social network's own page (TikTok,
// and the next ones): find buttons by their text or accessible name, hand
// a file of the chosen folder to the page, wait for an upload to reach
// 100 %, and keep the preview video paused and muted. Injected before the
// network's script; nothing is read from the page except what is clicked.
(() => {
  const VERSION = chrome.runtime.getManifest().version;
  if (window.KappKit && window.KappKit.version === VERSION) return;
  const S = (key) => window.KappRecipe.sel('kit', key);
  const X = (key) => window.KappRecipe.re('kit', key);
  // In a background tab Chrome slows timers down (down to one tick a minute):
  // the pause then goes through the extension's service worker, never slowed.
  const sleep = (ms) => (document.hidden
    ? chrome.runtime.sendMessage({ type: 'pageSleep', ms }).catch(() => new Promise((resolve) => setTimeout(resolve, ms)))
    : new Promise((resolve) => setTimeout(resolve, ms)));
  const visible = (node) => !!node && node.getClientRects().length > 0 && !node.closest('[hidden]');
  const textOf = (node) => (node.textContent || '').replace(/\s+/g, ' ').trim();
  const labelsOf = (node) => [textOf(node), (node.getAttribute('aria-label') || '').trim(), (node.getAttribute('data-e2e') || '').trim()].filter(Boolean);
  const enabled = (node) => node.getAttribute('aria-disabled') !== 'true' && !node.disabled && !/disabled/i.test(node.getAttribute('data-disabled') || '');
  const click = (node) => { node.scrollIntoView({ block: 'center' }); node.click(); };
  const dialogs = () => [...document.querySelectorAll(S('dialogs'))].filter(visible);
  const byText = (pattern, { needEnabled = false, root = document } = {}) => [...root.querySelectorAll(S('buttons'))]
    .find((node) => visible(node) && (!needEnabled || enabled(node)) && labelsOf(node).some((label) => pattern.test(label)));
  // The window on top first, then the page.
  const findButton = (pattern, options = {}) => {
    for (const root of [dialogs().pop(), document]) {
      if (!root) continue;
      const found = byText(pattern, { ...options, root });
      if (found) return found;
    }
    return null;
  };
  function seenButtons() {
    return [...new Set([...document.querySelectorAll(S('buttons'))].filter(visible)
      .map((node) => labelsOf(node).sort((a, b) => a.length - b.length)[0]).filter((label) => label && label.length < 40))].slice(0, 25);
  }
  const waitFor = async (finder, timeout, what, network) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const result = finder();
      if (result) return result;
      await sleep(500);
    }
    throw new Error(`${network} : ${what} introuvable. Termine l’action dans l’onglet ${network} resté ouvert. Boutons vus : ${seenButtons().join(' | ') || 'aucun'}`);
  };
  const silence = () => {
    for (const video of document.querySelectorAll(S('video'))) {
      try { video.muted = true; if (!video.paused) video.pause(); } catch { /* not ours to fail on */ }
    }
  };
  let quietTimer = null;
  const keepQuiet = (on) => {
    clearInterval(quietTimer);
    quietTimer = on ? setInterval(silence, 300) : null;
    if (on) silence();
  };
  // Text of an element without what was typed in it (a title may hold « 50 % »).
  function ownText(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => (node.parentElement && node.parentElement.closest(S('typed')) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    let text = '';
    while (walker.nextNode()) text += ` ${walker.currentNode.nodeValue}`;
    return text;
  }
  // Still sending the file? (a progress bar under 100 %, « 45 % », « Uploading… »)
  const uploading = (root = document) => {
    for (const bar of root.querySelectorAll(S('progressbar'))) {
      if (!visible(bar)) continue;
      const now = Number(bar.getAttribute('aria-valuenow'));
      const max = Number(bar.getAttribute('aria-valuemax') || 100);
      if (!Number.isFinite(now) || now < max) return true;
    }
    const text = ownText(root);
    return X('percent').test(text) || X('uploadingText').test(text);
  };
  // Hands one file of the chosen folder to the page's file field.
  async function giveFile(input, { src, path }) {
    const token = new URL(src).searchParams.get('token');
    if (!token) throw new Error('Autorisation du fichier absente.');
    const file = await new Promise((resolve, reject) => {
      const frame = document.createElement('iframe');
      frame.style.display = 'none';
      const done = (fn, value) => { clearTimeout(timer); window.removeEventListener('message', onMessage); frame.remove(); fn(value); };
      const timer = setTimeout(() => done(reject, new Error('Le fichier ne répond pas (accès au dossier à autoriser ?).')), 60000);
      function onMessage(event) {
        const data = event.data;
        if (event.source !== frame.contentWindow || !data || data.kappgen !== 'file' || data.token !== token) return;
        if (data.error) done(reject, new Error(data.error)); else done(resolve, data.file);
      }
      window.addEventListener('message', onMessage);
      frame.src = src;
      document.documentElement.append(frame);
    });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { name: file.name, size: file.size };
  }
  // Writes text in a rich editor (or a textarea) once, then checks it is there.
  async function writeText(field, text) {
    const start = text.replace(/\s+/g, ' ').trim().slice(0, 12);
    const written = () => (field.isContentEditable ? textOf(field) : field.value).includes(start);
    const settle = async () => { for (let i = 0; i < 8 && !written(); i += 1) await sleep(250); };
    field.scrollIntoView({ block: 'center' });
    field.click();
    field.focus();
    await sleep(300);
    if (field.isContentEditable) {
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      document.execCommand('insertText', false, text);
      await settle();
      if (!written()) {
        field.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        const data = new DataTransfer();
        data.setData('text/plain', text);
        field.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
        await settle();
      }
    } else {
      const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(field, text);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return written();
  }
  window.KappKit = { version: VERSION, S, X, sleep, visible, textOf, labelsOf, enabled, click, dialogs, byText, findButton, waitFor,
    silence, keepQuiet, cleanup: () => keepQuiet(false), uploading, giveFile, writeText, seenButtons };
})();
