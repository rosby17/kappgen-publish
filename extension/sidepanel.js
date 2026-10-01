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

async function renderAccess() {
  const access = await KappDossier.access();
  const status = $('folder-status');
  $('grant').hidden = access.state !== 'prompt';
  $('pick').textContent = access.state === 'none' ? 'Choisir le dossier' : 'Changer de dossier';
  if (access.state === 'none') {
    status.className = 'status';
    status.textContent = 'Choisis le dossier qui contient tes vidéos.';
  } else if (access.state === 'granted') {
    status.className = 'status ok';
    status.textContent = `Dossier : ${access.name}`;
  } else {
    status.className = 'status error';
    status.textContent = `« ${access.name} » : Chrome redemande l’accès. Clique « Autoriser l’accès » puis choisis « Autoriser à chaque visite ».`;
  }
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
  const item = el('li', 'video');
  const info = el('div', 'info');
  const title = el('div', 'title', video.title);
  title.title = video.relative_path;
  info.append(title, el('div', 'file', `Fichier : ${video.relative_path.split('/').pop()}`), el('div', 'meta', [size(video.size_bytes), 'YouTube',
    video.thumbnail_path ? 'miniature' : 'sans miniature', video.vertical_path ? 'vertical prêt' : null,
    video.tags.length ? `${video.tags.length} mots-clés` : null].filter(Boolean).join(' · ')));
  const problem = video.last_error || video.thumbnail_warning;
  info.append(el('div', video.auto_ok ? 'ok' : problem ? 'warn' : 'meta',
    video.last_error || (video.auto_ok ? `Partira toute seule, ${VISIBILITY_LABELS[visibilityOf(video.channel_key)]}.` : video.auto_blocked)));
  if (video.thumbnail_warning && !video.last_error) info.append(el('div', 'warn', video.thumbnail_warning));
  const buttons = el('div', 'buttons');
  const go = button('Publier sur YouTube', 'publish', async () => {
    go.disabled = true;
    const reply = await send({ type: 'publish', source: 'folder', videoId: video.id, visibility: 'CHANNEL' });
    if (!reply || !reply.ok) {
      go.disabled = false;
      info.append(el('div', 'warn', reply ? reply.error : 'Envoi impossible.'));
    }
  });
  go.disabled = jobRunning || video.running;
  go.title = 'Envoie maintenant cette vidéo sur YouTube. La miniature et la fiche viennent du même dossier.';
  if (video.vertical_path) go.title += ' Le format vertical associé est détecté dans l’onglet Facebook.';
  const already = button('Déjà publiée', 'secondary', async () => {
    await KappDossier.mark(video.relative_path, 'ignored');
    renderFolder();
  });
  already.title = 'Elle est déjà sur YouTube : la retirer de la liste sans l’envoyer.';
  buttons.append(go, already);
  item.append(thumb(video.preview_path), info, buttons);
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
  facebookPage.placeholder = 'URL de la page Facebook (facultatif)';
  facebookPage.value = own.facebookPageUrl || '';
  facebookPage.title = 'Ouvre directement cette page Facebook pour que son sélecteur de Reel soit présélectionné.';
  facebookPage.hidden = !social.checked;
  facebookPage.addEventListener('change', () => saveChannel(channel.key, { facebookPageUrl: facebookPage.value.trim() || null }));
  social.addEventListener('change', () => { facebookPage.hidden = !social.checked; });
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
  const item = el('li', 'video');
  const info = el('div', 'info');
  info.append(el('div', 'title', video.title || video.relative_path.split('/').pop()),
    el('div', 'file', `Fichier : ${video.relative_path.split('/').pop()}`),
    el('div', 'meta', ['YouTube', size(video.size_bytes), video.date ? new Date(video.date).toLocaleString('fr-FR') : null].filter(Boolean).join(' · ')));
  let state;
  if (!video.has_content) state = ['meta', 'Aucune fiche ni miniature dans le dossier.'];
  else if (video.applied_hash === video.hash) state = ['ok', 'À jour sur YouTube.'];
  else if (video.update_error && video.update_tried_hash === video.hash) state = ['warn', `Mise à jour échouée : ${video.update_error}`];
  else state = ['meta', 'Mise à jour automatique en attente (au prochain passage, 5 min).'];
  info.append(el('div', state[0], state[1]));
  const buttons = el('div', 'buttons');
  if (video.youtube_id) {
    const link = el('a', 'secondary', 'Ouvrir dans Studio');
    link.href = `https://studio.youtube.com/video/${video.youtube_id}/edit`;
    link.target = '_blank';
    const update = button('Mettre à jour maintenant', 'publish secondary', async () => {
      update.disabled = true;
      const reply = await send({ type: 'update', path: video.relative_path });
      if (!reply || !reply.ok) {
        update.disabled = false;
        info.append(el('div', 'warn', reply ? reply.error : 'Mise à jour impossible.'));
      }
    });
    update.title = 'Remet sur YouTube le titre, la description, les mots-clés et la miniature de la fiche du dossier';
    update.disabled = jobRunning;
    buttons.append(update, link);
  }
  item.append(thumb(video.preview_path), info, buttons);
  return item;
}

// ------------------------------------------------------ Facebook posts

const POST_STATES = { a_publier: 'prévu', en_cours: 'en cours', publie: 'publié', echec: 'échec' };
const POST_TYPES = { photo: 'Photo', texte: 'Texte', reel: 'Reel' };

// Today's posts of FACEBOOK/A-PUBLIER (and failures of any day), by time.
async function renderPosts() {
  const reply = await send({ type: 'facebookPosts' });
  const posts = reply && reply.ok ? reply.data : [];
  const today = new Date().toDateString();
  const shown = posts.filter((p) => (p.due_at && new Date(p.due_at).toDateString() === today) || p.statut === 'echec' || (p.ready));
  $('fb-block').hidden = !posts.length;
  const count = (state) => shown.filter((p) => p.statut === state).length;
  const missingPage = posts.some((p) => !p.page);
  $('fb-summary').textContent = `Aujourd’hui : ${count('publie')} publié(s), ${count('a_publier')} prévu(s)${count('echec') ? `, ${count('echec')} en échec` : ''}. Un post part à son heure, toutes les 5 min au plus.`
    + (missingPage ? ' Lien de la page Facebook à renseigner (planning.json) pour certains posts.' : '');
  $('fb-posts').replaceChildren(...shown.map((post) => {
    const item = el('li', 'video');
    const info = el('div', 'info');
    const when = post.due_at ? new Date(post.due_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '—';
    info.append(el('div', 'title', `${when} · ${post.text.split('\n')[0] || '(sans texte)'}`),
      el('div', 'meta', [POST_TYPES[post.type], post.channel_name, POST_STATES[post.statut] || post.statut].join(' · ')));
    if (post.error && post.statut === 'echec') info.append(el('div', 'warn', post.error));
    item.append(post.image_path ? thumb(post.image_path) : el('div', 'thumb empty', POST_TYPES[post.type]), info);
    if (post.statut === 'a_publier' || post.statut === 'echec') {
      const go = button('Publier maintenant', 'publish secondary', async () => {
        go.disabled = true;
        const r = await send({ type: 'postNow', path: post.path });
        if (!r || !r.ok) { go.disabled = false; info.append(el('div', 'warn', r ? r.error : 'Publication impossible.')); }
      });
      go.disabled = jobRunning;
      const buttons = el('div', 'buttons');
      buttons.append(go);
      item.append(buttons);
    }
    return item;
  }));
}

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
    $('folder-status').className = 'status error';
    $('folder-status').textContent = String(error.message || error);
    return;
  }
  for (const [key, own] of Object.entries(config.channels)) autoVisibility.set(key, own.visibility);
  $('videos').replaceChildren(...data.videos.map(videoItem));
  $('no-videos').hidden = data.videos.length > 0;
  const total = data.sent.reduce((sum, v) => sum + v.size_bytes, 0);
  $('sent-summary').textContent = data.sent.length
    ? `${data.sent.length} vidéo(s) envoyée(s) par KappGen : si tu modifies leur fiche ou leur miniature dans le dossier, elles sont mises à jour sur YouTube toutes seules. Elles prennent encore ${size(total)} sur ton disque.`
    : '';
  renderOnYoutube(data, config);
  renderFacebook(data);
}

function facebookItem(video, sent = false) {
  const item = el('li', 'video');
  const info = el('div', 'info');
  info.append(el('div', 'title', video.title || video.relative_path),
    el('div', 'meta', [video.vertical_path ? 'Format vertical' : 'Vidéo longue', video.vertical_path || video.relative_path].join(' · ')));
  info.append(el('div', sent && video.facebook_published_at ? 'ok' : 'meta',
    sent && video.facebook_published_at ? 'Publié sur Facebook.' : sent ? 'Sur YouTube, pas encore sur Facebook.' : 'Partira sur Facebook juste après YouTube.'));
  const buttons = el('div', 'buttons');
  if (sent && !video.facebook_published_at) {
    const publish = button('Publier sur Facebook', 'publish secondary', async () => {
      publish.disabled = true;
      const reply = await send({ type: 'facebook', path: video.relative_path });
      if (!reply || !reply.ok) publish.disabled = false;
    });
    publish.disabled = jobRunning;
    buttons.append(publish);
  }
  item.append(info, buttons);
  return item;
}

function renderFacebook(data) {
  const wantsFacebook = (video) => video.vertical_path || (video.channel_config && video.channel_config.facebook);
  const sent = data.sent.filter(wantsFacebook);
  const waiting = data.videos.filter(wantsFacebook);
  const list = $('facebook');
  list.replaceChildren(...sent.map((video) => facebookItem(video, true)), ...waiting.map((video) => facebookItem(video)));
  $('no-facebook').hidden = sent.length + waiting.length > 0;
}

// What KappGen sent from the selected publication folder. No channel
// selection is required here: the folder and its manifest identify each
// publication.
async function renderOnYoutube(data, config) {
  $('sent').replaceChildren(...data.sent.map(sentItem));
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

$('pick').addEventListener('click', async () => {
  try {
    rootHandle = await window.showDirectoryPicker({ id: 'kappgen-videos', mode: 'readwrite' });
    await KappDossier.saveRoot(rootHandle);
    send({ type: 'autoNow' }); // a chosen folder is published right away
  } catch (error) {
    if (!error || error.name !== 'AbortError') $('folder-status').textContent = String((error && error.message) || error);
  }
  renderFolder();
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
    const go = button('Envoyer (non répertoriée)', 'publish', async () => {
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

function renderJob(job) {
  const box = $('job');
  const wasRunning = jobRunning;
  jobRunning = !!(job && job.running);
  box.hidden = !job;
  if (job) {
    box.className = job.error ? 'job error' : 'job';
    $('job-title').textContent = [job.auto ? 'Envoi automatique' : null, job.title || 'Envoi YouTube'].filter(Boolean).join(' : ');
    $('job-message').textContent = [job.channel, job.message].filter(Boolean).join(' — ');
    $('job-link').hidden = !job.youtubeUrl;
    if (job.youtubeUrl) $('job-link').href = job.youtubeUrl;
    $('job-clear').hidden = jobRunning;
  }
  for (const node of document.querySelectorAll('button.publish')) node.disabled = jobRunning;
  if (wasRunning && !jobRunning) { renderFolder(); renderApp(); renderPosts(); }
}

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
