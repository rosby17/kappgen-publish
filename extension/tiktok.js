// Injected into TikTok Studio (www.tiktok.com/tiktokstudio/upload) after
// lib/page-kit.js. Uses the TikTok session already open in this Chrome
// profile; no password or cookie is read. TikTok changes its pages often:
// every step has a timeout and leaves the tab open for manual completion.
(() => {
  const VERSION = chrome.runtime.getManifest().version;
  if (window.__kappgenTikTok && window.__kappgenTikTok.version === VERSION) return;
  const K = window.KappKit;
  const N = 'TikTok';
  const X = (key) => window.KappRecipe.re('tiktok', key);

  // The video goes into the upload page's file field.
  async function sendVideo({ src, path }) {
    K.keepQuiet(true);
    const input = await K.waitFor(() => [...document.querySelectorAll(K.S('fileInput'))]
      .find((i) => K.X('acceptVideo').test(i.accept || '*')), 60000, 'le champ d’envoi de la vidéo', N);
    return K.giveFile(input, { src, path });
  }

  // Waits for the upload to reach 100 %, then writes the caption.
  async function writeCaption({ caption, timeout = 15 * 60000 }) {
    K.keepQuiet(true);
    const field = await K.waitFor(() => [...document.querySelectorAll(K.S('editable'))].find(K.visible),
      timeout, 'le champ de description', N);
    await K.waitFor(() => !K.uploading() && field, timeout, 'la fin de l’envoi de la vidéo (100 %)', N);
    await K.sleep(1500);
    if (caption && !(await K.writeText(field, caption))) {
      throw new Error('TikTok : la description n’a pas pu être écrite. Termine l’action dans l’onglet TikTok resté ouvert.');
    }
    return true;
  }

  // « Publier », then the confirmation TikTok sometimes asks (content check).
  async function post({ timeout = 15 * 60000 } = {}) {
    K.keepQuiet(true);
    const publish = X('publish');
    const button = await K.waitFor(() => !K.uploading() && K.findButton(publish, { needEnabled: true }), timeout, 'le bouton Publier actif', N);
    K.silence();
    K.click(button);
    await K.sleep(2500);
    const confirm = X('confirm');
    const deadline = Date.now() + 2 * 60000;
    while (Date.now() < deadline) {
      const top = K.dialogs().pop();
      const again = top && K.byText(confirm, { needEnabled: true, root: top });
      if (again) { K.click(again); await K.sleep(2500); continue; }
      // Done: TikTok leaves the upload page or shows its « posted » notice.
      if (!X('uploadPath').test(location.pathname) || X('posted').test(K.textOf(document.body))) break;
      await K.sleep(1000);
    }
    // Still on the form with its « Publier » button: the post did not go out.
    if (X('uploadPath').test(location.pathname) && K.findButton(publish, { needEnabled: true })) {
      throw new Error(`TikTok : la publication ne s’est pas lancée. Termine l’action dans l’onglet TikTok resté ouvert. Boutons vus : ${K.seenButtons().join(' | ')}`);
    }
    K.keepQuiet(false);
    return true;
  }

  window.__kappgenTikTok = { version: VERSION, sendVideo, writeCaption, post };
})();
