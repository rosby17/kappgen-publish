// Injected into Facebook by background.js.  It uses the existing
// Facebook session in this Chrome profile; no password or cookie is read by
// the extension.  Meta changes Business Suite markup often, so every action
// has a clear timeout and leaves the tab open for manual completion.
(() => {
  // A reused tab may hold the script of an older version: replace it.
  const VERSION = chrome.runtime.getManifest().version;
  if (window.__kappgen && window.__kappgen.version === VERSION) return;
  if (!globalThis.KappFacebookFlow) throw new Error('KappGen : règles de publication Facebook indisponibles.');
  const { PUBLISH_BUTTON, GROUPS_DONE_BUTTON, SUCCESS_NOTICE, DRAFT_NOTICE, GROUP_PICKER_TITLE,
    FORBIDDEN_GROUP_CONTROL, MAX_GROUPS, groupLimit, isPromotionUrl } = globalThis.KappFacebookFlow;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const visible = (node) => !!node && node.getClientRects().length > 0 && !node.closest('[hidden]');
  const textOf = (node) => (node.textContent || '').replace(/\s+/g, ' ').trim();
  // What a button says: its visible text, or its accessible name (icons).
  const labelsOf = (node) => [textOf(node), (node.getAttribute('aria-label') || '').trim()].filter(Boolean);
  const enabled = (node) => node.getAttribute('aria-disabled') !== 'true' && !node.disabled;
  const click = (node) => {
    if (!node || typeof node.click !== 'function') throw new Error('Facebook : élément à cliquer introuvable. Termine l’action dans l’onglet Facebook resté ouvert.');
    if (node.scrollIntoView) node.scrollIntoView({ block: 'center' });
    node.click();
  };
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
      // Facebook's upload badge is a percentage ALONE in its own element
      // (« 8.8 % »). A percentage inside a sentence is the post's own words —
      // and the settings screen shows them as plain text, outside any editable
      // field, so « malgré 65% de possession » used to look like an upload
      // that never finished and blocked the publication for good.
      let uploadBadge = false;
      while (walker.nextNode()) {
        const value = walker.currentNode.nodeValue || '';
        text += ` ${value}`;
        if (/^\s*\d{1,3}([.,]\d+)?\s?%\s*$/.test(value)) uploadBadge = true;
      }
      if (uploadBadge) return true;
      if (/importation en cours|t[eé]l[eé]versement en cours|uploading|chargement de la vid[eé]o/i.test(text)) return true;
    }
    return false;
  };
  const byText = (pattern, { needEnabled = false, root = document } = {}) => [...root.querySelectorAll(buttons)]
    .find((node) => visible(node) && (!needEnabled || enabled(node)) && labelsOf(node).some((label) => pattern.test(label)));

  // A publication is successful only after Facebook confirms it.  Closing a
  // composer is not sufficient: « Enregistrer » closes it too, but creates a
  // draft.  The attempt snapshot survives a Facebook reload and lets the
  // service worker verify that a new matching item appeared in the feed.
  const snippetOf = (value) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 80).toLowerCase();
  const matchingArticles = (snippet) => !snippet ? [] : [...document.querySelectorAll('[role="article"], [aria-posinset]')]
    .filter(visible).filter((node) => textOf(node).toLowerCase().includes(snippet));
  const liveNotices = (pattern) => [...document.querySelectorAll('[role="alert"], [role="status"], [aria-live="assertive"], [aria-live="polite"]')]
    .filter(visible).map(textOf).filter((text) => text && text.length <= 500 && pattern.test(text));
  // « Booster la publication » is a PAID action, and Facebook now arrives with
  // it already switched on for some Pages: publishing then leaves the Page for
  // the ad centre. It is switched back off before every « Publier », never on.
  const BOOST_ROW = /^(booster la publication|boost post|booster|boost)$/i;
  const labelNode = (pattern, root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const value = (node.nodeValue || '').replace(/\s+/g, ' ').trim();
      if (value && pattern.test(value) && visible(node.parentElement)) return node.parentElement;
    }
    return null;
  };
  const boostControl = () => {
    for (const root of [...document.querySelectorAll('[role="dialog"]')].filter(visible)) {
      const label = labelNode(BOOST_ROW, root);
      if (!label) continue;
      // Only the toggle of that very row, a few levels up at most: never a
      // neighbouring switch (« Ajouter une mention IA »…).
      let row = label;
      for (let up = 0; up < 6 && row && row !== root; up += 1) {
        const toggle = row.querySelector('[role="switch"], input[type="checkbox"]');
        if (toggle) return { label, toggle };
        row = row.parentElement;
      }
      return { label, toggle: null };
    }
    return null;
  };
  const toggleState = (toggle) => {
    const aria = toggle && (toggle.getAttribute('aria-checked') || toggle.getAttribute('aria-pressed') || toggle.dataset.state);
    if (aria != null) return /^(true|on|checked)$/i.test(aria);
    if (toggle && typeof toggle.checked === 'boolean') return toggle.checked;
    return null;
  };
  const ensureBoostOff = async () => {
    const control = boostControl();
    if (!control) return false; // this composer does not offer paid promotion
    if (!control.toggle) throw new Error('Facebook : le réglage « Booster la publication » est illisible. Publication arrêtée pour éviter une publicité payante.');
    const state = toggleState(control.toggle);
    if (state == null) throw new Error('Facebook : état du bouton « Booster la publication » inconnu. Publication arrêtée par sécurité.');
    if (!state) return false;
    click(control.toggle);
    await waitFor(() => {
      const current = boostControl();
      return current && current.toggle && toggleState(current.toggle) === false;
    }, 10000, 'la désactivation de « Booster la publication »');
    return true;
  };
  // Really reachable by a click, i.e. nothing covering it. Facebook keeps the
  // screen you came from in the page (just moved out of sight), so "is it
  // still there?" proves nothing — but what sits under the button's own centre
  // does: it tells the settings screen apart from the group picker over it.
  const onTop = (node) => {
    const r = node.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    // Outside the viewport: not judgeable, so never a reason to block.
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return true;
    const el = document.elementFromPoint(x, y);
    if (!el) return true;
    return el === node || node.contains(el) || el.contains(node);
  };
  const publishButtonInDialog = () => {
    const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible).reverse();
    for (const root of dialogs) {
      const button = byText(PUBLISH_BUTTON, { needEnabled: true, root });
      if (button && onTop(button)) return button;
    }
    return null;
  };
  const beginPublishAttempt = (expectedText, picked = {}) => {
    const attempt = { at: Date.now(), snippet: snippetOf(expectedText),
      groups: Array.isArray(picked.groups) ? picked.groups : [], extra: Array.isArray(picked.extra) ? picked.extra : [] };
    attempt.before = matchingArticles(attempt.snippet).length;
    attempt.successBefore = liveNotices(SUCCESS_NOTICE);
    try { sessionStorage.setItem('kappgenPublishAttempt', JSON.stringify(attempt)); } catch { /* private mode */ }
    return attempt;
  };
  const savedAttempt = (expectedText) => {
    try {
      const value = JSON.parse(sessionStorage.getItem('kappgenPublishAttempt') || 'null');
      if (value && Date.now() - value.at < 30 * 60000) return value;
    } catch { /* absent or invalid */ }
    return { at: 0, snippet: snippetOf(expectedText), before: 0 };
  };
  async function verifyPublication({ expectedText = '', timeout = 90000 } = {}) {
    const attempt = savedAttempt(expectedText);
    const confirmed = async (proof) => {
      // Meta can acknowledge the post, then redirect to its paid Ad Center a
      // few seconds later. Keep watching before allowing publication.json to
      // be marked as published.
      const stableUntil = Date.now() + 10000;
      while (Date.now() < stableUntil) {
        if (isPromotionUrl(location.href)) {
          throw new Error('Facebook a ouvert le parcours publicitaire « Booster ». Ferme-le sans accepter : KappGen n’a pas validé cette publication.');
        }
        await sleep(500);
      }
      return { confirmed: true, proof, groups: attempt.groups || [], extra: attempt.extra || [] };
    };
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (isPromotionUrl(location.href)) {
        throw new Error('Facebook a ouvert le parcours publicitaire « Booster ». Ferme-le sans accepter : KappGen n’a pas validé cette publication.');
      }
      if (liveNotices(DRAFT_NOTICE).length) {
        throw new Error('Facebook a enregistré un brouillon au lieu de publier. Le post reste à vérifier et n’est pas marqué comme publié.');
      }
      const oldNotices = new Set(attempt.successBefore || []);
      if (liveNotices(SUCCESS_NOTICE).some((text) => !oldNotices.has(text))) {
        return confirmed('facebook_notice');
      }
      if (attempt.snippet && matchingArticles(attempt.snippet).length > Number(attempt.before || 0)) {
        return confirmed('new_feed_post');
      }
      await sleep(750);
    }
    throw new Error('Facebook n’a pas confirmé la publication. Vérifie la Page et les brouillons avant de relancer : KappGen ne marque pas ce post comme publié.');
  }

  // kind "image": the photo input of the post composer is usually hidden,
  // so any file input accepting images is used.
  async function receiveFile({ src, path, kind }) {
    const token = new URL(src).searchParams.get('token');
    if (!token) throw new Error('Facebook : autorisation du fichier absente.');
    // A composer can hold several file inputs; only one of them is the one the
    // open photo picker listens to. They are tried in turn below, newest first.
    const imageInputs = () => [...scope().querySelectorAll('input[type="file"]')]
      .filter((i) => /image|\*/.test(i.accept || '*')).reverse();
    const pick = () => {
      const inputs = [...scope().querySelectorAll('input[type="file"]')];
      if (kind === 'image') return imageInputs()[0];
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
        if (event.source !== frame.contentWindow || !data || data.kappgen !== 'file' || data.token !== token) return;
        if (data.error) done(reject, new Error(data.error)); else done(resolve, data.file);
      }
      window.addEventListener('message', onMessage);
      frame.src = src;
      document.documentElement.append(frame);
    });
    const give = (target) => {
      const transfer = new DataTransfer();
      transfer.items.add(file);
      target.files = transfer.files;
      target.dispatchEvent(new Event('change', { bubbles: true }));
    };
    if (kind !== 'image') {
      give(input);
      return { name: file.name, size: file.size };
    }
    // Facebook shows the photo as a local preview (blob:) the moment it takes
    // it. A composer holds several file inputs and only one is the one the
    // open picker listens to, so they are tried in turn until that preview
    // appears. It never blocks the publication: if the preview cannot be
    // confirmed, the post goes out exactly as it did before (attached: false
    // simply says the proof is missing).
    const shown = () => !!(composer() || document).querySelector('img[src^="blob:"], img[src^="data:"]');
    for (const candidate of imageInputs()) {
      give(candidate);
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if (shown()) return { name: file.name, size: file.size, attached: true };
        await sleep(250);
      }
    }
    return { name: file.name, size: file.size, attached: false };
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
    // The Reel composer only shows the description field after one or two
    // « Suivant » screens (edit, then details): when the field is not there
    // yet, wait for the upload to reach 100 %, click « Suivant » and look again.
    const findField = () => [...scope().querySelectorAll('[contenteditable="true"][role="textbox"], [contenteditable="true"], textarea')].filter(visible)[0];
    let field = null;
    for (let screen = 0; screen < 4 && !field; screen += 1) {
      try {
        field = await waitFor(findField, screen === 0 ? 12000 : 20000, 'le champ de texte de la publication');
      } catch (error) {
        if (screen === 3) throw error;
        await waitFor(() => !uploading(), 15 * 60000, 'la fin de l’envoi (100 %)');
        const next = findButton(/^(next|suivant)$/i, { needEnabled: true });
        if (!next) throw error;
        click(next);
        await sleep(2500);
      }
    }
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

  async function publish({ groups = [], groupCount = 0, expectedText = '' } = {}) {
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
    let button = await waitFor(() => !uploading() && publishButtonInDialog(), 15 * 60000, 'le bouton Publier');
    let picked = { groups: [], extra: [] };
    if (groups.length || groupCount) {
      picked = await tickGroupsInComposer(groups, groupCount);
      button = await waitFor(() => !uploading() && publishButtonInDialog(), 60000, 'le bouton Publier après « Terminé »');
    }
    silence();
    if (await ensureBoostOff()) {
      await sleep(500);
      button = await waitFor(() => publishButtonInDialog(), 15000, 'le bouton Publier');
    }
    beginPublishAttempt(expectedText, picked);
    click(button);
    const confirmation = await verifyPublication({ expectedText, timeout: 120000 });
    keepQuiet(false);
    return { ...picked, ...confirmation };
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
  async function sendPost({ timeout = 90000, groups = [], groupCount = 0, expectedText = '' } = {}) {
    const dialog = composer();
    let groupsTried = false;
    let picked = { groups: [], extra: [] };
    const isFinal = (node) => labelsOf(node).some((label) => PUBLISH_BUTTON.test(label));
    // « Suivant » first when Facebook shows it (it stays grey while the text
    // or the video is not taken into account), then « Publier ».
    keepQuiet(true);
    for (let screen = 0; screen < 5; screen += 1) {
      // The file must be fully on Facebook (100 %) before « Suivant ».
      await waitFor(() => !uploading(), timeout, 'la fin de l’envoi de la vidéo (100 %)');
      await sleep(1500);
      const button = await waitFor(() => {
        silence();
        return !uploading() && (publishButtonInDialog() || findButton(/^(next|suivant)$/i, { needEnabled: true }));
      }, timeout, 'le bouton Suivant / Publier actif (texte ou vidéo pas encore pris en compte)');
      silence();
      let target = button;
      if (isFinal(button) && (groups.length || groupCount) && !groupsTried) {
        groupsTried = true;
        picked = await tickGroupsInComposer(groups, groupCount);
        target = await waitFor(() => publishButtonInDialog(), timeout, 'le bouton Publier après « Terminé »');
      }
      if (isFinal(target)) {
        if (await ensureBoostOff()) {
          await sleep(500);
          target = await waitFor(() => publishButtonInDialog(), timeout, 'le bouton Publier');
        }
        beginPublishAttempt(expectedText, picked);
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
    const confirmation = await verifyPublication({ expectedText, timeout: 120000 });
    keepQuiet(false);
    return { ...picked, ...confirmation };
  }


  // ---------------------------------------------- sharing to several groups
  // Menus and lists of the share window are not always buttons.
  const CHOICES = 'button, [role="button"], [role="menuitem"], [role="option"], [role="listitem"], [role="radio"], a';
  const choice = (pattern, root = document) => [...root.querySelectorAll(CHOICES)]
    .find((node) => visible(node) && labelsOf(node).some((label) => pattern.test(label)));
  const groupRowOf = (box, root) => {
    const semantic = box.closest('[role="listitem"], [role="option"], label, li');
    if (semantic && (!root || root.contains(semantic))) return semantic;
    let row = box.parentElement;
    for (let depth = 0; row && row !== root && depth < 6; depth += 1, row = row.parentElement) {
      const text = textOf(row);
      if (text && text.length < 500) return row;
    }
    return null;
  };
  const groupBoxes = (root) => [...root.querySelectorAll('[role="checkbox"], input[type="checkbox"]')]
    .filter((box) => {
      if (!visible(box) || !onTop(box) || box.matches('[role="switch"]') || box.closest('[role="switch"]')) return false;
      const row = groupRowOf(box, root);
      const label = [box.getAttribute('aria-label') || '', row ? textOf(row) : ''].join(' ').trim();
      return !!label && !FORBIDDEN_GROUP_CONTROL.test(label) && !/^(activ[ée]|d[ée]sactiv[ée]|on|off|checked|unchecked)$/i.test(label);
    });

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
  async function pickGroups({ names, root = null }) {
    const dialog = root || topDialog();
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
      const box = groupBoxes(dialog).find((node) => {
        const row = groupRowOf(node, dialog);
        return row && (textOf(row).toLowerCase().includes(lower) || (node.getAttribute('aria-label') || '').toLowerCase().includes(lower));
      });
      if (!box) { missing.push(name); continue; }
      const ticked = box.getAttribute('aria-checked') === 'true' || box.checked;
      if (!ticked) { click(box); await sleep(400); }
      if (box.getAttribute('aria-checked') === 'true' || box.checked) picked.push(name);
      else missing.push(name);
    }
    await setSearch('');
    return { picked, missing };
  }

  // The window's « Publier » / « Partager » (an optional text first).
  async function confirmShare({ caption }) {
    const dialog = topDialog();
    if (!dialog) throw new Error('Facebook : fenêtre de partage introuvable.');
    if (caption) {
      const field = dialog && [...dialog.querySelectorAll('[contenteditable="true"], textarea')].find(visible);
      if (field) { field.focus(); document.execCommand('insertText', false, caption); await sleep(500); }
    }
    const button = await waitFor(() => byText(/^(publier|partager|post|share|publish|partager maintenant|share now|envoyer|send)$/i,
      { needEnabled: true, root: dialog }),
      30000, 'le bouton « Publier » du partage');
    click(button);
    const start = Date.now();
    while (Date.now() - start < 60000 && dialog && document.contains(dialog) && visible(dialog)) await sleep(1000);
    if (document.contains(dialog) && visible(dialog)) {
      throw new Error('Facebook n’a pas confirmé le partage dans les groupes. Vérifie l’onglet avant de recommencer.');
    }
    return true;
  }

  // In the Page's composer (last screen, before « Publier »): the option to
  // publish in groups too, its list ticked by name, then back to the composer.
  // On the composer's last screen (after « Suivant »): « Partager dans les
  // groupes » → the groups of the creator's list found by name, completed at
  // random among the groups Facebook lists, up to `count` (9 at most).
  // Returns { groups: names ticked from the list, extra: names ticked at random }.
  async function tickGroupsInComposer(names, count = names.length) {
    const want = groupLimit(count, names.length);
    if (!want) return { groups: [], extra: [] };
    const OPTION = /partager dans (des|un|les) groupes?|publier (aussi )?dans (des|les) groupes|share (to|in) (a )?groups?|post (to|in) groups?|^groupes?$|^groups?$/i;
    // Last resort: the row's heading itself, whatever plain element holds it
    // (Facebook does not always give it a button/menu role or a tabindex) —
    // a native click() on it still bubbles up to whichever ancestor handles it.
    const findHeading = (pattern, root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const text = (node.nodeValue || '').replace(/\s+/g, ' ').trim();
        if (text && pattern.test(text) && visible(node.parentElement)) return node.parentElement;
      }
      return null;
    };
    // Looks in each visible dialog (Facebook can stack more than one —
    // header and scrollable content apart — so the LAST one, topDialog(),
    // may hold only the title and none of the rows below it), then in any
    // same-origin iframe one of them may contain, then in the page itself.
    const framesUnder = (root) => {
      const docs = [root];
      for (const frame of root.querySelectorAll ? root.querySelectorAll('iframe') : []) {
        try {
          const doc = frame.contentDocument;
          if (doc) docs.push(...framesUnder(doc));
        } catch { /* cross-origin: unreachable, nothing we can do about it */ }
      }
      return docs;
    };
    const findOption = () => {
      const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
      for (const root of [...dialogs, document]) {
        for (const doc of framesUnder(root)) {
          const found = choice(OPTION, doc)
            || [...doc.querySelectorAll('[role="switch"], [role="checkbox"], label, [tabindex="0"]')].find((n) => visible(n) && labelsOf(n).some((l) => OPTION.test(l)))
            || findHeading(OPTION, doc);
          if (found) return found;
        }
      }
      return null;
    };
    // L'écran « Paramètres de la publication » dessine son contenu après le
    // titre. On le laisse se stabiliser avant de conclure que l'option manque.
    await sleep(1500);
    const option = await waitFor(findOption, 60000, 'l’option « Partager dans des groupes »').catch(() => null);
    if (!option) {
      return { groups: [], extra: [], warning: 'Facebook n’a pas proposé le partage dans les groupes pour ce type de publication.' };
    }
    click(option);
    // Do not accept just any checkbox: the settings screen also contains the
    // paid « Booster la publication » switch. The group picker must explicitly
    // say « Sélectionnez des groupes » and contain real checkbox rows.
    const list = await waitFor(() => [...document.querySelectorAll('[role="dialog"]')].filter(visible)
      .find((d) => { const title = labelNode(GROUP_PICKER_TITLE, d); return title && onTop(title) && groupBoxes(d).length; }) || null,
    30000, 'la vraie liste « Sélectionnez des groupes »');
    // Long lists load while scrolling: a few turns to see more groups.
    for (let i = 0; i < 6; i += 1) {
      for (const el of list.querySelectorAll('div, ul')) if (el.scrollHeight > el.clientHeight + 40) el.scrollTop = el.scrollHeight;
      await sleep(500);
    }
    const { picked } = names.length ? await pickGroups({ names: names.slice(0, want), root: list }) : { picked: [] };
    const extra = [];
    const boxes = () => groupBoxes(list);
    const ticked = (b) => b.getAttribute('aria-checked') === 'true' || b.checked;
    const nameOf = (b) => {
      const row = groupRowOf(b, list);
      return (b.getAttribute('aria-label') || (row ? textOf(row) : '') || '')
        .replace(/\s*(?:votre derni[èe]re visite|your last visit).*$/i, '').trim();
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
    // Facebook accepts at most nine groups.  Enforce the cap even if the UI
    // restored old checks from a previous draft.
    let selected = boxes().filter(ticked);
    for (let guard = 0; selected.length > want && guard < 12; guard += 1) {
      click(selected[selected.length - 1]);
      await sleep(350);
      selected = boxes().filter(ticked);
    }
    if (!selected.length) throw new Error('Facebook : aucun groupe n’a pu être sélectionné. La publication n’a pas été lancée.');
    if (selected.length > want || selected.length > MAX_GROUPS) throw new Error('Facebook : impossible de limiter la sélection à 9 groupes. La publication est arrêtée par sécurité.');

    // Critical distinction: « Terminé » validates the group choices, whereas
    // « Enregistrer » on the settings screen creates a draft.  Search only in
    // the group dialog and never accept « Enregistrer » / “Save” here.
    const done = await waitFor(() => { const button = byText(GROUPS_DONE_BUTTON, { needEnabled: true, root: list }); return button && onTop(button) ? button : null; },
      15000, 'le bouton « Terminé » de la sélection des groupes');
    click(done);
    // Back on the settings screen when « Publier » is reachable by a click.
    // Trying instead to prove the picker had disappeared never worked: neither
    // its checkboxes nor its « Terminé » really leave the page — Facebook just
    // moves that screen out of sight — and the publication stopped right in
    // front of the « Publier » button. Should it still not be reachable, the
    // caller waits for it too, so this never blocks on its own.
    await waitFor(publishButtonInDialog, 30000, 'le retour aux paramètres avec le bouton « Publier »')
      .catch(() => null);
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

  window.__kappgen = { version: VERSION, openReel, openPost, receiveFile, fillCaption, publish, sendPost, verifyPublication,
    cleanup: () => keepQuiet(false), openShareToGroups, pickGroups, confirmShare, closeDialogs, tickGroupsInComposer };
})();
