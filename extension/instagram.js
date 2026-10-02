// Injected into Instagram (www.instagram.com) after lib/page-kit.js. Uses the
// Instagram session already open in this Chrome profile; no password or
// cookie is read. Instagram changes its pages often: every step has a timeout
// and leaves the tab open for manual completion. A video posted from the web
// becomes a Reel.
(() => {
  const VERSION = chrome.runtime.getManifest().version;
  if (window.__kappgenInstagram && window.__kappgenInstagram.version === VERSION) return;
  const K = window.KappKit;
  const N = 'Instagram';
  const fileField = () => [...document.querySelectorAll('input[type="file"]')]
    .find((i) => /video|\*/.test(i.accept || '*') && i.closest('[role="dialog"]'));

  // « Créer » (left menu) then « Publication », until the upload window shows.
  async function openComposer() {
    K.keepQuiet(true);
    if (fileField()) return true;
    const create = await K.waitFor(() => {
      const icon = [...document.querySelectorAll('svg[aria-label]')]
        .find((s) => K.visible(s) && /^(nouvelle publication|new post|cr[eé]er|create)$/i.test(s.getAttribute('aria-label')));
      return (icon && icon.closest('a, [role="link"], [role="button"], button')) || K.findButton(/^(cr[eé]er|create)$/i);
    }, 60000, 'le bouton Créer', N);
    K.click(create);
    await K.sleep(1500);
    if (!fileField()) {
      const entry = [...document.querySelectorAll('a, [role="link"], [role="button"], [role="menuitem"]')]
        .find((n) => K.visible(n) && /^(publication|post)$/i.test(K.textOf(n)));
      if (entry) { K.click(entry); await K.sleep(1500); }
    }
    await K.waitFor(fileField, 30000, 'la fenêtre d’envoi', N);
    return true;
  }

  // The video goes into the upload window; Instagram may then explain that
  // video posts are shared as Reels (« OK »).
  async function sendVideo({ src, path }) {
    K.keepQuiet(true);
    const input = await K.waitFor(fileField, 60000, 'le champ d’envoi de la vidéo', N);
    const info = await K.giveFile(input, { src, path });
    await K.sleep(3000);
    const ok = K.findButton(/^ok$/i, { needEnabled: true });
    if (ok) { K.click(ok); await K.sleep(1500); }
    return info;
  }

  // « Suivant » through the crop and edit screens.
  async function next({ times = 2 } = {}) {
    for (let i = 0; i < times; i += 1) {
      const button = await K.waitFor(() => K.findButton(/^(suivant|next)$/i, { needEnabled: true }), 3 * 60000, 'le bouton Suivant', N);
      K.click(button);
      await K.sleep(2500);
    }
    return true;
  }

  async function writeCaption({ caption }) {
    K.keepQuiet(true);
    const field = await K.waitFor(() => [...document.querySelectorAll('[role="dialog"] [contenteditable="true"], [role="dialog"] textarea')]
      .find(K.visible), 60000, 'le champ de légende', N);
    if (caption && !(await K.writeText(field, caption))) {
      throw new Error('Instagram : la légende n’a pas pu être écrite. Termine l’action dans l’onglet Instagram resté ouvert.');
    }
    return true;
  }

  // « Partager », then the « shared » notice (the upload itself can take minutes).
  async function share({ timeout = 20 * 60000 } = {}) {
    K.keepQuiet(true);
    const button = await K.waitFor(() => K.findButton(/^(partager|share)$/i, { needEnabled: true }), 60000, 'le bouton Partager', N);
    K.silence();
    K.click(button);
    await K.waitFor(() => /(reel a [eé]t[eé] partag[eé]|publication a [eé]t[eé] partag[eé]|reel has been shared|post has been shared|been shared)/i
      .test(K.textOf(document.body)), timeout, 'la confirmation « partagé »', N);
    const close = K.findButton(/^(fermer|close)$/i);
    if (close) K.click(close);
    K.keepQuiet(false);
    return true;
  }

  window.__kappgenInstagram = { version: VERSION, openComposer, sendVideo, next, writeCaption, share };
})();
