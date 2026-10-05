// Injected into Snapchat's web uploader (profile.snapchat.com, « Post to Snapchat ») after
// lib/page-kit.js. Uses the Snapchat session already open in this Chrome
// profile; no password or cookie is read. Snapchat changes its pages often:
// every step has a timeout and leaves the tab open for manual completion.
// Official steps: « Choose video » → « Send to » : Spotlight Snaps and/or
// My Story → description and #topics → Creator Terms → « Post to Snapchat ».
(() => {
  const VERSION = chrome.runtime.getManifest().version;
  if (window.__kappgenSnapchat && window.__kappgenSnapchat.version === VERSION) return;
  const K = window.KappKit;
  const N = 'Snapchat';
  const X = (key) => window.KappRecipe.re('snapchat', key);

  // Checkbox (native or ARIA) that goes with a label: the control itself, or the one in the same row.
  function checkboxNear(node) {
    if (!node) return null;
    if (node.matches('input[type="checkbox"], [role="checkbox"], [role="switch"], [aria-checked], [aria-pressed]')) return node;
    for (let up = node, i = 0; up && i < 5; up = up.parentElement, i += 1) {
      const box = up.querySelector('input[type="checkbox"], [role="checkbox"], [role="switch"], [aria-checked], [aria-pressed]');
      if (box) return box;
    }
    return node.closest('label, [role="button"], button') || node;
  }
  const isChecked = (box) => !!box && (box.checked === true || box.getAttribute('aria-checked') === 'true'
    || box.getAttribute('aria-pressed') === 'true' || /\b(checked|selected|active)\b/i.test(box.className || '')
    || box.getAttribute('data-state') === 'checked');
  // Smallest visible element whose own text matches (labels are often plain <span>/<div>).
  function labelFor(pattern) {
    const all = [...document.querySelectorAll('label, span, div, p, button, [role="checkbox"], [role="button"]')]
      .filter((n) => K.visible(n) && pattern.test(K.textOf(n)) && K.textOf(n).length < 120);
    return all.sort((a, b) => K.textOf(a).length - K.textOf(b).length)[0] || null;
  }
  async function tick(pattern, what) {
    const label = await K.waitFor(() => labelFor(pattern), 60000, what, N);
    const box = checkboxNear(label);
    if (isChecked(box)) return true;
    K.click(box);
    await K.sleep(700);
    if (!isChecked(box) && box !== label) { K.click(label); await K.sleep(700); }
    return true;
  }

  // The video goes into the uploader's file field (« Choose video »).
  async function sendVideo({ src, path }) {
    K.keepQuiet(true);
    const input = await K.waitFor(() => [...document.querySelectorAll(K.S('fileInput'))]
      .find((i) => K.X('acceptVideo').test(i.accept || '*')), 60000, 'le champ d’envoi de la vidéo (« Choose video »)', N);
    return K.giveFile(input, { src, path });
  }

  // « Send to » : Spotlight Snaps (public discovery) and/or My Story.
  async function chooseDestination({ spotlight = true, story = false } = {}) {
    K.keepQuiet(true);
    if (spotlight) await tick(X('spotlight'), '« Spotlight » dans « Send to »');
    if (story) await tick(X('story'), '« My Story » dans « Send to »');
    return true;
  }

  // Description with its #topics (Snapchat keeps it short). Optional: some layouts have no field.
  async function writeCaption({ caption, timeout = 10 * 60000 }) {
    K.keepQuiet(true);
    await K.waitFor(() => !K.uploading() || null, timeout, 'la fin de l’envoi de la vidéo (100 %)', N).catch(() => {});
    if (!caption) return true;
    const field = [...document.querySelectorAll(`${K.S('editable')}, textarea, input[type="text"]`)].filter(K.visible)
      .find((f) => X('captionField').test(`${f.getAttribute('placeholder') || ''} ${f.getAttribute('aria-label') || ''} ${f.getAttribute('name') || ''}`))
      || [...document.querySelectorAll(`${K.S('editable')}, textarea`)].find(K.visible);
    if (!field) return true;
    if (!(await K.writeText(field, caption))) {
      throw new Error('Snapchat : la description n’a pas pu être écrite. Termine l’action dans l’onglet Snapchat resté ouvert.');
    }
    return true;
  }

  // Creator Terms (asked once per post), then « Post to Snapchat ».
  async function post({ timeout = 10 * 60000 } = {}) {
    K.keepQuiet(true);
    const terms = labelFor(X('terms'));
    if (terms) {
      const box = checkboxNear(terms);
      if (!isChecked(box)) { K.click(box); await K.sleep(700); }
    }
    const publish = X('publish');
    const button = await K.waitFor(() => !K.uploading() && K.findButton(publish, { needEnabled: true }), timeout, 'le bouton « Post to Snapchat » actif', N);
    K.silence();
    K.click(button);
    await K.sleep(3000);
    const deadline = Date.now() + 3 * 60000;
    while (Date.now() < deadline) {
      const top = K.dialogs().pop();
      const again = top && K.byText(X('confirm'), { needEnabled: true, root: top });
      if (again) { K.click(again); await K.sleep(2500); continue; }
      if (X('posted').test(K.textOf(document.body))) break;
      if (!K.findButton(publish, { needEnabled: true }) && !K.uploading()) break;     // form gone or reset
      await K.sleep(1000);
    }
    if (X('refused').test(K.textOf(document.body))) {
      throw new Error(`Snapchat a refusé la vidéo : ${(K.textOf(document.body).match(X('refused')) || [''])[0]}. Vérifie qu’elle dure de 5 à 60 secondes, en vertical.`);
    }
    if (K.findButton(publish, { needEnabled: true }) && !X('posted').test(K.textOf(document.body))) {
      throw new Error(`Snapchat : la publication ne s’est pas lancée. Termine l’action dans l’onglet Snapchat resté ouvert. Boutons vus : ${K.seenButtons().join(' | ')}`);
    }
    K.keepQuiet(false);
    return true;
  }

  window.__kappgenSnapchat = { version: VERSION, sendVideo, chooseDestination, writeCaption, post };
})();
