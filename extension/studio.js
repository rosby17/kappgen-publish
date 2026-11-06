// Injected into YouTube Studio by background.js. Fills the upload dialog the
// way a person would: title, description, audience, visibility, then waits
// for the upload to finish before closing the dialog.
//
// Each step is exposed on window.__kappgen and called separately by the
// background worker, which does the one thing a page script cannot: handing
// the local MP4 path to the file picker (DevTools protocol, see background.js).

// Nom donné au fichier dans YouTube Studio : celui du dossier de la vidéo quand le fichier porte un nom passe-partout (video.mp4,
// final.mp4…) ou qu'il sort d'un dossier de travail KappGen (<vidéo>/06-rendu/). Exemple :
// « paz-nirvana/contenus/2026-10-15_003_sujet-a-choisir/06-rendu/video.mp4 » → « 2026-10-15_003_sujet-a-choisir.mp4 ».
function nomPourStudio(chemin, nomFichier) {
  const parts = String(chemin || '').split('/').filter(Boolean);
  if (parts.length && parts[parts.length - 1] === nomFichier) parts.pop();
  const m = String(nomFichier || '').match(/^(.*?)(\.[a-z0-9]{2,4})?$/i);
  const base = m[1] || '', ext = m[2] || '.mp4';
  const neutre = /^(\d+[-_ ]?)?(rendus?|renders?|exports?|sorties?|output|final|videos?|a[-_ ]publier|pret|prets|ready)$/i;
  const travail = parts.some((x) => /^\d+[-_ ]?rendu$/i.test(x));
  if (!travail && !/^(video|final|rendu|render|export|output|sortie|short|vertical|reel|montage)([-_ ]?\d+)?$/i.test(base)) return null;
  while (parts.length && neutre.test(parts[parts.length - 1])) parts.pop();
  const dossier = (parts.pop() || '').replace(/[\\/:*?"<>|]+/g, ' ').trim();
  if (!dossier || dossier.toLowerCase() === base.toLowerCase()) return null;
  return dossier + (/^(short|vertical|reel)/i.test(base) ? '-short' : '') + ext;
}
if (typeof module !== 'undefined') module.exports = { nomPourStudio };

(() => {
  // A reused tab may hold the script of an older version: replace it.
  const VERSION = chrome.runtime.getManifest().version;
  if (window.__kappgen && window.__kappgen.version === VERSION) return;

  const S = (key, vars) => window.KappRecipe.sel('studio', key, vars);
  const X = (key) => window.KappRecipe.re('studio', key);
  // In a background tab Chrome slows timers down (down to one tick a minute):
  // the pause then goes through the extension's service worker, never slowed.
  const sleep = (ms) => (document.hidden
    ? chrome.runtime.sendMessage({ type: 'pageSleep', ms }).catch(() => new Promise((resolve) => setTimeout(resolve, ms)))
    : new Promise((resolve) => setTimeout(resolve, ms)));

  const visible = (el) => !!el && el.getClientRects().length > 0 && !el.closest('[hidden]');

  async function waitFor(finder, { timeout = 60000, interval = 500, what = 'élément' } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const found = finder();
      if (found) return found;
      await sleep(interval);
    }
    throw new Error(`YouTube Studio : ${what} introuvable (la page a peut-être changé).`);
  }

  const dialog = () => document.querySelector(S('dialog'));

  // Studio's rich text boxes ignore direct .textContent writes; typing
  // through execCommand goes through its own input handlers.
  // Écrit dans un champ de Studio et VÉRIFIE que le texte y est (true/false). Roosevelt, 06/11 : vidéos parties avec le nom du
  // fichier comme titre et sans description, alors que l'étape disait réussir. Dans une fenêtre en arrière-plan (autre profil
  // devant, fenêtre d'une voie), execCommand peut ne rien écrire : le texte est alors posé directement et Studio est prévenu.
  const sansEspaces = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  function texteDe(box) { return sansEspaces(box.innerText || box.textContent); }
  function texteBon(box, voulu) {
    const lu = texteDe(box);
    const attendu = sansEspaces(voulu);
    return lu === attendu || (attendu.length > 100 && lu.length >= 90 && attendu.startsWith(lu));
  }
  async function typeInto(box, text) {
    const voulu = String(text || '');
    box.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    if (voulu) document.execCommand('insertText', false, voulu);
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(300);
    if (texteBon(box, voulu)) return true;
    box.focus();
    box.textContent = voulu;
    box.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: voulu }));
    box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: voulu }));
    box.dispatchEvent(new Event('change', { bubbles: true }));
    box.blur();
    await sleep(600);
    return texteBon(box, voulu);
  }

  function click(el) {
    el.scrollIntoView({ block: 'center' });
    el.click();
  }

  // Boutons « Reprendre l'importation » de la liste des vidéos, avec le nom du fichier que Studio demande sur leur ligne.
  const REPRENDRE = /^(reprendre l[’']importation|reprendre la mise en ligne|resume upload(ing)?)$/i;
  function lignesInterrompues() {
    const texte = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
    const boutons = [...document.querySelectorAll('button, ytcp-button, [role="button"]')]
      .filter((b) => REPRENDRE.test(texte(b)) && visible(b))
      .filter((b, _, tous) => !tous.some((x) => x !== b && b.contains(x)));      // le plus intérieur : un clic par bouton
    const vus = new Set();
    const sortie = [];
    for (const bouton of boutons) {
      let ligne = bouton.closest('ytcp-video-row');
      for (let el = bouton.parentElement, n = 0; !ligne && el && n < 10; el = el.parentElement, n += 1) {
        if (/\.(mp4|mov|m4v|webm|mkv|avi)\b/i.test(el.textContent || '')) ligne = el;
      }
      const nom = ligne && window.KappReprise ? window.KappReprise.nomDemande(ligne.innerText || ligne.textContent) : null;
      if (!nom || vus.has(ligne)) continue;
      vus.add(ligne);
      sortie.push({ nom, bouton, ligne });
    }
    return sortie;
  }

  function uploadProgress() {
    const label = document.querySelector(S('progressLabel'));
    return (label && label.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function youtubeIdOnPage() {
    const root = dialog() || document;
    for (const a of root.querySelectorAll(S('links'))) {
      const m = a.href.match(X('youtubeLink'));
      if (m) return m[1];
    }
    // Page de la vidéo (/video/ID/edit), ouverte par Studio à la place de la fenêtre d'envoi lors d'une reprise.
    const page = location.pathname.match(/^\/video\/([\w-]{11})(\/|$)/);
    return page ? page[1] : null;
  }

  const textOf = (node) => (node.textContent || '').replace(/\s+/g, ' ').trim();

  // Visible clickable element whose own text matches, anywhere in Studio
  // (monetization opens its own small dialog above the upload dialog).
  // Après « Enregistrer », Studio affiche « Importation de la vidéo : votre vidéo est toujours en cours d'importation… Ne fermez pas cet
  // onglet » avec un bouton « Fermer » (Roosevelt, 19/10 : l'extension restait bloquée devant). Fermer ce message ne coupe pas
  // l'importation : elle continue dans l'onglet. Renvoie true si le message a été fermé.
  function closeUploadingNotice() {
    const avis = /toujours en cours d.importation|is still (being )?upload|ne fermez pas cet onglet|don.t close this (tab|window)/i;
    for (const dlg of document.querySelectorAll('tp-yt-paper-dialog, ytcp-dialog, ytcp-uploads-still-processing-dialog, [role="dialog"]')) {
      if (!visible(dlg) || dlg.closest('ytcp-uploads-dialog') || !avis.test(dlg.innerText || '')) continue;   // jamais la fenêtre d'envoi elle-même
      const fermer = [...dlg.querySelectorAll('ytcp-button, button, tp-yt-paper-button, [role="button"]')]
        .find((b) => visible(b) && /^(Fermer|Close|OK|Compris|Got it)$/i.test((b.innerText || b.getAttribute('aria-label') || '').trim()));
      if (fermer) { click(fermer); return true; }
    }
    return false;
  }

  function findByText(selector, pattern) {
    return [...document.querySelectorAll(selector)].find((node) => visible(node) && pattern.test(textOf(node))) || null;
  }


  // Monetized channels get a "Monetization" step (and, once ads are on, an
  // "Ad suitability" questionnaire) before Visibility. mode comes from the
  // channel settings: "on", "off", or "manual" (the creator finishes it).
  // Studio's left-hand menu (Dashboard, Content, Earn…) is never a choice.
  const SIDE_MENU = 'ytcp-navigation-drawer, tp-yt-app-drawer, ytcp-app-sidebar, #navigation-drawer, #navigation, nav, [role="navigation"]';
  // Choices only the creator can make (menu the extension cannot open, « manual » mode,
  // ad questionnaire): a banner on Studio says what to do, chooseVisibility returns
  // { attente } and the background worker calls again (waitPerson) until it is done.
  const BANNER_ID = 'kappgen-attente-choix';
  function showBanner(text) {
    let banner = document.getElementById(BANNER_ID);
    if (!banner) {
      banner = document.createElement('div');
      banner.id = BANNER_ID;
      banner.setAttribute('role', 'status');
      banner.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;max-width:560px;'
        + 'padding:12px 16px;border-radius:12px;background:#0b5cad;color:#fff;font:500 14px/1.45 Roboto,Arial,sans-serif;'
        + 'box-shadow:0 8px 24px rgba(0,0,0,.25);pointer-events:none';
      document.documentElement.append(banner);
    }
    banner.textContent = text;
  }
  const hideBanner = () => { const b = document.getElementById(BANNER_ID); if (b) b.remove(); };
  const PERSON = 'personne';
  let lastMonetizationDetail = '';

  async function monetizationStep(mode, waitPerson = false) {
    const dlg = dialog() || document.body;
    const onStep = X('monetizationStep').test(textOf(dlg));
    const SELECT = X('select');
    const section = document.querySelector(S('monetizationSection'));
    const dropdown = findByText(S('monetizationDropdown'), SELECT);
    if (!dropdown || !(onStep || section)) return false;
    // Already waiting for the creator: never touch the menu they may be using.
    if (waitPerson || (mode !== 'on' && mode !== 'off')) {
      showBanner('KappGen Publish attend ton choix : dans « Monétisation », choisis Activée (ou Désactivée) puis OK. La publication continue toute seule ensuite.');
      return PERSON;
    }
    const first = dropdown || (section && section.querySelector(S('monetizationTrigger')));
    if (!first) throw new Error('YouTube Studio : menu « Monétisation » introuvable.');
    const M = window.KappMonetisation;
    // Ce qu'on peut presser : l'élément trouvé (souvent l'intérieur, div#child-input), puis le vrai déclencheur qui l'entoure
    // (14/10 : appuyer sur div#child-input ouvrait un menu vide).
    const triggers = [...new Set([first.closest('ytcp-dropdown-trigger'), first, first.closest('tp-yt-paper-dropdown-menu, ytcp-form-select, ytcp-select')]
      .filter((n) => n && visible(n)))];
    // Studio's dropdown opens on a pointer press, and its choices are not always
    // radio buttons ("On" / "Off" can be plain menu items with a description).
    // Opening: pointer press, then a click on the inner parts of the trigger, then the keyboard (Studio changes its
    // dropdowns often; one way or another opens it).
    const ouvertures = (trigger) => [
      () => { for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) trigger.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window })); click(trigger); },
      () => { const inner = trigger.querySelector('#right-icon, #container, #label, .dropdown-trigger-text, tp-yt-iron-icon') || trigger; click(inner); },
      () => { if (trigger.focus) trigger.focus(); for (const key of ['Enter', ' ', 'ArrowDown']) trigger.dispatchEvent(new KeyboardEvent('keydown', { key, code: key === ' ' ? 'Space' : key, bubbles: true, cancelable: true })); },
    ];
    const wanted = X(mode === 'on' ? 'monetizationOn' : 'monetizationOff');
    const CHOICES = S('monetizationChoices');
    // Jamais un choix : le menu de gauche de Studio, ni la file de mise en ligne en bas de l'écran.
    const horsChoix = (n) => n.closest(SIDE_MENU) || (M && n.closest(M.UPLOAD_PANEL));
    const correspond = (n) => (M ? M.matches(textOf(n), mode, wanted) : (wanted.test(textOf(n)) && textOf(n).length < 200));
    const findChoice = () => {
      const exact = document.querySelector(S('monetizationExact', { mode }));
      if (exact && visible(exact)) return exact;
      // Les éléments de la recette, puis tout ce que contiennent les menus et petites fenêtres ouverts.
      const pool = [...document.querySelectorAll(CHOICES)];
      if (M) for (const overlay of document.querySelectorAll(M.OVERLAYS)) if (visible(overlay)) pool.push(...overlay.querySelectorAll('*'));
      const hits = [...new Set(pool)].filter((n) => visible(n) && !horsChoix(n) && correspond(n));
      // the innermost match is the item itself, not a list that contains it
      const inner = hits.find((n) => !hits.some((o) => o !== n && n.contains(o))) || null;
      // Clic sur la ligne entière du choix (le texte seul ne réagit pas toujours).
      return inner && (inner.closest('tp-yt-paper-item, tp-yt-paper-radio-button, [role="option"], [role="menuitem"], [role="menuitemradio"], [role="radio"], ytcp-text-menu-item, ytcp-ve') || inner);
    };
    let option = null;
    for (const trigger of triggers) {
      for (const ouvrir of ouvertures(trigger)) {
        ouvrir();
        option = await waitFor(findChoice, { timeout: 4000, what: 'le choix de monétisation' }).catch(() => null);
        if (option) break;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); // menu à moitié ouvert : refermé avant l'essai suivant
        await sleep(400);
      }
      if (option) break;
    }
    if (!option) {
      const trigger = triggers[0] || first;
      const seen = [...new Set([...document.querySelectorAll(CHOICES)].filter((n) => visible(n) && !horsChoix(n)).map(textOf)
        .filter((t) => t && t.length < 80 && !(M && M.isUploadRow(t))))].slice(0, 8);
      // Which element was pressed, and what Studio opened above the dialog (with the texts of its items, even nested,
      // and how many are hidden): enough to see which tag and which words the options really use.
      const tag = (n) => `${n.localName}${n.id ? '#' + n.id : ''}${n.getAttribute('role') ? '[' + n.getAttribute('role') + ']' : ''}`;
      const pressed = triggers.map((t) => `${tag(t)} « ${textOf(t).slice(0, 30)} »`).join(' puis ');
      const overlays = [...document.querySelectorAll((M && M.OVERLAYS) || 'tp-yt-iron-dropdown, ytcp-text-menu, tp-yt-paper-listbox, [role="listbox"], [role="menu"], ytcp-paper-dialog')]
        .filter((n) => visible(n) && !horsChoix(n)).slice(0, 3)
        .map((n) => {
          const items = [...n.querySelectorAll('tp-yt-paper-item, [role="option"], [role="menuitem"], [role="menuitemradio"], [role="radio"], tp-yt-paper-radio-button, ytcp-text-menu-item, li')];
          const shown = items.filter(visible);
          return `${tag(n)} (${shown.length}/${items.length} visibles) > ${(shown.length ? shown : items).slice(0, 5).map((c) => `${tag(c)} « ${textOf(c).slice(0, 25)} »`).join(', ')}`;
        });
      // Not a dead end: the creator picks it by hand and the upload goes on.
      lastMonetizationDetail = `Appuyé sur : ${pressed || tag(trigger)}. Choix visibles : ${seen.join(' | ') || 'aucun'}. Menus ouverts : ${overlays.join(' ;; ') || 'aucun'}.`;
      showBanner('KappGen Publish n’a pas pu ouvrir le menu « Monétisation » : choisis Activée (ou Désactivée) puis OK. La publication continue toute seule ensuite.');
      return PERSON;
    }
    click(option);
    await sleep(600);
    // Older Studio: a small dialog with "Done". Current Studio: the choice sticks
    // and the dialog's own "Next" (clicked by chooseVisibility) moves on.
    const done = await waitFor(() => findByText(S('buttons'), X('done')), { timeout: 4000, what: 'le bouton Terminé' }).catch(() => null);
    if (done) click(done);
    await sleep(1500);
    return true;
  }

  // « Éligibilité aux annonces » / « Ad suitability » : the step badge is
  // selected, or its questionnaire (categories + « None of the above ») shows.
  const AD_STEP = /Éligibilité aux annonces|Adéquation publicitaire|Ad suitability|Idoneidad para anuncios|Adequação a anúncios|Eignung für Werbung/i;
  // « Aucun contenu non adapté aux annonceurs » : libellé des Shorts (Ballon Viral, 06/11), en plus de « Aucun des éléments ci-dessus ».
  const NONE_TEXT = /aucun contenu non adapt[ée] aux annonceurs|no (ad-unsuitable|unsuitable) content|none of the above|aucun(e)? (des|de ces)? ?(options|propositions|[ée]l[ée]ments|contenus|situations|cas|choix)? ?ci-dessus|aucun de ces|rien de tout cela|ningun[ao] de l[ao]s|nenhuma das|keine der/i;
  function adStepShown() {
    const dlg = dialog();
    if (!dlg) return false;
    const current = [...dlg.querySelectorAll('[id^="step-badge-"], ytcp-stepper [role="tab"], ytcp-stepper button')]
      .find((b) => visible(b) && (b.getAttribute('aria-selected') === 'true' || b.hasAttribute('active') || b.classList.contains('iron-selected') || b.getAttribute('state') === 'active'));
    if (current && AD_STEP.test(textOf(current))) return true;
    return [...dlg.querySelectorAll('h1, h2, #title, .title')].some((h) => visible(h) && AD_STEP.test(textOf(h)));
  }
  // The « None of the above » checkbox, wherever Studio puts its label (on the
  // box, beside it, or on a parent row). Lists can be lazy: scroll them first.
  function findNone() {
    let none = findByText(S('adCheckbox'), X('adNone'));
    if (none) return none;
    const dlg = dialog() || document.body;
    // Wider search only on the questionnaire itself (never on Details or Visibility).
    if (!adStepShown() && !/Langage inapproprié|Inappropriate language|Lenguaje inapropiado|Linguagem inadequada|Unangemessene Sprache/i.test(textOf(dlg))) return null;
    for (const box of dlg.querySelectorAll('*')) {
      if (box.scrollHeight > box.clientHeight + 40 && getComputedStyle(box).overflowY !== 'visible') box.scrollTop = box.scrollHeight;
    }
    const boxes = [...dlg.querySelectorAll(S('adCheckbox'))].filter(visible);
    none = boxes.find((c) => [c, c.parentElement, c.closest('ytcp-checkbox-lit, ytcp-checkbox, tp-yt-paper-checkbox, label, [role="listitem"], div')]
      .some((n) => n && textOf(n).length < 160 && NONE_TEXT.test(textOf(n)))) || null;
    if (none) return none;
    // A label alone (« Aucun des éléments ci-dessus ») : its own checkbox, or itself.
    const label = [...dlg.querySelectorAll('span, div, label, yt-formatted-string, p')]
      .find((n) => visible(n) && textOf(n).length < 120 && NONE_TEXT.test(textOf(n)) && ![...n.children].some((c) => NONE_TEXT.test(textOf(c))));
    if (!label) return null;
    const row = label.closest('ytcp-checkbox-lit, ytcp-checkbox, tp-yt-paper-checkbox, label, [role="checkbox"], [role="listitem"]') || label.parentElement;
    return (row && row.querySelector(S('adCheckbox'))) || row || label;
  }

  const nextEnabled = () => {
    const next = document.querySelector(S('nextButton'));
    return !!next && visible(next) && !next.hasAttribute('disabled') && next.getAttribute('aria-disabled') !== 'true';
  };
  const AD_BANNER = 'KappGen Publish attend ton choix : réponds au questionnaire « Éligibilité aux annonces » puis « Envoyer la classification ». La publication continue toute seule ensuite.';
  async function adSuitabilityStep(mode, waitPerson = false) {
    // Waiting for the creator: once Studio lets « Next » go, the questionnaire is answered.
    // Même en attente de la personne, réessaie seul si la case est maintenant trouvée (questionnaire chargé en retard).
    if (waitPerson && !(mode === 'on' && findNone())) {
      if (!adStepShown() || nextEnabled()) return false;
      showBanner(AD_BANNER);
      return PERSON;
    }
    const none = findNone();
    if (!none) {
      if (!adStepShown()) return false;
      if (nextEnabled()) return false;
      showBanner(AD_BANNER);
      return PERSON;
    }
    if (mode !== 'on') {
      showBanner(AD_BANNER);
      return PERSON;
    }
    const SUBMIT = /^(Submit rating|Envoyer (la note|la classification|l['’][ée]valuation)|Soumettre.*|Valider.*|Enviar (clasificaci[oó]n|avalia[cç][aã]o)|Bewertung senden)$/i;
    // « Envoyer l'évaluation » grisé = évaluation déjà envoyée (Studio laisse le bouton à l'écran) : ne compte pas. Sinon
    // l'extension le recliquait sans fin et n'appuyait jamais sur « Suivant » (Short Ballon Viral, 06/11).
    const actif = (b) => !!b && visible(b) && ![b, b.querySelector('button')].some((n) => n && (n.hasAttribute('disabled') || n.getAttribute('aria-disabled') === 'true'));
    const findSubmit = () => [findByText(S('buttons'), X('adSubmit')), findByText(S('buttons'), SUBMIT)].find(actif) || null;
    const box = none.matches(S('adCheckbox')) ? none : (none.querySelector(S('adCheckbox')) || none);
    const checked = () => box.getAttribute('aria-checked') === 'true' || box.hasAttribute('checked');
    // Already answered (Studio keeps the questionnaire on screen): « Next » moves on.
    if (checked() && !findSubmit()) return false;
    if (!findSubmit() && nextEnabled()) return false;
    if (!checked()) click(none);
    await sleep(600);
    const submit = await waitFor(findSubmit, { timeout: 10000, what: 'le bouton « Envoyer la classification »' });
    click(submit);
    await sleep(2000);
    return true;
  }

  // "Schedule" part of the Visibility step: date and time are typed in the
  // format Studio itself uses for its language ("Oct 2, 2026" / "2 oct. 2026",
  // "6:00 PM" / "18:00").
  async function typeInput(input, text) {
    input.focus();
    input.select();
    document.execCommand('insertText', false, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    await sleep(600);
  }

  async function scheduleFor(time) {
    const when = new Date(time);
    const lang = document.documentElement.lang || navigator.language || 'en-US';
    const expand = document.querySelector(S('scheduleExpand'))
      || findByText(S('buttons'), X('schedule'));
    if (!expand) throw new Error('YouTube Studio : option « Programmer » introuvable.');
    click(expand);
    await sleep(1000);
    // Page de la vidéo (pas de fenêtre d'envoi) : mêmes champs, dans la fenêtre Visibilité.
    const dateTrigger = await waitFor(() => document.querySelector(S('dateTrigger')) || document.querySelector('#datepicker-trigger'),
      { timeout: 10000, what: 'la date de programmation' });
    click(dateTrigger);
    const dateInput = await waitFor(() => {
      const input = document.querySelector(S('dateInput'));
      return visible(input) ? input : null;
    }, { timeout: 10000, what: 'le champ Date' });
    await typeInput(dateInput, new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short', year: 'numeric' }).format(when));
    const timeInput = await waitFor(() => {
      const input = document.querySelector(S('timeInput')) || document.querySelector('#time-of-day-container input');
      return visible(input) ? input : null;
    }, { timeout: 10000, what: 'le champ Heure' });
    await typeInput(timeInput, new Intl.DateTimeFormat(lang, { hour: 'numeric', minute: '2-digit' }).format(when));
    return true;
  }

  // What Studio shows right now: appended to the errors so that a failure
  // says WHERE it stopped (the creator can paste it as is).
  function whatIsShown() {
    const dlg = document.querySelector('ytcp-uploads-dialog');
    const root = dlg || document.body;
    const buttons = [...root.querySelectorAll('button, ytcp-button, tp-yt-paper-button, [role="button"], tp-yt-paper-radio-button, ytcp-checkbox-lit')]
      .filter(visible).map((b) => (b.getAttribute('name') || b.id || '') + ':' + textOf(b).slice(0, 40)).filter((t) => t.length > 1).slice(0, 25);
    const step = [...root.querySelectorAll('h1, h2, [id*="step"], #title')].filter(visible).map((h) => textOf(h).slice(0, 50)).filter(Boolean).slice(0, 4);
    return ` Vu dans Studio (${dlg ? 'fenêtre d’envoi ouverte' : 'AUCUNE fenêtre d’envoi'}, ${location.pathname.slice(0, 60)}) : ${step.join(' / ')} | ${buttons.join(' | ')}`;
  }

  window.__kappgen = {
    version: VERSION,
    // True once the upload dialog's file picker is on the page.
    // Nouvelle importation DANS la page déjà ouverte (Roosevelt, 19/10) : « Créer › Importer des vidéos », sans recharger, pour que
    // l'importation précédente continue. Renvoie false si le bouton n'est pas trouvé (l'extension ouvre alors un autre onglet).
    async openUploadInPage() {
      if (document.querySelector(S('filePicker'))) return true;
      const create = document.querySelector('ytcp-button#create-icon, #create-icon, ytcp-icon-button#create-icon');
      if (!create || !visible(create)) return false;
      click(create);
      const item = await waitFor(() => findByText('tp-yt-paper-item, ytcp-text-menu tp-yt-paper-item, [role="menuitem"], #text-item-0',
        /^(Importer des vidéos|Importer une vidéo|Upload videos?|Mettre en ligne des vidéos)$/i), { timeout: 8000, what: 'le menu Créer' }).catch(() => null);
      if (!item) return false;
      click(item);
      return !!(await waitFor(() => document.querySelector(S('filePicker')), { timeout: 20000, what: 'la fenêtre d’envoi' }).catch(() => null));
    },

    async waitForFilePicker() {
      try {
        await waitFor(() => document.querySelector(S('filePicker')),
          { timeout: 90000, what: 'la fenêtre d’envoi' });
      } catch (error) {
        throw new Error(error.message + whatIsShown());
      }
      return true;
    },

    // Videos from the chosen folder: a hidden extension frame (bridge.html)
    // reads the file and posts it here; it is then given to Studio's picker
    // as if dropped by hand.
    async receiveFile({ selector, css, src, path }) {
      const token = new URL(src).searchParams.get('token');
      if (!token) throw new Error('YouTube Studio : autorisation du fichier absente.');
      const input = await waitFor(() => document.querySelector(css || (selector ? S(selector) : S('videoInput'))), { timeout: 120000, what: 'le sélecteur de fichier' });
      const file = await new Promise((resolve, reject) => {
        const frame = document.createElement('iframe');
        frame.style.display = 'none';
        const done = (fn, value) => {
          clearTimeout(timer);
          window.removeEventListener('message', onMessage);
          frame.remove();
          fn(value);
        };
        const timer = setTimeout(() => done(reject, new Error('Le fichier local ne répond pas (accès au dossier à autoriser ?).')), 60000);
        function onMessage(event) {
          const data = event.data;
          if (event.source !== frame.contentWindow || !data || data.kappgen !== 'file' || data.token !== token) return;
          if (data.error) done(reject, new Error(data.error));
          else done(resolve, data.file);
        }
        window.addEventListener('message', onMessage);
        frame.src = src;
        document.documentElement.append(frame);
      });
      // Le fichier arrive dans Studio sous le nom de SON dossier (Roosevelt, 19/10 : « video » dans Studio, une importation interrompue
      // demandait « video.mp4 » et on ne retrouvait pas le dossier). Rien n'est renommé sur le disque.
      const nom = nomPourStudio(path, file.name);
      const envoye = nom ? new File([file], nom, { type: file.type, lastModified: file.lastModified }) : file;
      const transfer = new DataTransfer();
      transfer.items.add(envoye);
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { name: envoye.name, size: envoye.size };
    },

    async fillDetails({ title, description }) {
      const titleBox = await waitFor(
        () => document.querySelector(S('titleBox')),
        { timeout: 120000, what: 'le champ Titre' },
      );
      await sleep(1500); // Studio pre-fills the title from the file name.
      // Le titre est vérifié : sans lui la vidéo partirait avec le nom du fichier. Un essai de plus après une pause.
      if (!(await typeInto(titleBox, title))) {
        await sleep(2000);
        if (!(await typeInto(titleBox, title))) throw new Error(`YouTube Studio n’a pas gardé le titre (il affiche « ${texteDe(titleBox).slice(0, 60)} »).`);
      }
      const descriptionBox = document.querySelector(S('descriptionBox'));
      if (descriptionBox && !(await typeInto(descriptionBox, description || ''))) {
        await sleep(2000);
        if (!(await typeInto(descriptionBox, description || ''))) throw new Error('YouTube Studio n’a pas gardé la description.');
      }
      const notForKids = await waitFor(
        () => document.querySelector(S('notForKids')),
        { what: 'l’option « non conçue pour les enfants »' },
      );
      click(notForKids);
      await sleep(500);
      return true;
    },

    // Tags live under "Show more" on the details page. Typing them
    // comma-separated is how Studio turns them into chips.
    async fillTags({ tags }) {
      if (!tags || !tags.length) return true;
      let input = document.querySelector(S('tagsInput'));
      if (!visible(input)) {
        const more = document.querySelector(S('showMore'));
        if (more) click(more);
        input = await waitFor(
          () => { const el = document.querySelector(S('tagsInput')); return visible(el) ? el : null; },
          { timeout: 15000, what: 'le champ Tags' },
        );
      }
      input.focus();
      document.execCommand('insertText', false, `${tags.join(',')},`);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(500);
      input.blur();
      return true;
    },

    // Video edit page (studio.youtube.com/video/<id>/edit): re-apply title,
    // description and tags, then Save. The thumbnail is handed over by
    // receiveFile before this is called.
    async editDetails({ title, description, tags }) {
      const titleBox = await waitFor(() => document.querySelector(S('titleBox')),
        { timeout: 60000, what: 'le champ Titre' });
      if (title && !(await typeInto(titleBox, title))) throw new Error(`YouTube Studio n’a pas gardé le titre (il affiche « ${texteDe(titleBox).slice(0, 60)} »).`);
      const descriptionBox = document.querySelector(S('descriptionBox'));
      if (descriptionBox && description && !(await typeInto(descriptionBox, description))) throw new Error('YouTube Studio n’a pas gardé la description.');
      if (tags && tags.length) await this.fillTags({ tags }).catch(() => {});
      return true;
    },

    async saveEdit() {
      const button = await waitFor(() => {
        const b = findByText(S('saveEditButtons'), X('save'));
        return b && !b.hasAttribute('disabled') && b.getAttribute('aria-disabled') !== 'true' ? b : null;
      }, { timeout: 20000, what: 'le bouton Enregistrer (aucune modification détectée ?)' });
      click(button);
      await sleep(4000);
      return true;
    },

    // Present on the details page once Studio shows the custom thumbnail
    // uploader (only for verified channels).
    hasThumbnailPicker() {
      return !!document.querySelector(S('thumbnailPicker'));
    },

    // Studio shows the uploader only once the new file is processed: wait for it
    // rather than deciding from a snapshot (the video was sent without thumbnail).
    async waitForThumbnailPicker() {
      await waitFor(() => document.querySelector(S('thumbnailPicker')),
        { timeout: 150000, what: 'le champ Miniature (chaîne non vérifiée ?)' });
      return true;
    },

    async chooseVisibility({ visibility, monetization, scheduleAt, waitPerson = '' }) {
      const schedule = visibility === 'SCHEDULE' && scheduleAt;
      const name = ['PRIVATE', 'UNLISTED', 'PUBLIC'].includes(visibility) ? visibility : 'PRIVATE';
      // Details → Video elements → Checks → Visibility. "Next" stays
      // disabled while Studio is busy (checks, processing): wait for it.
      const start = Date.now();
      let stuck = 0;
      let lostSince = 0;
      // Bulles déjà fermées : chacune n'est cliquée qu'une fois. Le bandeau « Il semble que vous êtes en train de mettre en ligne
      // un Short » reste affiché après « Ignorer » : le recliquer sans fin empêchait de passer à « Suivant » (Ballon Viral, 06/11).
      const bullesVues = new WeakSet();
      let bullesFermees = 0;
      while (Date.now() - start < 180000) {
        const radio = document.querySelector(S('visibilityRadio', { name }));
        if (visible(radio)) {
          hideBanner();
          if (schedule) return scheduleFor(scheduleAt);
          click(radio);
          await sleep(800);
          return true;
        }
        // Fenêtre d'envoi fermée (onglet parti sur une autre page de Studio, allon-viral 04/11) : rien à cliquer ici,
        // le service la termine depuis la page de la vidéo au lieu de chercher « Visibilité » pendant 3 minutes.
        const dlg = dialog();
        if (!dlg || !visible(dlg)) {
          if (!lostSince) lostSince = Date.now();
          else if (Date.now() - lostSince > 10000) return { fenetrePerdue: true, detail: whatIsShown() };
          await sleep(700);
          continue;
        }
        lostSince = 0;
        const money = await monetizationStep(monetization, waitPerson === 'monetisation');
        if (money === PERSON) return { attente: 'monetisation', detail: lastMonetizationDetail };
        if (money) continue;
        const ads = await adSuitabilityStep(monetization, waitPerson === 'annonces');
        if (ads === PERSON) return { attente: 'annonces' };
        if (ads) continue;
        hideBanner();
        // Studio's info bubbles (« Learn more / Dismiss ») sit over the dialog
        // and keep it on « Details »: close them (never the dialog itself).
        const bubble = bullesFermees >= 6 ? null : [...document.querySelectorAll('ytcp-uploads-dialog button, ytcp-uploads-dialog ytcp-button, ytcp-uploads-dialog [role="button"], tp-yt-paper-dialog button, tp-yt-paper-dialog [role="button"]')]
          .find((b) => visible(b) && !bullesVues.has(b) && !b.closest('#close-button, ytcp-uploads-dialog-close-button')
            && (b.id === 'action-2' || /^(dismiss|ignorer|got it|j'ai compris|compris|no thanks|non merci)$/i.test((b.textContent || '').trim())));
        if (bubble) { bullesVues.add(bubble); bullesFermees += 1; click(bubble); await sleep(800); continue; }
        const next = document.querySelector(S('nextButton'));
        const enabled = next && visible(next) && !next.hasAttribute('disabled') && next.getAttribute('aria-disabled') !== 'true';
        if (enabled) { click(next); stuck = 0; }
        else if ((stuck += 1) === 20) {
          // Still on « Details » after ~15 s: the « not made for kids » choice
          // is what Studio most often waits for — tick it again.
          const kids = document.querySelector(S('notForKids'));
          if (kids && visible(kids)) click(kids);
        }
        await sleep(enabled ? 1500 : 700);
      }
      throw new Error('YouTube Studio : étape « Visibilité » introuvable.' + whatIsShown());
    },

    // Upload state as shown by Studio. The background worker polls this
    // (short calls keep its service worker alive for hours-long uploads).
    progress() {
      const label = uploadProgress();
      return { label, youtubeId: youtubeIdOnPage(), transferring: X('transferring').test(label) };
    },

    // Lignes « Mise en ligne interrompue » de la liste des vidéos : [{ nom }] = fichier demandé par Studio (lib/reprise.js).
    interrompues() {
      return lignesInterrompues().map((l) => ({ nom: l.nom }));
    },

    // Reprend la ligne dont Studio demande `nom` : « Reprendre l'importation », puis le fichier remis comme à l'envoi.
    // Le background a posé avant (monde de la page) un relais qui garde le sélecteur de fichier au lieu d'ouvrir la
    // fenêtre du Mac ; il le marque avec l'attribut data-kappgen-reprise.
    async reprendre({ nom, src, path }) {
      const ligne = lignesInterrompues().find((l) => l.nom === nom);
      if (!ligne) throw new Error(`YouTube Studio : la ligne « ${nom} » n’est plus interrompue (déjà reprise ?).`);
      document.querySelectorAll('input[data-kappgen-reprise]').forEach((x) => x.removeAttribute('data-kappgen-reprise'));
      document.documentElement.setAttribute('data-kappgen-reprise-attendue', '1');
      click(ligne.bouton);
      try {
        await waitFor(() => document.querySelector('input[data-kappgen-reprise]'), { timeout: 20000, what: 'le sélecteur de fichier de la reprise' });
      } finally {
        document.documentElement.removeAttribute('data-kappgen-reprise-attendue');
      }
      return this.receiveFile({ css: 'input[data-kappgen-reprise]', src, path });
    },

    // Titre de la fenêtre d'envoi ouverte (null sans fenêtre) : sert à finir une reprise faite à la main.
    titreDialogue() {
      const dlg = dialog();
      if (!dlg || !visible(dlg)) return null;
      const box = dlg.querySelector(S('titleBox'));
      return box ? (box.innerText || box.textContent || '').trim() : null;
    },

    // Ferme la fenêtre d'envoi restée ouverte après une reprise ratée (le brouillon reste dans Studio) : la ligne suivante peut être reprise.
    async closeDialog() {
      const dlg = dialog();
      if (!dlg || !visible(dlg)) return true;
      const fermer = dlg.querySelector('#close-button, ytcp-uploads-dialog-close-button button, [aria-label="Fermer"], [aria-label="Close"]');
      if (fermer) click(fermer);
      await sleep(1500);
      return !dialog() || !visible(dialog());
    },

    // True while Studio still shows a transfer (dialog or video list).
    stillUploading() {
      return X('stillUploading').test(document.body.innerText || '');
    },

    // Saves once the transfer is over. Studio keeps processing on its side.
    async save() {
      const done = await waitFor(() => {
        const button = document.querySelector(S('doneButton'));
        return button && !button.hasAttribute('disabled') && button.getAttribute('aria-disabled') !== 'true' ? button : null;
      }, { timeout: 120000, what: 'le bouton Enregistrer' }); // enabled even mid-transfer
      click(done);
      // Saved before Studio's checks are over, it asks for confirmation:
      // the video is unlisted, so "Publish anyway" is what we want.
      const start = Date.now();
      while (Date.now() - start < 6000) {
        const anyway = findByText(S('buttons'), X('publishAnyway'));
        if (anyway) { click(anyway); await sleep(2000); break; }
        await sleep(400);
      }
      const close = document.querySelector(S('shareClose'));
      if (close) click(close);
      await sleep(1500);
      closeUploadingNotice();
      return this.saveState();
    },

    // After Save: "closed" once the upload dialog is gone (or replaced by
    // the share dialog), "saving" while Studio shows "Saving…" with its
    // buttons greyed out, "open" if the dialog still waits for a click.
    saveState() {
      const close = document.querySelector(S('shareClose'));
      if (close && visible(close)) { click(close); return 'closed'; }
      if (closeUploadingNotice()) return 'closed';
      const dlg = dialog();
      if (!dlg || !visible(dlg)) return 'closed';
      if (X('saving').test(textOf(dlg))) return 'saving';
      const done = dlg.querySelector(S('dialogDoneButton'));
      const disabled = !done || done.hasAttribute('disabled') || done.getAttribute('aria-disabled') === 'true';
      return disabled ? 'saving' : 'open';
    },

    // Fallback when the upload dialog never finishes saving: the video
    // already exists, so its visibility is set from its edit page
    // (studio.youtube.com/video/<id>/edit), then Save.
    // scheduleAt (fenêtre d'envoi perdue d'une vidéo programmée) : programmée depuis la même fenêtre Visibilité.
    async setVisibilityOnEdit({ visibility, scheduleAt = null }) {
      const schedule = visibility === 'SCHEDULE' && scheduleAt;
      const name = ['PRIVATE', 'UNLISTED', 'PUBLIC'].includes(visibility) ? visibility : 'UNLISTED';
      const trigger = await waitFor(() => {
        const t = document.querySelector(S('visibilityTrigger'));
        return visible(t) ? t : null;
      }, { timeout: 60000, what: 'le réglage Visibilité de la page de la vidéo' });
      click(trigger);
      if (schedule) {
        await sleep(1000);
        await scheduleFor(scheduleAt);
      } else {
        const radio = await waitFor(() => {
          const r = document.querySelector(S('visibilityRadio', { name }));
          return visible(r) ? r : null;
        }, { timeout: 15000, what: 'le choix de visibilité' });
        click(radio);
      }
      await sleep(600);
      const done = await waitFor(() => findByText(S('buttons'), X('done')), { timeout: 10000, what: 'le bouton Terminé' });
      click(done);
      await sleep(1000);
      return this.saveEdit();
    },
  };
})();
