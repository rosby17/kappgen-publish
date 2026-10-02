// Injected into X (x.com/compose/post) after lib/page-kit.js. Uses the X
// session already open in this Chrome profile; no password or cookie is read.
// X changes its pages often: every step has a timeout and leaves the tab open
// for manual completion.
(() => {
  const VERSION = chrome.runtime.getManifest().version;
  if (window.__kappgenX && window.__kappgenX.version === VERSION) return;
  const K = window.KappKit;
  const N = 'X';
  const S = (key) => window.KappRecipe.sel('x', key);
  const X = (key) => window.KappRecipe.re('x', key);
  const box = () => [...document.querySelectorAll(S('textBox'))].find(K.visible);

  // The post's text (X counts 280 characters for a normal account).
  async function writePost({ text }) {
    const field = await K.waitFor(box, 45000, 'la zone pour écrire le post', N);
    if (text && !(await K.writeText(field, text))) {
      throw new Error('X : le texte n’a pas pu être écrit. Termine l’action dans l’onglet X resté ouvert.');
    }
    return true;
  }

  // A photo or a video of the chosen folder, into the post.
  async function addMedia({ src, path }) {
    K.keepQuiet(true);
    const input = await K.waitFor(() => document.querySelector(S('mediaInput'))
      || [...document.querySelectorAll(K.S('fileInput'))].pop(), 30000, 'l’ajout de photo ou vidéo', N);
    return K.giveFile(input, { src, path });
  }

  // « Poster » once the media is fully sent, then waits for the post to go.
  async function send({ timeout = 15 * 60000 } = {}) {
    K.keepQuiet(true);
    const button = () => {
      const b = document.querySelector(S('postButton'))
        || K.findButton(X('post'));
      return b && K.visible(b) && b.getAttribute('aria-disabled') !== 'true' && !b.disabled && !K.uploading() ? b : null;
    };
    const go = await K.waitFor(button, timeout, 'le bouton « Poster » actif (envoi de la vidéo pas fini ?)', N);
    K.silence();
    K.click(go);
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      await K.sleep(1000);
      // Done: the writing box is gone (compose window closed) or emptied.
      const field = box();
      if (!field || !K.textOf(field)) break;
    }
    const field = box();
    if (field && K.textOf(field) && button()) {
      throw new Error(`X : le post ne s’est pas envoyé. Termine l’action dans l’onglet X resté ouvert. Boutons vus : ${K.seenButtons().join(' | ')}`);
    }
    K.keepQuiet(false);
    return true;
  }

  window.__kappgenX = { version: VERSION, writePost, addMedia, send };
})();
