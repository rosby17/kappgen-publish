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

for (const tab of document.querySelectorAll('.tabs button')) {
  tab.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.tabs button')) other.classList.toggle('active', other === tab);
    for (const pane of document.querySelectorAll('.tab')) pane.hidden = pane.id !== `tab-${tab.dataset.tab}`;
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
const visibilityOf = (key) => VISIBILITY_LABELS[autoVisibility.get(key)] ? autoVisibility.get(key) : 'UNLISTED';

function videoItem(video) {
  const status = video.last_error ? pill('warn', video.last_error)
    : video.auto_ok ? pill('ok', `Partira toute seule (${VISIBILITY_LABELS[visibilityOf(video.channel_key)]}).`)
      : pill('neutral', video.auto_blocked || 'Envoi manuel.');
  const go = button('Publier sur YouTube', 'btn primary', () => act(item, go,
    { type: 'publish', source: 'folder', videoId: video.id, visibility: 'CHANNEL' }, 'Envoi vers YouTube en cours…'));
  go.dataset.publish = '1';
  const already = button('Déjà publiée', 'btn ghost', async () => {
    await KappDossier.mark(video.relative_path, 'ignored');
    renderFolder();
  });
  already.title = 'Elle est déjà sur YouTube : la retirer de la liste sans l’envoyer.';
  const item = card({
    path: video.relative_path, preview: video.preview_path, title: video.title,
    details: [video.channel_name, [size(video.size_bytes), video.thumbnail_path ? 'miniature' : 'sans miniature',
      video.tags.length ? `${video.tags.length} mots-clés` : null].filter(Boolean).join(' · ')],
    status, actions: [already, go],
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
  socialLabel.className = 'social-row';
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
  if (!video.youtube_id) {
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
    const link = el('a', 'btn ghost', 'Ouvrir dans Studio');
    link.href = `https://studio.youtube.com/video/${video.youtube_id}/edit`;
    link.target = '_blank';
    const update = button('Mettre à jour maintenant', 'btn primary', () => act(item, update,
      { type: 'update', path: video.relative_path }, 'Mise à jour sur YouTube en cours…'));
    update.dataset.publish = '1';
    actions.push(link, update);
  }
  item = card({
    path: video.relative_path, preview: video.preview_path, title: video.title || video.relative_path.split('/').pop(),
    details: [video.channel_name, [size(video.size_bytes), video.date ? new Date(video.date).toLocaleDateString('fr-FR') : null].filter(Boolean).join(' · ')],
    status, actions, extra,
  });
  return item;
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

// Today's posts (and failures of any day, and posts without a date), by time.
async function renderPosts() {
  const access = await renderFbAccess();
  const reply = await send({ type: 'facebookPosts' });
  const posts = reply && reply.ok ? reply.data : [];
  lastPosts = posts;
  const today = new Date().toDateString();
  const shown = posts.filter((p) => !p.due_at || new Date(p.due_at).toDateString() === today || p.statut === 'echec' || p.ready);
  const count = (state) => shown.filter((p) => p.statut === state).length;
  const config = await settings();
  const pageOf = (p) => p.page || ((config.channels[p.channel_key] || {}).facebookPageUrl) || config.facebookPageUrl;
  const missingPage = posts.some((p) => p.statut === 'a_publier' && !pageOf(p));
  const summary = $('fb-summary');
  if (reply && !reply.ok) {
    summary.className = 'warn';
    summary.textContent = reply.error;
  } else if (!posts.length) {
    summary.className = 'muted small';
    summary.textContent = access.state === 'granted' ? 'Aucun post ni Reel dans ce dossier.' : '';
  } else {
    summary.className = 'muted small';
    summary.textContent = `Aujourd’hui : ${count('publie')} publié(s), ${count('a_publier')} à publier${count('echec') ? `, ${count('echec')} en échec` : ''}. Les posts programmés partent à leur heure (un toutes les 5 min au plus).`
      + (missingPage ? ' Il manque le lien de la page Facebook (en haut).' : '');
  }
  $('fb-posts').replaceChildren(...shown.map((post) => {
    const when = post.due_at ? new Date(post.due_at).toLocaleString('fr-FR', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : 'Sans heure prévue';
    const states = { a_publier: pill('neutral', post.due_at ? `Prévu ${when}` : 'Prêt à publier'), en_cours: pill('busy', 'Publication en cours…'),
      publie: pill('ok', 'Publié sur Facebook.'), echec: pill('warn', post.error || 'Échec de la publication.') };
    const actions = [];
    let item;
    if (post.statut === 'a_publier' || post.statut === 'echec') {
      const go = button(post.statut === 'echec' ? 'Réessayer' : 'Publier maintenant', 'btn primary', () => act(item, go,
        { type: 'postNow', path: post.path }, 'Publication sur Facebook en cours…'));
      go.dataset.publish = '1';
      actions.push(go);
    }
    item = card({
      path: post.path, preview: post.image_path || undefined, emptyLabel: POST_TYPES[post.type],
      title: post.text.split('\n')[0] || '(sans texte)', details: [[POST_TYPES[post.type], post.channel_name].join(' · ')],
      status: states[post.statut] || pill('neutral', post.statut), actions,
    });
    return item;
  }));
  applyJob();
  renderPages();
}

// Step 1 of the Facebook tab: the link of the Facebook Page, one for all.
async function renderPages() {
  const config = await settings();
  const current = config.facebookPageUrl || '';
  $('fb-page').value = current;
  const state = $('fb-page-state');
  state.className = `pill ${current ? 'ok' : 'warn'}`;
  state.textContent = current ? 'Page enregistrée' : 'Lien à coller';
}

$('fb-page-save').addEventListener('click', async () => {
  const input = $('fb-page');
  const url = input.value.trim();
  if (url && !/^https?:\/\/(www\.|m\.|web\.|business\.)?(facebook|fb)\.com\//i.test(url)) {
    input.setCustomValidity('Colle un lien du type https://www.facebook.com/ta-page');
    input.reportValidity();
    return;
  }
  const current = await settings();
  current.facebookPageUrl = url || null;
  // One page for everything: links saved per channel by older versions go.
  for (const own of Object.values(current.channels)) { delete own.facebookPageUrl; delete own.facebook; delete own.facebookSince; }
  await chrome.storage.local.set({ folder: current });
  send({ type: 'autoNow' });
  renderPages();
  renderPosts();
  if (lastScan) renderFacebook(lastScan);
});
$('fb-page').addEventListener('input', () => $('fb-page').setCustomValidity(''));
$('fb-page').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('fb-page-save').click(); });

async function renderFolder() {
  const lists = ['videos', 'sent', 'facebook'].map($);
  if (!(await renderAccess())) {
    lists.forEach((list) => { list.textContent = ''; });
    $('no-videos').hidden = true;
    return;
  }
  const config = await settings();
  let data;
  try {
    data = await KappDossier.scan({ channels: config.channels, autoSince: config.autoSince });
  } catch (error) {
    $('folder-status').hidden = false;
    $('folder-status').className = 'status error';
    $('folder-status').textContent = String(error.message || error);
    return;
  }
  lastScan = data;
  for (const [key, own] of Object.entries(config.channels)) autoVisibility.set(key, own.visibility);
  $('videos').replaceChildren(...data.videos.map(videoItem));
  queueMicrotask(applyJob);
  $('no-videos').hidden = data.videos.length > 0;
  const total = data.sent.reduce((sum, v) => sum + v.size_bytes, 0);
  $('sent-summary').textContent = '';
  renderOnYoutube(data, config);
  renderFacebook(data);
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
  item = card({
    path: video.relative_path, preview: video.preview_path, title: video.title || video.relative_path.split('/').pop(),
    details: [[video.channel_name, video.vertical_path ? 'version verticale (Reel)' : 'vidéo longue'].filter(Boolean).join(' · ')],
    status, actions,
  });
  return item;
}

async function renderFacebook(data) {
  const config = await settings();
  const pageOf = (v) => ({ ...(config.channels[v.channel_key] || {}), ...(v.channel_config || {}) }).facebookPageUrl || config.facebookPageUrl;
  const sent = [...data.sent].sort((a, b) => Number(!!a.facebook_published_at) - Number(!!b.facebook_published_at));
  $('facebook').replaceChildren(...sent.map((video) => facebookItem(video, pageOf(video))));
  applyJob();
  $('no-facebook').hidden = sent.length > 0;
}

// What KappGen sent from the selected publication folder. No channel
// selection is required here: the folder and its manifest identify each
// publication.
async function renderOnYoutube(data, config) {
  $('sent').replaceChildren(...data.sent.map(sentItem));
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

// --------------------------------------------------------------- account

// Everything else waits for the KappGen account to be connected.
async function renderAccount() {
  const reply = await send({ type: 'account' });
  const user = reply && reply.ok ? reply.data : null;
  $('account-on').hidden = !user;
  $('login').hidden = !!user;
  $('main').hidden = !user;
  $('server').hidden = !!user; // the local-server setting only matters before signing in
  if (!user) {
    const error = $('login-error');
    error.hidden = !reply || reply.ok;
    if (reply && !reply.ok) error.textContent = reply.error;
    return false;
  }
  $('account-email').textContent = user.email;
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

// Catches the common case on its own: the panel was already open on the
// login screen, the user signs in on app.kappgen.com in another tab, then
// just comes back here without remembering to click "vérifier".
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !$('login').hidden) renderAccount().then((ok) => { if (ok) start(); });
});

$('logout').addEventListener('click', async () => {
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

// The running job, on its own card (and the other publish buttons wait).
function applyJob() {
  const job = currentJob;
  for (const node of document.querySelectorAll('[data-publish]')) node.disabled = !!(job && job.running);
  if (!job || !job.path) return;
  for (const item of document.querySelectorAll('li.item')) {
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

async function start() {
  const { appUrl } = await chrome.storage.local.get('appUrl');
  $('app-url').value = appUrl || '';
  if (!(await renderAccount())) return;
  const { job } = await chrome.storage.session.get('job');
  renderJob(job);
  renderFolder();
  renderApp();
  renderPosts();
}
start();

// The background worker applies updates by itself: keep the lists current.
setInterval(() => { if (!document.hidden && !jobRunning) renderFolder(); }, 60000);
