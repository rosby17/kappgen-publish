// Side panel: the whole extension in one place, next to the page being
// viewed (choose the publication folder, videos waiting, YouTube updates,
// Facebook derivatives, KappGen videos and progress). Unlike a popup it stays
// open while Chrome's folder picker is shown.
const $ = (id) => document.getElementById(id);

function send(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, (reply) => {
    const error = chrome.runtime.lastError;
    resolve(error ? { ok: false, error: error.message || 'Le service KappGen Publish ne répond pas.' } : reply);
  }));
}

const size = (bytes) => (!bytes ? '' : bytes > 1e9 ? `${(bytes / 1e9).toFixed(1)} Go` : `${Math.round(bytes / 1e6)} Mo`);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function objectImage(file, className = '') {
  const img = document.createElement('img');
  if (className) img.className = className;
  img.alt = '';
  const url = URL.createObjectURL(file);
  const release = () => URL.revokeObjectURL(url);
  img.addEventListener('load', release, { once: true });
  img.addEventListener('error', release, { once: true });
  img.src = url;
  return img;
}

// Small preview of the thumbnail file kept in the folder.
function thumb(path) {
  const box = el('div', 'thumb');
  if (path) {
    KappDossier.fileAt(path).then((file) => {
      box.append(objectImage(file));
    }).catch(() => { box.classList.add('empty'); });
  } else {
    box.classList.add('empty');
    box.textContent = 'Pas de miniature';
  }
  return box;
}

function button(label, className, onClick) {
  const node = el('button', className, label);
  node.addEventListener('click', onClick);
  return node;
}

function normalizedFacebookPage(value) {
  if (!String(value || '').trim()) return null;
  try {
    const url = new URL(value);
    const hosts = new Set(['facebook.com', 'www.facebook.com', 'web.facebook.com', 'm.facebook.com', 'mobile.facebook.com', 'business.facebook.com']);
    if (url.protocol !== 'https:' || !hosts.has(url.hostname.toLowerCase()) || url.username || url.password) return null;
    url.hostname = 'www.facebook.com';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

// Small status line with a coloured dot: ok, warn, info, busy (spinner).
function pill(kind, text) {
  return el('div', `pill ${kind}`, text);
}

function liveRegion() {
  const node = el('div', 'live');
  node.setAttribute('role', 'status');
  node.setAttribute('aria-live', 'polite');
  node.setAttribute('aria-atomic', 'true');
  return node;
}

// Small line icons (no emoji): clock, link, play, refresh.
const ICON_PATHS = {
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2l2 2h8.8A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  link: '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
  short: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="m10.5 9.5 4 2.5-4 2.5z"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.8 2.8L16.5 9.5"/>',
  dots: '<circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/>',
  trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7"/>',
};
function icon(name) {
  const span = el('span', 'ico-wrap');
  span.innerHTML = `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`;
  return span.firstChild;
}
// A status line with an icon in place of the dot.
function pillIcon(kind, text, name) {
  const node = pill(kind, '');
  node.classList.add('with-icon');
  node.append(icon(name), el('span', null, text));
  return node;
}

// One compact line for a video (YouTube, Facebook, TikTok, Instagram):
// picture, title, details, state and small buttons, like the posts.
// vertical: a Short — its own vertical picture (YouTube's vertical thumbnail,
// or a frame of short.mp4 before it is online), a « SHORT » badge, same height.
// extra (a field…) and then the buttons take the whole width under the line.
function mediaRow({ path, preview, youtubeId, emptyLabel = 'Vidéo', title, detail, status, actions = [], extra = [], vertical = null }) {
  const item = el('li', 'row media');
  if (path) item.dataset.path = path;
  const mini = el('div', 'mini wide', emptyLabel);
  const show = (src, revoke = false) => {
    const img = document.createElement('img');
    img.alt = '';
    if (revoke) {
      const release = () => URL.revokeObjectURL(src);
      img.addEventListener('load', release, { once: true });
      img.addEventListener('error', release, { once: true });
    }
    img.src = src;
    mini.replaceChildren(img);
  };
  if (vertical) {
    mini.classList.add('vertical');
    const tall = (src) => {
      const bg = document.createElement('img'); bg.className = 'bg'; bg.alt = ''; bg.src = src;
      const fg = document.createElement('img'); fg.className = 'fg'; fg.alt = ''; fg.src = src;
      mini.replaceChildren(bg, fg, el('span', 'badge-short', 'SHORT'));
    };
    mini.replaceChildren(el('span', 'badge-short', 'SHORT'));
    const fromFile = () => vertical.file && KappDossier.fileAt(vertical.file).then(frameOf).then(tall).catch(() => {});
    if (vertical.youtubeId) {
      // oardefault = the Short's own vertical thumbnail (absent for some: then the file)
      const probe = new Image();
      probe.onload = () => (probe.naturalHeight > probe.naturalWidth ? tall(probe.src) : (fromFile() || tall(probe.src)));
      probe.onerror = () => fromFile() || tall(`https://i.ytimg.com/vi/${vertical.youtubeId}/hqdefault.jpg`);
      probe.src = `https://i.ytimg.com/vi/${vertical.youtubeId}/oardefault.jpg`;
    } else fromFile();
  } else if (youtubeId) show(`https://i.ytimg.com/vi/${youtubeId}/mqdefault.jpg`);
  else if (preview) KappDossier.fileAt(preview).then((file) => show(URL.createObjectURL(file), true)).catch(() => {});
  const what = el('div', 'what');
  const t = el('div', 't', title);
  t.title = title || '';
  what.append(t);
  if (detail) what.append(el('div', 'd', detail));
  const live = liveRegion();
  const hint = (node) => { if (node && !node.title) node.title = node.textContent || ''; return node; };
  if (status) live.append(hint(status));
  what.append(live);
  const acts = el('div', 'acts');
  acts.append(...actions);
  item.append(mini, what);
  if (extra.length) {
    // A field under the line: the buttons go with it, full width.
    for (const node of extra) { node.classList.add('row-extra'); item.append(node); }
    acts.classList.add('below');
  }
  item.append(acts);
  item.say = (kind, text) => live.replaceChildren(hint(pill(kind, text)));
  return item;
}
// A small picture of a video file (a frame at 1 s), for Shorts not yet online.
function frameOf(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(file);
    video.muted = true;
    video.preload = 'metadata';
    video.onloadedmetadata = () => { video.currentTime = Math.min(1, (video.duration || 2) / 3); };
    video.onseeked = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(video.videoWidth / 6));
      canvas.height = Math.max(1, Math.round(video.videoHeight / 6));
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.82));
    };
    video.onerror = () => { URL.revokeObjectURL(url); reject(new Error('frame')); };
    video.src = url;
  });
}
// Studio's long error messages, said short on one line (full text on hover).
function shortError(text) {
  const msg = String(text || '');
  if (/Adéquation publicitaire/i.test(msg)) return 'Questionnaire « Adéquation publicitaire » à finir dans Studio';
  if (/Monétisation/i.test(msg)) return 'Étape « Monétisation » à finir dans Studio';
  return msg;
}
function iconLink(name, label, href) {
  const a = el('a', 'btn ghost icon-btn');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.title = label;
  a.append(icon(name), el('span', null, label));
  return a;
}

// One card: thumbnail, title, details, status and a row of actions.
function card({ path, preview, emptyLabel, title, details = [], status, actions = [], extra = [] }) {
  const item = el('li', 'item');
  if (path) item.dataset.path = path;
  const box = preview !== undefined ? thumb(preview) : el('div', 'thumb empty', emptyLabel || '');
  if (preview === undefined && emptyLabel) box.textContent = emptyLabel;
  const info = el('div', 'info');
  info.append(el('div', 'title', title));
  for (const line of details.filter(Boolean)) info.append(el('div', 'meta', line));
  const live = liveRegion();
  if (status) live.append(status);
  info.append(live);
  item.append(box, info);
  for (const node of extra) item.append(node);
  if (actions.length) {
    const row = el('div', 'actions-row');
    row.append(...actions);
    item.append(row);
  }
  item.say = (kind, text) => live.replaceChildren(pill(kind, text));
  return item;
}

// « Modifier l'heure »: a date and time field opened under the card.
const pad2 = (n) => String(n).padStart(2, '0');
const whenText = (ts) => new Date(ts).toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
// Date and time picker drawn in the panel's own style (Chrome's default one
// does not fit): a month to browse, the day, then hour and minutes.
const MONTHS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
function pickDateTime(current, { clearable = false, title = 'Date et heure de publication' } = {}) {
  return new Promise((resolve) => {
    const start = new Date(current || Date.now() + 3600 * 1000);
    start.setSeconds(0, 0);
    start.setMinutes(Math.ceil(start.getMinutes() / 15) * 15);
    let chosen = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    let shown = new Date(start.getFullYear(), start.getMonth(), 1);
    let hour = start.getHours();
    let minute = start.getMinutes();
    const overlay = el('div', 'dt-overlay');
    const box = el('div', 'dt-box');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', title);
    const head = el('div', 'dt-head');
    const prev = button('‹', 'dt-nav', () => { shown = new Date(shown.getFullYear(), shown.getMonth() - 1, 1); draw(); });
    const next = button('›', 'dt-nav', () => { shown = new Date(shown.getFullYear(), shown.getMonth() + 1, 1); draw(); });
    const monthLabel = el('strong', 'dt-month');
    head.append(prev, monthLabel, next);
    const grid = el('div', 'dt-grid');
    const time = el('div', 'dt-time');
    const hourOut = el('span', 'dt-num');
    const minOut = el('span', 'dt-num');
    const changeMinute = (delta) => {
      const nextMinute = minute + delta;
      if (nextMinute < 0) hour = (hour + 23) % 24;
      if (nextMinute >= 60) hour = (hour + 1) % 24;
      minute = (nextMinute + 60) % 60;
      drawTime();
    };
    const stepper = (out, onMinus, onPlus) => {
      const wrap = el('div', 'dt-step');
      wrap.append(button('−', 'dt-nav', onMinus), out, button('+', 'dt-nav', onPlus));
      return wrap;
    };
    time.append(el('span', 'dt-label', 'Heure'),
      stepper(hourOut, () => { hour = (hour + 23) % 24; drawTime(); }, () => { hour = (hour + 1) % 24; drawTime(); }),
      el('span', 'dt-sep', ':'),
      stepper(minOut, () => changeMinute(-15), () => changeMinute(15)));
    const error = el('p', 'dt-error');
    error.hidden = true;
    const foot = el('div', 'dt-foot');
    const close = (value) => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(value); };
    const save = button('Enregistrer', 'btn primary', () => {
      const at = new Date(chosen.getFullYear(), chosen.getMonth(), chosen.getDate(), hour, minute).getTime();
      if (at < Date.now() + 20 * 60 * 1000) {
        error.textContent = 'Choisis un quart d’heure situé au moins 20 minutes dans le futur.';
        error.hidden = false;
        return;
      }
      close(at);
    });
    foot.append(button('Annuler', 'btn ghost', () => close(undefined)));
    if (clearable) foot.append(button('Retirer l’heure', 'btn ghost', () => close(null)));
    foot.append(save);
    box.append(el('div', 'dt-title', title), head, grid, time, error, foot);
    overlay.append(box);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(undefined); });
    const onKey = (e) => { if (e.key === 'Escape') close(undefined); };
    document.addEventListener('keydown', onKey);
    function drawTime() { hourOut.textContent = String(hour).padStart(2, '0'); minOut.textContent = String(minute).padStart(2, '0'); error.hidden = true; }
    function draw() {
      monthLabel.textContent = `${MONTHS_FR[shown.getMonth()]} ${shown.getFullYear()}`;
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const cells = ['L', 'M', 'M', 'J', 'V', 'S', 'D'].map((d) => el('span', 'dt-dow', d));
      const offset = (shown.getDay() + 6) % 7;
      for (let i = 0; i < offset; i += 1) cells.push(el('span', 'dt-empty'));
      const days = new Date(shown.getFullYear(), shown.getMonth() + 1, 0).getDate();
      for (let d = 1; d <= days; d += 1) {
        const date = new Date(shown.getFullYear(), shown.getMonth(), d);
        const cell = button(String(d), 'dt-day', () => { chosen = date; error.hidden = true; draw(); });
        if (date < today) cell.disabled = true;
        if (date.getTime() === today.getTime()) cell.classList.add('today');
        if (date.getTime() === chosen.getTime()) cell.classList.add('chosen');
        cells.push(cell);
      }
      grid.replaceChildren(...cells);
    }
    draw();
    drawTime();
    document.body.append(overlay);
    save.focus();
  });
}

function timeButton(getItem, current, onSave, { label = 'Modifier l’heure', clearable = false } = {}) {
  return button(label, 'btn ghost', async () => {
    const at = await pickDateTime(current, { clearable });
    if (at === undefined) return; // cancelled
    await onSave(at);
  });
}

// What a click returns: an error is shown on the card itself.
async function act(item, buttonNode, message, busyText) {
  buttonNode.disabled = true;
  const reply = await send(message);
  if (!reply || !reply.ok) {
    buttonNode.disabled = false;
    item.say('warn', reply ? reply.error : 'Action impossible.');
    return null;
  }
  if (busyText) item.say('busy', busyText);
  return reply.data || {};
}

async function settings() {
  const { folder } = await chrome.storage.local.get('folder');
  const current = { channels: {}, ...(folder || {}) };
  return current;
}

async function saveChannel(key, patch) {
  const current = await settings();
  current.channels[key] = { ...(current.channels[key] || {}), ...patch };
  await chrome.storage.local.set({ folder: current });
}

let jobRunning = false;

// ------------------------------------------------------------------ tabs

for (const tab of document.querySelectorAll('nav [data-tab]')) {
  tab.setAttribute('aria-controls', `tab-${tab.dataset.tab}`);
  const networkTab = !!tab.closest('.tabs');
  if (networkTab) {
    tab.id = `network-tab-${tab.dataset.tab}`;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(tab.classList.contains('active')));
    tab.tabIndex = tab.classList.contains('active') ? 0 : -1;
    const pane = $(`tab-${tab.dataset.tab}`);
    if (pane) {
      pane.setAttribute('role', 'tabpanel');
      pane.setAttribute('aria-labelledby', tab.id);
    }
  } else {
    tab.setAttribute('aria-pressed', String(tab.classList.contains('active')));
  }
  tab.addEventListener('click', () => {
    for (const other of document.querySelectorAll('nav [data-tab]')) {
      const active = other === tab;
      other.classList.toggle('active', active);
      if (other.closest('.tabs')) other.setAttribute('aria-selected', String(active));
      else other.setAttribute('aria-pressed', String(active));
      other.tabIndex = other.closest('.tabs') ? (active ? 0 : -1) : 0;
    }
    if (!tab.closest('.tabs')) {
      const firstNetwork = [...document.querySelectorAll('.tabs [data-tab]')].find((item) => !item.hidden);
      if (firstNetwork) firstNetwork.tabIndex = 0;
    }
    for (const pane of document.querySelectorAll('.tab')) pane.hidden = pane.id !== `tab-${tab.dataset.tab}`;
  });
  if (networkTab) tab.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...document.querySelectorAll('.tabs [data-tab]')].filter((item) => !item.hidden);
    const index = tabs.indexOf(tab);
    const next = event.key === 'Home' ? tabs[0]
      : event.key === 'End' ? tabs.at(-1)
        : tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    if (next) { event.preventDefault(); next.click(); next.focus(); }
  });
}

// ------------------------------------------------------------ first run

// Right after signing in, nothing can go out before the folder is chosen:
// say so, show what is left, and open the settings once by ourselves.
let setupOpened = false;
async function renderSetup() {
  const config = await settings();
  const folderOk = (await KappDossier.access()).state === 'granted';
  // Only Facebook routes publications by a saved Page URL. Other networks
  // publish to the account that is already connected in this Chrome profile.
  const pagesOk = !networkIsOn(config, 'facebook') || !!pageUrlOf(config, 'facebook');
  const fbOk = (await KappDossier.fbAccess().catch(() => ({}))).state === 'granted';
  $('setup-folder').classList.toggle('done', folderOk);
  $('setup-fb').classList.toggle('done', fbOk);
  $('setup-pages').classList.toggle('done', pagesOk);
  $('setup-pages').closest('li').hidden = !networkIsOn(config, 'facebook');
  // The posts folder is optional: the card goes once the videos folder and the
  // links are set, or for good when closed with its ✕.
  const { setupClosed } = await chrome.storage.local.get('setupClosed');
  $('setup').hidden = !!setupClosed || (folderOk && pagesOk);
  if (!folderOk && !setupOpened) {
    setupOpened = true;
    document.querySelector('.topbar [data-tab="settings"]').click();
  }
}
$('setup-close').addEventListener('click', async () => {
  await chrome.storage.local.set({ setupClosed: true });
  $('setup').hidden = true;
});

// Each step opens the settings right on its own card, which lights up briefly.
for (const stepButton of document.querySelectorAll('.setup-steps button')) {
  stepButton.addEventListener('click', () => {
    document.querySelector('.topbar [data-tab="settings"]').click();
    const target = $(stepButton.dataset.target);
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target.classList.remove('flash');
    void target.offsetWidth;
    target.classList.add('flash');
  });
}

// ---------------------------------------------------------------- folder

// A chosen folder shows as "✓ Dossier sélectionné : NAME" and its big button
// disappears; "changer" stays available. Same for the Facebook folder.
function showFolder(prefix, access) {
  const granted = access.state === 'granted';
  $(`${prefix}folder-chosen`).hidden = !granted;
  $(`${prefix}folder-name`).textContent = access.name || '';
  $(`${prefix}folder-actions`).hidden = granted;
  $(`${prefix}folder-hint`).hidden = granted;
  $(`${prefix}pick`).hidden = access.state === 'prompt';
  $(`${prefix}grant`).hidden = access.state !== 'prompt';
  const status = $(`${prefix}folder-status`);
  status.hidden = access.state !== 'prompt';
  status.className = 'status error';
  status.textContent = access.state === 'prompt'
    ? `« ${access.name} » : Chrome redemande l’accès. Clique « Autoriser l’accès » puis « Autoriser à chaque visite ».`
    : '';
}

async function renderAccess() {
  const access = await KappDossier.access();
  showFolder('', access);
  return access.state === 'granted';
}

// channel key → visibility of its settings, filled by renderFolder.
const autoVisibility = new Map();
const VISIBILITY_LABELS = {
  UNLISTED: 'non répertoriée',
  PUBLIC: 'publique',
  PRIVATE: 'privée',
  SCHEDULE: 'programmée',
};
let defaultVisibility = 'UNLISTED';
const visibilityOf = (key) => VISIBILITY_LABELS[autoVisibility.get(key)] ? autoVisibility.get(key) : defaultVisibility;
// Channel names are only shown when the folder holds several channels.
let showChannels = false;
const chan = (name) => (showChannels ? name : null);

function videoItem(video) {
  const planned = video.schedule_at && video.schedule_at > Date.now();
  const status = video.last_error ? pill('warn', video.last_error)
    : planned ? pill('ok', `Programmée : publique sur YouTube le ${whenText(video.schedule_at)}${video.auto_ok ? ' (envoyée à YouTube dès maintenant)' : ''}.`)
      : video.auto_ok ? pill('ok', visibilityOf(video.channel_key) === 'SCHEDULE' ? 'Partira toute seule, au prochain horaire.' : `Partira toute seule (${VISIBILITY_LABELS[visibilityOf(video.channel_key)]}).`)
        : pill('neutral', video.auto_blocked || 'Envoi manuel.');
  // « Publier maintenant »: out now, with the chosen visibility (never a later slot).
  const go = button('Publier maintenant', 'btn primary', async () => {
    const config = await settings();
    const own = config.channels[video.channel_key] || {};
    const base = ['PUBLIC', 'UNLISTED', 'PRIVATE'].includes(own.visibility) ? own.visibility
      : ['PUBLIC', 'UNLISTED', 'PRIVATE'].includes(config.visibility) ? config.visibility : 'UNLISTED';
    await act(item, go, { type: 'publish', source: 'folder', videoId: video.id, visibility: base }, 'Envoi vers YouTube en cours…');
  });
  go.dataset.publish = '1';
  const plan = timeButton(() => item, video.schedule_at, async (at) => {
    await KappDossier.mark(video.relative_path, 'schedule', { at });
    send({ type: 'autoNow' });
    renderFolder();
  }, { label: video.schedule_at ? 'Modifier l’heure' : 'Programmer', clearable: true });
  const already = button('Déjà publiée', 'btn ghost', async () => {
    await KappDossier.mark(video.relative_path, 'ignored');
    renderFolder();
  });
  already.title = 'Elle est déjà sur YouTube : la retirer de la liste sans l’envoyer.';
  // Not meant to be published at all (a test, a preview…): set aside for good.
  const drop = button('Ne pas publier', 'btn ghost', async () => {
    if (!confirm('Cette vidéo ne sera jamais publiée (même automatiquement).\nTu pourras la remettre depuis « Retirées ».')) return;
    await KappDossier.mark(video.relative_path, 'excluded');
    renderFolder();
  });
  drop.title = 'Ne jamais publier cette vidéo';
  const item = card({
    path: video.relative_path, preview: video.preview_path, title: video.title,
    details: [chan(video.channel_name), [size(video.size_bytes), video.thumbnail_path ? 'miniature' : 'sans miniature',
      video.tags.length ? `${video.tags.length} mots-clés` : null].filter(Boolean).join(' · ')],
    status, actions: [go, moreMenu([
      entryOf(plan, video.schedule_at ? 'Changer l’heure de publication' : 'Programmer', 'clock'),
      entryOf(already, 'Déjà publiée (déjà sur YouTube)', 'check'),
      entryOf(drop, 'Ne pas publier', 'trash', { danger: true }),
    ])],
  });
  if (video.thumbnail_warning && !video.last_error) item.querySelector('.info').append(pill('warn', video.thumbnail_warning));
  item.dataset.ytKinds = 'video';
  item.dataset.ytFailed = video.last_error ? '1' : '';
  return item;
}

function channelItem(channel, panelOwn) {
  // What the channel folder says (reglages-publication.json) wins over the panel.
  const fromFile = channel.config || {};
  const own = { ...panelOwn, ...fromFile };
  const item = el('li');
  const row = el('div', 'channel-row');
  const name = el('div');
  name.append(el('strong', null, channel.name), el('div', 'path', `${channel.videos} en attente`));
  const fileKeys = Object.keys(fromFile).filter((key) => key !== 'channelId');
  if (fileKeys.length) name.append(el('div', 'path', 'Réglée par reglages-publication.json (dossier de la chaîne)'));
  const label = el('label');
  const auto = document.createElement('input');
  auto.type = 'checkbox';
  auto.checked = own.auto !== false;
  label.append(auto, document.createTextNode('Auto'));
  auto.addEventListener('change', async () => {
    await saveChannel(channel.key, { auto: auto.checked });
    renderFolder();
    if (auto.checked) send({ type: 'autoNow' });
  });
  const money = document.createElement('select');
  money.title = 'Chaînes monétisées : étape « Monétisation » de YouTube Studio';
  for (const [value, text] of [
    ['on', 'Monétisation : activée'],
    ['off', 'Monétisation : désactivée'],
    ['manual', 'Monétisation : je termine moi-même'],
  ]) {
    const option = el('option', null, text);
    option.value = value;
    money.append(option);
  }
  money.value = own.monetization || 'on';
  money.addEventListener('change', async () => {
    if (money.value === 'on' && !confirm('Pour chaque vidéo de cette chaîne, KappGen activera les annonces et répondra « None of the above » (aucun contenu sensible) au questionnaire d’adéquation publicitaire de YouTube.\n\nC’est une déclaration faite en ton nom : à choisir seulement si c’est vrai pour toutes ses vidéos.')) {
      money.value = own.monetization || 'on';
      return;
    }
    await saveChannel(channel.key, { monetization: money.value });
    own.monetization = money.value;
  });
  const socialLabel = document.createElement('label');
  socialLabel.className = 'social-row net-facebook';
  const social = document.createElement('input');
  social.type = 'checkbox';
  social.checked = own.facebook === true;
  social.disabled = !channel.videos && !own.youtubeChannelId;
  socialLabel.append(social, document.createTextNode('Facebook aussi'));
  social.title = 'Après YouTube, publie aussi sur la page Facebook : la version verticale (short.mp4/reel.mp4 → Short + Reel) si elle existe, sinon la vidéo longue.';
  social.addEventListener('change', async () => {
    await saveChannel(channel.key, { facebook: social.checked });
    if (social.checked) send({ type: 'autoNow' });
  });
  const facebookPage = document.createElement('input');
  facebookPage.type = 'url';
  facebookPage.classList.add('net-facebook');
  // Always visible: the Page is also needed by the scheduled posts of
  // FACEBOOK/A-PUBLIER, even when the videos do not go to Facebook.
  facebookPage.placeholder = 'Lien de ta page Facebook, ex. https://www.facebook.com/MaPage';
  facebookPage.value = own.facebookPageUrl || '';
  facebookPage.title = 'Page Facebook de cette chaîne : posts programmés (FACEBOOK/A-PUBLIER) et vidéos si « Facebook aussi » est coché.';
  facebookPage.addEventListener('change', async () => {
    const raw = facebookPage.value.trim();
    const page = normalizedFacebookPage(raw);
    if (raw && !page) {
      facebookPage.setCustomValidity('Colle un lien https://www.facebook.com/…');
      facebookPage.reportValidity();
      return;
    }
    facebookPage.setCustomValidity('');
    facebookPage.value = page || '';
    await saveChannel(channel.key, { facebookPageUrl: page });
    send({ type: 'autoNow' });
  });
  facebookPage.addEventListener('input', () => facebookPage.setCustomValidity(''));
  const visibility = document.createElement('select');
  visibility.title = 'Comment chaque vidéo de cette chaîne arrive sur YouTube.';
  for (const [value, text] of [
    ['UNLISTED', 'Visibilité : non répertoriée (tu la passes en public)'],
    ['PUBLIC', 'Visibilité : publique tout de suite'],
    ['PRIVATE', 'Visibilité : privée'],
    ['SCHEDULE', 'Visibilité : programmée (publique à l’heure choisie)'],
  ]) {
    const option = el('option', null, text);
    option.value = value;
    visibility.append(option);
  }
  const current = VISIBILITY_LABELS[own.visibility] ? own.visibility : 'UNLISTED';
  visibility.value = current;
  autoVisibility.set(channel.key, current);
  const times = document.createElement('input');
  times.type = 'text';
  times.placeholder = 'Heures de publication, ex. 18:00 ou 9:00, 18:30';
  times.value = own.times || '18:00';
  times.title = 'Une vidéo par créneau : chaque nouvelle vidéo prend le prochain créneau libre (heures de ton ordinateur).';
  times.hidden = current !== 'SCHEDULE';
  times.addEventListener('input', () => times.setCustomValidity(''));
  times.addEventListener('change', async () => {
    const normalized = normalizeTimes(times.value);
    if (!normalized) {
      times.setCustomValidity('Écris des quarts d’heure valides, par exemple 09:00, 18:30.');
      times.reportValidity();
      return;
    }
    times.setCustomValidity('');
    times.value = normalized;
    await saveChannel(channel.key, { times: normalized });
  });
  visibility.addEventListener('change', async () => {
    if (visibility.value === 'PUBLIC' && !confirm(`${channel.name} : chaque vidéo prête sera PUBLIÉE directement sur YouTube, sans que tu la valides.`)) {
      visibility.value = own.visibility || 'UNLISTED';
      return;
    }
    const normalized = normalizeTimes(times.value);
    if (visibility.value === 'SCHEDULE' && !normalized) {
      times.hidden = false;
      times.setCustomValidity('Écris des quarts d’heure valides, par exemple 09:00, 18:30.');
      times.reportValidity();
      visibility.value = own.visibility || 'UNLISTED';
      return;
    }
    await saveChannel(channel.key, { visibility: visibility.value, times: normalized || '18:00' });
    own.visibility = visibility.value;
    autoVisibility.set(channel.key, visibility.value);
    times.hidden = visibility.value !== 'SCHEDULE';
    renderFolder();
  });
  // Controls fixed by the channel's file are shown but locked.
  const locked = { auto: [auto], facebook: [social], facebookPageUrl: [facebookPage], monetization: [money], visibility: [visibility], times: [times] };
  for (const key of fileKeys) for (const control of locked[key] || []) {
    control.disabled = true;
    control.title = 'Fixé par reglages-publication.json dans le dossier de la chaîne.';
  }
  row.append(name, label, socialLabel, facebookPage, money, visibility, times);
  item.append(row);
  return item;
}

// YouTube tab filters: Tout / Vidéos / Shorts / Échecs, on the waiting and the published lists.
let ytFilter = '';
function applyYtFilter() {
  const shown = (list) => [...document.querySelectorAll(`#${list} > li`)].filter((item) => {
    const kind = item.dataset.ytKinds || 'video';
    item.hidden = ytFilter === 'echec' ? item.dataset.ytFailed !== '1' : !!ytFilter && kind !== ytFilter;
    return !item.hidden;
  }).length;
  const waiting = shown('videos');
  const sent = shown('sent');
  const what = { video: ['Aucune vidéo en attente.', 'Vidéos déjà publiées'], short: ['Aucun Short en attente.', 'Shorts déjà publiés'],
    echec: ['Aucun échec en attente.', 'Échecs parmi les publiées'] }[ytFilter] || ['Rien en attente : tout ce qui est dans le dossier est déjà publié (plus bas).', 'Déjà publiés'];
  $('no-videos').textContent = what[0];
  $('no-videos').hidden = waiting > 0 || !lastScan;
  $('sent-title').textContent = `${what[1]} (${sent})`;
  $('sent-box').hidden = !sent;
}
for (const chip of document.querySelectorAll('#yt-filters .chip')) {
  chip.addEventListener('click', () => {
    ytFilter = chip.dataset.type;
    for (const other of document.querySelectorAll('#yt-filters .chip')) other.classList.toggle('active', other === chip);
    applyYtFilter();
  });
}

function sentItem(video) {
  const actions = [];
  const extra = [];
  let status;
  let item;
  if (video.manual && !video.youtube_id) {
    // Marked "Déjà publiée": published by hand, nothing to send or update.
    status = pill('ok', 'Publiée à la main (rien à envoyer).');
  } else if (!video.youtube_id) {
    // Sent, but its YouTube link is unknown: give it, or send it again.
    status = pill('warn', 'Lien YouTube pas enregistré.');
    const group = el('div', 'input-group');
    const input = document.createElement('input');
    input.type = 'url';
    input.placeholder = 'https://youtu.be/…';
    const save = button('Enregistrer', 'btn secondary', async () => {
      const data = await act(item, save, { type: 'linkYoutube', path: video.relative_path, url: input.value.trim() });
      if (data) { item.say('busy', 'Lien enregistré : titre, description et miniature vont être appliqués…'); setTimeout(renderFolder, 1500); }
    });
    group.append(input, save);
    const field = el('div', 'field');
    field.append(el('label', null, 'Déjà sur YouTube ? Colle son lien :'), group);
    extra.push(field);
    const again = button('Republier', 'btn ghost', async () => {
      if (!confirm('La vidéo sera envoyée de nouveau sur YouTube, avec le titre, la description et la miniature du dossier.\n\nPense à supprimer l’ancienne version dans YouTube Studio.')) return;
      await act(item, again, { type: 'republish', path: video.relative_path }, 'Nouvel envoi vers YouTube en cours…');
    });
    again.title = 'Republier sur YouTube avec le titre, la description et la miniature du dossier';
    actions.push(again);
  } else {
    if (!video.has_content) status = pill('neutral', 'Aucune fiche ni miniature dans le dossier.');
    else if (video.applied_hash === video.hash) status = pill('ok', 'À jour sur YouTube.');
    else if (video.update_error && video.update_tried_hash === video.hash) status = pill('warn', `Mise à jour échouée : ${video.update_error}`);
    else status = pill('neutral', 'Modifications à envoyer : mise à jour toute seule dans 5 à 10 min.');
    // A published video needs no buttons: it is listed small, and updated by
    // itself. "Mettre à jour" only shows when an update failed.
    actions.push(iconLink('link', 'Voir', `https://youtu.be/${video.youtube_id}`));
    if (video.update_error && video.update_tried_hash === video.hash) {
      const update = button('Réessayer', 'btn primary', () => act(item, update,
        { type: 'update', path: video.relative_path }, 'Mise à jour sur YouTube en cours…'));
      update.title = 'Réessayer la mise à jour sur YouTube';
      update.dataset.publish = '1';
      actions.push(update);
    }
  }
  item = mediaRow({
    path: video.relative_path, preview: video.preview_path, youtubeId: video.youtube_id,
    title: video.title || video.relative_path.split('/').pop(),
    detail: [chan(video.channel_name), video.date ? new Date(video.date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) : null].filter(Boolean).join(' · '),
    status, actions: actions.filter((a) => !(a.tagName === 'A' && /youtu/.test(a.href))), extra,
  });
  // The video's thumbnail opens it on YouTube.
  const mini = item.querySelector('.mini');
  if (video.youtube_id && mini) {
    const link = el('a', 'mini-link');
    link.href = `https://youtu.be/${video.youtube_id}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.title = 'Voir la vidéo sur YouTube';
    mini.replaceWith(link);
    link.append(mini);
  }
  item.dataset.ytKinds = 'video';
  item.dataset.ytFailed = video.update_error && video.update_tried_hash === video.hash ? '1' : '';
  return item;
}

// A video's Short (its vertical version, short.mp4): its own row, in « En
// attente » until it is on YouTube, then in « Déjà publiés ».
function shortItem(video) {
  const actions = [];
  let status;
  let item;
  if (video.short_youtube_id) {
    status = pill('ok', 'Short publié sur YouTube.');
    actions.push(iconLink('link', 'Voir', `https://youtube.com/shorts/${video.short_youtube_id}`));
  } else {
    if (video.short_error) {
      status = pill('warn', `Échec : ${shortError(video.short_error)}`);
      status.title = video.short_error;
    } else status = pill('neutral', 'Part sur YouTube après sa vidéo.');
    const go = button(video.short_error ? 'Réessayer' : 'Publier', 'btn secondary', () => act(item, go,
      { type: 'shortYoutube', path: video.relative_path }, 'Envoi du Short sur YouTube en cours… (Studio s’ouvre)'));
    go.title = video.short_error ? 'Renvoyer le Short sur YouTube' : 'Publier le Short sur YouTube';
    go.dataset.publish = '1';
    actions.push(go);
  }
  item = mediaRow({
    path: video.relative_path, emptyLabel: 'Short',
    vertical: { youtubeId: video.short_youtube_id, file: video.vertical_path },
    title: String(video.title || video.relative_path.split('/').pop()).replace(/\s*[—-]\s*Short$/i, ''),
    detail: [chan(video.channel_name), video.date ? new Date(video.date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) : null].filter(Boolean).join(' · '),
    status, actions: actions.filter((x) => !(x.tagName === 'A' && /youtube\.com\/shorts/.test(x.href))),
  });
  item.classList.add('is-short');
  const mini = item.querySelector('.mini');
  if (video.short_youtube_id && mini) {
    const link = el('a', 'mini-link');
    link.href = `https://youtube.com/shorts/${video.short_youtube_id}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.title = 'Voir le Short sur YouTube';
    mini.replaceWith(link);
    link.append(mini);
  }
  item.dataset.ytKinds = 'short';
  item.dataset.ytFailed = !video.short_youtube_id && video.short_error ? '1' : '';
  return item;
}


// ------------------------------------------------------ networks used

// Each network's logo (brand colour) and short name, for the tabs and settings.
const LOGOS = {
  youtube: { short: 'YT', color: '#ff0033', svg: '<path d="M23.5 6.19a3.02 3.02 0 0 0-2.12-2.14C19.5 3.55 12 3.55 12 3.55s-7.5 0-9.38.5A3.02 3.02 0 0 0 .5 6.19C0 8.07 0 12 0 12s0 3.93.5 5.81a3.02 3.02 0 0 0 2.12 2.14c1.87.5 9.38.5 9.38.5s7.5 0 9.38-.5a3.02 3.02 0 0 0 2.12-2.14C24 15.93 24 12 24 12s0-3.93-.5-5.81zM9.55 15.57V8.43L15.82 12l-6.27 3.57z"/>' },
  facebook: { short: 'FB', color: '#1877f2', svg: '<path d="M9.1 23.69v-7.98H6.63v-3.67H9.1v-1.58c0-4.09 1.85-5.98 5.86-5.98.4 0 .96.04 1.47.1.4.05.79.11 1.14.2v3.32a8.6 8.6 0 0 0-1.39-.05c-.71 0-1.26.1-1.68.31a1.69 1.69 0 0 0-.68.62c-.26.42-.37 1-.37 1.75v1.3h3.92l-.39 2.1-.29 1.57h-3.25v8.24C19.4 23.24 24 18.18 24 12.04 24 5.42 18.63.04 12 .04S0 5.42 0 12.04c0 5.63 3.87 10.35 9.1 11.65Z"/>' },
  tiktok: { short: 'TikTok', color: '#ffffff', svg: '<path d="M12.53.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/>' },
  instagram: { short: 'Insta', color: '#e1306c', svg: '<path fill="none" stroke="currentColor" stroke-width="2.2" d="M7 2h10a5 5 0 0 1 5 5v10a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5V7a5 5 0 0 1 5-5z"/><circle cx="12" cy="12" r="4.3" fill="none" stroke="currentColor" stroke-width="2.2"/><circle cx="17.6" cy="6.4" r="1.4"/>' },
  linkedin: { short: 'In', color: '#0a66c2', svg: '<path d="M20.45 20.45h-3.55v-5.57c0-1.33-.03-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zm1.78 13.02H3.56V9h3.56v11.45zM22.23 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.73C24 .77 23.2 0 22.22 0z"/>' },
  x: { short: 'X', color: '#ffffff', svg: '<path d="M18.9 1.15h3.68l-8.04 9.19L24 22.85h-7.41l-5.8-7.58-6.64 7.58H.47l8.6-9.83L0 1.15h7.59l5.24 6.93zM17.61 20.64h2.04L6.49 3.24H4.3z"/>' },
};
const logo = (name, size = 14) => {
  const l = LOGOS[name];
  if (!l) return null;
  const span = document.createElement('span');
  span.className = 'net-logo';
  span.style.color = l.color;
  span.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" aria-hidden="true">${l.svg}</svg>`;
  return span;
};
// Network tabs: logo + short name (full name on hover).
for (const tab of document.querySelectorAll('.tabs button[data-tab]')) {
  const l = LOGOS[tab.dataset.tab];
  if (!l) continue;
  tab.title = tab.textContent.trim();
  tab.setAttribute('aria-label', tab.title);
  tab.replaceChildren(logo(tab.dataset.tab), document.createTextNode(l.short));
}

const NETWORKS = [
  ['youtube', 'YouTube', 'Vidéos et Shorts depuis le dossier.', 'youtube'],
  ['facebook', 'Facebook', 'Reels, vidéos et posts programmés sur ta page.', 'facebook'],
  ['tiktok', 'TikTok', 'Vidéos verticales (et horizontales) sur ton compte.', 'tiktok'],
  ['instagram', 'Instagram', 'Reels (versions verticales) sur ton compte.', 'instagram'],
  ['linkedin', 'LinkedIn', 'Vidéos (lien) et posts sur ton profil.', 'linkedin'],
  ['x', 'X', 'Posts et vidéos sur ton compte.', 'x'],
];
// Every listed network is operational. Older defaults stay enabled until the
// creator unticks them; newer destinations require an explicit opt-in.
const DEFAULT_ON = new Set(['youtube', 'facebook', 'tiktok', 'instagram']);          // on until unticked
const networkIsOn = (config, name) => {
  const value = (config.networks || {})[name];
  return value === undefined ? DEFAULT_ON.has(name) : value !== false;
};

// Hides the tabs (and the per-channel Facebook fields) of the networks switched off.
async function applyNetworks() {
  const config = await settings();
  for (const [name, , , tab] of NETWORKS) {
    const on = networkIsOn(config, name);
    const button = document.querySelector(`.tabs button[data-tab="${tab}"]`);
    if (button) button.hidden = !on;
    document.body.classList.toggle(`off-${name}`, !on);
    const pane = $(`tab-${tab}`);
    if (!on && pane && !pane.hidden) {
      const first = [...document.querySelectorAll('.tabs button')].find((b) => !b.hidden);
      if (first) first.click();
    }
  }
}

async function renderNetworks() {
  const config = await settings();
  $('networks').replaceChildren(...NETWORKS.map(([name, label, hint]) => {
    const row = el('li', 'network-row');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = networkIsOn(config, name);
    const text = el('div');
    const title = el('strong', null, label);
    if (LOGOS[name]) title.prepend(logo(name, 13));
    text.append(title);
    text.title = hint;
    const wrap = el('label');
    wrap.append(box, text);
    box.addEventListener('change', async () => {
      const current = await settings();
      current.networks = { ...(current.networks || {}), [name]: box.checked };
      // X: what is published from now on goes there (never the older catalogue).
      if ((name === 'x' || name === 'linkedin') && box.checked) current[`${name}Since`] = Date.now();
      await chrome.storage.local.set({ folder: current });
      await applyNetworks();
      renderPages();
      send({ type: 'autoNow' });
    });
    row.append(wrap);
    return row;
  }));
}

// ------------------------------------------------ publication settings

function normalizeTimes(value) {
  return KappSchedule.normalizeTimes(value);
}

async function renderPublishSettings() {
  const config = await settings();
  const visibility = ['UNLISTED', 'PUBLIC', 'PRIVATE'].includes(config.visibility) ? config.visibility : 'UNLISTED';
  for (const b of $('yt-visibility').querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.value === visibility);
    b.setAttribute('aria-checked', String(b.dataset.value === visibility));
  }
  $('yt-visibility-hint').textContent = {
    PUBLIC: 'Chaque vidéo est visible par tout le monde dès sa publication.',
    UNLISTED: 'Seules les personnes qui ont le lien la voient : tu la passes en publique toi-même dans YouTube Studio.',
    PRIVATE: 'Toi seul la vois.',
  }[visibility];
  const when = config.schedule === 'times' ? 'times' : 'now';
  for (const radio of document.querySelectorAll('input[name="yt-when"]')) radio.checked = radio.value === when;
  $('yt-times-row').hidden = when !== 'times';
  $('yt-times').value = config.times || '';
}

async function saveSetting(patch) {
  const current = await settings();
  Object.assign(current, patch);
  await chrome.storage.local.set({ folder: current });
  send({ type: 'autoNow' });
  renderPublishSettings();
}

for (const b of $('yt-visibility').querySelectorAll('button')) {
  b.addEventListener('click', async () => {
    const value = b.dataset.value;
    if (value === 'PUBLIC' && !confirm('Chaque vidéo prête sera PUBLIÉE directement sur YouTube, sans que tu la valides.')) return;
    await saveSetting({ visibility: value });
  });
}
for (const radio of document.querySelectorAll('input[name="yt-when"]')) {
  radio.addEventListener('change', async () => {
    $('yt-times-row').hidden = radio.value !== 'times';
    if (radio.value === 'now' || normalizeTimes($('yt-times').value)) await saveSetting({ schedule: radio.value });
    else $('yt-times').focus();
  });
}
function timesSaver(input, key, extra = {}) {
  return async () => {
    const value = $(input).value.trim();
    const normalized = normalizeTimes(value);
    if (!normalized) {
      $(input).setCustomValidity('Écris des quarts d’heure valides, par exemple 08:00, 12:30, 18:45');
      $(input).reportValidity();
      return;
    }
    $(input).value = normalized;
    await saveSetting({ [key]: normalized, ...extra });
    renderPosts();
  };
}
$('yt-times-save').addEventListener('click', timesSaver('yt-times', 'times', { schedule: 'times' }));
for (const id of ['yt-times']) {
  $(id).addEventListener('input', () => $(id).setCustomValidity(''));
  $(id).addEventListener('keydown', (event) => { if (event.key === 'Enter') $(`${id}-save`).click(); });
}

// ------------------------------------------------------ Facebook posts

const POST_STATES = { a_publier: 'prévu', en_cours: 'en cours', publie: 'publié', echec: 'échec',
  a_verifier: 'à vérifier', configuration_invalide: 'configuration invalide' };
const POST_TYPES = { photo: 'Photo', texte: 'Texte', reel: 'Réel' };

let lastScan = null;  // last scan of the videos folder
let lastPosts = [];   // last list of Facebook posts

// Facebook folder (Reels and posts): its own, or the main one.
async function renderFbAccess() {
  const all = await KappDossier.folders().catch(() => ({}));
  renderNetFolders(all);
  return all.facebook || { state: 'none' };
}

// One aligned row per post: time, picture, text and state. Already published
// posts are folded away (with their count); everything to come is listed below.
function postRow(post) {
  const item = el('li', `row state-${post.statut}`);
  item.dataset.path = post.path;
  const when = el('div', 'when');
  if (post.statut === 'publie' && post.published_at) {
    const d = new Date(post.published_at);
    when.append(el('strong', null, `${pad2(d.getHours())}:${pad2(d.getMinutes())}`), el('span', null, d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })));
  } else if (post.statut === 'a_publier' && lateEta.has(post.path)) {
    // Late (catching up): the estimated new time, the planned one under it.
    const eta = new Date(lateEta.get(post.path));
    const was = new Date(post.due_at);
    when.append(el('strong', null, `${pad2(eta.getHours())}:${pad2(eta.getMinutes())}`), el('span', 'was', `${pad2(was.getHours())}:${pad2(was.getMinutes())}`));
    when.title = 'En retard : nouvelle heure estimée (les posts en retard partent un par un).';
  } else if (post.due_at) {
    const d = new Date(post.due_at);
    const today = d.toDateString() === new Date().toDateString();
    when.append(el('strong', null, `${pad2(d.getHours())}:${pad2(d.getMinutes())}`), el('span', null, today ? 'aujourd’hui' : d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' })));
  } else {
    when.append(el('strong', null, '—'), el('span', null, 'sans heure'));
  }
  const mini = el('div', 'mini', POST_TYPES[post.type]);
  if (post.image_path) KappDossier.fileAt(post.image_path).then((file) => mini.replaceChildren(objectImage(file))).catch(() => {});
  const what = el('div', 'what');
  what.append(el('div', 't', post.text.split('\n')[0] || '(sans texte)'));
  const live = liveRegion();
  const due = post.due_at && post.due_at > Date.now();
  const states = {
    a_publier: due ? pillIcon('neutral', 'Programmé', 'clock') : pill('neutral', 'En retard'),
    en_cours: pill('busy', 'Publication en cours…'),
    publie: pill('ok', 'Publié'),
    echec: pill('warn', post.error || 'Échec de la publication.'),
    a_verifier: pill('warn', post.error || 'Vérifie sur Facebook avant toute nouvelle tentative.'),
    configuration_invalide: pill('warn', post.configuration_error || 'Corrige publication.json.'),
  };
  live.append(states[post.statut] || pill('neutral', post.statut));
  what.append(live);
  const shared = Object.values(post.groups_shared || {});
  const failedGroups = shared.filter((g) => g.statut === 'echec');
  if (failedGroups.length) {
    const line = el('div', `groups-line${failedGroups.length ? ' warn' : ''}`,
      `Groupes : ${shared.length - failedGroups.length} partagé(s)${failedGroups.length ? `, ${failedGroups.length} en échec (${failedGroups[0].erreur || 'erreur'})` : ''}`);
    what.append(line);
  }
  const acts = el('div', 'acts');
  if (post.statut === 'publie' && failedGroups.length) {
    const again = button('Repartager', 'btn ghost', () => act(item, again, { type: 'shareGroups', path: post.path }, 'Partage dans les groupes en cours…'));
    again.dataset.publish = '1';
    acts.append(again);
  }
  if (post.statut === 'a_verifier') {
    const accept = button('Confirmer publié', 'btn ghost', async () => {
      if (!confirm('As-tu vérifié que ce post est bien visible sur la Page Facebook ?\n\nConfirmer évite de le publier une seconde fois.')) return;
      accept.disabled = true;
      await KappDossier.markPost(post.path, { statut: 'publie', published_at: post.published_at || new Date().toISOString(), erreur: null });
      renderPosts();
    });
    const unlock = button('Autoriser un renvoi', 'btn ghost', async () => {
      if (!confirm('As-tu vérifié la Page ET les brouillons Facebook et confirmé que le post est absent ?\n\nIl faudra encore cliquer « Réessayer » avant tout nouvel envoi.')) return;
      unlock.disabled = true;
      await KappDossier.markPost(post.path, { statut: 'echec', erreur: 'Publication vérifiée comme absente : nouvel envoi autorisé manuellement.' });
      renderPosts();
    });
    acts.append(accept, unlock);
  }
  if (post.statut === 'a_publier' || post.statut === 'echec') {
    const change = timeButton(() => item, post.due_at, async (at) => {
      const d = new Date(at);
      await KappDossier.markPost(post.path, { date_locale: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
        heure_prevue: `${pad2(d.getHours())}:${pad2(d.getMinutes())}`, statut: 'a_publier', erreur: null, horaire: 'manuel' });
      renderPosts();
    }, { label: '' });
    change.classList.add('icon-btn');
    change.append(icon('clock'));
    change.title = 'Changer l’heure de publication';
    const go = button(post.statut === 'echec' ? 'Réessayer' : 'Publier', 'btn primary', () => act(item, go,
      { type: 'postNow', path: post.path }, 'Publication sur Facebook en cours…'));
    go.dataset.publish = '1';
    acts.append(go);
    acts.append(moreMenu([entryOf(change, 'Changer l’heure', 'clock'), alreadyDone(() => item, () => markPostManual(post.path, 'facebook')),
      retireButton(() => item, () => retirePost(post.path, 'facebook'))]));
  }
  item.append(when, mini, what, acts);
  item.say = (kind, text) => live.replaceChildren(pill(kind, text));
  return item;
}

// Posts grouped by day, each day folded (today open): a long list (hundreds
// of posts a day) stays readable. Rows of a day are built when it is opened.
let postFilter = '';
let postSort = 'asc';
const openDays = new Set();
const dayKey = (ts) => { if (!ts) return 'sans-heure'; const d = new Date(ts); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
function dayLabel(key) {
  if (key === 'sans-heure') return 'Sans heure';
  const d = new Date(`${key}T12:00:00`);
  const diff = Math.round((new Date(d.toDateString()) - new Date(new Date().toDateString())) / 864e5);
  const date = d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
  const name = diff === 0 ? 'Aujourd’hui' : diff === 1 ? 'Demain' : diff === -1 ? 'Hier' : d.toLocaleDateString('fr-FR', { weekday: 'long' });
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} · ${date}`;
}
function dayGroups(list, timeOf, scope, { openToday = false, openFirst = false } = {}) {
  const groups = new Map();
  for (const post of list) {
    const key = dayKey(timeOf(post));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(post);
  }
  const today = dayKey(Date.now());
  return [...groups].map(([key, posts], index) => {
    const box = el('details', 'day');
    const id = `${scope}:${key}`;
    box.open = openDays.has(id) || ((openToday && key === today) || (openFirst && index === 0)) && !openDays.has(`${id}:closed`);
    const summary = el('summary');
    const failed = posts.filter((p) => p.statut === 'echec').length;
    const verify = posts.filter((p) => p.statut === 'a_verifier').length;
    const invalid = posts.filter((p) => p.configuration_error).length;
    summary.append(el('span', 'day-name', dayLabel(key)), el('span', 'day-count', `${posts.length} post${posts.length > 1 ? 's' : ''}${verify ? ` · ${verify} à vérifier` : ''}${failed ? ` · ${failed} en échec` : ''}${invalid ? ` · ${invalid} à corriger` : ''}`));
    const list = el('ul', 'rows');
    const fill = () => { if (!list.childElementCount) list.replaceChildren(...posts.map(postRow)); };
    if (box.open) fill();
    box.addEventListener('toggle', () => {
      if (box.open) { openDays.add(id); openDays.delete(`${id}:closed`); fill(); applyJob(); }
      else { openDays.delete(id); openDays.add(`${id}:closed`); }
    });
    box.append(summary, list);
    return box;
  });
}
for (const chip of document.querySelectorAll('#fb-filters .chip')) {
  chip.addEventListener('click', () => {
    postFilter = chip.dataset.type;
    for (const other of document.querySelectorAll('#fb-filters .chip')) other.classList.toggle('active', other === chip);
    renderPosts();
    if (lastScan) renderFacebook(lastScan);
  });
}
// One small button flips the order (earliest / latest first).
$('fb-sort').addEventListener('click', () => {
  postSort = postSort === 'desc' ? 'asc' : 'desc';
  $('fb-sort').textContent = postSort === 'desc' ? '↓' : '↑';
  $('fb-sort').title = `Ordre : ${postSort === 'desc' ? 'plus tard' : 'plus tôt'} d’abord (cliquer pour inverser)`;
  renderPosts();
});

// ---------------------------------------------------------- Facebook groups

const groupLink = (url) => {
  const m = String(url || '').trim().replace(/^https?:\/\/(?:www\.|web\.|m\.|mobile\.)?facebook\.com/i, 'https://www.facebook.com')
    .match(/^https:\/\/www\.facebook\.com\/groups\/[^/?#\s]+/i);
  return m ? `${m[0]}/` : null;
};
// A group's name, from its link (its address name, or its number).
const groupName = (url) => {
  const slug = decodeURIComponent((String(url).match(/\/groups\/([^/?#]+)/) || [])[1] || url);
  return /^\d+$/.test(slug) ? `Groupe ${slug}` : slug.replace(/[-_.]+/g, ' ');
};
let groupList = [];
async function renderGroups() {
  const config = await settings();
  groupList = config.facebookGroups || [];
  $('fb-groups-count').textContent = groupList.length;
  if (document.activeElement !== $('fb-groups-per')) $('fb-groups-per').value = config.facebookGroupsPerPost || 9;
  $('fb-groups-on').checked = !!config.facebookGroupsOn;
  $('fb-groups-more').hidden = !config.facebookGroupsOn; // the rest only once ticked
  $('fb-from-yt').checked = config.facebookFromYoutube !== false;
  $('fb-group-list').replaceChildren(...groupList.map((link) => {
    const item = el('li', 'group-chip');
    const a = el('a', null, groupName(link));
    a.href = link;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.title = link;
    const drop = el('button', 'group-drop', '✕');
    drop.type = 'button';
    drop.title = 'Retirer ce groupe';
    drop.addEventListener('click', () => { groupList = groupList.filter((g) => g !== link); saveGroups(); });
    item.append(a, drop);
    return item;
  }));
  const per = Math.min(config.facebookGroupsPerPost || 9, groupList.length);
  const state = $('fb-groups-state');
  state.className = `pill ${config.facebookGroupsOn ? 'ok' : 'neutral'}`;
  state.textContent = !config.facebookGroupsOn ? 'Groupes désactivés'
    : groupList.length ? `${per} groupes par post sur ${groupList.length}` : `${Math.min(config.facebookGroupsPerPost || 9, 9)} groupes par post`;
}
function groupsSaid(text, warn = false) {
  const saved = $('fb-groups-saved');
  saved.className = `small ${warn ? 'warn' : 'ok-text'}`;
  saved.textContent = text;
  saved.hidden = false;
  clearTimeout(groupsSaid.timer);
  groupsSaid.timer = setTimeout(() => { saved.hidden = true; }, 5000);
}
async function saveGroups() {
  const current = await settings();
  current.facebookGroups = [...new Set(groupList.map(groupLink).filter(Boolean))].slice(0, 500);
  current.facebookGroupsPerPost = Math.min(9, Math.max(1, Number($('fb-groups-per').value) || 9));
  current.facebookGroupsOn = $('fb-groups-on').checked; // no list needed: Facebook's own list is used
  await chrome.storage.local.set({ folder: current });
  renderGroups();
}
// Pasted links (one or several), added to the list.
async function addGroups() {
  const typed = $('fb-group-new').value.split(/\s+/).filter(Boolean);
  if (!typed.length) return;
  const valid = typed.map(groupLink).filter(Boolean);
  if (!valid.length) { groupsSaid('Ce n’est pas un lien de groupe Facebook (facebook.com/groups/…).', true); return; }
  groupList = [...new Set([...groupList, ...valid])];
  $('fb-group-new').value = '';
  await saveGroups();
  groupsSaid(valid.length > 1 ? `${valid.length} groupes ajoutés.` : 'Groupe ajouté.');
}
$('fb-group-add').addEventListener('click', addGroups);
$('fb-group-new').addEventListener('keydown', (event) => { if (event.key === 'Enter') addGroups(); });
// « Trouver mes groupes »: all the groups of the connected Facebook account.
async function findGroups() {
  const find = $('fb-groups-find');
  const label = find.querySelector('span');
  find.disabled = true;
  label.textContent = 'Recherche…';
  const reply = await send({ type: 'findGroups' });
  find.disabled = false;
  label.textContent = 'Trouver';
  if (!reply || !reply.ok) { groupsSaid(reply ? reply.error : 'Recherche impossible.', true); return; }
  const before = groupList.length;
  groupList = [...new Set([...reply.data.groups, ...groupList])].slice(0, 500);
  await saveGroups();
  groupsSaid(`${groupList.length - before} groupe(s) trouvé(s).`);
}
$('fb-groups-find').addEventListener('click', findGroups);
// YouTube videos and Shorts on the Page too (from the moment it is switched on).
$('fb-from-yt').addEventListener('change', async () => {
  const current = await settings();
  current.facebookFromYoutube = $('fb-from-yt').checked;
  if ($('fb-from-yt').checked) current.facebookFromYoutubeSince = Date.now();
  await chrome.storage.local.set({ folder: current });
  send({ type: 'autoNow' });
});
$('fb-groups-per').addEventListener('change', saveGroups);
for (const [id, step] of [['fb-groups-less', -1], ['fb-groups-plus', 1]]) {
  $(id).addEventListener('click', () => {
    $('fb-groups-per').value = Math.min(9, Math.max(1, (Number($('fb-groups-per').value) || 9) + step));
    saveGroups();
  });
}
$('fb-groups-on').addEventListener('change', () => { $('fb-groups-more').hidden = !$('fb-groups-on').checked; saveGroups(); });

// null when no group list is set (no per-post button then).
let groupsDefault = null;
// Late posts: estimated departure, one by one at the catch-up rhythm.
let lateEta = new Map();
function estimateLate(posts, catchUp) {
  const now = Date.now();
  const late = posts.filter((p) => p.statut === 'a_publier' && p.due_at && p.due_at <= now).sort((a, b) => a.due_at - b.due_at);
  const map = new Map();
  if (!late.length) return map;
  const times = posts.map((p) => p.due_at).filter(Boolean).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < times.length; i += 1) { const g = times[i] - times[i - 1]; if (g > 0 && g <= 86400000) gaps.push(g); }
  gaps.sort((a, b) => a - b);
  const gap = (catchUp && catchUp.gap) || Math.min(1800000, Math.max(150000, (gaps.length ? gaps[Math.floor(gaps.length / 2)] : 1800000) / 2));
  const start = Math.max(now, (catchUp && catchUp.next) || now);
  late.forEach((p, i) => map.set(p.path, start + i * gap));
  return map;
}

// Failed posts are never sent again on their own (no double post): one
// button puts them all back in line, at the catch-up rhythm.
$('fb-retry-all').addEventListener('click', async () => {
  const failed = (lastPosts || []).filter((p) => p.statut === 'echec');
  if (!failed.length) return;
  if (!confirm(`Remettre ${failed.length} post(s) en échec dans la file ? Ils repartiront un par un.\n\nVérifie d’abord sur ta Page qu’ils ne sont pas déjà publiés.`)) return;
  for (const p of failed) await KappDossier.markPost(p.path, { statut: 'a_publier', erreur: null, started_at: null }).catch(() => {});
  send({ type: 'autoNow' });
  renderPosts();
});

let postsRenderPromise = null;
let postsRenderQueued = false;
function renderPosts() {
  if (postsRenderPromise) {
    postsRenderQueued = true;
    return postsRenderPromise;
  }
  postsRenderPromise = renderPostsOnce().catch((error) => {
    $('fb-summary').className = 'warn';
    $('fb-summary').textContent = String(error.message || error);
  }).finally(() => {
    postsRenderPromise = null;
    if (postsRenderQueued) {
      postsRenderQueued = false;
      queueMicrotask(renderPosts);
    }
  });
  return postsRenderPromise;
}

async function renderPostsOnce() {
  const groupConfig = await settings();
  groupsDefault = !!groupConfig.facebookGroupsOn;
  renderGroups().catch(() => {});
  renderSetup().catch(() => {});
  const access = await renderFbAccess();
  const reply = await send({ type: 'facebookPosts' });
  const posts = reply && reply.ok ? reply.data : [];
  lastPosts = posts;
  const { catchUp } = await chrome.storage.local.get('catchUp');
  lateEta = estimateLate(posts, catchUp);
  const failedCount = posts.filter((p) => p.statut === 'echec').length;
  const verifyCount = posts.filter((p) => p.statut === 'a_verifier').length;
  const invalidCount = posts.filter((p) => p.configuration_error).length;
  $('fb-retry-all').hidden = !failedCount;
  $('fb-retry-all').textContent = `Réessayer les ${failedCount} post(s) en échec`;
  const config = await settings();
  const pageOf = (p) => p.page || ((config.channels[p.channel_key] || {}).facebookPageUrl) || config.facebookPageUrl;
  const missingPage = posts.some((p) => p.statut === 'a_publier' && !pageOf(p));
  const rank = { en_cours: 0, a_verifier: 1, echec: 2, a_publier: 3 };
  const toCome = posts.filter((p) => p.statut !== 'publie')
    .sort((a, b) => (rank[a.statut] ?? 3) - (rank[b.statut] ?? 3) || (a.due_at || 0) - (b.due_at || 0) || a.path.localeCompare(b.path));
  const done = posts.filter((p) => p.statut === 'publie')
    .sort((a, b) => Date.parse(b.published_at || 0) - Date.parse(a.published_at || 0));
  const summary = $('fb-summary');
  if (reply && !reply.ok) { summary.className = 'warn'; summary.textContent = reply.error; }
  else {
    summary.className = 'muted small';
    summary.textContent = !posts.length ? (access.state === 'granted' ? 'Aucun post dans ce dossier.' : '')
      : `${toCome.length} à venir · ${done.length} publié(s)` + (verifyCount ? ` · ${verifyCount} à vérifier sur Facebook` : '')
        + (invalidCount ? ` · ${invalidCount} configuration(s) à corriger` : '')
        + (missingPage ? ' · lien de la page manquant (en haut)' : '');
  }
  const shown = (p) => !postFilter || (postFilter === 'echec' ? p.statut === 'echec' : p.type === postFilter);
  const upcoming = toCome.filter(shown);
  if (postSort === 'desc') upcoming.sort((a, b) => (b.due_at || 0) - (a.due_at || 0));
  $('fb-days').replaceChildren(...dayGroups(upcoming, (p) => p.due_at, 'come', { openToday: true }));
  // « Déjà publiés » follows the chosen filter too; the latest day is open.
  const doneShown = done.filter(shown);
  $('fb-done-box').hidden = !doneShown.length;
  $('fb-done-title').textContent = `Déjà publiés (${doneShown.length})`;
  $('fb-done-days').replaceChildren(...dayGroups(doneShown, (p) => Date.parse(p.published_at || 0) || p.due_at, 'done', { openFirst: true }));
  $('no-posts').hidden = !(posts.length && !upcoming.length);
  applyJob();
  await refreshNetworkData();
  renderNetworkViews();
}

// Facebook is the only network routed by a saved destination URL. YouTube,
// TikTok, Instagram, X and LinkedIn publish to the account already connected
// in this Chrome profile.
const PAGE_FIELDS = [
  ['facebook', 'Facebook', 'https://www.facebook.com/ta-page', /^https:\/\/(www\.|m\.|web\.|business\.)?facebook\.com\//i],
];
const pageUrlOf = (config, name) => (name === 'facebook' ? config.facebookPageUrl : '') || '';

async function renderPages() {
  const config = await settings();
  const used = PAGE_FIELDS.filter(([name]) => networkIsOn(config, name));
  $('set-pages').hidden = !used.length;
  const active = used.filter(([name]) => pageUrlOf(config, name)).length;
  const state = $('pages-state');
  state.className = `pill ${active ? 'ok' : 'warn'}`;
  state.textContent = active ? 'Page configurée' : 'Page à renseigner';
  $('pages').replaceChildren(...used.map(([name, label, placeholder, pattern]) => {
    const row = el('label', 'page-row');
    const input = document.createElement('input');
    input.type = 'url';
    input.placeholder = placeholder;
    input.value = pageUrlOf(config, name);
    // Next to each link, one small icon: « save » while the link is new or
    // changed (nothing to copy yet), « copy » once it is saved.
    const saved = input.value.trim();
    const SAVE_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/></svg>';
    const COPY_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'page-copy';
    const toSave = () => input.value.trim() !== saved;
    copy.addEventListener('click', async (event) => {
      event.preventDefault();
      if (toSave()) { input.dispatchEvent(new Event('change')); return; }
      if (!saved) return;
      try { await navigator.clipboard.writeText(saved); } catch { input.select(); document.execCommand('copy'); }
      copy.classList.add('done');
      setTimeout(() => copy.classList.remove('done'), 1500);
    });
    const syncCopy = () => {
      const save = toSave() || !saved;
      copy.classList.toggle('save', toSave());
      copy.innerHTML = save ? SAVE_ICON : COPY_ICON;
      copy.title = save ? 'Enregistrer le lien' : 'Copier le lien';
      copy.setAttribute('aria-label', `${save ? 'Enregistrer' : 'Copier'} le lien ${label}`);
      copy.disabled = !toSave() && !saved;
    };
    syncCopy();
    input.addEventListener('input', () => { input.setCustomValidity(''); syncCopy(); });
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); input.dispatchEvent(new Event('change')); } });
    input.addEventListener('change', async () => {
      const url = input.value.trim();
      if (url && !pattern.test(url)) {
        input.setCustomValidity(`Colle un lien ${label}, ex. ${placeholder}`);
        input.reportValidity();
        return;
      }
      const savedUrl = name === 'facebook' && url ? normalizedFacebookPage(url) : url;
      const current = await settings();
      if (name === 'facebook') {
        current.facebookPageUrl = savedUrl || null;
        input.value = savedUrl || '';
        // One page for everything: links saved per channel by older versions go.
        for (const own of Object.values(current.channels || {})) { delete own.facebookPageUrl; delete own.facebook; delete own.facebookSince; }
      }
      await chrome.storage.local.set({ folder: current });
      send({ type: 'autoNow' });
      $('pages-saved').hidden = false;
      setTimeout(() => { $('pages-saved').hidden = true; }, 2500);
      renderPages();
      if (name === 'facebook') { renderPosts(); if (lastScan) renderFacebook(lastScan); }
    });
    row.append(el('span', 'page-label', label), input, copy);
    return row;
  }));
  renderSetup().catch(() => {});
}

let folderRenderPromise = null;
let folderRenderQueued = false;
function renderFolder() {
  if (folderRenderPromise) {
    folderRenderQueued = true;
    return folderRenderPromise;
  }
  folderRenderPromise = renderFolderOnce().catch((error) => {
    $('folder-status').hidden = false;
    $('folder-status').className = 'status error';
    $('folder-status').textContent = String(error.message || error);
  }).finally(() => {
    folderRenderPromise = null;
    if (folderRenderQueued) {
      folderRenderQueued = false;
      queueMicrotask(renderFolder);
    }
  });
  return folderRenderPromise;
}

async function renderFolderOnce() {
  renderSetup().catch(() => {});
  const lists = ['videos', 'sent', 'facebook'].map($);
  if (!(await renderAccess())) {
    lists.forEach((list) => { list.textContent = ''; });
    $('no-videos').hidden = true;
    return;
  }
  const config = await settings();
  let data;
  try {
    data = await KappDossier.scan({ channels: config.channels, watchSince: config.watchSince || Date.now() });
  } catch (error) {
    $('folder-status').hidden = false;
    $('folder-status').className = 'status error';
    $('folder-status').textContent = String(error.message || error);
    return;
  }
  lastScan = data;
  defaultVisibility = config.schedule === 'times' ? 'SCHEDULE' : (VISIBILITY_LABELS[config.visibility] ? config.visibility : 'UNLISTED');
  showChannels = new Set([...data.videos, ...data.sent].map((v) => v.channel_key)).size > 1;
  for (const [key, own] of Object.entries(config.channels)) autoVisibility.set(key, own.visibility);
  const order = (v) => (v.schedule_at && v.schedule_at > Date.now() ? v.schedule_at : v.auto_ok ? Date.now() : Infinity);
  const shortsWaiting = data.sent.filter((v) => v.youtube_id && v.vertical_path && !v.short_youtube_id).map(shortItem);
  $('videos').replaceChildren(...[...data.videos].sort((a, b) => order(a) - order(b)).map(videoItem), ...shortsWaiting);
  queueMicrotask(applyJob);
  const excluded = data.excluded || [];
  $('excluded-box').hidden = !excluded.length;
  $('excluded-title').textContent = `Retirées, jamais publiées (${excluded.length})`;
  $('excluded').replaceChildren(...excluded.map((v) => {
    let item;
    const back = button('Remettre', 'btn ghost', async () => {
      await KappDossier.mark(v.relative_path, 'reset');
      renderFolder();
    });
    item = mediaRow({ path: v.relative_path, title: v.name, detail: [chan(v.channel_name), size(v.size_bytes)].filter(Boolean).join(' · '),
      status: pill('neutral', 'Ne sera pas publiée.'), actions: [back] });
    return item;
  }));
  const total = data.sent.reduce((sum, v) => sum + v.size_bytes, 0);
  $('sent-summary').textContent = '';
  renderOnYoutube(data, config);
  applyYtFilter();
  renderFacebook(data);
  await refreshNetworkData();
  renderNetworkViews();
}

// One YouTube publication on the Facebook Page: `as` "video" (the long video)
// or "reel" (its Short, the vertical version).
function facebookItem(video, page, as = 'video') {
  const reel = as === 'reel';
  const doneAt = reel ? video.facebook_reel_at : video.facebook_published_at;
  const error = reel ? video.facebook_reel_error : video.facebook_error;
  const actions = [];
  let status;
  let item;
  if (doneAt) {
    status = pill('ok', `${reel ? 'Réel publié' : 'Vidéo publiée'} sur Facebook le ${new Date(doneAt).toLocaleDateString('fr-FR')}.`);
  } else {
    // Why it goes, or waits (the same rules as background.js).
    const since = fbConfig.facebookFromYoutubeSince || Date.now() - 7 * 24 * 3600000;
    const auto = fbConfig.facebookFromYoutube !== false && (video.published_at || 0) >= since;
    const shortFirst = reel && !video.short_youtube_id && !video.short_error;
    status = error ? pill('warn', `Échec : ${error}`)
      : !page ? pill('warn', 'Colle le lien de ta page Facebook (Réglages).')
        : !auto ? pill('neutral', 'Publiée sur YouTube avant l’activation : clique « Publier ».')
          : shortFirst ? pill('neutral', 'Part tout seul juste après le Short sur YouTube.')
            : pill('ok', reel ? 'Part tout seul (à la suite).' : 'Part toute seule (à la suite).');
    const publish = button(error ? 'Réessayer' : 'Publier', 'btn primary', () => act(item, publish,
      { type: 'facebook', path: video.relative_path, as }, 'Publication sur Facebook en cours…'));
    publish.dataset.publish = '1';
    actions.push(publish);
    const field = reel ? 'facebookReelAt' : 'facebookPublishedAt';
    actions.push(moreMenu([alreadyDone(() => item, () => markVideoManual(video.relative_path, { [field]: nowIso() })),
      retireButton(() => item, () => markVideoManual(video.relative_path, { [field]: RETIRED }))]));
  }
  item = mediaRow({
    path: video.relative_path, preview: video.preview_path, youtubeId: reel ? (realId(video.short_youtube_id) || video.youtube_id) : video.youtube_id,
    title: video.title || video.relative_path.split('/').pop(),
    detail: [reel ? 'Réel (Short)' : 'Vidéo', chan(video.channel_name)].filter(Boolean).join(' · '),
    status, actions,
  });
  item.dataset.fbKind = as;
  item.dataset.fbFailed = error && !doneAt ? '1' : '';
  return item;
}

// TikTok: every video already on YouTube (its vertical version if there is
// one, otherwise the video itself, horizontal or not) and the videos of the
// posts folder.
// X: YouTube videos and Facebook posts published since X was ticked, and the rest on request.
// Each network's own folder (Réglages → Dossiers) and its own posts
// (that folder, or <NETWORK>/A-PUBLIER in the main folder).
let netFolders = {};
let ownPosts = {};
let networkDataPromise = null;
async function refreshNetworkData() {
  if (!networkDataPromise) {
    networkDataPromise = (async () => {
      const folders = await KappDossier.folders().catch(() => ({}));
      const entries = await Promise.all(['tiktok', 'instagram', 'x', 'linkedin'].map(async (net) => {
        const reply = await send({ type: 'networkPosts', net });
        return [net, reply && reply.ok && Array.isArray(reply.data) ? reply.data : []];
      }));
      netFolders = folders;
      ownPosts = Object.fromEntries(entries);
    })().finally(() => { networkDataPromise = null; });
  }
  return networkDataPromise;
}

function renderNetworkViews() {
  renderTikTok();
  renderInstagram();
  renderShare('x');
  renderShare('linkedin');
  renderNetSettings();
  renderPages();
}
const hasOwn = (net) => !!(netFolders[net] && netFolders[net].own);
// A network's own post, as a row of its tab.
function ownPostItem(p, net) {
  return { path: p.path, kind: 'post', title: p.text.split('\n')[0] || 'Post', preview: p.image_path,
    detail: [POST_TYPES[p.type] || 'Post', 'dossier du réseau', chan(p.channel_name)].filter(Boolean).join(' · '),
    done: p.statut === 'publie', error: p.configuration_error || (p.statut === 'echec' ? (p.error || 'échec') : null),
    blocked: !!p.configuration_error, date: p.published_at || p.due_at,
    auto: true, at: p.statut === 'a_publier' && p.due_at && p.due_at > Date.now() ? p.due_at : null, own: true, net };
}

// X and LinkedIn: what is published since the network was ticked (YouTube
// videos, Facebook posts), unless it has its own folder; and its own posts.
const SHARE = {
  x: { name: 'X', video: 'x', post: 'xPost', doneAt: 'x_published_at', error: 'x_error', statut: 'x_statut', perr: 'x_error' },
  linkedin: { name: 'LinkedIn', video: 'linkedin', post: 'linkedinPost', doneAt: 'linkedin_published_at', error: 'linkedin_error', statut: 'linkedin_statut', perr: 'linkedin_error' },
};
async function renderShare(net) {
  const config = await settings();
  const k = SHARE[net];
  const items = [];
  if (!hasOwn(net)) {
    const since = config[`${net}Since`] || Date.now();
    if (config[`${net}FromYoutube`] !== false) {
      for (const v of (lastScan && lastScan.sent) || []) {
        if (!v.youtube_id) continue;
        items.push({ path: v.relative_path, kind: 'video', title: v.title || v.relative_path.split('/').pop(), youtubeId: v.youtube_id,
          detail: [v.vertical_path && net === 'x' ? 'Vidéo + Short' : 'Vidéo (lien)', chan(v.channel_name)].filter(Boolean).join(' · '),
          done: v[k.doneAt], error: v[k.error], date: v.date, auto: (v.published_at || 0) >= since });
      }
    }
    if (config[`${net}FromFacebook`] !== false) {
      for (const p of lastPosts) {
        if (p.statut !== 'publie') continue;
        items.push({ path: p.path, kind: 'post', title: p.text.split('\n')[0] || 'Post', preview: p.image_path,
          detail: [POST_TYPES[p.type] || 'Post', 'Facebook', chan(p.channel_name)].filter(Boolean).join(' · '),
          done: p[k.statut] === 'publie', error: p[k.perr], date: p.published_at, auto: Date.parse(p.published_at || 0) >= since });
      }
    }
  }
  for (const p of ownPosts[net] || []) items.push(ownPostItem(p, net));
  const card = (it) => {
    let item;
    const actions = [];
    let status;
    if (it.done) status = pill('ok', `Publié sur ${k.name}.`);
    else {
      status = it.blocked ? pill('warn', `Configuration invalide : ${it.error}`)
        : it.error ? pill('warn', `Échec : ${it.error}`)
        : it.at ? pillIcon('neutral', `Programmé : ${whenText(it.at)}`, 'clock')
          : it.auto ? pill('ok', `Part tout seul sur ${k.name}.`) : pill('neutral', `Publié avant d’avoir coché ${k.name} : clique « Publier ».`);
      if (!it.blocked) {
        const go = button(it.error ? 'Réessayer' : 'Publier', 'btn primary', () => act(item, go,
          { type: it.kind === 'video' ? k.video : k.post, path: it.path }, `Publication sur ${k.name} en cours…`));
        go.dataset.publish = '1';
        actions.push(go);
      }
    }
    item = mediaRow({ path: it.path, preview: it.preview, youtubeId: it.youtubeId, emptyLabel: it.kind === 'video' ? 'Vidéo' : 'Post', title: it.title, detail: it.detail, status, actions });
    return item;
  };
  const recent = (a, b) => (Date.parse(b.date) || b.date || 0) - (Date.parse(a.date) || a.date || 0);
  const waiting = items.filter((it) => !it.done).sort((a, b) => (a.at || 0) - (b.at || 0) || recent(a, b)).slice(0, 60);
  const done = items.filter((it) => it.done).sort(recent);
  $(`${net}-list`).replaceChildren(...waiting.map(card));
  $(`no-${net}`).hidden = waiting.length > 0;
  $(`${net}-done-box`).hidden = !done.length;
  $(`${net}-done-title`).textContent = `Déjà sur ${k.name} (${done.length})`;
  $(`${net}-done`).replaceChildren(...done.map(card));
  applyJob();
}

function renderTikTok() {
  const items = [];
  for (const v of hasOwn('tiktok') ? [] : (lastScan && lastScan.sent) || []) {
    if (!v.youtube_id && !v.published_at) continue;
    items.push({ path: v.relative_path, kind: 'video', title: v.title || v.relative_path.split('/').pop(), preview: v.preview_path,
      youtubeId: v.youtube_id, vertical: !!v.vertical_path,
      detail: [chan(v.channel_name), v.vertical_path ? 'version verticale' : 'pas de version verticale : format long'].filter(Boolean).join(' · '),
      done: v.tiktok_published_at, error: v.tiktok_error, date: v.date });
  }
  for (const p of hasOwn('tiktok') ? [] : lastPosts) {
    if (!p.video_path) continue;
    items.push({ path: p.path, kind: 'post', title: p.text.split('\n')[0] || 'Reel', preview: undefined,
      detail: [chan(p.channel_name), 'vidéo du dossier de posts'].filter(Boolean).join(' · '),
      done: p.tiktok_statut === 'publie', error: p.configuration_error || p.tiktok_error,
      blocked: !!p.configuration_error, date: p.due_at });
  }
  for (const p of ownPosts.tiktok || []) if (p.video_path) items.push(ownPostItem(p, 'tiktok'));
  const tiktokCard = (it) => {
    let item;
    const actions = [];
    let status;
    if (it.done) status = pill('ok', 'Publiée sur TikTok.');
    else {
      status = it.blocked ? pill('warn', `Configuration invalide : ${it.error}`)
        : it.error ? pill('warn', `Échec sur TikTok : ${it.error}`) : pill('neutral', 'Prête à partir sur TikTok.');
      if (!it.blocked) {
        const go = button(it.error ? 'Réessayer' : it.kind === 'video' && !it.vertical ? 'Publier (format long)' : 'Publier', 'btn primary', () => act(item, go,
          { type: it.kind === 'video' ? 'tiktok' : 'tiktokPost', path: it.path }, 'Publication sur TikTok en cours… (TikTok Studio s’ouvre)'));
        go.dataset.publish = '1';
        actions.push(go);
      }
      // The long version stays possible, as an option.
      if (!it.blocked && it.kind === 'video' && it.vertical) {
        const long = button('Version longue', 'btn ghost', () => act(item, long,
          { type: 'tiktok', path: it.path, long: true }, 'Version longue vers TikTok en cours…'));
        long.dataset.publish = '1';
        const menuNode = actions.find((a) => a.classList && a.classList.contains('more'));
        if (menuNode) menuNode.add(entryOf(long, 'Publier la version longue', 'short'));
        else actions.push(long);
      }
    }
    item = mediaRow({ path: it.path, preview: it.preview, youtubeId: it.youtubeId, title: it.title, detail: it.detail, status, actions });
    return item;
  };
  const recent = (a, b) => (Date.parse(b.date) || b.date || 0) - (Date.parse(a.date) || a.date || 0);
  for (let i = items.length - 1; i >= 0; i -= 1) if (items[i].done === RETIRED) items.splice(i, 1);
  const waiting = items.filter((it) => !it.done).sort((a, b) => (b.vertical ? 1 : 0) - (a.vertical ? 1 : 0) || recent(a, b));
  const done = items.filter((it) => it.done).sort(recent);
  $('tiktok-list').replaceChildren(...waiting.map(tiktokCard));
  $('no-tiktok').hidden = items.length > 0;
  $('tiktok-done-box').hidden = !done.length;
  $('tiktok-done-title').textContent = `Déjà sur TikTok (${done.length})`;
  $('tiktok-done').replaceChildren(...done.map(tiktokCard));
  applyJob();
}

// Instagram: videos already on YouTube that have a vertical version (a
// horizontal one would be cropped to a square), and the videos of the posts folder.
function renderInstagram() {
  const items = [];
  for (const v of hasOwn('instagram') ? [] : (lastScan && lastScan.sent) || []) {
    if ((!v.youtube_id && !v.published_at) || !v.vertical_path) continue;
    items.push({ path: v.relative_path, kind: 'video', title: v.title || v.relative_path.split('/').pop(), preview: v.preview_path,
      youtubeId: v.youtube_id, detail: [chan(v.channel_name), 'version verticale'].filter(Boolean).join(' · '),
      done: v.instagram_published_at, error: v.instagram_error, date: v.date });
  }
  for (const p of hasOwn('instagram') ? [] : lastPosts) {
    if (!p.video_path) continue;
    items.push({ path: p.path, kind: 'post', title: p.text.split('\n')[0] || 'Reel', preview: undefined,
      detail: [chan(p.channel_name), 'vidéo du dossier de posts'].filter(Boolean).join(' · '),
      done: p.instagram_statut === 'publie', error: p.configuration_error || p.instagram_error,
      blocked: !!p.configuration_error, date: p.due_at });
  }
  for (const p of ownPosts.instagram || []) if (p.video_path) items.push(ownPostItem(p, 'instagram'));
  const igCard = (it) => {
    let item;
    const actions = [];
    let status;
    if (it.done) status = pill('ok', 'Publiée sur Instagram.');
    else {
      status = it.blocked ? pill('warn', `Configuration invalide : ${it.error}`)
        : it.error ? pill('warn', `Échec sur Instagram : ${it.error}`) : pill('neutral', 'Prête à partir sur Instagram.');
      if (!it.blocked) {
        const go = button(it.error ? 'Réessayer' : 'Publier sur Instagram', 'btn primary', () => act(item, go,
          { type: it.kind === 'video' ? 'instagram' : 'instagramPost', path: it.path }, 'Publication sur Instagram en cours… (Instagram s’ouvre)'));
        go.dataset.publish = '1';
        actions.push(go);
      }
    }
    item = mediaRow({ path: it.path, preview: it.preview, youtubeId: it.youtubeId, title: it.title, detail: it.detail, status, actions });
    return item;
  };
  const recent = (a, b) => (Date.parse(b.date) || b.date || 0) - (Date.parse(a.date) || a.date || 0);
  for (let i = items.length - 1; i >= 0; i -= 1) if (items[i].done === RETIRED) items.splice(i, 1);
  const waiting = items.filter((it) => !it.done).sort(recent);
  const done = items.filter((it) => it.done).sort(recent);
  $('instagram-list').replaceChildren(...waiting.map(igCard));
  $('no-instagram').hidden = items.length > 0;
  $('instagram-done-box').hidden = !done.length;
  $('instagram-done-title').textContent = `Déjà sur Instagram (${done.length})`;
  $('instagram-done').replaceChildren(...done.map(igCard));
  settings().then((config) => { $('instagram-auto').checked = !!config.instagramAuto; });
  applyJob();
}

let fbConfig = {};
async function renderFacebook(data) {
  const config = await settings();
  fbConfig = config;
  const pageOf = (v) => ({ ...(config.channels[v.channel_key] || {}), ...(v.channel_config || {}) }).facebookPageUrl || config.facebookPageUrl;
  const recent = (a, b) => Date.parse(b.date || 0) - Date.parse(a.date || 0);
  // Each YouTube video: the long video, and its Short as a Reel when there is one.
  const rows = [];
  for (const v of [...data.sent].sort(recent)) {
    if (v.facebook_published_at !== RETIRED) rows.push({ v, as: 'video', done: !!v.facebook_published_at, failed: !!v.facebook_error && !v.facebook_published_at });
    if (v.vertical_path && v.facebook_reel_at !== RETIRED) rows.push({ v, as: 'reel', done: !!v.facebook_reel_at, failed: !!v.facebook_reel_error && !v.facebook_reel_at });
  }
  const kept = rows.filter((r) => !postFilter || (postFilter === 'echec' ? r.failed : r.as === postFilter));
  const waiting = kept.filter((r) => !r.done);
  const posted = kept.filter((r) => r.done);
  $('facebook').replaceChildren(...waiting.map((r) => facebookItem(r.v, pageOf(r.v), r.as)));
  $('facebook-done-box').hidden = !posted.length;
  $('facebook-done-title').textContent = `Déjà sur Facebook (${posted.length})`;
  $('facebook-done').replaceChildren(...posted.map((r) => facebookItem(r.v, pageOf(r.v), r.as)));
  // Photos / texts only: no YouTube videos; videos / Reels: shown open.
  $('fb-videos-box').hidden = postFilter === 'photo' || postFilter === 'texte' || !kept.length;
  if (postFilter === 'video' || postFilter === 'reel' || postFilter === 'echec') $('fb-videos-box').open = true;
  applyJob();
  $('no-facebook').hidden = data.sent.length > 0;
}

// What KappGen sent from the selected publication folder. No channel
// selection is required here: the folder and its manifest identify each
// publication.
async function renderOnYoutube(data, config) {
  // The long video and its Short: two rows, one under the other.
  $('sent').replaceChildren(...[...data.sent].sort((a, b) => Date.parse(b.date || 0) - Date.parse(a.date || 0))
    .flatMap((v) => (v.short_youtube_id ? [sentItem(v), shortItem(v)] : [sentItem(v)])));
  applyYtFilter();
  applyJob();
  if (!data.sent.length) $('sent-summary').textContent = 'Aucune vidéo publiée détectée dans ce dossier.';
}

function youtubeItem(video) {
  const item = el('li', 'video');
  const box = el('div', 'thumb');
  const img = document.createElement('img');
  img.src = `https://i.ytimg.com/vi/${video.id}/mqdefault.jpg`;
  img.alt = '';
  box.append(img);
  const info = el('div', 'info');
  info.append(el('div', 'title', video.title), el('div', 'meta', [video.published, video.views, video.length].filter(Boolean).join(' · ')));
  const link = el('a', 'secondary', 'Ouvrir dans Studio');
  link.href = `https://studio.youtube.com/video/${video.id}/edit`;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  const buttons = el('div', 'buttons');
  buttons.append(link);
  item.append(box, info, buttons);
  return item;
}

async function pickFolder() {
  try {
    rootHandle = await window.showDirectoryPicker({ id: 'kappgen-videos', mode: 'readwrite' });
    await KappDossier.saveRoot(rootHandle);
    // Watching starts now: what is already in the folder waits for a click.
    const current = await settings();
    current.watchSince = Date.now();
    await chrome.storage.local.set({ folder: current });
    send({ type: 'autoNow' }); // a chosen folder is published right away
  } catch (error) {
    if (!error || error.name !== 'AbortError') {
      $('folder-status').hidden = false;
      $('folder-status').textContent = String((error && error.message) || error);
    }
  }
  renderFolder();
  renderPosts();
}
$('pick').addEventListener('click', pickFolder);
$('pick-change').addEventListener('click', pickFolder);

// One folder per network (Réglages → Dossiers): by default the main one.
const FOLDER_NETS = [
  ['youtube', 'YouTube', 'tes vidéos'],
  ['facebook', 'Facebook', 'posts et Reels'],
  ['instagram', 'Instagram', 'Reels'],
  ['tiktok', 'TikTok', 'vidéos'],
  ['x', 'X', 'posts'],
  ['linkedin', 'LinkedIn', 'posts'],
];
// Loaded in advance: Chrome only shows its prompt when requestPermission is
// called right in the click.
const netHandles = {};
async function loadNetHandles() {
  for (const [net] of FOLDER_NETS) netHandles[net] = await KappDossier.loadNetRoot(net).catch(() => null);
}
loadNetHandles();
let fbRootHandle = null; // kept for the « Reprendre » button
const netFolderSaid = (text) => {
  const status = $('net-folders-status');
  status.hidden = !text;
  status.textContent = text || '';
};
async function pickNetFolder(net) {
  try {
    const handle = await window.showDirectoryPicker({ id: `kappgen-${net}`, mode: 'readwrite' });
    await KappDossier.saveNetRoot(net, handle);
    netHandles[net] = handle;
    if (net === 'youtube') {
      // Watching starts now: what is already in the folder waits for a click.
      const current = await settings();
      current.watchSince = Date.now();
      await chrome.storage.local.set({ folder: current });
    }
    netFolderSaid('');
    send({ type: 'autoNow' });
  } catch (error) {
    if (!error || error.name !== 'AbortError') netFolderSaid(String((error && error.message) || error));
  }
  refreshFolders();
}
async function forgetNetFolder(net) {
  await KappDossier.clearNetRoot(net);
  netHandles[net] = null;
  send({ type: 'autoNow' });
  refreshFolders();
}
async function grantNetFolder(net) {
  const handle = netHandles[net];
  if (handle) await handle.requestPermission({ mode: 'readwrite' }).catch(() => {});
  send({ type: 'autoNow' });
  refreshFolders();
}
function refreshFolders() {
  renderFolder();
  renderPosts();
  renderNetSettings();
}
function renderNetFolders(all) {
  fbRootHandle = netHandles.facebook || null;
  $('net-folders').replaceChildren(...FOLDER_NETS.map(([net, label, what]) => {
    const info = all[net] || { state: 'none' };
    const row = el('li', `net-folder${info.own ? ' own' : ''}`);
    const name = el('div', 'net-folder-name');
    name.append(logo(net, 14), el('strong', null, label), el('small', null, what));
    const where = el('div', 'net-folder-where');
    if (info.own) where.append(icon('folder'), el('span', null, info.name));
    else if (info.shared === 'facebook') where.append(icon('folder'), el('span', null, `${info.name} (même dossier que Facebook)`));
    else where.append(el('span', 'muted', all.main && all.main.state !== 'none' ? 'Dossier principal' : '—'));
    const acts = el('div', 'net-folder-acts');
    if (info.own && info.state === 'prompt') {
      const grant = button('Autoriser', 'btn primary small-btn', () => grantNetFolder(net));
      acts.append(grant);
    }
    const change = button(info.own ? 'Changer' : 'Choisir', 'btn ghost small-btn', () => pickNetFolder(net));
    change.title = info.own ? 'Choisir un autre dossier pour ce réseau' : `Un dossier rien que pour ${label}`;
    acts.append(change);
    if (info.own) {
      const back = el('button', 'icon-close', '✕');
      back.type = 'button';
      back.title = 'Revenir au dossier principal';
      back.setAttribute('aria-label', back.title);
      back.addEventListener('click', () => forgetNetFolder(net));
      acts.append(back);
    }
    row.append(name, where, acts);
    return row;
  }));
}

// X / LinkedIn tabs: what goes there, and the folder of their own posts.
async function renderNetSettings() {
  const config = await settings();
  const all = await KappDossier.folders().catch(() => ({}));
  for (const box of document.querySelectorAll('.net-settings')) {
    const net = box.dataset.net;
    const own = all[net] && all[net].own;
    for (const input of box.querySelectorAll('input[data-key]')) {
      input.checked = config[input.dataset.key] !== false;
      // A network with its own folder only takes that folder's posts.
      input.disabled = !!own;
      input.closest('.set-row').classList.toggle('off', !!own);
    }
    const dirName = { x: 'X', linkedin: 'LINKEDIN' }[net];
    box.querySelector('.net-folder-line').textContent = own
      ? `Dossier « ${all[net].name} » : seuls ses posts partent.`
      : all[net] && all[net].shared === 'facebook'
        ? `Mêmes posts que Facebook (dossier « ${all[net].name} »), chacun à son heure.`
        : `Mêmes posts que Facebook, plus ${dirName}/A-PUBLIER du dossier principal.`;
    const on = config.networks && config.networks[net];
    const state = box.querySelector('.net-state');
    state.className = `pill net-state ${on ? 'ok' : 'neutral'}`;
    state.textContent = !on ? 'Désactivé' : own ? 'Son propre dossier' : 'Automatique';
  }
}
for (const box of document.querySelectorAll('.net-settings')) {
  for (const input of box.querySelectorAll('input[data-key]')) {
    input.addEventListener('change', async () => {
      const current = await settings();
      current[input.dataset.key] = input.checked;
      await chrome.storage.local.set({ folder: current });
      send({ type: 'autoNow' });
    });
  }
  box.querySelector('.net-folder-btn').addEventListener('click', () => {
    document.querySelector('.topbar [data-tab="settings"]').click();
    const target = $('set-net-folders');
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target.classList.remove('flash');
    void target.offsetWidth;
    target.classList.add('flash');
  });
}

// Loaded in advance so the click calls requestPermission straight away
// (Chrome ignores it when something was awaited first).
let rootHandle = null;
KappDossier.loadRoot().then((handle) => { rootHandle = handle; }).catch(() => {});

$('grant').addEventListener('click', async () => {
  const handle = rootHandle || await KappDossier.loadRoot();
  if (handle) await handle.requestPermission({ mode: 'readwrite' }).catch(() => {});
  renderFolder();
  send({ type: 'autoNow' });
});

$('rescan').addEventListener('click', () => { renderFolder(); renderApp(); renderPosts(); });

// ---------------------------------------------------------- subscription

let paywallBack = false; // paywall opened from the menu while still subscribed

// Main screen only with an active subscription (or the trial); otherwise the
// subscription screen.
async function renderSubscription({ fresh = false } = {}) {
  const reply = await send({ type: 'access', fresh });
  const state = reply && reply.ok ? reply.data : { active: false, offline: true };
  const active = !!state.active;
  $('main').hidden = !active || paywallBack;
  $('paywall').hidden = active && !paywallBack;
  $('pw-trial').hidden = !state.trial_available;
  const trialDays = state.trial_days || 7;
  $('pw-trial').textContent = `Essayer gratuitement ${trialDays} jours`;
  $('pw-back').hidden = !(active && paywallBack);
  const forever = state.kind === 'lifetime' || state.kind === 'unlimited';
  $('pw-current').hidden = !active;
  $('pw-current').textContent = !active ? '' : forever ? 'Tu as l’accès à vie : rien à payer.' : state.kind === 'trial'
    ? `Essai gratuit en cours : ${state.days_left} jour(s) restant(s).` : `Premium actif encore ${state.days_left} jour(s). Un nouvel achat s’ajoute à la suite.`;
  $('offers').hidden = active && forever;
  $('pw-subscribe').hidden = active && forever;
  renderOffers();
  const message = $('pw-message');
  message.className = 'small muted';
  message.textContent = state.unavailable ? 'Le serveur KappGen n’est pas encore à jour : réessaie un peu plus tard.'
    : state.offline ? 'Impossible de vérifier ton abonnement : vérifie ta connexion Internet.'
      : state.trial_available ? `Commence par l’essai gratuit : rien à payer pendant ${trialDays} jours.`
        : waitingPayment ? 'En attente de ton paiement… KappGen Publish se débloque tout seul dès qu’il est confirmé.'
          : 'Choisis ta formule. Paiement sécurisé par carte, PayPal ou Mobile Money.';
  const until = state.expires_at ? new Date(state.expires_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' }) : '';
  $('account-plan').textContent = !active ? 'Gratuit · aucun abonnement actif'
    : forever ? 'Premium · accès à vie'
      : state.kind === 'trial' ? `Essai gratuit : ${state.days_left} jour(s) restant(s)` : `Premium · jusqu’au ${until}`;
  $('account-plan').classList.toggle('free', !active);
  if (active && waitingPayment) { waitingPayment = false; stopPaymentWatch(); }
  // Small badge on the title line: the trial, or a subscription ending soon.
  const pill = $('plan-pill');
  pill.hidden = !(active && state.kind !== 'lifetime' && state.kind !== 'unlimited' && (state.kind === 'trial' || state.days_left <= 3));
  pill.className = `plan-pill${state.days_left <= 1 ? ' urgent' : ''}`;
  pill.textContent = state.kind === 'trial' ? `Essai gratuit · ${state.days_left} j` : `Abonnement · ${state.days_left} j`;
  $('plan-banner').hidden = true;
  return active;
}

async function paywallAction(node, message, busy) {
  const text = node.textContent;
  node.disabled = true;
  node.textContent = busy;
  const reply = await send(message);
  node.disabled = false;
  node.textContent = text;
  if (!reply || !reply.ok) {
    $('pw-message').className = 'small warn';
    $('pw-message').textContent = reply ? reply.error : 'Action impossible.';
    return null;
  }
  return reply.data;
}

// Partner code typed before paying (or starting the trial): ties this account
// to the partner who brought it.
async function applyPartnerCode() {
  const code = $('pw-ref').value.trim();
  if (!code) return true;
  const msg = $('pw-ref-msg');
  const reply = await send({ type: 'claimReferral', code });
  msg.hidden = false;
  msg.className = `small ${reply && reply.ok ? 'ok-text' : 'warn'}`;
  msg.textContent = reply && reply.ok ? `Code accepté${reply.data.referrer ? ` : de la part de ${reply.data.referrer}` : ''}.` : (reply ? reply.error : 'Code non vérifié.');
  if (reply && reply.ok) $('pw-ref').value = '';
  return !!(reply && reply.ok);
}
$('pw-ref-apply').addEventListener('click', () => applyPartnerCode());

$('pw-trial').addEventListener('click', async () => {
  if (!await applyPartnerCode()) return;
  if (await paywallAction($('pw-trial'), { type: 'startTrial' }, 'Activation…')) { paywallBack = false; start(); }
});

// Offer chosen on the paywall (monthly by default; lifetime highlighted).
let chosenOffer = 'lifetime';
const OFFER_TEXT = { monthly: '2 $ par mois', yearly: '20 $ par an', lifetime: '50 $ une seule fois (accès à vie)' };
function renderOffers() {
  for (const b of document.querySelectorAll('#offers .offer')) {
    b.classList.toggle('active', b.dataset.offer === chosenOffer);
    b.setAttribute('aria-checked', String(b.dataset.offer === chosenOffer));
  }
}
for (const b of document.querySelectorAll('#offers .offer')) {
  b.addEventListener('click', () => { chosenOffer = b.dataset.offer; renderOffers(); });
}
$('pw-subscribe').addEventListener('click', async () => {
  if (!await applyPartnerCode()) return;
  $('pay-summary').textContent = `Formule choisie : ${OFFER_TEXT[chosenOffer]}.`;
  $('pay-modal').hidden = false;
});
$('pay-close').addEventListener('click', () => { $('pay-modal').hidden = true; });
$('pay-modal').addEventListener('click', (event) => { if (event.target === $('pay-modal')) $('pay-modal').hidden = true; });

// After the payment tab opens, the panel asks the server every 10 s (and when it
// comes back to the front): as soon as the order is paid, it unlocks by itself.
let waitingPayment = false;
let paymentTimer = null;
function stopPaymentWatch() { clearInterval(paymentTimer); paymentTimer = null; }
async function checkPaymentNow() {
  const reply = await send({ type: 'checkPayment' });
  if (reply && reply.ok && reply.data.active) {
    waitingPayment = false;
    stopPaymentWatch();
    paywallBack = false;
    start();
  }
}
for (const method of document.querySelectorAll('.pay-method')) {
  method.addEventListener('click', async () => {
    for (const m of document.querySelectorAll('.pay-method')) m.disabled = true;
    const reply = await send({ type: 'subscribe', provider: method.dataset.provider, offer: chosenOffer });
    for (const m of document.querySelectorAll('.pay-method')) m.disabled = false;
    $('pay-modal').hidden = true;
    if (!reply || !reply.ok) {
      $('pw-message').className = 'small warn';
      $('pw-message').textContent = reply ? reply.error : 'Paiement impossible à ouvrir.';
      return;
    }
    waitingPayment = true;
    $('pw-message').className = 'small muted waiting';
    $('pw-message').textContent = 'En attente de ton paiement… Termine-le dans l’onglet ouvert : KappGen Publish se débloque tout seul ici.';
    stopPaymentWatch();
    paymentTimer = setInterval(checkPaymentNow, 10000);
    setTimeout(stopPaymentWatch, 30 * 60 * 1000);
  });
}
$('pw-back').addEventListener('click', () => { paywallBack = false; renderSubscription(); });
$('plan-pill').addEventListener('click', () => { paywallBack = true; renderSubscription(); });
$('renew').addEventListener('click', () => { toggleProfile(false); paywallBack = true; renderSubscription(); });
// Back from the payment tab: check on its own.
document.addEventListener('visibilitychange', async () => {
  if (document.hidden || $('paywall').hidden) return;
  checkPaymentNow();
});

// --------------------------------------------------------------- account

// Everything else waits for the KappGen account to be connected.
async function renderAccount() {
  const reply = await send({ type: 'account' });
  const user = reply && reply.ok && reply.data && typeof reply.data === 'object' ? reply.data : null;
  $('profile').hidden = !user;
  $('account').hidden = !!user; // the login card only when signed out
  $('login').hidden = !!user;
  if (!user) { $('main').hidden = true; $('paywall').hidden = true; watchLogin(); }
  if (!user) {
    const error = $('login-error');
    error.hidden = !reply || reply.ok;
    if (reply && !reply.ok) error.textContent = reply.error;
    return false;
  }
  const email = typeof user.email === 'string' ? user.email : '';
  const name = typeof user.name === 'string' ? user.name : '';
  $('account-email').textContent = email || 'Compte KappGen';
  $('pw-account-email').textContent = email || 'Compte KappGen'; // shown on the paywall: the right account?
  $('account-name').textContent = name || email.split('@')[0] || 'Compte KappGen';
  // Profile photo (Google account), otherwise the first letter.
  const avatar = $('avatar');
  avatar.replaceChildren();
  if (user.picture_url) {
    const img = document.createElement('img');
    img.src = user.picture_url;
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => { avatar.textContent = (name || email || '?').trim()[0].toUpperCase(); });
    avatar.append(img);
  } else {
    avatar.textContent = (name || email || '?').trim()[0].toUpperCase();
  }
  return true;
}

$('login').addEventListener('submit', async (event) => {
  event.preventDefault();
  const reply = await send({ type: 'login', email: $('login-email').value.trim(), password: $('login-password').value });
  $('login-password').value = '';
  if (!reply || !reply.ok) {
    $('login-error').hidden = false;
    $('login-error').textContent = reply ? reply.error : 'Connexion impossible.';
    return;
  }
  start();
});

// The extension's own fetches already carry the shared kappgen.com session
// cookie (host_permissions + credentials:'include' in background.js's api()) —
// so signing in once on the website, with Google or a password, is enough
// for the extension to pick it up too. No separate Google flow is
// implemented inside the extension itself (a Chrome-extension OAuth client
// would mint a token for a different audience than what /auth/google
// verifies against) — opening the real login page is simpler and reuses
// whatever KappGen already supports there.
$('login-google').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://app.kappgen.com/login' });
});

// Signed in on app.kappgen.com in this Chrome (Google or password)? The panel
// notices on its own, with no button: it looks every few seconds while the
// login card is shown, and as soon as the panel is visible again.
let recheckingLogin = false;
let loginPoll = null;
function watchLogin() {
  if (loginPoll) return;
  loginPoll = setInterval(async () => {
    if ($('login').hidden) { clearInterval(loginPoll); loginPoll = null; return; }
    if (document.hidden || recheckingLogin) return;
    recheckingLogin = true;
    try {
      if (await renderAccount()) { clearInterval(loginPoll); loginPoll = null; start(); }
    } finally {
      recheckingLogin = false;
    }
  }, 3000);
}

// Catches the common case on its own: the panel was already open on the
// login screen, the user signs in on app.kappgen.com in another tab, then
// just comes back here without remembering to click "vérifier".
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !$('login').hidden) renderAccount().then((ok) => { if (ok) start(); });
});

// Account menu: opens on the avatar, closes on a click elsewhere or Escape.
function toggleProfile(open) {
  const menu = $('profile-menu');
  menu.hidden = !open;
  $('avatar').setAttribute('aria-expanded', String(open));
}
$('avatar').addEventListener('click', (event) => { event.stopPropagation(); toggleProfile($('profile-menu').hidden); });
document.addEventListener('click', (event) => { if (!$('profile').contains(event.target)) toggleProfile(false); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') toggleProfile(false); });

// Paywall: signed in with another address than the one that paid.
$('pw-switch').addEventListener('click', async () => {
  await send({ type: 'logout' });
  paywallBack = false;
  renderAccount();
  chrome.tabs.create({ url: 'https://app.kappgen.com/login' });
});

$('logout').addEventListener('click', async () => {
  toggleProfile(false);
  await send({ type: 'logout' });
  renderAccount();
});

// -------------------------------------------------------- KappGen videos

// Videos made in KappGen and waiting on this computer (local version only;
// the online version publishes them itself): shown only when there are some.
async function renderApp() {
  const queue = await send({ type: 'queue' });
  const videos = queue && queue.ok && Array.isArray(queue.data && queue.data.videos) ? queue.data.videos : [];
  $('app-block').hidden = !videos.length;
  $('app-videos').replaceChildren(...videos.map((video) => {
    const item = el('li', 'item');
    item.dataset.path = String(video.id);
    const info = el('div', 'info');
    const live = liveRegion();
    info.append(el('div', 'title', video.title), el('div', 'meta', [video.channel_name, size(video.size_bytes)].filter(Boolean).join(' · ')), live);
    item.say = (kind, text) => live.replaceChildren(pill(kind, text));
    if (video.last_error) item.say('warn', video.last_error);
    const go = button('Envoyer (non répertoriée)', 'btn primary', () => act(
      item,
      go,
      { type: 'publish', source: 'app', videoId: video.id, visibility: 'UNLISTED' },
      'Envoi vers YouTube Studio…',
    ));
    go.dataset.publish = '1';
    go.dataset.publishAvailable = video.file_path ? '1' : '0';
    go.disabled = jobRunning || !video.file_path;
    item.append(info, go);
    return item;
  }));
}

// ------------------------------------------------------------- the job

let currentJob = null;
let jobHideTimer = null;

// The running job, on its own card (and the other publish buttons wait).
function applyJob() {
  const job = currentJob;
  for (const node of document.querySelectorAll('[data-publish]')) {
    node.disabled = !!(job && job.running) || node.dataset.publishAvailable === '0';
  }
  if (!job || !job.path) return;
  // A job's news shows on its own network's tab only (a YouTube failure is
  // not the Facebook Reel's state).
  const tabOf = { facebook: 'facebook', post: 'facebook', image: 'facebook', groups: 'facebook', x: 'x', linkedin: 'linkedin', tiktok: 'tiktok', instagram: 'instagram' };
  const jobTab = `tab-${tabOf[job.kind] || 'youtube'}`;
  for (const item of document.querySelectorAll('li.item, li.row')) {
    if (item.dataset.path !== String(job.path) || !item.say) continue;
    const tab = item.closest('.tab');
    if (tab && tab.id !== jobTab) continue;
    if (job.running) item.say('busy', job.message || 'En cours…');
    else if (job.error || job.warning) item.say('warn', job.error || job.warning);
    else if (job.done) item.say('ok', job.message || 'Terminé.');
  }
}

function renderJob(job) {
  const box = $('job');
  const wasRunning = jobRunning;
  currentJob = job || null;
  jobRunning = !!(job && job.running);
  box.hidden = !job;
  if (job) {
    box.className = `job ${job.running ? 'running' : job.error ? 'error' : job.warning ? 'warning' : 'done'}`;
    $('job-title').textContent = job.running ? `En cours : ${job.title || 'publication'}`
      : job.error ? 'Échec' : job.warning ? 'Terminé avec avertissement' : 'Terminé';
    const jobDetails = [job.channel, job.message].filter(Boolean);
    if (job.warning && !String(job.message || '').includes(job.warning)) jobDetails.push(job.warning);
    $('job-message').textContent = jobDetails.join(' — ')
      + (job.running ? ' Les autres boutons « Publier » attendent la fin.' : '');
    $('job-link').hidden = !job.youtubeUrl;
    if (job.youtubeUrl) $('job-link').href = job.youtubeUrl;
    $('job-clear').hidden = jobRunning;
    // Stuck for more than 5 minutes without news: offer to unblock.
    const quiet = Date.now() - (job.updatedAt || job.startedAt || Date.now());
    $('job-unblock').hidden = !job.running; // « Annuler »: always there while it runs
    void quiet;
  }
  applyJob();
  clearTimeout(jobHideTimer);
  if (job && job.done && !job.error && !job.warning && !job.running) {
    jobHideTimer = setTimeout(async () => { await send({ type: 'clearJob' }); renderJob(null); }, 6000);
  }
  if (wasRunning && !jobRunning) { renderFolder(); renderApp(); renderPosts(); }
}

$('job-unblock').addEventListener('click', async () => {
  if (!confirm('Annuler cette publication ? Elle s’arrête tout de suite et ne repartira pas toute seule (bouton « Réessayer » ensuite).')) return;
  await send({ type: 'cancelJob' });
});
setInterval(() => { if (currentJob && currentJob.running) renderJob(currentJob); }, 30000);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.job) renderJob(changes.job.newValue);
});

$('job-clear').addEventListener('click', async () => {
  await send({ type: 'clearJob' });
  renderJob(null);
});

// Version next to the logo, and a notice when a newer one is out on GitHub
// (the zip install cannot update itself: the link explains how).
const newerVersion = (a, b) => {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};
function renderVersion(releaseCheck) {
  const current = chrome.runtime.getManifest().version;
  $('version').textContent = `v${current}`;
  const latest = releaseCheck && releaseCheck.latest;
  const pill = $('update-pill');
  pill.hidden = !(latest && newerVersion(latest, current));
  if (!pill.hidden) {
    pill.textContent = `Mise à jour ${latest}`;
    pill.title = `Ce profil Chrome a encore la version ${current}, la ${latest} est sortie. Relance la commande d’installation : elle met à jour tous tes profils. Si ce profil reste en retard, regarde d’où il charge l’extension (chrome://extensions → Détails → « Chargée depuis »).`;
  }
}
chrome.storage.local.get('releaseCheck').then(({ releaseCheck }) => renderVersion(releaseCheck));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.releaseCheck) renderVersion(changes.releaseCheck.newValue);
});
send({ type: 'checkRelease' }).catch(() => {});

// One line under the title: is the automatic publishing running, when did it
// last look, what is next, and on which clock (this computer's).
const clock = (t) => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
function timeZoneLabel() {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'heure locale';
  const offset = -new Date().getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const h = Math.floor(Math.abs(offset) / 60);
  const m = Math.abs(offset) % 60;
  return `${zone.replace(/_/g, ' ')}, UTC${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}
async function renderAutoStatus() {
  const { autoStatus, lastAutoTick, nextDueAt, catchUp, autoPaused } = await chrome.storage.local.get(['autoStatus', 'lastAutoTick', 'nextDueAt', 'catchUp', 'autoPaused']);
  const box = $('auto-status');
  const now = Date.now();
  // Folder access closed by Chrome: a card with one button instead of a sentence.
  const paused = !!(autoStatus && autoStatus.state === 'folder');
  $('paused').hidden = !paused;
  let tone = '';
  let text;
  if (paused) {
    box.hidden = true;
    return;
  } else if (autoPaused) {
    tone = 'warn'; text = 'Tout est en pause : rien ne part automatiquement. Clique « Reprendre » pour relancer.';
  } else if (autoStatus && autoStatus.state === 'nofolder') {
    tone = 'warn'; text = 'Publication automatique en attente : choisis d’abord le dossier de tes vidéos (Réglages).';
  } else if (!lastAutoTick) {
    text = 'Publication automatique : démarrage…';
  } else if (autoStatus && autoStatus.state === 'subscription') {
    tone = 'warn'; text = 'Publication automatique en pause : ton abonnement n’est plus actif.';
  } else if (now - lastAutoTick > 12 * 60000) {
    tone = 'warn'; text = `Pas de vérification depuis ${clock(lastAutoTick)} (Chrome fermé ou ordinateur en veille). Ce qui était prévu part maintenant.`;
  } else {
    tone = autoStatus && autoStatus.state === 'busy' ? 'busy' : '';
    const later = nextDueAt && new Date(nextDueAt).toDateString() !== new Date().toDateString()
      ? ` le ${new Date(nextDueAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}` : '';
    text = catchUp && catchUp.count > 1
      ? `Rattrapage : ${catchUp.count} posts en retard, un toutes les ${Math.round(catchUp.gap / 60000 * 10) / 10} min (prochain à ${clock(catchUp.next)})`
      : `Publication automatique active${nextDueAt ? ` · prochain post à ${clock(nextDueAt)}${later}` : ''} · heure de ton ordinateur : ${clock(now)} (${timeZoneLabel().split(',')[0].split('/').pop()})`;
  }
  box.className = `auto-status ${tone}`.trim();
  $('auto-status-text').textContent = text;
  box.title = `Les heures de publication suivent l’horloge de cet ordinateur (${timeZoneLabel()}). Dernière vérification : ${lastAutoTick ? clock(lastAutoTick) : '—'}.`;
  box.hidden = false;
}
// « Reprendre les publications »: Chrome's own prompt, for the videos folder
// (and the posts folder if there is one), straight from the click.
$('auto-resume').addEventListener('click', async () => {
  const main = rootHandle || await KappDossier.loadRoot();
  if (!main) {
    // No folder remembered: choose it (Réglages, first card).
    $('paused').hidden = true;
    $('setup-folder').click();
    return;
  }
  const state = await main.requestPermission({ mode: 'readwrite' }).catch(() => 'denied');
  if (state !== 'granted') {
    $('auto-resume').textContent = 'Accès refusé : clique de nouveau puis « Autoriser à chaque visite »';
    setTimeout(() => { $('auto-resume').textContent = 'Reprendre les publications'; }, 6000);
    return;
  }
  for (const handle of Object.values(netHandles)) {
    if (handle && await handle.queryPermission({ mode: 'readwrite' }).catch(() => 'granted') !== 'granted') {
      await handle.requestPermission({ mode: 'readwrite' }).catch(() => {});
    }
  }
  await send({ type: 'autoNow' });
  renderFolder();
  setTimeout(renderAutoStatus, 1500);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.autoStatus || changes.lastAutoTick || changes.nextDueAt || changes.catchUp || changes.autoPaused)) { renderAutoStatus(); renderPauseButton(); }
});
setInterval(() => { if (!document.hidden) renderAutoStatus(); }, 30000);

// Evening summary e-mail: off unless the creator ticks it. Ticking it never
// sends the past days, only from today on.
async function renderDailyReport() {
  const { dailyReport } = await chrome.storage.local.get('dailyReport');
  $('daily-report').checked = !!dailyReport;
}
$('daily-report').addEventListener('change', async () => {
  const on = $('daily-report').checked;
  const d = new Date(Date.now() - 86400000);
  const yesterday = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  await chrome.storage.local.set(on ? { dailyReport: true, reportedDays: [yesterday] } : { dailyReport: false });
});

// Only the partners chosen by KappGen see this card: their link and earnings.
const money = (n) => `${(n || 0).toLocaleString('fr-FR')} F`;
async function renderPartner() {
  const reply = await send({ type: 'referrals' });
  const data = reply && reply.ok ? reply.data : null;
  $('partner-card').hidden = !(data && data.partner);
  if (!data || !data.partner) return;
  $('partner-rate').textContent = `${Math.round(data.rate * 100)} % par vente`;
  $('partner-link').value = data.links.guide;
  $('partner-code').textContent = data.code;
  $('partner-referred').textContent = data.referred;
  $('partner-sales').textContent = data.sales;
  $('partner-due').textContent = money(data.due_fcfa);
  $('partner-paid').textContent = money(data.paid_fcfa);
}
$('partner-copy').addEventListener('click', async () => {
  const link = $('partner-link').value;
  try { await navigator.clipboard.writeText(link); } catch { $('partner-link').select(); document.execCommand('copy'); }
  $('partner-copy').textContent = 'Copié';
  setTimeout(() => { $('partner-copy').textContent = 'Copier'; }, 1800);
});

// Pause / Lecture: stops every automatic publication (YouTube, Facebook,
// groups, TikTok, Instagram) until clicked again. « Publier » buttons still work.
const PAUSE_ICON = '<svg class="ico" viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
const PLAY_ICON = '<svg class="ico" viewBox="0 0 24 24"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5Z"/></svg>';
async function renderPauseButton() {
  const { autoPaused } = await chrome.storage.local.get('autoPaused');
  const b = $('pause-all');
  b.classList.toggle('paused', !!autoPaused);
  b.innerHTML = `${autoPaused ? PLAY_ICON : PAUSE_ICON}<span>${autoPaused ? 'Reprendre' : 'Pause'}</span>`;
  b.title = autoPaused ? 'Tout est en pause : cliquer pour reprendre les publications automatiques'
    : 'Mettre en pause toutes les publications automatiques';
}
$('pause-all').addEventListener('click', async () => {
  const { autoPaused } = await chrome.storage.local.get('autoPaused');
  await chrome.storage.local.set({ autoPaused: !autoPaused });
  if (autoPaused) send({ type: 'autoNow' }); // play: start again now
  renderPauseButton();
  renderAutoStatus();
});
renderPauseButton();

let startPromise = null;
let startQueued = false;
function start() {
  if (startPromise) {
    startQueued = true;
    return startPromise;
  }
  startPromise = startOnce().catch((error) => {
    const target = $('main').hidden ? $('login-error') : $('folder-status');
    target.hidden = false;
    target.className = target === $('folder-status') ? 'status error' : target.className;
    target.textContent = String(error.message || error);
  }).finally(() => {
    startPromise = null;
    if (startQueued) {
      startQueued = false;
      queueMicrotask(start);
    }
  });
  return startPromise;
}

async function startOnce() {
  if (!(await renderAccount())) { watchLogin(); return; }
  if (!(await renderSubscription({ fresh: true }))) return;
  const { job } = await chrome.storage.session.get('job');
  renderJob(job);
  renderPublishSettings();
  renderNetworks();
  applyNetworks();
  renderFolder();
  renderApp();
  renderPosts();
  renderAutoStatus();
  renderDailyReport();
  renderPartner().catch(() => {});
}
start();

// The background worker applies updates by itself: keep the lists current.
setInterval(() => { if (!document.hidden && !jobRunning) renderFolder(); }, 60000);

function bindInstagramAuto() {
  const box = document.getElementById('instagram-auto');
  if (box) box.addEventListener('change', () => send({ type: 'instagramAuto', on: box.checked }));
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindInstagramAuto);
else bindInstagramAuto();
