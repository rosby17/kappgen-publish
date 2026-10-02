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

  const S = (key, vars) => window.KappRecipe.sel('studio', key, vars);
  const X = (key) => window.KappRecipe.re('studio', key);
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

  const dialog = () => document.querySelector(S('dialog'));

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
    const label = document.querySelector(S('progressLabel'));
    return (label && label.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function youtubeIdOnPage() {
    const root = dialog() || document;
    for (const a of root.querySelectorAll(S('links'))) {
      const m = a.href.match(X('youtubeLink'));
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


  // Monetized channels get a "Monetization" step (and, once ads are on, an
  // "Ad suitability" questionnaire) before Visibility. mode comes from the
  // channel settings: "on", "off", or "manual" (the creator finishes it).
  async function monetizationStep(mode) {
    const dlg = dialog() || document.body;
    const onStep = X('monetizationStep').test(textOf(dlg));
    const SELECT = X('select');
    const section = document.querySelector(S('monetizationSection'));
    const dropdown = findByText(S('monetizationDropdown'), SELECT);
    if (!dropdown || !(onStep || section)) return false;
    if (mode !== 'on' && mode !== 'off') {
      throw new Error('Chaîne monétisée : choisis « Monétisation » pour cette chaîne dans l’onglet Chaînes de KappGen, ou termine l’envoi dans l’onglet YouTube Studio resté ouvert.');
    }
    const trigger = dropdown || (section && section.querySelector(S('monetizationTrigger')));
    if (!trigger) throw new Error('YouTube Studio : menu « Monétisation » introuvable.');
    // Studio's dropdown opens on a pointer press, and its choices are not always
    // radio buttons ("On" / "Off" can be plain menu items with a description).
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) trigger.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    click(trigger);
    const wanted = X(mode === 'on' ? 'monetizationOn' : 'monetizationOff');
    const CHOICES = S('monetizationChoices');
    const findChoice = () => {
      const exact = document.querySelector(S('monetizationExact', { mode }));
      if (exact && visible(exact)) return exact;
      const hits = [...document.querySelectorAll(CHOICES)].filter((n) => visible(n) && wanted.test(textOf(n)) && textOf(n).length < 200);
      // the innermost match is the item itself, not a list that contains it
      return hits.find((n) => !hits.some((o) => o !== n && n.contains(o))) || null;
    };
    let option;
    try {
      option = await waitFor(findChoice, { timeout: 15000, what: 'le choix de monétisation' });
    } catch (error) {
      const seen = [...new Set([...document.querySelectorAll(CHOICES)].filter(visible).map(textOf).filter((t) => t && t.length < 80))].slice(0, 8);
      throw new Error(`${error.message} Choix visibles : ${seen.join(' | ') || 'aucun'}.`);
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

  async function adSuitabilityStep(mode) {
    const none = findByText(S('adCheckbox'), X('adNone'));
    if (!none) return false;
    if (mode !== 'on') {
      throw new Error('YouTube Studio demande le questionnaire « Adéquation publicitaire » : termine-le dans l’onglet Studio resté ouvert.');
    }
    if (none.getAttribute('aria-checked') !== 'true' && !none.hasAttribute('checked')) click(none);
    await sleep(600);
    const submit = await waitFor(() => findByText(S('buttons'), X('adSubmit')), { timeout: 10000, what: 'le bouton « Submit rating »' });
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
    const dateTrigger = await waitFor(() => document.querySelector(S('dateTrigger')), { timeout: 10000, what: 'la date de programmation' });
    click(dateTrigger);
    const dateInput = await waitFor(() => {
      const input = document.querySelector(S('dateInput'));
      return visible(input) ? input : null;
    }, { timeout: 10000, what: 'le champ Date' });
    await typeInput(dateInput, new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short', year: 'numeric' }).format(when));
    const timeInput = await waitFor(() => {
      const input = document.querySelector(S('timeInput'));
      return visible(input) ? input : null;
    }, { timeout: 10000, what: 'le champ Heure' });
    await typeInput(timeInput, new Intl.DateTimeFormat(lang, { hour: 'numeric', minute: '2-digit' }).format(when));
    return true;
  }

  window.__kappgen = {
    version: VERSION,
    // True once the upload dialog's file picker is on the page.
    async waitForFilePicker() {
      await waitFor(() => document.querySelector(S('filePicker')),
        { timeout: 90000, what: 'la fenêtre d’envoi' });
      return true;
    },

    // Videos from the chosen folder: a hidden extension frame (bridge.html)
    // reads the file and posts it here; it is then given to Studio's picker
    // as if dropped by hand.
    async receiveFile({ selector, src, path }) {
      const input = await waitFor(() => document.querySelector(selector ? S(selector) : S('videoInput')), { timeout: 120000, what: 'le sélecteur de fichier' });
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
        () => document.querySelector(S('titleBox')),
        { timeout: 120000, what: 'le champ Titre' },
      );
      await sleep(1500); // Studio pre-fills the title from the file name.
      await typeInto(titleBox, title);
      const descriptionBox = document.querySelector(S('descriptionBox'));
      if (descriptionBox) await typeInto(descriptionBox, description || '');
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
      if (title) await typeInto(titleBox, title);
      const descriptionBox = document.querySelector(S('descriptionBox'));
      if (descriptionBox && description) await typeInto(descriptionBox, description);
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

    async chooseVisibility({ visibility, monetization, scheduleAt }) {
      const schedule = visibility === 'SCHEDULE' && scheduleAt;
      const name = ['PRIVATE', 'UNLISTED', 'PUBLIC'].includes(visibility) ? visibility : 'PRIVATE';
      // Details → Video elements → Checks → Visibility. "Next" stays
      // disabled while Studio is busy (checks, processing): wait for it.
      const start = Date.now();
      while (Date.now() - start < 90000) {
        const radio = document.querySelector(S('visibilityRadio', { name }));
        if (visible(radio)) {
          if (schedule) return scheduleFor(scheduleAt);
          click(radio);
          await sleep(800);
          return true;
        }
        if (await monetizationStep(monetization) || await adSuitabilityStep(monetization)) continue;
        const next = document.querySelector(S('nextButton'));
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
      return { label, youtubeId: youtubeIdOnPage(), transferring: X('transferring').test(label) };
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
      return this.saveState();
    },

    // After Save: "closed" once the upload dialog is gone (or replaced by
    // the share dialog), "saving" while Studio shows "Saving…" with its
    // buttons greyed out, "open" if the dialog still waits for a click.
    saveState() {
      const close = document.querySelector(S('shareClose'));
      if (close && visible(close)) { click(close); return 'closed'; }
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
    async setVisibilityOnEdit({ visibility }) {
      const name = ['PRIVATE', 'UNLISTED', 'PUBLIC'].includes(visibility) ? visibility : 'UNLISTED';
      const trigger = await waitFor(() => {
        const t = document.querySelector(S('visibilityTrigger'));
        return visible(t) ? t : null;
      }, { timeout: 60000, what: 'le réglage Visibilité de la page de la vidéo' });
      click(trigger);
      const radio = await waitFor(() => {
        const r = document.querySelector(S('visibilityRadio', { name }));
        return visible(r) ? r : null;
      }, { timeout: 15000, what: 'le choix de visibilité' });
      click(radio);
      await sleep(600);
      const done = await waitFor(() => findByText(S('buttons'), X('done')), { timeout: 10000, what: 'le bouton Terminé' });
      click(done);
      await sleep(1000);
      return this.saveEdit();
    },
  };
})();
