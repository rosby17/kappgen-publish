// Injected into YouTube Studio by background.js. Fills the upload dialog the
// way a person would: title, description, audience, visibility, then waits
// for the upload to finish before closing the dialog.
//
// Each step is exposed on window.__kappgen and called separately by the
// background worker, which does the one thing a page script cannot: handing
// the local MP4 path to the file picker (DevTools protocol, see background.js).

(() => {
  // A reused tab may hold the script of an older version: replace it.
  const VERSION = chrome.runtime.getManifest().version;
  if (window.__kappgen && window.__kappgen.version === VERSION) return;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

  const dialog = () => document.querySelector('ytcp-uploads-dialog');

  // Studio's rich text boxes ignore direct .textContent writes; typing
  // through execCommand goes through its own input handlers.
  async function typeInto(box, text) {
    box.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    if (text) document.execCommand('insertText', false, text);
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(300);
  }

  function click(el) {
    el.scrollIntoView({ block: 'center' });
    el.click();
  }

  function uploadProgress() {
    const label = document.querySelector('ytcp-uploads-dialog ytcp-video-upload-progress .progress-label, ytcp-uploads-dialog .progress-label');
    return (label && label.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function youtubeIdOnPage() {
    const root = dialog() || document;
    for (const a of root.querySelectorAll('a[href]')) {
      const m = a.href.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/video\/)([A-Za-z0-9_-]{11})/);
      if (m) return m[1];
    }
    return null;
  }

  const textOf = (node) => (node.textContent || '').replace(/\s+/g, ' ').trim();

  // Visible clickable element whose own text matches, anywhere in Studio
  // (monetization opens its own small dialog above the upload dialog).
  function findByText(selector, pattern) {
    return [...document.querySelectorAll(selector)].find((node) => visible(node) && pattern.test(textOf(node))) || null;
  }

  const BUTTONS = 'ytcp-button, button, tp-yt-paper-button, [role="button"]';

  // Monetized channels get a "Monetization" step (and, once ads are on, an
  // "Ad suitability" questionnaire) before Visibility. mode comes from the
  // channel settings: "on", "off", or "manual" (the creator finishes it).
  async function monetizationStep(mode) {
    const dlg = dialog() || document.body;
    const onStep = /needs a monetization setting|n[ée]cessite un param[eè]tre de mon[ée]tisation|choose how you want to earn money|choisis? comment tu souhaites? gagner de l.argent|Watch Page ads|annonces de la page de visionnage/i.test(textOf(dlg));
    const SELECT = /^(Select|S[ée]lectionner)$/i;
    const section = document.querySelector('ytcp-uploads-dialog ytcp-video-monetization, ytcp-uploads-dialog ytcp-uploads-monetization, ytcp-uploads-dialog [id*="monetization" i]');
    const dropdown = findByText('ytcp-uploads-dialog ytcp-dropdown-trigger, ytcp-uploads-dialog #child-input, ytcp-uploads-dialog [role="button"], ytcp-uploads-dialog tp-yt-paper-dropdown-menu', SELECT);
    if (!dropdown || !(onStep || section)) return false;
    if (mode !== 'on' && mode !== 'off') {
      throw new Error('Chaîne monétisée : choisis « Monétisation » pour cette chaîne dans l’onglet Chaînes de KappGen, ou termine l’envoi dans l’onglet YouTube Studio resté ouvert.');
    }
    const trigger = dropdown || (section && section.querySelector('#child-input, ytcp-dropdown-trigger, [role="button"]'));
    if (!trigger) throw new Error('YouTube Studio : menu « Monétisation » introuvable.');
    click(trigger);
    const choice = mode === 'on' ? /^(On|Activ[ée]e?)$/i : /^(Off|D[ée]sactiv[ée]e?)$/i;
    const option = await waitFor(
      () => document.querySelector(`tp-yt-paper-radio-button#radio-${mode}`) || findByText('tp-yt-paper-radio-button, [role="radio"], [role="option"], tp-yt-paper-item', choice),
      { timeout: 15000, what: 'le choix de monétisation' },
    );
    click(option);
    await sleep(600);
    const done = await waitFor(() => findByText(BUTTONS, /^(Done|OK|Termin[ée]|Valider|Enregistrer|Save)$/i), { timeout: 10000, what: 'le bouton Terminé' });
    click(done);
    await sleep(1500);
    return true;
  }

  async function adSuitabilityStep(mode) {
    const none = findByText('ytcp-checkbox-lit, tp-yt-paper-checkbox, [role="checkbox"]', /^(None of the above|Aucun de ces (contenus|[ée]l[ée]ments))$/i);
    if (!none) return false;
    if (mode !== 'on') {
      throw new Error('YouTube Studio demande le questionnaire « Adéquation publicitaire » : termine-le dans l’onglet Studio resté ouvert.');
    }
    if (none.getAttribute('aria-checked') !== 'true' && !none.hasAttribute('checked')) click(none);
    await sleep(600);
    const submit = await waitFor(() => findByText(BUTTONS, /^(Submit rating|Envoyer (la note|l['’][ée]valuation)|Soumettre.*)$/i), { timeout: 10000, what: 'le bouton « Submit rating »' });
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
    const expand = document.querySelector('ytcp-uploads-dialog #second-container-expand-button')
      || findByText(BUTTONS, /^(Schedule|Programmer|Planifier)$/i);
    if (!expand) throw new Error('YouTube Studio : option « Programmer » introuvable.');
    click(expand);
    await sleep(1000);
    const dateTrigger = await waitFor(() => document.querySelector('ytcp-uploads-dialog #datepicker-trigger'), { timeout: 10000, what: 'la date de programmation' });
    click(dateTrigger);
    const dateInput = await waitFor(() => {
      const input = document.querySelector('ytcp-date-picker tp-yt-paper-input input, ytcp-date-picker input');
      return visible(input) ? input : null;
    }, { timeout: 10000, what: 'le champ Date' });
    await typeInput(dateInput, new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short', year: 'numeric' }).format(when));
    const timeInput = await waitFor(() => {
      const input = document.querySelector('ytcp-uploads-dialog #time-of-day-container input, ytcp-uploads-dialog ytcp-form-input-container#time-of-day-container input');
      return visible(input) ? input : null;
    }, { timeout: 10000, what: 'le champ Heure' });
    await typeInput(timeInput, new Intl.DateTimeFormat(lang, { hour: 'numeric', minute: '2-digit' }).format(when));
    return true;
  }

  window.__kappgen = {
    version: VERSION,
    // True once the upload dialog's file picker is on the page.
    async waitForFilePicker() {
      await waitFor(() => document.querySelector('ytcp-uploads-dialog input[type="file"], input[type="file"][name="Filedata"]'),
        { timeout: 90000, what: 'la fenêtre d’envoi' });
      return true;
    },

    // Videos from the chosen folder: a hidden extension frame (bridge.html)
    // reads the file and posts it here; it is then given to Studio's picker
    // as if dropped by hand.
    async receiveFile({ selector, src, path }) {
      const input = await waitFor(() => document.querySelector(selector), { timeout: 120000, what: 'le sélecteur de fichier' });
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
          if (event.source !== frame.contentWindow || !data || data.kappgen !== 'file' || data.path !== path) return;
          if (data.error) done(reject, new Error(data.error));
          else done(resolve, data.file);
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
    },

    async fillDetails({ title, description }) {
      const titleBox = await waitFor(
        () => document.querySelector('#title-textarea #textbox, ytcp-video-title #textbox'),
        { timeout: 120000, what: 'le champ Titre' },
      );
      await sleep(1500); // Studio pre-fills the title from the file name.
      await typeInto(titleBox, title);
      const descriptionBox = document.querySelector('#description-textarea #textbox, ytcp-video-description #textbox');
      if (descriptionBox) await typeInto(descriptionBox, description || '');
      const notForKids = await waitFor(
        () => document.querySelector('tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]'),
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
      let input = document.querySelector('#tags-container input#text-input, ytcp-form-input-container#tags-container input');
      if (!visible(input)) {
        const more = document.querySelector('ytcp-uploads-dialog #toggle-button, ytcp-video-metadata-editor #toggle-button, #toggle-button');
        if (more) click(more);
        input = await waitFor(
          () => { const el = document.querySelector('#tags-container input#text-input, ytcp-form-input-container#tags-container input'); return visible(el) ? el : null; },
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
      const titleBox = await waitFor(() => document.querySelector('#title-textarea #textbox, ytcp-video-title #textbox'),
        { timeout: 60000, what: 'le champ Titre' });
      if (title) await typeInto(titleBox, title);
      const descriptionBox = document.querySelector('#description-textarea #textbox, ytcp-video-description #textbox');
      if (descriptionBox && description) await typeInto(descriptionBox, description);
      if (tags && tags.length) await this.fillTags({ tags }).catch(() => {});
      return true;
    },

    async saveEdit() {
      const button = await waitFor(() => {
        const b = findByText('ytcp-button#save, #save, ytcp-button, button', /^(Save|Enregistrer)$/i);
        return b && !b.hasAttribute('disabled') && b.getAttribute('aria-disabled') !== 'true' ? b : null;
      }, { timeout: 20000, what: 'le bouton Enregistrer (aucune modification détectée ?)' });
      click(button);
      await sleep(4000);
      return true;
    },

    // Present on the details page once Studio shows the custom thumbnail
    // uploader (only for verified channels).
    hasThumbnailPicker() {
      return !!document.querySelector('ytcp-uploads-dialog input#file-loader, ytcp-thumbnails-compact-editor-uploader input[type="file"]');
    },

    async chooseVisibility({ visibility, monetization, scheduleAt }) {
      const schedule = visibility === 'SCHEDULE' && scheduleAt;
      const name = ['PRIVATE', 'UNLISTED', 'PUBLIC'].includes(visibility) ? visibility : 'PRIVATE';
      // Details → Video elements → Checks → Visibility. "Next" stays
      // disabled while Studio is busy (checks, processing): wait for it.
      const start = Date.now();
      while (Date.now() - start < 90000) {
        const radio = document.querySelector(`tp-yt-paper-radio-button[name="${name}"]`);
        if (visible(radio)) {
          if (schedule) return scheduleFor(scheduleAt);
          click(radio);
          await sleep(800);
          return true;
        }
        if (await monetizationStep(monetization) || await adSuitabilityStep(monetization)) continue;
        const next = document.querySelector('ytcp-uploads-dialog #next-button');
        const enabled = next && visible(next) && !next.hasAttribute('disabled') && next.getAttribute('aria-disabled') !== 'true';
        if (enabled) click(next);
        await sleep(enabled ? 1500 : 700);
      }
      throw new Error('YouTube Studio : étape « Visibilité » introuvable.');
    },

    // Upload state as shown by Studio. The background worker polls this
    // (short calls keep its service worker alive for hours-long uploads).
    progress() {
      const label = uploadProgress();
      return { label, youtubeId: youtubeIdOnPage(), transferring: /\d\s*%/.test(label) };
    },

    // True while Studio still shows a transfer (dialog or video list).
    stillUploading() {
      return /Uploading\s*\d|\d\s*%\s*(uploaded|\.\.\.)|Envoi en cours|Importation/i.test(document.body.innerText || '');
    },

    // Saves once the transfer is over. Studio keeps processing on its side.
    async save() {
      const done = await waitFor(() => {
        const button = document.querySelector('ytcp-uploads-dialog #done-button');
        return button && !button.hasAttribute('disabled') && button.getAttribute('aria-disabled') !== 'true' ? button : null;
      }, { timeout: 120000, what: 'le bouton Enregistrer' }); // enabled even mid-transfer
      click(done);
      // Saved before Studio's checks are over, it asks for confirmation:
      // the video is unlisted, so "Publish anyway" is what we want.
      const start = Date.now();
      while (Date.now() - start < 6000) {
        const anyway = findByText(BUTTONS, /^(Publish anyway|Publier quand m[êe]me|Save anyway|Enregistrer quand m[êe]me)$/i);
        if (anyway) { click(anyway); await sleep(2000); break; }
        await sleep(400);
      }
      const close = document.querySelector('ytcp-video-share-dialog #close-button');
      if (close) click(close);
      await sleep(1500);
      return this.saveState();
    },

    // After Save: "closed" once the upload dialog is gone (or replaced by
    // the share dialog), "saving" while Studio shows "Saving…" with its
    // buttons greyed out, "open" if the dialog still waits for a click.
    saveState() {
      const close = document.querySelector('ytcp-video-share-dialog #close-button');
      if (close && visible(close)) { click(close); return 'closed'; }
      const dlg = dialog();
      if (!dlg || !visible(dlg)) return 'closed';
      if (/(Saving|Enregistrement( en cours)?|Sauvegarde)\s*(\.\.\.|…)/i.test(textOf(dlg))) return 'saving';
      const done = dlg.querySelector('#done-button');
      const disabled = !done || done.hasAttribute('disabled') || done.getAttribute('aria-disabled') === 'true';
      return disabled ? 'saving' : 'open';
    },

    // Fallback when the upload dialog never finishes saving: the video
    // already exists, so its visibility is set from its edit page
    // (studio.youtube.com/video/<id>/edit), then Save.
    async setVisibilityOnEdit({ visibility }) {
      const name = ['PRIVATE', 'UNLISTED', 'PUBLIC'].includes(visibility) ? visibility : 'UNLISTED';
      const trigger = await waitFor(() => {
        const t = document.querySelector('ytcp-video-metadata-visibility #select-button, ytcp-video-metadata-visibility ytcp-dropdown-trigger, ytcp-video-metadata-visibility [role="button"]');
        return visible(t) ? t : null;
      }, { timeout: 60000, what: 'le réglage Visibilité de la page de la vidéo' });
      click(trigger);
      const radio = await waitFor(() => {
        const r = document.querySelector(`tp-yt-paper-radio-button[name="${name}"]`);
        return visible(r) ? r : null;
      }, { timeout: 15000, what: 'le choix de visibilité' });
      click(radio);
      await sleep(600);
      const done = await waitFor(() => findByText(BUTTONS, /^(Done|OK|Termin[ée]|Enregistrer|Save)$/i), { timeout: 10000, what: 'le bouton Terminé' });
      click(done);
      await sleep(1000);
      return this.saveEdit();
    },
  };
})();
