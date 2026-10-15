// Injected into Pinterest's pin builder (www.pinterest.com/pin-creation-tool/) after lib/page-kit.js. Uses the Pinterest
// session already open in this Chrome profile; no password or cookie is read. Pinterest changes its pages often: every
// step has a timeout and leaves the tab open for manual completion.
// ATTENTION : les sélecteurs et libellés ci-dessous viennent de la recette du serveur (recipe.pinterest) et n'ont PAS été
// vérifiés sur un vrai compte Pinterest. À valider avant la mise en ligne.
(() => {
  const VERSION = chrome.runtime.getManifest().version;
  if (window.__kappgenPinterest && window.__kappgenPinterest.version === VERSION) return;
  const K = window.KappKit;
  const N = 'Pinterest';
  const S = (key) => window.KappRecipe.sel('pinterest', key);
  const X = (key) => window.KappRecipe.re('pinterest', key);
  const titleField = () => [...document.querySelectorAll(S('title'))].find(K.visible);

  // The image or video of the chosen folder (the builder's file field).
  async function sendMedia({ src, path }) {
    K.keepQuiet(true);
    const input = await K.waitFor(() => document.querySelector(S('fileInput')), 60000, 'le champ d’envoi de l’épingle', N);
    return K.giveFile(input, { src, path });
  }

  // Title and description of the pin. The link and the board are left to Pinterest's defaults.
  async function writePin({ title, description }) {
    K.keepQuiet(true);
    const field = await K.waitFor(titleField, 60000, 'le champ « titre » de l’épingle', N);
    if (title && !(await K.writeText(field, title))) {
      throw new Error('Pinterest : le titre n’a pas pu être écrit. Termine l’action dans l’onglet Pinterest resté ouvert.');
    }
    const text = [...document.querySelectorAll(S('description'))].find(K.visible);
    if (text && description && !(await K.writeText(text, description))) {
      throw new Error('Pinterest : la description n’a pas pu être écrite. Termine l’action dans l’onglet Pinterest resté ouvert.');
    }
    return true;
  }

  // « Enregistrer » / « Publier » once the media is fully sent, then waits for Pinterest to confirm.
  async function send({ timeout = 10 * 60000 } = {}) {
    K.keepQuiet(true);
    const button = () => {
      const b = K.findButton(X('publish'), { needEnabled: true });
      return b && !K.uploading() ? b : null;
    };
    const go = await K.waitFor(button, timeout, 'le bouton « Publier » actif (envoi de l’image pas fini ?)', N);
    K.silence();
    K.click(go);
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      await K.sleep(1000);
      if (X('posted').test(K.textOf(document.body))) break;
      if (X('refused').test(K.textOf(document.body))) break;
      if (!titleField()) break;               // le constructeur s’est fermé : épingle partie
    }
    const refused = (K.textOf(document.body).match(X('refused')) || [])[0];
    if (refused) {
      throw new Error(`Pinterest a refusé l’épingle : ${refused}. Vérifie le format (vertical, 2:3 ou 9:16) et le titre.`);
    }
    const stillThere = titleField();
    if (stillThere && K.textOf(stillThere) && button()) {
      throw new Error(`Pinterest : l’épingle ne s’est pas publiée. Termine l’action dans l’onglet Pinterest resté ouvert. Boutons vus : ${K.seenButtons().join(' | ')}`);
    }
    K.keepQuiet(false);
    return true;
  }

  window.__kappgenPinterest = { version: VERSION, sendMedia, writePin, send };
})();
