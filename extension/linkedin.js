// Injected into LinkedIn (www.linkedin.com/feed) after lib/page-kit.js. Uses
// the LinkedIn session already open in this Chrome profile; no password or
// cookie is read. LinkedIn changes its pages often: every step has a timeout
// and leaves the tab open for manual completion.
(() => {
  const VERSION = chrome.runtime.getManifest().version;
  if (window.__kappgenLinkedin && window.__kappgenLinkedin.version === VERSION) return;
  const K = window.KappKit;
  const N = 'LinkedIn';
  const S = (key) => window.KappRecipe.sel('linkedin', key);
  const X = (key) => window.KappRecipe.re('linkedin', key);
  const box = () => [...document.querySelectorAll(S('textBox'))].find(K.visible);

  // The « Commencer un post » window (opened by the address, or by its button).
  async function openComposer() {
    K.keepQuiet(true);
    const until = Date.now() + 8000;
    while (Date.now() < until && !box()) await K.sleep(500);
    if (!box()) {
      const start = await K.waitFor(() => K.findButton(X('start')), 45000, 'le bouton « Commencer un post »', N);
      K.click(start);
    }
    await K.waitFor(box, 45000, 'la zone pour écrire le post', N);
    return true;
  }

  async function writePost({ text }) {
    const field = await K.waitFor(box, 45000, 'la zone pour écrire le post', N);
    if (text && !(await K.writeText(field, text))) {
      throw new Error('LinkedIn : le texte n’a pas pu être écrit. Termine l’action dans l’onglet LinkedIn resté ouvert.');
    }
    return true;
  }

  // A photo or a video of the chosen folder. Its file field shows once
  // « Ajouter un média » is clicked (no window of the computer opens: the
  // click does not come from a person), then « Suivant » in the media editor.
  async function addMedia({ src, path }) {
    K.keepQuiet(true);
    const field = () => [...document.querySelectorAll(S('fileInput'))].pop();
    if (!field()) {
      const media = await K.waitFor(() => K.findButton(X('media')), 30000, 'le bouton « Ajouter un média »', N);
      K.click(media);
    }
    const input = await K.waitFor(field, 30000, 'l’ajout de photo ou vidéo', N);
    const info = await K.giveFile(input, { src, path });
    await K.sleep(3000);
    // The editor's « Suivant » / « Terminé », once the file is in.
    const next = await K.waitFor(() => (box() && !K.findButton(X('next'), { needEnabled: true }) && !K.uploading()
      ? 'back' : K.findButton(X('next'), { needEnabled: true })), 10 * 60000, 'le bouton « Suivant » après le média', N);
    if (next !== 'back') { K.click(next); await K.sleep(2000); }
    return info;
  }

  // « Publier » once the media is fully sent, then waits for the window to close.
  async function send({ timeout = 15 * 60000 } = {}) {
    K.keepQuiet(true);
    const button = () => {
      const b = K.findButton(X('post'), { needEnabled: true });
      return b && !K.uploading() ? b : null;
    };
    const go = await K.waitFor(button, timeout, 'le bouton « Publier » actif (envoi du média pas fini ?)', N);
    K.silence();
    K.click(go);
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      await K.sleep(1000);
      const field = box();
      if (!field || !K.textOf(field)) break;
    }
    const field = box();
    if (field && K.textOf(field) && button()) {
      throw new Error(`LinkedIn : le post ne s’est pas envoyé. Termine l’action dans l’onglet LinkedIn resté ouvert. Boutons vus : ${K.seenButtons().join(' | ')}`);
    }
    K.keepQuiet(false);
    return true;
  }

  window.__kappgenLinkedin = { version: VERSION, openComposer, writePost, addMedia, send };
})();
