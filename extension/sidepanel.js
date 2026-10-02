// Side panel: the whole extension in one place, next to the page being
// viewed (choose the publication folder, videos waiting, YouTube updates,
// Facebook derivatives, KappGen videos and progress). Unlike a popup it stays
// open while Chrome's folder picker is shown.
const $ = (id) => document.getElementById(id);

function send(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}

const size = (bytes) => (!bytes ? '' : bytes > 1e9 ? `${(bytes / 1e9).toFixed(1)} Go` : `${Math.round(bytes / 1e6)} Mo`);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Small preview of the thumbnail file kept in the folder.
function thumb(path) {
  const box = el('div', 'thumb');
  if (path) {
    KappDossier.fileAt(path).then((file) => {
      const img = document.createElement('img');
      img.src = URL.createObjectURL(file);
      img.alt = '';
      box.append(img);
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

// Small status line with a coloured dot: ok, warn, info, busy (spinner).
function pill(kind, text) {
  return el('div', `pill ${kind}`, text);
}

// Small line icons (no emoji): clock, link, play, refresh.
const ICON_PATHS = {
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  link: '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
  short: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="m10.5 9.5 4 2.5-4 2.5z"/>',
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
function mediaRow({ path, preview, youtubeId, emptyLabel = 'Vidéo', title, detail, status, actions = [], extra = [] }) {
  const item = el('li', 'row media');
  if (path) item.dataset.path = path;
  const mini = el('div', 'mini wide', emptyLabel);
  const show = (src) => { const img = document.createElement('img'); img.src = src; img.alt = ''; mini.replaceChildren(img); };
  if (youtubeId) show(`https://i.ytimg.com/vi/${youtubeId}/mqdefault.jpg`);
  else if (preview) KappDossier.fileAt(preview).then((file) => show(URL.createObjectURL(file))).catch(() => {});
  const what = el('div', 'what');
  what.append(el('div', 't', title));
  if (detail) what.append(el('div', 'd', detail));
  const live = el('div', 'live');
  if (status) live.append(status);
  what.append(live);
  for (const node of extra) what.append(node);
  const acts = el('div', 'acts');
  acts.append(...actions);
  item.append(mini, what, acts);
  item.say = (kind, text) => live.replaceChildren(pill(kind, text));
  return item;
}
function iconLink(name, label, href) {
  const a = el('a', 'btn ghost icon-btn');
  a.href = href;
  a.target = '_blank';
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
  const live = el('div', 'live');
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
const localInput = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const whenText = (ts) => new Date(ts).toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
function timeButton(getItem, current, onSave, { label = 'Modifier l’heure', clearable = false } = {}) {
  const open = button(label, 'btn ghost', () => {
    const item = getItem();
    const existing = item.querySelector(':scope > .field.when');
    if (existing) { existing.remove(); return; }
    const field = el('div', 'field when');
    const group = el('div', 'input-group');
    const input = document.createElement('input');
    input.type = 'datetime-local';
    input.value = localInput(current || Date.now() + 3600 * 1000);
    input.min = localInput(Date.now());
    const save = button('Enregistrer', 'btn secondary', async () => {
      const at = new Date(input.value).getTime();
      if (!Number.isFinite(at) || at < Date.now() + 60 * 1000) {
        input.setCustomValidity('Choisis une date et une heure à venir.');
        input.reportValidity();
        return;
      }
      save.disabled = true;
      await onSave(at);
    });
    input.addEventListener('input', () => input.setCustomValidity(''));
    group.append(input, save);
    if (clearable && current) group.append(button('Retirer', 'btn ghost', async () => { await onSave(null); }));
    field.append(el('label', null, 'Nouvelle date et heure de publication :'), group);
    item.insertBefore(field, item.querySelector(':scope > .actions-row'));
    input.focus();
  });
  return open;
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
  tab.addEventListener('click', () => {
    for (const other of document.querySelectorAll('nav [data-tab]')) other.classList.toggle('active', other === tab);
    for (const pane of document.querySelectorAll('.tab')) pane.hidden = pane.id !== `tab-${tab.dataset.tab}`;
    $('setup-go').hidden = tab.dataset.tab === 'settings';
  });
}

// ------------------------------------------------------------ first run

// Right after signing in, nothing can go out before the folder is chosen:
// say so, show what is left, and open the settings once by ourselves.
let setupOpened = false;
async function renderSetup() {
  const config = await settings();
  const folderOk = (await KappDossier.access()).state === 'granted';
  const pagesOk = PAGE_FIELDS.filter(([name]) => networkIsOn(config, name)).every(([name]) => pageUrlOf(config, name));
  $('setup-folder').classList.toggle('done', folderOk);
  $('setup-pages').classList.toggle('done', pagesOk);
  $('setup').hidden = folderOk && pagesOk;
  if (!folderOk && !setupOpened) {
    setupOpened = true;
    document.querySelector('.topbar [data-tab="settings"]').click();
  }
}
$('setup-go').addEventListener('click', () => document.querySelector('.topbar [data-tab="settings"]').click());

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
    status, actions: [drop, already, plan, go],
  });
  if (video.thumbnail_warning && !video.last_error) item.querySelector('.info').append(pill('warn', video.thumbnail_warning));
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
    await saveChannel(channel.key, { facebookPageUrl: facebookPage.value.trim() || null });
    send({ type: 'autoNow' });
  });
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
  times.addEventListener('change', () => saveChannel(channel.key, { times: times.value.trim() || '18:00' }));
  visibility.addEventListener('change', async () => {
    if (visibility.value === 'PUBLIC' && !confirm(`${channel.name} : chaque vidéo prête sera PUBLIÉE directement sur YouTube, sans que tu la valides.`)) {
      visibility.value = own.visibility || 'UNLISTED';
      return;
    }
    await saveChannel(channel.key, { visibility: visibility.value, times: times.value.trim() || '18:00' });
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
    status = pill('warn', 'Le lien YouTube de cette vidéo n’a pas été enregistré.');
    const group = el('div', 'input-group');
    const input = document.createElement('input');
    input.type = 'url';
    input.placeholder = 'Colle le lien YouTube de la vidéo';
    const save = button('Enregistrer', 'btn secondary', async () => {
      const data = await act(item, save, { type: 'linkYoutube', path: video.relative_path, url: input.value.trim() });
      if (data) { item.say('busy', 'Lien enregistré : titre, description et miniature vont être appliqués…'); setTimeout(renderFolder, 1500); }
    });
    group.append(input, save);
    const field = el('div', 'field');
    field.append(el('label', null, 'Elle est déjà sur YouTube ? Colle son lien pour la mettre à jour :'), group);
    extra.push(field);
    const again = button('Republier avec les infos à jour', 'btn ghost', async () => {
      if (!confirm('La vidéo sera envoyée de nouveau sur YouTube, avec le titre, la description et la miniature du dossier.\n\nPense à supprimer l’ancienne version dans YouTube Studio.')) return;
      await act(item, again, { type: 'republish', path: video.relative_path }, 'Nouvel envoi vers YouTube en cours…');
    });
    actions.push(again);
  } else {
    if (!video.has_content) status = pill('neutral', 'Aucune fiche ni miniature dans le dossier.');
    else if (video.applied_hash === video.hash) status = pill('ok', 'À jour sur YouTube.');
    else if (video.update_error && video.update_tried_hash === video.hash) status = pill('warn', `Mise à jour échouée : ${video.update_error}`);
    else status = pill('neutral', 'Modifications à envoyer : mise à jour toute seule dans 5 à 10 min.');
    // A published video needs no buttons: it is listed small, and updated by
    // itself. "Mettre à jour" only shows when an update failed.
    actions.push(iconLink('link', 'Voir', `https://youtu.be/${video.youtube_id}`));
    // Its vertical version (short.mp4) as a YouTube Short.
    if (video.short_youtube_id) {
      actions.push(iconLink('short', 'Short', `https://youtube.com/shorts/${video.short_youtube_id}`));
    } else if (video.vertical_path) {
      if (video.short_error) extra.push(el('div', 'small muted', `Short : ${video.short_error}`));
      const short = button(video.short_error ? 'Réessayer le Short' : 'Publier le Short', 'btn secondary', () => act(item, short,
        { type: 'shortYoutube', path: video.relative_path }, 'Envoi du Short sur YouTube en cours… (Studio s’ouvre)'));
      short.dataset.publish = '1';
      actions.push(short);
    }
    if (video.update_error && video.update_tried_hash === video.hash) {
      const update = button('Réessayer la mise à jour', 'btn primary', () => act(item, update,
        { type: 'update', path: video.relative_path }, 'Mise à jour sur YouTube en cours…'));
      update.dataset.publish = '1';
      actions.push(update);
    }
  }
  item = mediaRow({
    path: video.relative_path, preview: video.preview_path, youtubeId: video.youtube_id,
    title: video.title || video.relative_path.split('/').pop(),
    detail: [chan(video.channel_name), video.date ? new Date(video.date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) : null,
      video.short_youtube_id ? 'Short publié' : video.vertical_path ? 'Short prêt' : null].filter(Boolean).join(' · '),
    status, actions, extra,
  });
  return item;
}


// ------------------------------------------------------ networks used

const NETWORKS = [
  ['youtube', 'YouTube', 'Vidéos et Shorts depuis le dossier.', 'youtube'],
  ['facebook', 'Facebook', 'Reels, vidéos et posts programmés sur ta page.', 'facebook'],
  ['tiktok', 'TikTok', 'Vidéos verticales (et horizontales) sur ton compte.', 'tiktok'],
  ['instagram', 'Instagram', 'Reels (versions verticales) sur ton compte.', 'instagram'],
  ['linkedin', 'LinkedIn', 'En développement.', 'linkedin'],
  ['snapchat', 'Snapchat', 'En développement.', 'snapchat'],
  ['x', 'X', 'En développement.', 'x'],
];
const networkIsOn = (config, name) => ((config.networks || {})[name] !== false);

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
    text.append(el('strong', null, label), el('div', 'small muted', hint));
    const wrap = el('label');
    wrap.append(box, text);
    box.addEventListener('change', async () => {
      const current = await settings();
      current.networks = { ...(current.networks || {}), [name]: box.checked };
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

const TIMES = /^\s*\d{1,2}[:hH]\d{2}(\s*[,;\s]\s*\d{1,2}[:hH]\d{2})*\s*$/;

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
    if (radio.value === 'now' || TIMES.test($('yt-times').value)) await saveSetting({ schedule: radio.value });
    else $('yt-times').focus();
  });
}
function timesSaver(input, key, extra = {}) {
  return async () => {
    const value = $(input).value.trim();
    if (!TIMES.test(value)) {
      $(input).setCustomValidity('Écris des heures comme 08:00, 12:30, 18:00');
      $(input).reportValidity();
      return;
    }
    await saveSetting({ [key]: value.replace(/[hH]/g, ':'), ...extra });
    renderPosts();
  };
}
$('yt-times-save').addEventListener('click', timesSaver('yt-times', 'times', { schedule: 'times' }));
for (const id of ['yt-times']) {
  $(id).addEventListener('input', () => $(id).setCustomValidity(''));
  $(id).addEventListener('keydown', (event) => { if (event.key === 'Enter') $(`${id}-save`).click(); });
}

// ------------------------------------------------------ Facebook posts

const POST_STATES = { a_publier: 'prévu', en_cours: 'en cours', publie: 'publié', echec: 'échec' };
const POST_TYPES = { photo: 'Photo', texte: 'Texte', reel: 'Reel' };

let lastScan = null;  // last scan of the videos folder
let lastPosts = [];   // last list of Facebook posts

// Facebook folder (Reels and posts), chosen apart from the videos folder.
async function renderFbAccess() {
  const access = await KappDossier.fbAccess().catch(() => ({ state: 'none' }));
  showFolder('fb-', access);
  $('fb-forget').hidden = access.state === 'none';
  return access;
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
  } else if (post.due_at) {
    const d = new Date(post.due_at);
    const today = d.toDateString() === new Date().toDateString();
    when.append(el('strong', null, `${pad2(d.getHours())}:${pad2(d.getMinutes())}`), el('span', null, today ? 'aujourd’hui' : d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' })));
  } else {
    when.append(el('strong', null, '—'), el('span', null, 'sans heure'));
  }
  const mini = el('div', 'mini', POST_TYPES[post.type]);
  if (post.image_path) KappDossier.fileAt(post.image_path).then((file) => { const img = document.createElement('img'); img.src = URL.createObjectURL(file); img.alt = ''; mini.replaceChildren(img); }).catch(() => {});
  const what = el('div', 'what');
  what.append(el('div', 't', post.text.split('\n')[0] || '(sans texte)'));
  const live = el('div', 'live');
  const due = post.due_at && post.due_at > Date.now();
  const states = {
    a_publier: due ? pillIcon('neutral', 'Programmé', 'clock') : pill('neutral', 'Part dans les 5 min'),
    en_cours: pill('busy', 'Publication en cours…'),
    publie: pill('ok', 'Publié'),
    echec: pill('warn', post.error || 'Échec de la publication.'),
  };
  live.append(states[post.statut] || pill('neutral', post.statut));
  what.append(live);
  const acts = el('div', 'acts');
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
    acts.append(change, go);
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
function dayGroups(list, timeOf, scope, { openToday = false } = {}) {
  const groups = new Map();
  for (const post of list) {
    const key = dayKey(timeOf(post));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(post);
  }
  const today = dayKey(Date.now());
  return [...groups].map(([key, posts]) => {
    const box = el('details', 'day');
    const id = `${scope}:${key}`;
    box.open = openDays.has(id) || (openToday && key === today && !openDays.has(`${id}:closed`));
    const summary = el('summary');
    const failed = posts.filter((p) => p.statut === 'echec').length;
    summary.append(el('span', 'day-name', dayLabel(key)), el('span', 'day-count', `${posts.length} post${posts.length > 1 ? 's' : ''}${failed ? ` · ${failed} en échec` : ''}`));
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
  });
}
for (const b of $('fb-sort').querySelectorAll('button')) b.addEventListener('click', () => {
  postSort = b.dataset.value;
  for (const x of $('fb-sort').querySelectorAll('button')) { x.classList.toggle('active', x === b); x.setAttribute('aria-checked', String(x === b)); }
  renderPosts();
});

async function renderPosts() {
  const access = await renderFbAccess();
  const reply = await send({ type: 'facebookPosts' });
  const posts = reply && reply.ok ? reply.data : [];
  lastPosts = posts;
  const config = await settings();
  const pageOf = (p) => p.page || ((config.channels[p.channel_key] || {}).facebookPageUrl) || config.facebookPageUrl;
  const missingPage = posts.some((p) => p.statut === 'a_publier' && !pageOf(p));
  const rank = { en_cours: 0, echec: 1, a_publier: 2 };
  const toCome = posts.filter((p) => p.statut !== 'publie')
    .sort((a, b) => (rank[a.statut] ?? 3) - (rank[b.statut] ?? 3) || (a.due_at || 0) - (b.due_at || 0) || a.path.localeCompare(b.path));
  const done = posts.filter((p) => p.statut === 'publie')
    .sort((a, b) => Date.parse(b.published_at || 0) - Date.parse(a.published_at || 0));
  const summary = $('fb-summary');
  if (reply && !reply.ok) { summary.className = 'warn'; summary.textContent = reply.error; }
  else {
    summary.className = 'muted small';
    summary.textContent = !posts.length ? (access.state === 'granted' ? 'Aucun post dans ce dossier.' : '')
      : `${toCome.length} à venir · ${done.length} publié(s)` + (missingPage ? ' · lien de la page manquant (en haut)' : '');
  }
  const shown = (p) => !postFilter || (postFilter === 'echec' ? p.statut === 'echec' : p.type === postFilter);
  const upcoming = toCome.filter(shown);
  if (postSort === 'desc') upcoming.sort((a, b) => (b.due_at || 0) - (a.due_at || 0));
  $('fb-days').replaceChildren(...dayGroups(upcoming, (p) => p.due_at, 'come', { openToday: true }));
  $('fb-done-box').hidden = !done.length;
  $('fb-done-title').textContent = `Déjà publiés (${done.length})`;
  $('fb-done-days').replaceChildren(...dayGroups(done.filter(shown), (p) => Date.parse(p.published_at || 0) || p.due_at, 'done'));
  $('no-posts').hidden = !(posts.length && !upcoming.length);
  applyJob();
  renderTikTok();
  renderInstagram();
  renderPages();
}

// Settings › « Tes pages et comptes »: one link per network in use. Facebook's
// stays in settings.facebookPageUrl (read by the background worker); the
// others in settings.pageUrls, for now as a reminder of where to be signed in.
const PAGE_FIELDS = [
  ['youtube', 'YouTube', 'https://www.youtube.com/@ta-chaine', /^https?:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\//i],
  ['facebook', 'Facebook', 'https://www.facebook.com/ta-page', /^https?:\/\/(www\.|m\.|web\.|business\.)?(facebook|fb)\.com\//i],
  ['tiktok', 'TikTok', 'https://www.tiktok.com/@ton-compte', /^https?:\/\/(www\.)?tiktok\.com\//i],
  ['instagram', 'Instagram', 'https://www.instagram.com/ton-compte', /^https?:\/\/(www\.)?instagram\.com\//i],
  ['snapchat', 'Snapchat', 'https://www.snapchat.com/add/ton-compte', /^https?:\/\/(www\.)?snapchat\.com\//i],
  ['linkedin', 'LinkedIn', 'https://www.linkedin.com/company/ta-page', /^https?:\/\/(www\.)?linkedin\.com\//i],
  ['x', 'X', 'https://x.com/ton-compte', /^https?:\/\/(www\.)?(x|twitter)\.com\//i],
];
const pageUrlOf = (config, name) => (name === 'facebook' ? config.facebookPageUrl : (config.pageUrls || {})[name]) || '';

async function renderPages() {
  const config = await settings();
  const used = PAGE_FIELDS.filter(([name]) => networkIsOn(config, name));
  const missing = used.filter(([name]) => !pageUrlOf(config, name)).length;
  const state = $('pages-state');
  state.className = `pill ${missing ? 'warn' : 'ok'}`;
  state.textContent = missing ? `${missing} lien(s) à coller` : 'Tout est renseigné';
  $('pages').replaceChildren(...used.map(([name, label, placeholder, pattern]) => {
    const row = el('label', 'page-row');
    const input = document.createElement('input');
    input.type = 'url';
    input.placeholder = placeholder;
    input.value = pageUrlOf(config, name);
    const open = el('a', 'page-open', 'Ouvrir');
    open.target = '_blank';
    open.title = 'Ouvre la page dans ce Chrome pour vérifier que tu y es connecté';
    const syncOpen = () => { open.href = input.value.trim() || '#'; open.hidden = !input.value.trim(); };
    syncOpen();
    input.addEventListener('input', () => { input.setCustomValidity(''); syncOpen(); });
    input.addEventListener('change', async () => {
      const url = input.value.trim();
      if (url && !pattern.test(url)) {
        input.setCustomValidity(`Colle un lien ${label}, ex. ${placeholder}`);
        input.reportValidity();
        return;
      }
      const current = await settings();
      if (name === 'facebook') {
        current.facebookPageUrl = url || null;
        // One page for everything: links saved per channel by older versions go.
        for (const own of Object.values(current.channels || {})) { delete own.facebookPageUrl; delete own.facebook; delete own.facebookSince; }
      } else {
        current.pageUrls = { ...(current.pageUrls || {}), [name]: url || null };
      }
      await chrome.storage.local.set({ folder: current });
      send({ type: 'autoNow' });
      $('pages-saved').hidden = false;
      setTimeout(() => { $('pages-saved').hidden = true; }, 2500);
      renderPages();
      if (name === 'facebook') { renderPosts(); if (lastScan) renderFacebook(lastScan); }
    });
    row.append(el('span', 'page-label', label), input, open);
    return row;
  }));
  renderSetup().catch(() => {});
}

async function renderFolder() {
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
  $('videos').replaceChildren(...[...data.videos].sort((a, b) => order(a) - order(b)).map(videoItem));
  queueMicrotask(applyJob);
  $('no-videos').hidden = data.videos.length > 0;
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
  renderFacebook(data);
  renderTikTok();
  renderInstagram();
  renderPages();
}

function facebookItem(video, page) {
  const actions = [];
  let status;
  let item;
  if (video.facebook_published_at) {
    status = pill('ok', `Publiée sur Facebook le ${new Date(video.facebook_published_at).toLocaleDateString('fr-FR')}.`);
  } else {
    status = video.facebook_error ? pill('warn', `Échec sur Facebook : ${video.facebook_error}`)
      : page ? pill('neutral', 'Prête à partir sur Facebook.') : pill('warn', 'Colle le lien de ta page Facebook en haut pour la publier.');
    const publish = button(video.facebook_error ? 'Réessayer' : 'Publier sur Facebook', 'btn primary', () => act(item, publish,
      { type: 'facebook', path: video.relative_path }, 'Publication sur Facebook en cours… (un onglet Facebook s’ouvre)'));
    publish.dataset.publish = '1';
    actions.push(publish);
  }
  item = mediaRow({
    path: video.relative_path, preview: video.preview_path, youtubeId: video.youtube_id,
    title: video.title || video.relative_path.split('/').pop(),
    detail: [chan(video.channel_name), video.vertical_path ? 'version verticale (Reel)' : 'vidéo longue'].filter(Boolean).join(' · '),
    status, actions,
  });
  return item;
}

// TikTok: every video already on YouTube (its vertical version if there is
// one, otherwise the video itself, horizontal or not) and the videos of the
// posts folder.
function renderTikTok() {
  const items = [];
  for (const v of (lastScan && lastScan.sent) || []) {
    if (!v.youtube_id && !v.published_at) continue;
    items.push({ path: v.relative_path, kind: 'video', title: v.title || v.relative_path.split('/').pop(), preview: v.preview_path,
      youtubeId: v.youtube_id, vertical: !!v.vertical_path,
      detail: [chan(v.channel_name), v.vertical_path ? 'version verticale' : 'pas de version verticale : format long'].filter(Boolean).join(' · '),
      done: v.tiktok_published_at, error: v.tiktok_error, date: v.date });
  }
  for (const p of lastPosts) {
    if (!p.video_path) continue;
    items.push({ path: p.path, kind: 'post', title: p.text.split('\n')[0] || 'Reel', preview: undefined,
      detail: [chan(p.channel_name), 'vidéo du dossier de posts'].filter(Boolean).join(' · '),
      done: p.tiktok_statut === 'publie', error: p.tiktok_error, date: p.due_at });
  }
  const tiktokCard = (it) => {
    let item;
    const actions = [];
    let status;
    if (it.done) status = pill('ok', 'Publiée sur TikTok.');
    else {
      status = it.error ? pill('warn', `Échec sur TikTok : ${it.error}`) : pill('neutral', 'Prête à partir sur TikTok.');
      const go = button(it.error ? 'Réessayer' : it.kind === 'video' && !it.vertical ? 'Publier (format long)' : 'Publier', 'btn primary', () => act(item, go,
        { type: it.kind === 'video' ? 'tiktok' : 'tiktokPost', path: it.path }, 'Publication sur TikTok en cours… (TikTok Studio s’ouvre)'));
      go.dataset.publish = '1';
      actions.push(go);
      // The long version stays possible, as an option.
      if (it.kind === 'video' && it.vertical) {
        const long = button('Version longue', 'btn ghost', () => act(item, long,
          { type: 'tiktok', path: it.path, long: true }, 'Version longue vers TikTok en cours…'));
        long.dataset.publish = '1';
        actions.unshift(long);
      }
    }
    item = mediaRow({ path: it.path, preview: it.preview, youtubeId: it.youtubeId, title: it.title, detail: it.detail, status, actions });
    return item;
  };
  const recent = (a, b) => (Date.parse(b.date) || b.date || 0) - (Date.parse(a.date) || a.date || 0);
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
  for (const v of (lastScan && lastScan.sent) || []) {
    if ((!v.youtube_id && !v.published_at) || !v.vertical_path) continue;
    items.push({ path: v.relative_path, kind: 'video', title: v.title || v.relative_path.split('/').pop(), preview: v.preview_path,
      youtubeId: v.youtube_id, detail: [chan(v.channel_name), 'version verticale'].filter(Boolean).join(' · '),
      done: v.instagram_published_at, error: v.instagram_error, date: v.date });
  }
  for (const p of lastPosts) {
    if (!p.video_path) continue;
    items.push({ path: p.path, kind: 'post', title: p.text.split('\n')[0] || 'Reel', preview: undefined,
      detail: [chan(p.channel_name), 'vidéo du dossier de posts'].filter(Boolean).join(' · '),
      done: p.instagram_statut === 'publie', error: p.instagram_error, date: p.due_at });
  }
  const igCard = (it) => {
    let item;
    const actions = [];
    let status;
    if (it.done) status = pill('ok', 'Publiée sur Instagram.');
    else {
      status = it.error ? pill('warn', `Échec sur Instagram : ${it.error}`) : pill('neutral', 'Prête à partir sur Instagram.');
      const go = button(it.error ? 'Réessayer' : 'Publier sur Instagram', 'btn primary', () => act(item, go,
        { type: it.kind === 'video' ? 'instagram' : 'instagramPost', path: it.path }, 'Publication sur Instagram en cours… (Instagram s’ouvre)'));
      go.dataset.publish = '1';
      actions.push(go);
    }
    item = mediaRow({ path: it.path, preview: it.preview, youtubeId: it.youtubeId, title: it.title, detail: it.detail, status, actions });
    return item;
  };
  const recent = (a, b) => (Date.parse(b.date) || b.date || 0) - (Date.parse(a.date) || a.date || 0);
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

async function renderFacebook(data) {
  const config = await settings();
  const pageOf = (v) => ({ ...(config.channels[v.channel_key] || {}), ...(v.channel_config || {}) }).facebookPageUrl || config.facebookPageUrl;
  const recent = (a, b) => Date.parse(b.date || 0) - Date.parse(a.date || 0);
  const waiting = data.sent.filter((v) => !v.facebook_published_at).sort(recent);
  const posted = data.sent.filter((v) => v.facebook_published_at).sort(recent);
  $('facebook').replaceChildren(...waiting.map((video) => facebookItem(video, pageOf(video))));
  $('facebook-done-box').hidden = !posted.length;
  $('facebook-done-title').textContent = `Déjà sur Facebook (${posted.length})`;
  $('facebook-done').replaceChildren(...posted.map((video) => facebookItem(video, pageOf(video))));
  applyJob();
  $('no-facebook').hidden = data.sent.length > 0;
}

// What KappGen sent from the selected publication folder. No channel
// selection is required here: the folder and its manifest identify each
// publication.
async function renderOnYoutube(data, config) {
  $('sent').replaceChildren(...[...data.sent].sort((a, b) => Date.parse(b.date || 0) - Date.parse(a.date || 0)).map(sentItem));
  $('sent-title').textContent = `Déjà publiées (${data.sent.length})`;
  $('sent-box').hidden = !data.sent.length;
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

let fbRootHandle = null;
KappDossier.loadFbRoot().then((handle) => { fbRootHandle = handle; }).catch(() => {});

async function pickFbFolder() {
  try {
    fbRootHandle = await window.showDirectoryPicker({ id: 'kappgen-facebook', mode: 'readwrite' });
    await KappDossier.saveFbRoot(fbRootHandle);
    send({ type: 'autoNow' });
  } catch (error) {
    if (!error || error.name !== 'AbortError') {
      $('fb-folder-status').hidden = false;
      $('fb-folder-status').textContent = String((error && error.message) || error);
    }
  }
  renderPosts();
}
$('fb-pick').addEventListener('click', pickFbFolder);
$('fb-pick-change').addEventListener('click', pickFbFolder);
$('fb-forget').addEventListener('click', async () => {
  await KappDossier.clearFbRoot();
  fbRootHandle = null;
  renderPosts();
});
$('fb-grant').addEventListener('click', async () => {
  const handle = fbRootHandle || await KappDossier.loadFbRoot();
  if (handle) await handle.requestPermission({ mode: 'readwrite' }).catch(() => {});
  renderPosts();
  send({ type: 'autoNow' });
});

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

$('pw-trial').addEventListener('click', async () => {
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
$('pw-subscribe').addEventListener('click', () => {
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
  const user = reply && reply.ok ? reply.data : null;
  $('profile').hidden = !user;
  $('account').hidden = !!user; // the login card only when signed out
  $('login').hidden = !!user;
  if (!user) { $('main').hidden = true; $('paywall').hidden = true; }
  $('server').hidden = !!user; // the local-server setting only matters before signing in
  if (!user) {
    const error = $('login-error');
    error.hidden = !reply || reply.ok;
    if (reply && !reply.ok) error.textContent = reply.error;
    return false;
  }
  $('account-email').textContent = user.email;
  $('account-name').textContent = user.name || user.email.split('@')[0];
  // Profile photo (Google account), otherwise the first letter.
  const avatar = $('avatar');
  avatar.replaceChildren();
  if (user.picture_url) {
    const img = document.createElement('img');
    img.src = user.picture_url;
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => { avatar.textContent = (user.name || user.email || '?').trim()[0].toUpperCase(); });
    avatar.append(img);
  } else {
    avatar.textContent = (user.name || user.email || '?').trim()[0].toUpperCase();
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

let recheckingLogin = false;
$('login-recheck').addEventListener('click', async () => {
  if (recheckingLogin) return;
  recheckingLogin = true;
  $('login-recheck').textContent = 'Vérification…';
  try {
    if (await renderAccount()) start();
  } finally {
    recheckingLogin = false;
    $('login-recheck').textContent = "J'ai fini, vérifier";
  }
});

// The side panel stays visible while the creator signs in on app.kappgen.com
// in a tab next to it, so no visibility event comes: look every few seconds
// while the login card is shown.
let loginPoll = null;
function watchLogin() {
  if (loginPoll) return;
  $('login-waiting').hidden = false;
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
$('login-google').addEventListener('click', watchLogin);

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
  const videos = queue && queue.ok ? queue.data.videos : [];
  $('app-block').hidden = !videos.length;
  $('app-videos').replaceChildren(...videos.map((video) => {
    const item = el('li');
    const info = el('div', 'info');
    info.append(el('div', 'title', video.title), el('div', 'meta', [video.channel_name, size(video.size_bytes)].filter(Boolean).join(' · ')));
    if (video.last_error) info.append(el('div', 'warn', video.last_error));
    const go = button('Envoyer (non répertoriée)', 'btn primary', async () => {
      go.disabled = true;
      // Videos of the KappGen app are handed to Studio by path, which needs
      // the optional "debugger" permission: asked once, on this click.
      if (!await chrome.permissions.request({ permissions: ['debugger'] }).catch(() => false)) {
        go.disabled = false;
        return;
      }
      const reply = await send({ type: 'publish', source: 'app', videoId: video.id, visibility: 'UNLISTED' });
      if (!reply || !reply.ok) go.disabled = false;
    });
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
  for (const node of document.querySelectorAll('[data-publish]')) node.disabled = !!(job && job.running);
  if (!job || !job.path) return;
  for (const item of document.querySelectorAll('li.item, li.row')) {
    if (item.dataset.path !== job.path || !item.say) continue;
    if (job.running) item.say('busy', job.message || 'En cours…');
    else if (job.error) item.say('warn', job.error);
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
    box.className = `job ${job.running ? 'running' : job.error ? 'error' : 'done'}`;
    $('job-title').textContent = job.running ? `En cours : ${job.title || 'publication'}` : job.error ? 'Échec' : 'Terminé';
    $('job-message').textContent = [job.channel, job.message].filter(Boolean).join(' — ')
      + (job.running ? ' Les autres boutons « Publier » attendent la fin.' : '');
    $('job-link').hidden = !job.youtubeUrl;
    if (job.youtubeUrl) $('job-link').href = job.youtubeUrl;
    $('job-clear').hidden = jobRunning;
    // Stuck for more than 5 minutes without news: offer to unblock.
    const quiet = Date.now() - (job.updatedAt || job.startedAt || Date.now());
    $('job-unblock').hidden = !(job.running && quiet > 5 * 60 * 1000);
  }
  applyJob();
  clearTimeout(jobHideTimer);
  if (job && job.done && !job.error && !job.running) {
    jobHideTimer = setTimeout(async () => { await send({ type: 'clearJob' }); renderJob(null); }, 6000);
  }
  if (wasRunning && !jobRunning) { renderFolder(); renderApp(); renderPosts(); }
}

$('job-unblock').addEventListener('click', async () => {
  if (!confirm('Arrêter le suivi de cet envoi ? Vérifie ensuite sur YouTube / Facebook s’il est parti avant de relancer.')) return;
  await send({ type: 'unblockJob' });
});
setInterval(() => { if (currentJob && currentJob.running) renderJob(currentJob); }, 30000);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.job) renderJob(changes.job.newValue);
});

$('job-clear').addEventListener('click', async () => {
  await send({ type: 'clearJob' });
  renderJob(null);
});

$('save-url').addEventListener('click', async () => {
  await chrome.storage.local.set({ appUrl: $('app-url').value.trim() || null });
  start();
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
    pill.title = `Tu as la version ${current}, la ${latest} est sortie : clique pour voir comment mettre à jour (2 minutes, tes réglages sont gardés).`;
  }
}
chrome.storage.local.get('releaseCheck').then(({ releaseCheck }) => renderVersion(releaseCheck));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.releaseCheck) renderVersion(changes.releaseCheck.newValue);
});
send({ type: 'checkRelease' }).catch(() => {});

async function start() {
  const { appUrl } = await chrome.storage.local.get('appUrl');
  $('app-url').value = appUrl || '';
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
