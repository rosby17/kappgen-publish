// Injected into Facebook by background.js.  It uses the existing
// Facebook session in this Chrome profile; no password or cookie is read by
// the extension.  Meta changes Business Suite markup often, so every action
// has a clear timeout and leaves the tab open for manual completion.
(() => {
  // A reused tab may hold the script of an older version: replace it.
  const VERSION = chrome.runtime.getManifest().version;
  if (window.__kappgen && window.__kappgen.version === VERSION) return;
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
  // The open composer window (« Créer une publication », Reel…): everything
  // is looked for inside it first, never in the page behind (comment boxes).
  const composer = () => [...document.querySelectorAll('[role="dialog"]')].filter(visible)
    .filter((d) => d.querySelector('[contenteditable="true"], input[type="file"]')).pop() || null;
  const scope = () => composer() || document;
  // The window on top (« Modifier le reel » over « Créer une publication »).
  const topDialog = () => [...document.querySelectorAll('[role="dialog"]')].filter(visible).pop() || null;
  // A button is looked for in the window on top first, then the composer, then the page.
  const findButton = (pattern, options = {}) => {
    for (const root of [topDialog(), composer(), document]) {
      if (!root) continue;
      const found = byText(pattern, { ...options, root });
      if (found) return found;
    }
    return null;
  };
  // Facebook plays the video in its editor: pause it and cut the sound.
  const silence = () => {
    for (const video of document.querySelectorAll('[role="dialog"] video')) {
      try { video.muted = true; if (!video.paused) video.pause(); } catch { /* not ours to fail on */ }
    }
  };
  // Kept quiet for the whole publication, not only at the clicks: Facebook
  // starts the preview again on its own.
  let quietTimer = null;
  const keepQuiet = (on) => {
    clearInterval(quietTimer);
    quietTimer = on ? setInterval(silence, 300) : null;
    if (on) silence();
  };
  // Still sending the file to Facebook? (progress bar under 100 %, or « 45 % »).
  const uploading = () => {
    for (const root of [topDialog(), composer()].filter(Boolean)) {
      for (const bar of root.querySelectorAll('[role="progressbar"]')) {
        if (!visible(bar)) continue;
        const now = Number(bar.getAttribute('aria-valuenow'));
        const max = Number(bar.getAttribute('aria-valuemax') || 100);
        if (!Number.isFinite(now) || now < max) return true;
      }
      // The window's own text, without what was typed (a title may contain « 50 % »).
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => (node.parentElement && node.parentElement.closest('[contenteditable="true"], textarea') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      });
      let text = '';
      while (walker.nextNode()) text += ` ${walker.currentNode.nodeValue}`;
      if (/\b\d{1,2}\s?%/.test(text)) return true;
      if (/importation en cours|t[eé]l[eé]versement en cours|uploading|chargement de la vid[eé]o/i.test(text)) return true;
    }
    return false;
  };
  const byText = (pattern, { needEnabled = false, root = document } = {}) => [...root.querySelectorAll(buttons)]
    .find((node) => visible(node) && (!needEnabled || enabled(node)) && labelsOf(node).some((label) => pattern.test(label)));

  // kind "image": the photo input of the post composer is usually hidden,
  // so any file input accepting images is used.
  async function receiveFile({ src, path, kind }) {
    const pick = () => {
      const inputs = [...scope().querySelectorAll('input[type="file"]')];
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
    keepQuiet(true);
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
    const field = await waitFor(() => {
      const root = scope();
      const fields = [...root.querySelectorAll('[contenteditable="true"][role="textbox"], [contenteditable="true"], textarea')].filter(visible);
      return fields[0];
    }, 30000, 'le champ de texte de la publication');
    const start = caption.replace(/\s+/g, ' ').trim().slice(0, 12);
    const written = () => (field.isContentEditable ? textOf(field) : field.value).includes(start);
    field.scrollIntoView({ block: 'center' });
    field.click();
    field.focus();
    await sleep(300);
    const settle = async () => { for (let i = 0; i < 8 && !written(); i += 1) await sleep(250); };
    if (field.isContentEditable) {
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, caption);
      await settle();
      // Facebook's editor sometimes ignores insertText: empty it, then paste
      // (never both, or the text would appear twice).
      if (!written()) {
        field.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        const data = new DataTransfer();
        data.setData('text/plain', caption);
        field.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
        await settle();
      }
    } else {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(field, caption);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (!written()) throw new Error('Facebook : le texte n’a pas pu être écrit dans la publication. Termine l’action dans l’onglet Facebook resté ouvert.');
    return true;
  }

  async function publish({ groups = [], groupCount = 0 } = {}) {
    // The Reel composer has one or two "Next" screens before "Publish",
    // and the file must be fully sent (100 %) before each of them.
    keepQuiet(true);
    for (let i = 0; i < 3; i += 1) {
      await waitFor(() => !uploading(), 15 * 60000, 'la fin de l’envoi du Reel (100 %)');
      await sleep(1500);
      const next = findButton(/^(next|suivant)$/i, { needEnabled: true });
      if (!next || byText(/^(publish|publier|share|partager|post)$/i, { needEnabled: true })) break;
      click(next);
      await sleep(2500);
    }
    const finalButton = /^(publish|publier|share now|share|partager maintenant|partager|publier maintenant|post)$/i;
    let button = await waitFor(() => !uploading() && findButton(finalButton, { needEnabled: true }), 15 * 60000, 'le bouton Publier');
    let picked = { groups: [], extra: [] };
    if (groups.length || groupCount) {
      picked = await tickGroupsInComposer(groups, groupCount).catch(() => ({ groups: [], extra: [] }));
      button = await waitFor(() => !uploading() && findButton(finalButton, { needEnabled: true }), 60000, 'le bouton Publier');
    }
    silence();
    click(button);
    await sleep(3000);
    keepQuiet(false);
    return picked;
  }

  // Opens the "Create post" composer of the Page (text, with or without photo).
  async function openPost({ photo }) {
    keepQuiet(true);
    const create = await waitFor(
      () => byText(/^(create post|cr[eé]er une publication|cr[eé]er un post|nouvelle publication)$/i)
        || [...document.querySelectorAll('[role="button"]')].find((n) => visible(n) && /what'?s on your mind|what'?s new|write something|quoi de neuf|[ée]crivez quelque chose|que voulez-vous dire|exprimez-vous|[àa] quoi pensez-vous/i.test(textOf(n))),
      45000, 'le bouton Créer une publication');
    click(create);
    await waitFor(() => [...document.querySelectorAll('[role="dialog"] [contenteditable="true"], [contenteditable="true"][role="textbox"]')].find(visible), 30000, 'la fenêtre de publication');
    if (photo) {
      const root = composer() || document;
      const add = byText(/^(photo\/vid[eé]o|photo\/video|photo|ajouter des photos|add photos)/i, { root })
        || [...root.querySelectorAll('[aria-label]')].find((n) => visible(n) && /photo/i.test(n.getAttribute('aria-label')));
      if (add) { click(add); await sleep(1200); }
    }
    return true;
  }

  // Posts the composer: "Next" first when Facebook shows it, then "Post".
  // timeout: how long Facebook may keep the button grey (a video uploads first).
  // groups: names of groups to tick in the composer's own « share to groups »
  // option before « Publier » (Facebook takes 9 at most); returns the ticked ones.
  async function sendPost({ timeout = 90000, groups = [], groupCount = 0 } = {}) {
    const dialog = composer();
    let groupsTried = false;
    let picked = { groups: [], extra: [] };
    const final = /^(post|publier|publish|share now|share|partager maintenant|partager|publier maintenant)$/i;
    const isFinal = (node) => labelsOf(node).some((label) => final.test(label));
    // « Suivant » first when Facebook shows it (it stays grey while the text
    // or the video is not taken into account), then « Publier ».
    keepQuiet(true);
    for (let screen = 0; screen < 5; screen += 1) {
      // The file must be fully on Facebook (100 %) before « Suivant ».
      await waitFor(() => !uploading(), timeout, 'la fin de l’envoi de la vidéo (100 %)');
      await sleep(1500);
      const button = await waitFor(() => {
        silence();
        return !uploading() && (findButton(final, { needEnabled: true }) || findButton(/^(next|suivant)$/i, { needEnabled: true }));
      }, timeout, 'le bouton Suivant / Publier actif (texte ou vidéo pas encore pris en compte)');
      silence();
      let target = button;
      if (isFinal(button) && (groups.length || groupCount) && !groupsTried) {
        groupsTried = true;
        picked = await tickGroupsInComposer(groups, groupCount).catch(() => ({ groups: [], extra: [] }));
        target = await waitFor(() => findButton(final, { needEnabled: true }), timeout, 'le bouton Publier');
      }
      click(target);
      await sleep(2500);
      if (isFinal(target)) break;
    }
    // After « Publier », Facebook may show an offer (« Vous organisez un
    // évènement ? », boost…): the post itself is kept with « Publier la
    // publication d’origine » / « Pas maintenant », never the paid option.
    const skip = /publier la publication d.origine|publish original post|post original|pas maintenant|not now|plus tard|later|ignorer|skip/i;
    // Only inside a window (an offer is always one), never in the page.
    const inWindow = () => {
      const top = [...document.querySelectorAll('[role="dialog"]')].filter(visible).pop();
      return top ? byText(skip, { needEnabled: true, root: top }) : null;
    };
    const deadline = Date.now() + 5 * 60000;
    while (Date.now() < deadline) {
      const offer = inWindow();
      if (offer) { click(offer); await sleep(2000); continue; }
      if (!dialog || !document.contains(dialog) || !visible(dialog)) break;
      await sleep(1000);
    }
    if (dialog && document.contains(dialog) && visible(dialog)) {
      throw new Error('Facebook : la fenêtre de publication ne s’est pas fermée. Vérifie dans l’onglet Facebook resté ouvert.');
    }
    await sleep(2000);
    // A last offer can appear once the composer is gone.
    const late = inWindow();
    if (late) { click(late); await sleep(1500); }
    keepQuiet(false);
    return picked;
  }


  // ---------------------------------------------- sharing to several groups
  // Menus and lists of the share window are not always buttons.
  const CHOICES = 'button, [role="button"], [role="menuitem"], [role="option"], [role="listitem"], [role="radio"], a';
  const choice = (pattern, root = document) => [...root.querySelectorAll(CHOICES)]
    .find((node) => visible(node) && labelsOf(node).some((label) => pattern.test(label)));

  // On the Page: the post (found by the start of its text) → « Partager » →
  // « Groupe ». mode "multi" when the window has a box to tick per group.
  async function openShareToGroups({ snippet }) {
    const wanted = snippet.toLowerCase();
    const article = await waitFor(() => [...document.querySelectorAll('[role="article"], [aria-posinset]')]
      .filter(visible).find((a) => textOf(a).toLowerCase().includes(wanted)), 60000, 'la publication sur la Page');
    const share = choice(/^(partager|share)$/i, article)
      || [...article.querySelectorAll('[aria-label]')].find((n) => visible(n) && /^(partager|share|envoyer ceci|send this)/i.test(n.getAttribute('aria-label')));
    if (!share) throw new Error('Facebook : bouton « Partager » de la publication introuvable.');
    click(share);
    await sleep(1500);
    const toGroup = await waitFor(() => choice(/^(groupe|group|partager dans un groupe|share to a group|dans un groupe|in a group)$/i)
      || choice(/partager dans (un|des) groupes?|share (to|in) (a )?groups?/i), 15000, 'l’option « Groupe » du partage');
    click(toGroup);
    await sleep(2500);
    const dialog = topDialog();
    const boxes = dialog ? dialog.querySelectorAll('[role="checkbox"], input[type="checkbox"]').length : 0;
    return { mode: boxes > 0 ? 'multi' : 'single' };
  }

  // Ticks each group by its name (typed in the search field when there is one).
  async function pickGroups({ names }) {
    const dialog = topDialog();
    if (!dialog) throw new Error('Facebook : fenêtre de partage introuvable.');
    const search = [...dialog.querySelectorAll('input[type="search"], input[type="text"], input:not([type])')].find(visible);
    const setSearch = async (text) => {
      if (!search) return;
      search.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(search, text);
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(1500);
    };
    const picked = [];
    const missing = [];
    for (const name of names) {
      await setSearch(name);
      const lower = name.toLowerCase();
      const box = [...dialog.querySelectorAll('[role="checkbox"], input[type="checkbox"]')].find((node) => {
        const row = node.closest('[role="listitem"], [role="option"], label, li') || node.parentElement;
        return row && (textOf(row).toLowerCase().includes(lower) || (node.getAttribute('aria-label') || '').toLowerCase().includes(lower));
      });
      if (!box) { missing.push(name); continue; }
      const ticked = box.getAttribute('aria-checked') === 'true' || box.checked;
      if (!ticked) { click(box); await sleep(400); }
      picked.push(name);
    }
    await setSearch('');
    return { picked, missing };
  }

  // The window's « Publier » / « Partager » (an optional text first).
  async function confirmShare({ caption }) {
    const dialog = topDialog();
    if (caption) {
      const field = dialog && [...dialog.querySelectorAll('[contenteditable="true"], textarea')].find(visible);
      if (field) { field.focus(); document.execCommand('insertText', false, caption); await sleep(500); }
    }
    const button = await waitFor(() => findButton(/^(publier|partager|post|share|publish|partager maintenant|share now|envoyer|send)$/i, { needEnabled: true }),
      30000, 'le bouton « Publier » du partage');
    click(button);
    const start = Date.now();
    while (Date.now() - start < 60000 && dialog && document.contains(dialog) && visible(dialog)) await sleep(1000);
    return true;
  }

  // In the Page's composer (last screen, before « Publier »): the option to
  // publish in groups too, its list ticked by name, then back to the composer.
  // On the composer's last screen (after « Suivant »): « Partager dans les
  // groupes » → the groups of the creator's list found by name, completed at
  // random among the groups Facebook lists, up to `count` (9 at most).
  // Returns { groups: names ticked from the list, extra: names ticked at random }.
  async function tickGroupsInComposer(names, count = names.length) {
    const want = Math.min(9, Math.max(count || 0, names.length));
    if (!want) return { groups: [], extra: [] };
    const OPTION = /partager dans (des|un|les) groupes?|publier (aussi )?dans (des|les) groupes|share (to|in) (a )?groups?|post (to|in) groups?|^groupes?$|^groups?$/i;
    const option = choice(OPTION, topDialog() || document)
      || [...(topDialog() || document).querySelectorAll('[role="switch"], [role="checkbox"], label, [tabindex="0"]')]
        .find((n) => visible(n) && labelsOf(n).some((l) => OPTION.test(l)));
    if (!option) return { groups: [], extra: [] };
    const before = topDialog();
    click(option);
    const list = await waitFor(() => { const d = topDialog(); return d && d !== before && d.querySelector('[role="checkbox"], input[type="checkbox"]') ? d : null; }, 15000, 'la liste des groupes');
    // Long lists load while scrolling: a few turns to see more groups.
    for (let i = 0; i < 6; i += 1) {
      for (const el of list.querySelectorAll('div, ul')) if (el.scrollHeight > el.clientHeight + 40) el.scrollTop = el.scrollHeight;
      await sleep(500);
    }
    const { picked } = names.length ? await pickGroups({ names: names.slice(0, want) }) : { picked: [] };
    const extra = [];
    const boxes = () => [...list.querySelectorAll('[role="checkbox"], input[type="checkbox"]')].filter(visible);
    const ticked = (b) => b.getAttribute('aria-checked') === 'true' || b.checked;
    const nameOf = (b) => {
      const row = b.closest('[role="listitem"], [role="option"], label, li') || b.parentElement;
      return (b.getAttribute('aria-label') || (row ? textOf(row) : '') || '').trim();
    };
    const free = boxes().filter((b) => !ticked(b));
    for (let i = free.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [free[i], free[j]] = [free[j], free[i]];
    }
    for (const box of free) {
      if (boxes().filter(ticked).length >= want) break;
      click(box);
      await sleep(350);
      if (ticked(box)) extra.push(nameOf(box));
    }
    const save = await waitFor(() => findButton(/^(enregistrer|termin[ée]|ok|valider|confirmer|appliquer|save|done|apply|confirm)$/i, { needEnabled: true }), 10000, 'le bouton pour valider les groupes');
    click(save);
    await sleep(1500);
    return { groups: picked, extra };
  }

  async function closeDialogs() {
    for (let i = 0; i < 3 && topDialog(); i += 1) {
      const target = document.activeElement || document.body;
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
      await sleep(600);
    }
    return true;
  }

  window.__kappgen = { version: VERSION, openReel, openPost, receiveFile, fillCaption, publish, sendPost,
    openShareToGroups, pickGroups, confirmShare, closeDialogs, tickGroupsInComposer };
})();
