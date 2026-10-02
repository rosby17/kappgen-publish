// KappGen extension — service worker.
//
// Two sources of videos:
//   - "app": videos finished in KappGen (local API, session cookie);
//   - "folder": any folder of the computer chosen in the options page,
//     whatever tool made the videos (read by offscreen.html, see lib/dossier.js).
//     Channels switched to automatic are checked every 5 minutes and each new
//     ready video is sent as UNLISTED (the creator makes it public himself),
//     or straight to PUBLIC on channels set to « Publique » in the side panel.
//
// Publishing one video:
//   1. read it from its source;
//   2. open YouTube Studio's upload dialog in a tab;
//   3. give the MP4 to Studio's file picker without loading it in memory:
//      by path through the DevTools protocol (app), or as a disk-backed File
//      handed over by bridge.html (folder);
//   4. fill title, description, audience and visibility (studio.js);
//   5. wait for the transfer to end, save, and report the YouTube id back.
// Progress lives in chrome.storage.session so the popup can be closed and
// reopened at any time.

// The user's KappGen account (session cookie of kappgen.com). The local
// Docker version is chosen in the panel's Help tab (http://localhost:8080).
const DEFAULT_APP_URL = 'https://api.kappgen.com';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function appUrl() {
  const { appUrl: saved } = await chrome.storage.local.get('appUrl');
  return (saved || DEFAULT_APP_URL).replace(/\/+$/, '');
}

async function api(path, options = {}) {
  const base = await appUrl();
  let response;
  try {
    response = await fetch(`${base}/api${path}`, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
  } catch {
    throw new Error('KappGen est injoignable. Vérifie ta connexion Internet.');
  }
  if (response.status === 401 && path !== '/auth/login') throw Object.assign(new Error('Connecte-toi à ton compte KappGen.'), { status: 401 });
  if (response.status === 404) throw Object.assign(new Error('Fonction indisponible sur ce serveur KappGen.'), { status: 404 });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : `Erreur KappGen (${response.status}).`);
  return data;
}

async function setJob(patch) {
  const { job } = await chrome.storage.session.get('job');
  const next = { ...(job || {}), ...patch, updatedAt: Date.now() };
  await chrome.storage.session.set({ job: next });
  // Every publication that ends (sent or failed) goes into the day's log,
  // told in one e-mail in the evening (no message for each one).
  if (job && job.running && patch.running === false && REPORTED_KINDS.has(job.kind)) await logDay(next).catch(() => {});
}

// ------------------------------------------------------- evening summary

// The day's publications, on this computer's clock; sent once in the evening
// (21:00) to creators who ticked « Bilan du soir par mail » (off by default).
const REPORTED_KINDS = new Set(['youtube', 'short', 'post', 'facebook', 'tiktok', 'instagram', 'x']);
const REPORT_HOUR = 21;
const pad2 = (n) => String(n).padStart(2, '0');
const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const hourMinute = (t) => { const d = new Date(t); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };

async function logDay(job) {
  const now = Date.now();
  const { dayLog } = await chrome.storage.local.get('dayLog');
  const oldest = dayKey(now - 8 * 86400000);
  const entry = { day: dayKey(now), time: hourMinute(now), kind: job.kind, title: String(job.title || '').slice(0, 300),
    ok: !job.error, error: job.error ? String(job.error).slice(0, 300) : null, url: job.youtubeUrl || null };
  await chrome.storage.local.set({ dayLog: [...(dayLog || []).filter((e) => e.day >= oldest), entry].slice(-500) });
}

function timeZoneName() {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  const offset = -new Date().getTimezoneOffset();
  const h = Math.floor(Math.abs(offset) / 60);
  const m = Math.abs(offset) % 60;
  return `${zone}${zone ? ', ' : ''}UTC${offset >= 0 ? '+' : '-'}${h}${m ? `:${pad2(m)}` : ''}`;
}

// Today's summary from 21:00, or yesterday's if Chrome was closed at 21:00.
async function dailyReport() {
  const { dailyReport: on, dayLog, reportedDays } = await chrome.storage.local.get(['dailyReport', 'dayLog', 'reportedDays']);
  if (!on) return;
  const now = Date.now();
  const today = dayKey(now);
  const yesterday = dayKey(now - 86400000);
  const done = new Set(reportedDays || []);
  const days = [yesterday, ...(new Date(now).getHours() >= REPORT_HOUR ? [today] : [])].filter((d) => !done.has(d));
  for (const day of days) {
    const items = (dayLog || []).filter((e) => e.day === day).map(({ day: _day, ...item }) => item);
    if (items.length) {
      await api('/publish/daily-report', { method: 'POST', body: JSON.stringify({ day, timezone: timeZoneName(), items }) });
    }
    done.add(day);
    await chrome.storage.local.set({ reportedDays: [...done].filter((d) => d >= yesterday) });
  }
}

// What the automatic publishing is doing, shown in the panel.
async function autoState(state, extra = {}) {
  await chrome.storage.local.set({ autoStatus: { state, at: Date.now(), ...extra } });
}

// ------------------------------------------------------- subscription

// KappGen Publish is paid: nothing goes out without an active subscription
// (or the free trial). Checked on the server, kept 10 minutes; without
// network the last answer stays valid for 24 h.
const ACCESS_TTL = 10 * 60 * 1000;
async function publishAccess({ fresh = false } = {}) {
  const { publishAccess: cached } = await chrome.storage.local.get('publishAccess');
  if (!fresh && cached && Date.now() - cached.checkedAt < ACCESS_TTL) return cached;
  try {
    const data = await api('/publish/access');
    const state = { ...data, checkedAt: Date.now() };
    await chrome.storage.local.set({ publishAccess: state });
    return state;
  } catch (error) {
    if (error.status === 401) {
      await chrome.storage.local.remove('publishAccess');
      return { active: false, signedOut: true, checkedAt: Date.now() };
    }
    if (error.status === 404) return { active: false, unavailable: true, checkedAt: Date.now() };
    // Network trouble: the last answer, if recent and still running.
    if (cached && Date.now() - cached.checkedAt < 24 * 3600 * 1000
      && (!cached.expires_at || Date.parse(cached.expires_at) > Date.now())) return cached;
    return { active: false, offline: true, checkedAt: Date.now() };
  }
}

async function requireAccess() {
  const state = await publishAccess();
  if (state.active) return state;
  if (state.signedOut) throw new Error('Connecte-toi à ton compte KappGen.');
  if (state.unavailable) throw new Error('Le serveur KappGen n’est pas encore à jour pour KappGen Publish.');
  if (state.offline) throw new Error('Impossible de vérifier ton abonnement (connexion Internet ?).');
  throw new Error('Ton abonnement KappGen Publish n’est pas actif : ouvre le panneau pour t’abonner.');
}

// ------------------------------------------------------- publishing recipe

// Selectors and button names of YouTube Studio, Facebook, TikTok and
// Instagram are not shipped with the extension: the server sends them, as
// data, to accounts with an active trial or subscription (lib/recette.js
// reads them inside the page). Kept in memory only, refreshed every 30 min.
const RECIPE_TTL = 30 * 60 * 1000;
let recipeCache = null;
async function publishRecipe({ fresh = false } = {}) {
  if (!fresh && recipeCache && Date.now() - recipeCache.at < RECIPE_TTL) return recipeCache.data;
  await requireAccess();
  let data;
  try {
    data = await api('/publish/recipe');
  } catch (error) {
    if (error.status === 401) throw new Error('Connecte-toi à ton compte KappGen.');
    if (error.status === 402) throw new Error('Ton abonnement KappGen Publish n’est pas actif : ouvre le panneau pour t’abonner.');
    if (error.status === 404) throw new Error('Le serveur KappGen n’est pas encore à jour pour cette version de KappGen Publish.');
    // Network trouble: the last recipe of this session, if any.
    if (recipeCache) return recipeCache.data;
    throw new Error('Impossible de joindre KappGen pour préparer la publication (connexion Internet ?).');
  }
  recipeCache = { data, at: Date.now() };
  return data;
}

// Puts the recipe in the page, then the network's scripts.
async function injectScripts(tabId, files) {
  const recipe = await publishRecipe();
  await chrome.scripting.executeScript({ target: { tabId }, func: (data) => { window.__kappgenRecipe = data; }, args: [recipe] });
  await chrome.scripting.executeScript({ target: { tabId }, files: ['lib/recette.js', ...files] });
}

async function recipeSelector(network, key) {
  const recipe = await publishRecipe();
  const selector = recipe && recipe[network] && recipe[network].sel && recipe[network].sel[key];
  if (!selector) throw new Error(`KappGen Publish : recette de publication incomplète (${network}.${key}).`);
  return selector;
}

// ------------------------------------------------------------ folder source

const AUTO_EVERY_MINUTES = 5;

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Lire le dossier de vidéos choisi par l’utilisateur.',
    });
  } catch (error) {
    if (!/single offscreen/i.test(String(error && error.message))) throw error;
  }
}

// Chrome sometimes asks again for access to the videos folder. Granting it
// needs a click, so a small popup window with one button is opened (once at a
// time, at most every 30 min when nobody asked for it). Choosing « Autoriser
// à chaque visite » in Chrome's prompt makes the access permanent.
const ASK_URL = chrome.runtime.getURL('autorisation.html');
async function askAccess({ wait = false, force = false } = {}) {
  const access = await folder('access').catch(() => ({ state: 'none' }));
  // The other folders (main, each network's own) are asked in the same small window.
  const all = await folder('folders').catch(() => ({}));
  const otherAsks = Object.values(all).some((f) => f && f.state === 'prompt');
  if (access.state !== 'prompt' && (!otherAsks || wait)) return access.state === 'granted';
  const [open] = await chrome.tabs.query({ url: ASK_URL });
  if (open) {
    await chrome.windows.update(open.windowId, { focused: true, drawAttention: true }).catch(() => {});
  } else {
    const { askedAt } = await chrome.storage.session.get('askedAt');
    if (force || wait || !askedAt || Date.now() - askedAt > 30 * 60 * 1000) {
      await chrome.storage.session.set({ askedAt: Date.now() });
      const current = await chrome.windows.getLastFocused().catch(() => null);
      const width = 520, height = 330;
      const left = current ? Math.max(0, current.left + Math.round((current.width - width) / 2)) : undefined;
      const top = current ? Math.max(0, current.top + 120) : undefined;
      // A normal window: Chrome shows its folder-access prompt under the
      // address bar, which a 'popup' window doesn't have (the click did nothing).
      await chrome.windows.create({ url: ASK_URL, type: 'normal', width, height: height + 160, left, top, focused: true });
    }
  }
  if (!wait) return false;
  const deadline = Date.now() + 3 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(2000);
    if ((await folder('access').catch(() => ({}))).state === 'granted') return true;
  }
  return false;
}

// Older versions kept a pinned tab open: close it.
async function closeOldKeeper() {
  const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL('keepalive.html') }).catch(() => []);
  for (const tab of tabs) chrome.tabs.remove(tab.id).catch(() => {});
}

async function folderSettings() {
  const { folder } = await chrome.storage.local.get('folder');
  const current = { channels: {}, ...(folder || {}) };
  // Before 1.7.4 every channel folder chosen on its own was saved as "." and
  // could inherit another channel's YouTube id: forget that shared entry.
  if (current.channels['.']) {
    delete current.channels['.'];
    await chrome.storage.local.set({ folder: current });
  }
  // Watching starts when the folder is chosen: only videos finished after
  // that go out on their own (older ones wait for a click). Installs from
  // before 1.11 start watching now.
  if (!current.watchSince) {
    current.watchSince = Date.now();
    await chrome.storage.local.set({ folder: current });
  }
  return current;
}

async function folder(type, payload = {}) {
  await ensureOffscreen();
  const reply = await chrome.runtime.sendMessage({ target: 'offscreen', type, ...payload });
  if (!reply || !reply.ok) throw new Error((reply && reply.error) || 'Dossier de vidéos illisible.');
  return reply.data;
}

// Facebook posts: each one at the time written in it (or right away).
// net: a network's own posts (its folder, or its <NETWORK>/A-PUBLIER folders).
async function postsList(net = 'facebook') {
  return folder('posts', { net });
}
const POST_NETS = ['instagram', 'tiktok', 'x', 'linkedin'];
// A post by its path, whichever list it is in.
async function findPost(postPath) {
  for (const net of ['facebook', ...POST_NETS]) {
    const post = (await postsList(net).catch(() => [])).find((p) => p.path === postPath);
    if (post) return post;
  }
  return null;
}
// True when the network has its own folder (Réglages → Dossiers).
async function ownFolders() {
  const all = await folder('folders').catch(() => ({}));
  return (net) => !!(all[net] && all[net].own);
}

async function folderQueue() {
  const settings = await folderSettings();
  return folder('scan', { channels: settings.channels, watchSince: settings.watchSince });
}

// "UC…" id from an id, a channel link or a Studio link.
function channelIdOf(text) {
  const m = String(text || '').match(/UC[A-Za-z0-9_-]{22}/);
  return m ? m[0] : null;
}

// Runs one window.__kappgen step inside the Studio tab.
// Same as step(), for a network driven by its own script (TikTok…).
async function stepIn(tabId, namespace, name, args) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (ns, fn, input) => {
      try {
        return { ok: true, value: await window[ns][fn](input) };
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) };
      }
    },
    args: [namespace, name, args || {}],
  });
  if (!result || !result.ok) throw new Error((result && result.error) || `Étape « ${name} » impossible.`);
  return result.value;
}

// sendPost / publish: when the page reloads right after « Publier » (no
// answer from the script), the mark left in the tab tells it was clicked.
async function postStep(tabId, name, args) {
  try { await chrome.scripting.executeScript({ target: { tabId }, func: () => sessionStorage.removeItem('kappgenPublishClicked') }); } catch { /* checked below */ }
  try {
    return await step(tabId, name, args);
  } catch (error) {
    if (!/impossible\.$/.test(String(error.message))) throw error;
    await sleep(4000);
    const [{ result } = {}] = await chrome.scripting.executeScript({ target: { tabId },
      func: () => Number(sessionStorage.getItem('kappgenPublishClicked') || 0) }).catch(() => [{}]);
    if (result && Date.now() - result < 30 * 60000) return { groups: [], extra: [], reloaded: true };
    throw error;
  }
}

async function step(tabId, name, args) {
  // Studio sometimes reloads the page under the script (after a thumbnail, a
  // redirect...): window.__kappgen is then gone. Inject the script again and
  // retry the step once instead of failing with « reading '...' of undefined ».
  const run = async () => {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (fn, input) => {
        if (!window.__kappgen) return { ok: false, missing: true };
        try {
          return { ok: true, value: await window.__kappgen[fn](input) };
        } catch (error) {
          return { ok: false, error: String((error && error.message) || error) };
        }
      },
      args: [name, args || {}],
    });
    return result;
  };
  let result = await run();
  if (result && result.missing) {
    await sleep(4000); // let the reloaded page settle
    await injectScripts(tabId, ['studio.js']);
    result = await run();
  }
  if (!result || !result.ok) throw new Error((result && !result.missing && result.error) || `Étape « ${name} » impossible.`);
  return result.value;
}

// Chrome's own messages ("Frame with ID 0 is showing error page"...) mean
// nothing to a creator; say what actually went wrong instead.
function friendly(error) {
  if (cancelRequested) { cancelRequested = false; return 'Publication annulée.'; }
  const message = String((error && error.message) || error);
  if (/error page|ERR_|Cannot access contents|No tab with id/i.test(message)) {
    return 'La page (YouTube Studio, Facebook…) n’a pas pu se charger (connexion Internet ?) ou l’onglet a été fermé. Relance l’envoi.';
  }
  if (/Another debugger is already attached/i.test(message)) {
    return 'Ferme les outils de développement (DevTools) de l’onglet YouTube Studio, puis relance.';
  }
  return message;
}

// channelId: open the upload dialog of that channel (several channels on one
// Google account); otherwise the channel last used in this Chrome profile.
// Studio tabs that belong to the creator (the one they had open, or the one
// opened for a click): the upload runs there and they are never closed.
async function borrowedTabs() {
  const { borrowed } = await chrome.storage.session.get('borrowed');
  return new Set(borrowed || []);
}

async function setBorrowed(tabId, on) {
  const tabs = await borrowedTabs();
  if (on) tabs.add(tabId); else tabs.delete(tabId);
  await chrome.storage.session.set({ borrowed: [...tabs] });
}

// Closes a Studio tab the extension opened by itself (automatic uploads),
// leaves the creator's own tab open.
async function closeStudioTab(tabId) {
  if ((await borrowedTabs()).has(tabId)) return;
  chrome.tabs.remove(tabId).catch(() => {});
}

// An already open tab of the site is used (the one in front first, then one
// of the current window, then any window); a new tab only when there is none.
async function tabToReuse(pattern, patterns) {
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active && pattern.test(active.url || '')) return active;
  const here = await chrome.tabs.query({ url: patterns, lastFocusedWindow: true });
  if (here[0]) return here[0];
  const anywhere = await chrome.tabs.query({ url: patterns });
  return anywhere[0] || null;
}
const tiktokTabToReuse = () => tabToReuse(/^https:\/\/www\.tiktok\.com\//, ['https://www.tiktok.com/*']);
const instagramTabToReuse = () => tabToReuse(/^https:\/\/www\.instagram\.com\//, ['https://www.instagram.com/*']);
const xTabToReuse = () => tabToReuse(/^https:\/\/(x|twitter)\.com\//, ['https://x.com/*', 'https://twitter.com/*']);
const linkedinTabToReuse = () => tabToReuse(/^https:\/\/www\.linkedin\.com\//, ['https://www.linkedin.com/*']);
const studioTabToReuse = () => tabToReuse(/^https:\/\/studio\.youtube\.com\//, ['https://studio.youtube.com/*']);
const facebookTabToReuse = () => tabToReuse(/^https:\/\/(www\.|web\.|business\.)?facebook\.com\//,
  ['https://www.facebook.com/*', 'https://facebook.com/*', 'https://web.facebook.com/*', 'https://business.facebook.com/*']);

// Goes to url in an open tab of the site, or opens one. A tab that was
// already open is "borrowed": it is never closed afterwards.
async function reuseOrOpen(findTab, url, { sameIfStartsWith = null, normalize = (u) => u } = {}) {
  let tab = await findTab();
  if (tab) {
    const current = normalize(tab.url || '');
    if (!(sameIfStartsWith && current.startsWith(sameIfStartsWith))) tab = await chrome.tabs.update(tab.id, { url });
    await setBorrowed(tab.id, true);
  } else {
    tab = await chrome.tabs.create({ url, active: false });
  }
  await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  return tab;
}

// reuse: upload in the creator's own Studio tab (clicks); otherwise a tab of
// its own in the background (automatic uploads, so the tab the creator is
// working in is never taken over).
async function openStudioUpload(channelId, active = true, { reuse = false } = {}) {
  const url = channelId ? `https://studio.youtube.com/channel/${channelId}/videos/upload?d=ud` : 'https://www.youtube.com/upload';
  // The YouTube Studio tab already open is used, for clicks and automatic
  // uploads alike; a new tab only when none is open.
  const tab = await reuseOrOpen(studioTabToReuse, url);
  if (reuse || active) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  const start = Date.now();
  while (Date.now() - start < 90000) {
    const current = await chrome.tabs.get(tab.id);
    const url = current.url || current.pendingUrl || '';
    if (url.startsWith('https://accounts.google.com')) {
      throw new Error('Connecte-toi d’abord à YouTube Studio dans ce navigateur, puis relance.');
    }
    if (url.startsWith('https://studio.youtube.com') && /\/upload|[?&]d=ud/.test(url) && current.status === 'complete') {
      if (channelId && !url.includes(channelId)) {
        throw new Error(`Ce profil Chrome n’a pas accès à la chaîne ${channelId} dans YouTube Studio.`);
      }
      await injectScripts(tab.id, ['studio.js']);
      return tab.id;
    }
    await sleep(700);
  }
  throw new Error('YouTube Studio ne s’est pas ouvert.');
}

// Sets `path` on the first element matching the recipe's Studio selector
// `key`, without reading the file.
async function setLocalFile(tabId, key, path) {
  const selector = await recipeSelector('studio', key);
  if (!chrome.debugger || !await chrome.permissions.contains({ permissions: ['debugger'] })) {
    throw new Error('Cette vidéo de l’application ne peut pas être envoyée directement : télécharge-la et range-la dans ton dossier de vidéos, elle partira toute seule.');
  }
  const target = { tabId };
  await chrome.debugger.attach(target, '1.3');
  try {
    const { root } = await chrome.debugger.sendCommand(target, 'DOM.getDocument', { depth: -1, pierce: true });
    const { nodeId } = await chrome.debugger.sendCommand(target, 'DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error('Sélecteur de fichier YouTube introuvable.');
    await chrome.debugger.sendCommand(target, 'DOM.setFileInputFiles', { nodeId, files: [path] });
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

// Studio only moves through its upload dialog while its tab is shown (a
// hidden tab gets no animation frames). Show it for the few seconds the
// dialog needs, then give the user back the tab they were on.
// The tab a publication is working in, so « Annuler » can stop it.
let workTabId = null;
let cancelRequested = false;
async function whileShown(tabId, fn) {
  workTabId = tabId;
  const tab = await chrome.tabs.get(tabId);
  const [previous] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  await chrome.tabs.update(tabId, { active: true });
  try {
    return await fn();
  } finally {
    if (workTabId === tabId) workTabId = null;
    if (previous && previous.id !== tabId) await chrome.tabs.update(previous.id, { active: true }).catch(() => {});
  }
}

// Settings of one channel: the side panel's, overridden by what the channel
// folder itself says (reglages-publication.json, ADN/chaine.json).
// The Facebook Page is one link for the whole panel (settings.facebookPageUrl);
// publishing a YouTube video on Facebook automatically is only decided by the
// channel's own file (reglages-publication.json), never by the panel.
// Networks the creator switched off in the panel's « Réseaux » tab: nothing is
// sent to them, automatically or by a click (YouTube, Facebook, TikTok...).
// Networks on unless unticked; the newer ones (X…) only once ticked.
const DEFAULT_ON = new Set(['youtube', 'facebook', 'tiktok', 'instagram']);
const networkOn = (settings, name) => {
  const value = ((settings && settings.networks) || {})[name];
  return value === undefined ? DEFAULT_ON.has(name) : value !== false;
};

function ownOf(settings, video) {
  const { facebook, ...panel } = (settings.channels || {})[video.channel_key] || {};
  const own = { ...panel, ...((video && video.channel_config) || {}) };
  if (!own.facebookPageUrl && settings.facebookPageUrl) own.facebookPageUrl = settings.facebookPageUrl;
  // Panel-wide YouTube settings (one Chrome profile = one channel): used when
  // the channel has none of its own.
  if (!own.visibility && (settings.visibility || settings.schedule === 'times')) {
    own.visibility = settings.schedule === 'times' ? 'SCHEDULE' : settings.visibility;
  }
  if (!own.times && settings.times) own.times = settings.times;
  // YouTube videos and Shorts also go to the Facebook Page (panel switch,
  // on by default, for videos published from the moment it was switched on),
  // unless the channel's own folder settings say otherwise.
  if (own.facebook === undefined) own.facebook = settings.facebookFromYoutube !== false;
  if (!own.facebookSince) own.facebookSince = settings.facebookFromYoutubeSince || 1;
  if (!networkOn(settings, 'facebook')) own.facebook = false;
  return own;
}

// ------------------------------------------------- visibility & schedule

const VISIBILITIES = ['UNLISTED', 'PUBLIC', 'PRIVATE', 'SCHEDULE'];
const channelVisibility = (own) => (VISIBILITIES.includes(own.visibility) ? own.visibility : 'UNLISTED');

async function rememberChannel(channelKey, youtubeChannelId) {
  const settings = await folderSettings();
  const own = settings.channels[channelKey] || {};
  if (own.youtubeChannelId === youtubeChannelId) return;
  settings.channels[channelKey] = { ...own, youtubeChannelId };
  await chrome.storage.local.set({ folder: settings });
}

// "18:00" or "9:00, 18:30" -> [[18, 0]] / [[9, 0], [18, 30]] (quarter hours:
// Studio only offers times every 15 minutes).
function parseTimes(text) {
  const times = [];
  for (const m of String(text || '18:00').matchAll(/(\d{1,2})\s*[:h]\s*(\d{2})?/g)) {
    const hour = Number(m[1]);
    const minute = Math.round(Number(m[2] || 0) / 15) * 15;
    if (hour < 24) times.push([hour + Math.floor(minute / 60), minute % 60]);
  }
  return times.length ? times.sort((a, b) => a[0] - b[0] || a[1] - b[1]) : [[18, 0]];
}

// Next publishing time of the channel not taken by an earlier scheduled
// video, at least one hour from now.
async function nextSlot(channelKey, timesText) {
  const { scheduled } = await chrome.storage.local.get('scheduled');
  const taken = new Set(((scheduled || {})[channelKey] || []).map(Number));
  const earliest = Date.now() + 3600 * 1000;
  for (let day = 0; day < 400; day += 1) {
    for (const [hour, minute] of parseTimes(timesText)) {
      const date = new Date();
      date.setDate(date.getDate() + day);
      date.setHours(hour, minute, 0, 0);
      if (date.getTime() >= earliest && !taken.has(date.getTime())) return date.getTime();
    }
  }
  throw new Error('Aucun créneau de programmation libre.');
}

async function rememberSlot(channelKey, time) {
  const { scheduled } = await chrome.storage.local.get('scheduled');
  const all = scheduled || {};
  all[channelKey] = [...(all[channelKey] || []).filter((t) => t > Date.now()), time];
  await chrome.storage.local.set({ scheduled: all });
}

// Videos of a channel as shown on its public page (title, date, views):
// read from the page's own data, no YouTube API key needed. Private and
// unlisted videos are not on that page.
async function channelVideos(youtubeChannelId) {
  const response = await fetch(`https://www.youtube.com/channel/${youtubeChannelId}/videos`, { credentials: 'include' });
  if (!response.ok) throw new Error(`YouTube ne répond pas (${response.status}).`);
  const html = await response.text();
  const m = html.match(/var ytInitialData\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
  if (!m) throw new Error('Page de la chaîne illisible.');
  const found = [];
  const seen = new Set();
  const text = (t) => (t && (t.simpleText || (t.runs || []).map((r) => r.text).join(''))) || '';
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.videoId && node.title && !seen.has(node.videoId) && (node.thumbnail || node.publishedTimeText)) {
      seen.add(node.videoId);
      found.push({
        id: node.videoId,
        title: text(node.title),
        published: text(node.publishedTimeText),
        views: text(node.viewCountText) || text(node.shortViewCountText),
        length: text(node.lengthText),
      });
    }
    for (const value of Object.values(node)) walk(value);
  }(JSON.parse(m[1])));
  return found;
}

// Facebook's native composer is used with the account already signed in in
// Chrome.  This deliberately opens facebook.com rather than Business Suite:
// the page chooser in the normal Reel composer is the source of truth for
// which Page receives the post.
// In several countries (much of Africa among them) Facebook serves itself
// from web.facebook.com: same site, same session, same page.
const FACEBOOK_HOST = /^https?:\/\/(?:www\.|web\.|m\.|mobile\.)?facebook\.com(?=\/|$)/i;
const facebookWww = (url) => String(url || '').replace(FACEBOOK_HOST, 'https://www.facebook.com');
async function openFacebookReel(pageUrl) {
  const safePage = FACEBOOK_HOST.test(String(pageUrl || '')) ? facebookWww(pageUrl) : 'https://www.facebook.com/';
  // The Facebook tab already open is used (left as is if it already shows the page).
  const tab = await reuseOrOpen(facebookTabToReuse, safePage, { sameIfStartsWith: safePage.replace(/\/+$/, ''), normalize: facebookWww });
  const start = Date.now();
  while (Date.now() - start < 90000) {
    const current = await chrome.tabs.get(tab.id);
    const url = current.url || current.pendingUrl || '';
    if (/login|checkpoint|recover/i.test(url)) throw new Error('Connecte-toi d’abord à Facebook dans ce navigateur, puis relance.');
    if (/^https:\/\/(www\.|web\.)?facebook\.com/.test(url) && current.status === 'complete') {
      await injectScripts(tab.id, ['facebook.js']);
      return tab.id;
    }
    await sleep(700);
  }
  throw new Error('Facebook ne s’est pas ouvert.');
}

// filePath: the file to post (the long video, or its vertical version).
async function publishFacebookReel(video, channelName, pageUrl, filePath = video && video.vertical_path, { groups = [], groupCount = 0 } = {}) {
  if (!filePath) throw new Error('Aucun fichier vertical associé à cette vidéo.');
  const tabId = await openFacebookReel(pageUrl);
  // The long video is a normal video post ("Photo/vidéo"); only the vertical
  // version is a Reel.
  if (filePath === video.relative_path && !video.vertical_path) {
    await whileShown(tabId, async () => {
      await step(tabId, 'openPost', { photo: true });
      await setJob({ message: 'Envoi de la vidéo sur Facebook…' });
      await step(tabId, 'receiveFile', { kind: 'video', path: filePath,
        src: chrome.runtime.getURL(`bridge.html?path=${encodeURIComponent(filePath)}`) });
      await sleep(3000);
      // Only the catchy title of the YouTube video goes with it on Facebook.
      await step(tabId, 'fillCaption', { caption: (video.title || '').slice(0, 500) });
      await setJob({ message: 'Envoi de la vidéo à Facebook, puis publication (peut prendre plusieurs minutes)…' });
      await postStep(tabId, 'sendPost', { timeout: 15 * 60000 });
    });
    return true;
  }
  let picked = { groups: [], extra: [] };
  try {
    await whileShown(tabId, async () => {
      await step(tabId, 'openReel');
      await step(tabId, 'receiveFile', {
        src: chrome.runtime.getURL(`bridge.html?path=${encodeURIComponent(filePath)}`),
        path: filePath,
      });
      await setJob({ message: `Préparation de la publication Facebook (${channelName || 'page sélectionnée'})…` });
      // A YouTube video: its title only; a Reel post of the Facebook folder: its text.
      const caption = (video.title || video.description || '').slice(0, 5000);
      await step(tabId, 'fillCaption', { caption });
      picked = await postStep(tabId, 'publish', { groups, groupCount });
    });
    return picked;
  } finally {
    // Keep Facebook visible after a successful post so the creator can see
    // the selected Page and the published Reel. On error, it stays open too
    // because the visible error is usually actionable in the composer.
  }
}

// monetization: the channel's choice, like its long videos ("on" answers the
// « Adéquation publicitaire » questionnaire; before 1.18.1 Shorts always stopped there).
async function publishShortYouTube(video, channelId, visibility, { reuse = false, monetization = 'on' } = {}) {
  const tabId = await openStudioUpload(channelId, false, { reuse });
  const shortVisibility = visibility === 'SCHEDULE' ? 'UNLISTED' : visibility;
  const job = { source: 'folder', social: true, videoId: video.id, tabId,
    visibility: shortVisibility, stage: 'filling',
    video: { title: `${video.title} — Short`, description: video.description, tags: video.tags,
      channel_name: video.channel_name, channel_key: video.channel_key,
      relative_path: video.relative_path, hash: video.hash } };
  try {
    await injectScripts(tabId, ['studio.js']);
    await chrome.storage.local.set({ pending: job });
    await whileShown(tabId, async () => {
      await step(tabId, 'waitForFilePicker');
      await step(tabId, 'receiveFile', {
        selector: 'videoInput',
        src: chrome.runtime.getURL(`bridge.html?path=${encodeURIComponent(video.vertical_path)}`),
        path: video.vertical_path,
      });
      await step(tabId, 'fillDetails', { title: `${video.title} — Short`, description: video.description });
      if (video.tags && video.tags.length) await step(tabId, 'fillTags', { tags: video.tags }).catch(() => {});
      await step(tabId, 'chooseVisibility', { visibility: shortVisibility, monetization });
    });
    await finishUpload(job);
    const { job: finished } = await chrome.storage.session.get('job');
    return finished && finished.youtubeId;
  } catch (error) {
    // 1.18.2 : sans ça, la marque « envoi en cours » restait et bloquait toute
    // la file (posts Facebook compris) jusqu'à 8 h après un Short raté.
    await chrome.storage.local.remove('pending');
    closeStudioTab(tabId);
    throw error;
  }
}

// The Short (vertical short.mp4) of a video ALREADY on YouTube: the long
// upload only sends it right after the long video, so videos published
// before their vertical version existed get it from here (button, or
// automatically for channels in automatic mode).
async function publishShortOnly(relativePath, { auto = false } = {}) {
  await chrome.storage.session.set({ job: { running: true, source: 'folder', kind: 'short', path: relativePath, auto, message: 'Préparation du Short YouTube…', startedAt: Date.now() } });
  try {
    const { sent } = await folderQueue();
    const video = sent.find((item) => item.relative_path === relativePath);
    if (!video || !video.youtube_id) throw new Error('La vidéo longue doit d’abord être publiée sur YouTube.');
    if (!video.vertical_path) throw new Error('Aucune version verticale (short.mp4) dans le dossier de la vidéo.');
    if (video.short_youtube_id) throw new Error('Le Short de cette vidéo est déjà publié.');
    const own = ownOf(await folderSettings(), video);
    const channelId = channelIdOf(own.channelId) || channelIdOf(own.youtubeChannelId);
    await setJob({ title: video.title, message: 'Envoi du Short sur YouTube…' });
    const shortId = await publishShortYouTube(video, channelId, channelVisibility(own), { reuse: !auto, monetization: own.monetization || 'on' });
    if (shortId) await folder('mark', { path: relativePath, status: 'published', data: { shortYoutubeId: shortId } });
    await setJob({ running: false, done: true, error: null, auto, message: 'Short publié sur YouTube.' });
  } catch (error) {
    const message = friendly(error);
    // Not retried on its own (never a double Short): the panel offers « Réessayer ».
    await folder('mark', { path: relativePath, status: 'published', data: { shortError: message } }).catch(() => {});
    await setJob({ running: false, done: false, error: message, message });
  }
}

// Same steps for both sources; only where the video comes from differs.
async function publish(source, videoId, visibility, { auto = false } = {}) {
  await chrome.storage.session.set({ job: { running: true, source, kind: 'youtube', path: videoId, videoId, auto, message: 'Préparation…', startedAt: Date.now() } });
  let video;
  let channelId = null;
  let monetization = 'on';
  let scheduleAt = null; // ms timestamp when visibility is SCHEDULE
  let marked = false; // only our own "started" mark may become "failed"
  let tabId = null;
  let job = null;
  linkedYoutubeId = null;
  try {
    if (source === 'folder') {
      if (!await askAccess({ wait: true })) {
        throw new Error('Accès au dossier non autorisé : clique « Autoriser » dans la petite fenêtre KappGen Publish.');
      }
      const { videos } = await folderQueue();
      video = videos.find((v) => v.id === videoId);
      if (!video) throw new Error('Cette vidéo n’est plus dans le dossier (déplacée, renommée ou déjà envoyée).');
      const own = ownOf(await folderSettings(), video);
      // The channel is learned on the first upload (Studio's address); an
      // id typed by hand in older versions still wins.
      channelId = channelIdOf(own.channelId) || channelIdOf(own.youtubeChannelId);
      monetization = own.monetization || 'on';
      // A time chosen for this video in the panel wins (YouTube makes it public then).
      const fixed = video.schedule_at && video.schedule_at > Date.now() + 15 * 60000;
      if (visibility === 'CHANNEL') visibility = fixed ? 'SCHEDULE' : channelVisibility(own);
      if (visibility === 'SCHEDULE') scheduleAt = fixed ? video.schedule_at : await nextSlot(video.channel_key, own.times);
      await folder('mark', { path: video.relative_path, status: 'started' });
      marked = true;
    } else {
      const { videos, host_storage_configured: configured } = await api('/studio-upload/queue');
      video = videos.find((v) => v.id === videoId);
      if (!video) throw new Error('Cette vidéo n’est plus dans la liste à publier.');
      if (!configured || !video.file_path) {
        throw new Error('KappGen ne connaît pas l’emplacement des vidéos sur ce Mac (KAPPGEN_DATA_DIR, voir LOCAL.md).');
      }
    }
    await setJob({ title: video.title, channel: video.channel_name, message: 'Ouverture de YouTube Studio…' });
    if (visibility === 'CHANNEL') visibility = 'UNLISTED';
    tabId = await openStudioUpload(channelId, false, { reuse: !auto });
    if (source === 'folder') {
      const learned = channelIdOf((await chrome.tabs.get(tabId)).url);
      if (learned) await rememberChannel(video.channel_key, learned);
    }
    // Written to disk: after an update/reload of the extension, resume()
    // picks this up and only follows the transfer already under way.
    job = { source, videoId, tabId, visibility, auto, stage: 'filling',
      video: video && { title: video.title, description: video.description, tags: video.tags,
        channel_name: video.channel_name, channel_key: video.channel_key, relative_path: video.relative_path,
        hash: video.hash, vertical_path: video.vertical_path } };
    await chrome.storage.local.set({ pending: job });
    await whileShown(tabId, async () => {
      await step(tabId, 'waitForFilePicker');
      await setJob({ message: 'Sélection du fichier vidéo…' });
      const videoInput = 'videoInput';
      if (source === 'folder') {
        const src = chrome.runtime.getURL(`bridge.html?path=${encodeURIComponent(video.relative_path)}`);
        await step(tabId, 'receiveFile', { selector: videoInput, src, path: video.relative_path });
      } else {
        await setLocalFile(tabId, videoInput, video.file_path);
      }

      await setJob({ message: 'Titre et description…' });
      await step(tabId, 'fillDetails', { title: video.title, description: video.description });
      if (video.tags && video.tags.length) {
        await setJob({ message: 'Tags…' });
        // Not worth failing a whole upload over: tags can be added later.
        await step(tabId, 'fillTags', { tags: video.tags }).catch((error) => setJob({ warning: String(error.message || error) }));
      }
      if (video.thumbnail_path && await step(tabId, 'hasThumbnailPicker')) {
        const thumbInput = 'thumbInput';
        if (source === 'folder') {
          const src = chrome.runtime.getURL(`bridge.html?path=${encodeURIComponent(video.thumbnail_path)}`);
          await step(tabId, 'receiveFile', { selector: thumbInput, src, path: video.thumbnail_path }).catch(() => {});
        } else {
          await setLocalFile(tabId, thumbInput, video.thumbnail_path).catch(() => {});
        }
      }

      // The draft exists on YouTube as soon as Studio shows its link. Record it
      // NOW: if a later step fails (monetization, visibility...), the video is
      // known as sent with its link, so a retry edits that draft ("Mettre à
      // jour") instead of uploading the same file a second time.
      const early = await earlyLink(tabId);
      if (early) {
        linkedYoutubeId = early;
        job = { ...job, youtubeId: early };
        await chrome.storage.local.set({ pending: job });
        if (source === 'folder') {
          await folder('mark', { path: video.relative_path, status: 'published', data: { youtubeId: early, visibility, channel: video.channel_key, hash: video.hash, draft: true } });
        } else {
          await api(`/studio-upload/${videoId}/published`, { method: 'POST', body: JSON.stringify({ youtube_video_id: early }) }).catch(() => {});
        }
      }

      await setJob({ message: 'Visibilité…' });
      await step(tabId, 'chooseVisibility', { visibility, monetization, scheduleAt });
    });
    if (scheduleAt) await rememberSlot(video.channel_key, scheduleAt);

    await finishUpload(job);
  } catch (error) {
    const message = friendly(error);
    const draftNote = linkedYoutubeId ? ` Le brouillon existe déjà sur YouTube (https://studio.youtube.com/video/${linkedYoutubeId}/edit) : termine-le là ou utilise « Mettre à jour », sans renvoyer la vidéo.` : '';
    await setJob({ running: false, done: false, error: message + draftNote, message: message + draftNote });
    await chrome.storage.local.remove('pending');
    if (source === 'folder' && !(job && job.social)) {
      if (marked && !linkedYoutubeId) await folder('mark', { path: video.relative_path, status: 'failed', data: { error: message } }).catch(() => {});
    } else {
      if (!linkedYoutubeId) await api(`/studio-upload/${videoId}/failed`, { method: 'POST', body: JSON.stringify({ error: message }) }).catch(() => {});
    }
  }
}


// Link of the video being uploaded, as soon as the Details page shows it.
async function earlyLink(tabId, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const { youtubeId } = await step(tabId, 'progress').catch(() => ({}));
    if (youtubeId) return youtubeId;
    await sleep(1500);
  }
  return null;
}

// Second half of an upload, shared by publish() and resume(): save as soon as
// Studio has given the video its YouTube link, then keep the Studio tab open
// until the transfer is over (closing it would cancel the transfer).
let linkedYoutubeId = null; // set once the video has a YouTube link
async function finishUpload(job) {
  const { source, videoId, tabId, visibility, video } = job;
  let { youtubeId } = job;
  if (job.stage !== 'saved') {
    const linkDeadline = Date.now() + 10 * 60 * 1000;
    while (!youtubeId) {
      if (Date.now() > linkDeadline) throw new Error('YouTube n’a pas donné de lien pour la vidéo.');
      youtubeId = (await step(tabId, 'progress')).youtubeId;
      if (!youtubeId) await sleep(1500);
    }
    // The video exists on YouTube from now on: record it before saving, so
    // "Mettre à jour" can finish it even if the save step fails.
    linkedYoutubeId = youtubeId;
    if (source === 'folder') {
      // A Short (job.social) belongs to the long video's folder: it must not
      // replace the long video's link, only be recorded next to it.
      await folder('mark', { path: video.relative_path, status: 'published', data: job.social
        ? { shortYoutubeId: youtubeId }
        : { youtubeId, visibility, channel: video.channel_key, hash: video.hash } });
    } else {
      await api(`/studio-upload/${videoId}/published`, { method: 'POST', body: JSON.stringify({ youtube_video_id: youtubeId }) });
    }
    const saved = await saveUntilClosed(tabId);
    job = { ...job, stage: 'saved', youtubeId, saveStuck: !saved };
    await chrome.storage.local.set({ pending: job });
  }
  await setJob({ running: true, youtubeUrl: `https://youtu.be/${youtubeId}`, message: 'Enregistrée dans Studio, transfert en cours (garde l’onglet Studio ouvert)…' });
  let calm = 0;
  const deadline = Date.now() + 8 * 3600 * 1000;
  while (calm < 3 && Date.now() < deadline) {
    const busy = await step(tabId, 'stillUploading').catch(() => false);
    calm = busy ? 0 : calm + 1;
    // A dialog still "Saving…" gets a few visible seconds now and then:
    // Studio only moves on while its tab is shown.
    if (job.saveStuck && calm === 0 && await step(tabId, 'saveState').catch(() => 'closed') !== 'closed') {
      await whileShown(tabId, () => sleep(4000));
    }
    await sleep(3000);
  }
  // Transfer over and the upload dialog never finished saving: the video
  // exists (it has its link), so set its visibility from its own page.
  if (job.saveStuck && await step(tabId, 'saveState').catch(() => 'closed') !== 'closed') {
    await setJob({ message: 'Studio bloqué sur « Saving… » : visibilité réglée depuis la page de la vidéo…' });
    await applyVisibilityFromEdit(tabId, youtubeId, visibility);
  }
  await closeStudioTab(tabId);
  await chrome.storage.local.remove('pending');
  let socialMessage = '';
  if (source === 'folder' && !job.social) {
    try {
      const settings = await folderSettings();
      const { sent: sentNow } = await folderQueue();
      const publishedNow = sentNow.find((item) => item.relative_path === video.relative_path);
      const own = ownOf(settings, publishedNow || video);
      // Without a choice in the channel file: the vertical version if there
      // is one (Short + Reel, as before), otherwise the long video itself.
      own.facebookMode = own.facebookMode || (video.vertical_path ? 'reel' : 'video');
      if (own.facebook && own.facebookMode !== 'reel' && publishedNow && !publishedNow.facebook_published_at) {
        // The same long video, posted on the channel's Facebook Page.
        await setJob({ message: 'Vidéo envoyée sur YouTube — publication sur Facebook…' });
        await publishFacebookReel(publishedNow, video.channel_name, own.facebookPageUrl, publishedNow.relative_path);
        await folder('mark', { path: video.relative_path, status: 'published', data: { facebookPublishedAt: new Date().toISOString() } });
        socialMessage = ' Publiée aussi sur Facebook.';
      } else if (own.facebook && own.facebookMode === 'reel' && video.vertical_path) {
        await setJob({ message: 'Vidéo envoyée sur YouTube — publication du Short et du Reel Facebook…' });
        const { sent } = await folderQueue();
        const published = sent.find((item) => item.relative_path === video.relative_path);
        if (published) {
          let shortId = published.short_youtube_id;
          if (!shortId) {
            const channelId = channelIdOf(own.channelId) || channelIdOf(own.youtubeChannelId);
            shortId = await publishShortYouTube(published, channelId, visibility, { reuse: !job.auto, monetization: own.monetization || 'on' });
            await folder('mark', { path: video.relative_path, status: 'published', data: { shortYoutubeId: shortId } });
          }
          if (!published.facebook_published_at) {
            await publishFacebookReel(published, video.channel_name, own.facebookPageUrl);
            await folder('mark', { path: video.relative_path, status: 'published', data: { facebookPublishedAt: new Date().toISOString() } });
          }
          socialMessage = ' Short YouTube et Reel Facebook publiés.';
        }
      } else if (own.facebook && own.facebookMode === 'reel' && !video.vertical_path) {
        socialMessage = ' Facebook activé, mais aucun fichier vertical associé n’a été trouvé.';
      }
    } catch (error) {
      socialMessage = ` Facebook non publié : ${friendly(error)}`;
    }
  }
  await setJob({ running: false, done: true, error: null, message: `Vidéo envoyée sur YouTube.${socialMessage}` });
  await remember({ title: video.title, channel: video.channel_name, youtubeId, visibility, at: Date.now() });
}

// Clicks Save and makes sure the upload dialog really closes. Studio
// sometimes stays on "Saving…" (tab hidden at the wrong moment, slow
// checks): the tab is shown again for a few seconds and Save retried.
// Returns false if it is still stuck after ~4 minutes.
async function saveUntilClosed(tabId) {
  let state = await whileShown(tabId, () => step(tabId, 'save')).catch(() => 'open');
  const deadline = Date.now() + 4 * 60 * 1000;
  while (state !== 'closed' && Date.now() < deadline) {
    if (state === 'open') state = await whileShown(tabId, () => step(tabId, 'save')).catch(() => 'open');
    else state = await whileShown(tabId, async () => { await sleep(5000); return step(tabId, 'saveState'); }).catch(() => 'saving');
    if (state !== 'closed') await sleep(5000);
  }
  return state === 'closed';
}

async function applyVisibilityFromEdit(tabId, youtubeId, visibility) {
  if (!['UNLISTED', 'PUBLIC', 'PRIVATE'].includes(visibility)) {
    throw new Error(`Vidéo envoyée (https://youtu.be/${youtubeId}) mais Studio est resté bloqué : règle sa programmation à la main dans Studio.`);
  }
  await chrome.tabs.update(tabId, { url: `https://studio.youtube.com/video/${youtubeId}/edit` });
  const start = Date.now();
  while (Date.now() - start < 90000) {
    const tab = await chrome.tabs.get(tabId);
    if ((tab.url || '').includes(`/video/${youtubeId}/edit`) && tab.status === 'complete') break;
    await sleep(700);
  }
  await injectScripts(tabId, ['studio.js']);
  await whileShown(tabId, () => step(tabId, 'setVisibilityOnEdit', { visibility }));
}

// After the extension is updated or reloaded (or the browser restarted):
// never start a new upload. If a transfer is under way in its Studio tab,
// just follow that one to its end.
let resuming = false;
async function resume() {
  if (resuming) return;
  const { pending } = await chrome.storage.local.get('pending');
  if (!pending) return;
  resuming = true;
  try {
    // 1.18.2 : un Short pas encore enregistré n'est jamais « suivi » après un
    // redémarrage : Studio peut l'avoir arrêté sur une question (ex. le
    // questionnaire « Adéquation publicitaire ») et le suivi bloquait alors
    // toutes les autres publications pendant des heures. On le note en échec
    // (« Réessayer le Short ») et la file repart.
    if (pending.social && pending.stage !== 'saved') {
      await chrome.storage.local.remove('pending');
      const message = 'Short interrompu par un redémarrage de l’extension : termine-le dans YouTube Studio, ou clique « Réessayer le Short ».';
      if (pending.video && pending.video.relative_path) {
        await folder('mark', { path: pending.video.relative_path, status: 'published', data: { shortError: message } }).catch(() => {});
      }
      await setJob({ running: false, done: false, error: message, message });
      return;
    }
    const tab = await chrome.tabs.get(pending.tabId).catch(() => null);
    if (!tab || !(tab.url || '').startsWith('https://studio.youtube.com')) {
      await chrome.storage.local.remove('pending');
      if (pending.stage !== 'saved' && pending.source === 'folder') {
        await folder('mark', { path: pending.video.relative_path, status: 'failed', data: { error: 'Envoi interrompu (onglet Studio fermé).' } }).catch(() => {});
      }
      await setJob({ running: false, done: false, error: 'Envoi interrompu : l’onglet YouTube Studio a été fermé.', message: 'Envoi interrompu.' });
      return;
    }
    await chrome.storage.session.set({ job: { running: true, source: pending.source, videoId: pending.videoId, title: pending.video.title,
      channel: pending.video.channel_name, message: 'Reprise du suivi de l’envoi en cours…', startedAt: Date.now() } });
    try {
      await injectScripts(pending.tabId, ['studio.js']); // no-op if already there
      await finishUpload(pending);
    } catch (error) {
      const message = friendly(error);
      await setJob({ running: false, done: false, error: message, message });
      await chrome.storage.local.remove('pending');
    }
  } finally {
    resuming = false;
  }
}

// "Mettre à jour" on a video already sent: re-apply its sheet (title,
// description, tags) and thumbnail from the folder on its YouTube edit page.
async function updateVideo(relativePath, auto = false) {
  await chrome.storage.session.set({ job: { running: true, source: 'folder', kind: 'update', path: relativePath, auto, message: 'Préparation de la mise à jour…', startedAt: Date.now() } });
  let tabId = null;
  let sentHash = null;
  try {
    const { sent } = await folderQueue();
    const video = sent.find((v) => v.relative_path === relativePath);
    sentHash = video && video.hash;
    if (!video || !video.youtube_id) throw new Error('Cette vidéo n’a pas de lien YouTube enregistré.');
    if (!video.title && !video.description && !(video.tags || []).length && !video.thumbnail_path) {
      throw new Error('Aucune fiche ni miniature trouvée pour cette vidéo dans le dossier.');
    }
    await setJob({ title: video.title || relativePath.split('/').pop(), channel: video.channel_name, message: 'Ouverture de la vidéo dans YouTube Studio…' });
    const tab = await reuseOrOpen(studioTabToReuse, `https://studio.youtube.com/video/${video.youtube_id}/edit`);
    tabId = tab.id;
    const start = Date.now();
    for (;;) {
      const current = await chrome.tabs.get(tabId);
      const url = current.url || current.pendingUrl || '';
      if (url.startsWith('https://accounts.google.com')) throw new Error('Connecte-toi d’abord à YouTube Studio dans ce navigateur, puis relance.');
      if (url.startsWith('https://studio.youtube.com') && current.status === 'complete') break;
      if (Date.now() - start > 90000) throw new Error('YouTube Studio ne s’est pas ouvert.');
      await sleep(700);
    }
    await injectScripts(tabId, ['studio.js']);
    await whileShown(tabId, async () => {
      const thumbInput = 'editThumbInput';
      if (video.thumbnail_path) {
        await setJob({ message: 'Miniature…' });
        const src = chrome.runtime.getURL(`bridge.html?path=${encodeURIComponent(video.thumbnail_path)}`);
        // Studio sometimes reloads the edit page under the script (no answer:
        // « Étape impossible »): wait, inject again, try once more. A thumbnail
        // that still cannot be set must not block the title and description.
        const sendThumb = () => step(tabId, 'receiveFile', { selector: thumbInput, src, path: video.thumbnail_path });
        try {
          try {
            await sendThumb();
          } catch (error) {
            if (!/impossible\.$/.test(String(error.message))) throw error;
            await sleep(5000);
            await injectScripts(tabId, ['studio.js']);
            await sendThumb();
          }
        } catch (error) {
          await setJob({ warning: `Miniature non mise à jour : ${friendly(error)}` });
        }
        await sleep(3000);
      }
      await setJob({ message: 'Titre, description, mots-clés…' });
      await step(tabId, 'editDetails', { title: video.title, description: video.description, tags: video.tags });
      await setJob({ message: 'Enregistrement…' });
      await step(tabId, 'saveEdit');
    });
    closeStudioTab(tabId);
    await folder('mark', { path: relativePath, status: 'applied', data: { hash: video.hash } });
    await setJob({ running: false, done: true, error: null, youtubeUrl: `https://youtu.be/${video.youtube_id}`, message: 'Vidéo mise à jour sur YouTube.' });
  } catch (error) {
    const message = friendly(error);
    await setJob({ running: false, done: false, error: message, message });
    // Automatic retries wait for the next change of the sheet; the button still works.
    if (sentHash) await folder('mark', { path: relativePath, status: 'applied', data: { hash: sentHash, error: message } }).catch(() => {});
  }
}

// Publish only the detected Facebook derivative. This is deliberately an
// explicit action from the Facebook tab because it opens Facebook and posts
// externally; detecting a reel file must not publish it silently.
// A YouTube video on the Facebook Page: `as` "video" = the long video as a
// video post, "reel" = its Short (vertical version) as a Reel.
async function publishFacebookOnly(relativePath, { auto = false, as = null } = {}) {
  await chrome.storage.session.set({ job: { running: true, source: 'folder', kind: 'facebook', path: relativePath, auto, message: 'Préparation de la publication Facebook…', startedAt: Date.now() } });
  let reel = as === 'reel';
  try {
    const { sent } = await folderQueue();
    const video = sent.find((item) => item.relative_path === relativePath);
    if (!video) throw new Error('La vidéo longue doit d’abord être publiée sur YouTube.');
    const own = ownOf(await folderSettings(), video);
    // Without `as` (the « Publier » button): the Short as a Reel if there is one, else the video.
    if (as === null) reel = own.facebookMode !== 'video' && !!video.vertical_path;
    if (reel && !video.vertical_path) throw new Error('Pas de version verticale (short.mp4) pour un Réel.');
    const file = reel ? video.vertical_path : video.relative_path;
    await setJob({ title: video.title, message: reel ? 'Réel sur Facebook…' : 'Vidéo sur Facebook…' });
    await publishFacebookReel(video, video.channel_name, own.facebookPageUrl, file);
    const at = new Date().toISOString();
    await folder('mark', { path: relativePath, status: 'published', data: reel ? { facebookReelAt: at } : { facebookPublishedAt: at } });
    await setJob({ running: false, done: true, error: null, message: reel ? 'Réel publié sur Facebook.' : 'Vidéo publiée sur Facebook.' });
  } catch (error) {
    const message = friendly(error);
    // Not retried on its own (never a double post): the panel offers « Réessayer ».
    await folder('mark', { path: relativePath, status: 'published', data: reel ? { facebookReelError: message } : { facebookError: message } }).catch(() => {});
    await setJob({ running: false, done: false, error: message, message });
  }
}

// ---------------------------------------------------------------- TikTok

// TikTok Studio's upload page, in the TikTok tab already open if there is one.
async function openTikTok() {
  const tab = await reuseOrOpen(tiktokTabToReuse, 'https://www.tiktok.com/tiktokstudio/upload?from=webapp');
  const start = Date.now();
  while (Date.now() - start < 90000) {
    const current = await chrome.tabs.get(tab.id);
    const url = current.url || current.pendingUrl || '';
    if (/\/login|\/signup/.test(url)) throw new Error('Connecte-toi d’abord à TikTok dans ce navigateur, puis relance.');
    if (url.startsWith('https://www.tiktok.com/') && /upload/.test(url) && current.status === 'complete') {
      await injectScripts(tab.id, ['lib/page-kit.js', 'tiktok.js']);
      return tab.id;
    }
    await sleep(700);
  }
  throw new Error('TikTok Studio ne s’est pas ouvert.');
}

// One vertical video to TikTok with its caption.
async function sendToTikTok({ filePath, caption, title, channel, path }) {
  await chrome.storage.session.set({ job: { running: true, source: 'tiktok', kind: 'tiktok', path, title, channel, message: 'Ouverture de TikTok Studio…', startedAt: Date.now() } });
  const tabId = await openTikTok();
  await whileShown(tabId, async () => {
    await setJob({ message: 'Envoi de la vidéo à TikTok…' });
    await stepIn(tabId, '__kappgenTikTok', 'sendVideo', { path: filePath, src: chrome.runtime.getURL(`bridge.html?path=${encodeURIComponent(filePath)}`) });
    await setJob({ message: 'Envoi à TikTok (jusqu’à 100 %), puis description…' });
    await stepIn(tabId, '__kappgenTikTok', 'writeCaption', { caption });
    await setJob({ message: 'Publication sur TikTok…' });
    await stepIn(tabId, '__kappgenTikTok', 'post');
  });
  closeStudioTab(tabId); // only a tab opened for this post is closed
}

const hashtags = (tags) => (tags || []).slice(0, 5).map((t) => `#${String(t).replace(/[^\p{L}\p{N}]+/gu, '')}`).filter((t) => t.length > 1).join(' ');

// A video already on YouTube: its vertical version if there is one, otherwise
// the video itself (TikTok takes horizontal videos too).
async function publishTikTokVideo(relativePath, { auto = false, long = false } = {}) {
  try {
    const { sent } = await folderQueue();
    const video = sent.find((item) => item.relative_path === relativePath);
    if (!video) throw new Error('La vidéo doit d’abord être publiée sur YouTube.');
    // The vertical version first (TikTok's own format); the long one on request.
    const filePath = long ? video.relative_path : (video.vertical_path || video.relative_path);
    const caption = [video.title, hashtags(video.tags)].filter(Boolean).join(' ').slice(0, 2200);
    await sendToTikTok({ filePath, caption, title: video.title, channel: video.channel_name, path: relativePath });
    await folder('mark', { path: relativePath, status: 'published', data: { tiktokPublishedAt: new Date().toISOString() } });
    await setJob({ running: false, done: true, error: null, auto, message: 'Publiée sur TikTok.' });
  } catch (error) {
    const message = friendly(error);
    await folder('mark', { path: relativePath, status: 'published', data: { tiktokError: message } }).catch(() => {});
    await setJob({ running: false, done: false, error: message, message });
  }
}

// ---------------------------------------------------------------- X

// X's « new post » window, in the X tab already open if there is one.
async function openX() {
  const tab = await reuseOrOpen(xTabToReuse, 'https://x.com/compose/post');
  const start = Date.now();
  while (Date.now() - start < 90000) {
    const current = await chrome.tabs.get(tab.id);
    const url = current.url || current.pendingUrl || '';
    if (/\/login|\/i\/flow\/(login|signup)|\/logout/.test(url)) throw new Error('Connecte-toi d’abord à X dans ce navigateur, puis relance.');
    if (/^https:\/\/(x|twitter)\.com\//.test(url) && current.status === 'complete') {
      if (!/\/compose\/post/.test(url)) {
        await chrome.tabs.update(tab.id, { url: 'https://x.com/compose/post' });
        await sleep(2500);
        continue;
      }
      await injectScripts(tab.id, ['lib/page-kit.js', 'x.js']);
      return tab.id;
    }
    await sleep(700);
  }
  throw new Error('X ne s’est pas ouvert.');
}

// 280 characters for a normal X account: the text is cut cleanly, a link kept whole.
function xText(text, link = '') {
  const room = 280 - (link ? 25 : 0);
  let body = String(text || '').trim();
  if (body.length > room) body = `${body.slice(0, room - 1).replace(/\s+\S*$/, '')}…`;
  return link ? `${body}\n\n${link}` : body;
}

async function sendToX({ text, mediaPath, title, channel, path }) {
  await chrome.storage.session.set({ job: { running: true, source: 'x', kind: 'x', path, title, channel, message: 'Ouverture de X…', startedAt: Date.now() } });
  const tabId = await openX();
  await whileShown(tabId, async () => {
    await setJob({ message: 'Texte du post…' });
    await stepIn(tabId, '__kappgenX', 'writePost', { text });
    if (mediaPath) {
      await setJob({ message: 'Envoi du média à X…' });
      await stepIn(tabId, '__kappgenX', 'addMedia', { path: mediaPath, src: chrome.runtime.getURL(`bridge.html?path=${encodeURIComponent(mediaPath)}`) });
      await sleep(3000);
    }
    await setJob({ message: 'Publication sur X…' });
    await stepIn(tabId, '__kappgenX', 'send');
  });
  closeStudioTab(tabId); // only a tab opened for this post is closed
}

// A video already on YouTube: its title and link, with its Short attached
// when there is one (X takes short videos; the long one stays a link).
async function publishXVideo(relativePath, { auto = false } = {}) {
  try {
    const { sent } = await folderQueue();
    const video = sent.find((item) => item.relative_path === relativePath);
    if (!video || !video.youtube_id) throw new Error('La vidéo doit d’abord être publiée sur YouTube.');
    await sendToX({ text: xText(video.title, `https://youtu.be/${video.youtube_id}`), mediaPath: video.vertical_path || null,
      title: video.title, channel: video.channel_name, path: relativePath });
    await folder('mark', { path: relativePath, status: 'published', data: { xPublishedAt: new Date().toISOString() } });
    await setJob({ running: false, done: true, error: null, auto, message: 'Publiée sur X.' });
  } catch (error) {
    const message = friendly(error);
    await folder('mark', { path: relativePath, status: 'published', data: { xError: message } }).catch(() => {});
    await setJob({ running: false, done: false, error: message, message });
  }
}

// A post of the posts folder: its text, and its photo or video.
async function publishXPost(postPath, { auto = false } = {}) {
  const post = await findPost(postPath);
  try {
    if (!post) throw new Error('Post introuvable (déplacé ?).');
    await sendToX({ text: xText(post.text), mediaPath: post.video_path || post.image_path || null,
      title: post.text.split('\n')[0].slice(0, 80) || 'Post', channel: post.channel_name, path: postPath });
    await folder('markPost', { path: postPath, patch: { x: { statut: 'publie', published_at: new Date().toISOString() } } });
    await setJob({ running: false, done: true, error: null, auto, message: 'Publié sur X.' });
  } catch (error) {
    const message = friendly(error);
    await folder('markPost', { path: postPath, patch: { x: { statut: 'echec', erreur: message } } }).catch(() => {});
    await setJob({ running: false, done: false, error: message, message });
  }
}

// ---------------------------------------------------------------- LinkedIn

// LinkedIn's « Commencer un post » window, in the LinkedIn tab already open if there is one.
const LINKEDIN_COMPOSE = 'https://www.linkedin.com/feed/?shareActive=true';
async function openLinkedin() {
  const tab = await reuseOrOpen(linkedinTabToReuse, LINKEDIN_COMPOSE);
  const start = Date.now();
  let asked = false;
  while (Date.now() - start < 90000) {
    const current = await chrome.tabs.get(tab.id);
    const url = current.url || current.pendingUrl || '';
    if (/\/(login|signup|checkpoint|authwall|uas\/login)/.test(url)) throw new Error('Connecte-toi d’abord à LinkedIn dans ce navigateur, puis relance.');
    if (url.startsWith('https://www.linkedin.com/') && current.status === 'complete') {
      if (!asked && !/shareActive=true/.test(url)) {
        asked = true;
        await chrome.tabs.update(tab.id, { url: LINKEDIN_COMPOSE });
        await sleep(2500);
        continue;
      }
      await sleep(1500);
      await injectScripts(tab.id, ['lib/page-kit.js', 'linkedin.js']);
      return tab.id;
    }
    await sleep(700);
  }
  throw new Error('LinkedIn ne s’est pas ouvert.');
}

async function sendToLinkedin({ text, mediaPath, title, channel, path }) {
  await chrome.storage.session.set({ job: { running: true, source: 'linkedin', kind: 'linkedin', path, title, channel, message: 'Ouverture de LinkedIn…', startedAt: Date.now() } });
  const tabId = await openLinkedin();
  await whileShown(tabId, async () => {
    await stepIn(tabId, '__kappgenLinkedin', 'openComposer');
    await setJob({ message: 'Texte du post…' });
    await stepIn(tabId, '__kappgenLinkedin', 'writePost', { text });
    if (mediaPath) {
      await setJob({ message: 'Envoi du média à LinkedIn…' });
      await stepIn(tabId, '__kappgenLinkedin', 'addMedia', { path: mediaPath, src: chrome.runtime.getURL(`bridge.html?path=${encodeURIComponent(mediaPath)}`) });
    }
    await setJob({ message: 'Publication sur LinkedIn…' });
    await stepIn(tabId, '__kappgenLinkedin', 'send');
  });
  closeStudioTab(tabId); // only a tab opened for this post is closed
}

// A video already on YouTube: its title, description start and link
// (LinkedIn shows the YouTube preview).
async function publishLinkedinVideo(relativePath, { auto = false } = {}) {
  try {
    const { sent } = await folderQueue();
    const video = sent.find((item) => item.relative_path === relativePath);
    if (!video || !video.youtube_id) throw new Error('La vidéo doit d’abord être publiée sur YouTube.');
    const intro = String(video.description || '').split(/\n\s*\n/)[0].slice(0, 600);
    await sendToLinkedin({ text: [video.title, intro, `https://youtu.be/${video.youtube_id}`].filter(Boolean).join('\n\n'),
      mediaPath: null, title: video.title, channel: video.channel_name, path: relativePath });
    await folder('mark', { path: relativePath, status: 'published', data: { linkedinPublishedAt: new Date().toISOString() } });
    await setJob({ running: false, done: true, error: null, auto, message: 'Publiée sur LinkedIn.' });
  } catch (error) {
    const message = friendly(error);
    await folder('mark', { path: relativePath, status: 'published', data: { linkedinError: message } }).catch(() => {});
    await setJob({ running: false, done: false, error: message, message });
  }
}

// A post (Facebook's, or LinkedIn's own): its text, and its photo or video.
async function publishLinkedinPost(postPath, { auto = false } = {}) {
  const post = await findPost(postPath);
  try {
    if (!post) throw new Error('Post introuvable (déplacé ?).');
    await sendToLinkedin({ text: post.text.slice(0, 3000), mediaPath: post.video_path || post.image_path || null,
      title: post.text.split('\n')[0].slice(0, 80) || 'Post', channel: post.channel_name, path: postPath });
    await folder('markPost', { path: postPath, patch: { linkedin: { statut: 'publie', published_at: new Date().toISOString() } } });
    await setJob({ running: false, done: true, error: null, auto, message: 'Publié sur LinkedIn.' });
  } catch (error) {
    const message = friendly(error);
    await folder('markPost', { path: postPath, patch: { linkedin: { statut: 'echec', erreur: message } } }).catch(() => {});
    await setJob({ running: false, done: false, error: message, message });
  }
}

// ---------------------------------------------------------------- Instagram

// Instagram home, in the Instagram tab already open if there is one.
async function openInstagram() {
  const tab = await reuseOrOpen(instagramTabToReuse, 'https://www.instagram.com/');
  const start = Date.now();
  while (Date.now() - start < 90000) {
    const current = await chrome.tabs.get(tab.id);
    const url = current.url || current.pendingUrl || '';
    if (/\/accounts\/(login|signup)|\/challenge\//.test(url)) throw new Error('Connecte-toi d’abord à Instagram dans ce navigateur, puis relance.');
    if (url.startsWith('https://www.instagram.com/') && current.status === 'complete') {
      await sleep(2000);
      await injectScripts(tab.id, ['lib/page-kit.js', 'instagram.js']);
      return tab.id;
    }
    await sleep(700);
  }
  throw new Error('Instagram ne s’est pas ouvert.');
}

// One vertical video to Instagram (it becomes a Reel) with its caption.
async function sendToInstagram({ filePath, caption, title, channel, path }) {
  await chrome.storage.session.set({ job: { running: true, source: 'instagram', kind: 'instagram', path, title, channel, message: 'Ouverture d’Instagram…', startedAt: Date.now() } });
  const tabId = await openInstagram();
  await whileShown(tabId, async () => {
    await stepIn(tabId, '__kappgenInstagram', 'openComposer');
    await setJob({ message: 'Envoi de la vidéo à Instagram…' });
    await stepIn(tabId, '__kappgenInstagram', 'sendVideo', { path: filePath, src: chrome.runtime.getURL(`bridge.html?path=${encodeURIComponent(filePath)}`) });
    await stepIn(tabId, '__kappgenInstagram', 'next', { times: 2 });
    await setJob({ message: 'Légende…' });
    await stepIn(tabId, '__kappgenInstagram', 'writeCaption', { caption });
    await setJob({ message: 'Partage sur Instagram (envoi jusqu’au bout)…' });
    await stepIn(tabId, '__kappgenInstagram', 'share');
  });
  closeStudioTab(tabId); // only a tab opened for this post is closed
}

// A video already on YouTube, as a Reel: needs its vertical version
// (Instagram crops a horizontal video to a square).
async function publishInstagramVideo(relativePath, { auto = false } = {}) {
  try {
    const { sent } = await folderQueue();
    const video = sent.find((item) => item.relative_path === relativePath);
    if (!video) throw new Error('La vidéo doit d’abord être publiée sur YouTube.');
    if (!video.vertical_path) throw new Error('Aucune version verticale (short.mp4) dans le dossier : Instagram recadrerait la vidéo.');
    const caption = [video.title, hashtags(video.tags)].filter(Boolean).join('\n\n').slice(0, 2200);
    await sendToInstagram({ filePath: video.vertical_path, caption, title: video.title, channel: video.channel_name, path: relativePath });
    await folder('mark', { path: relativePath, status: 'published', data: { instagramPublishedAt: new Date().toISOString() } });
    await setJob({ running: false, done: true, error: null, auto, message: 'Publiée sur Instagram.' });
  } catch (error) {
    const message = friendly(error);
    await folder('mark', { path: relativePath, status: 'published', data: { instagramError: message } }).catch(() => {});
    await setJob({ running: false, done: false, error: message, message });
  }
}

// A video of the posts folder, as a Reel.
async function publishInstagramPost(postPath, { auto = false } = {}) {
  const post = await findPost(postPath);
  try {
    if (!post || !post.video_path) throw new Error('Ce post n’a pas de vidéo pour Instagram.');
    await sendToInstagram({ filePath: post.video_path, caption: (post.text || '').slice(0, 2200), title: post.text.split('\n')[0] || 'Reel', channel: post.channel_name, path: postPath });
    await folder('markPost', { path: postPath, patch: { instagram: { statut: 'publie', published_at: new Date().toISOString() } } });
    await setJob({ running: false, done: true, error: null, auto, message: 'Publié sur Instagram.' });
  } catch (error) {
    const message = friendly(error);
    await folder('markPost', { path: postPath, patch: { instagram: { statut: 'echec', erreur: message } } }).catch(() => {});
    await setJob({ running: false, done: false, error: message, message });
  }
}

// A Reel (vertical video) of the posts folder.
async function publishTikTokPost(postPath, { auto = false } = {}) {
  const post = await findPost(postPath);
  try {
    if (!post || !post.video_path) throw new Error('Ce post n’a pas de vidéo pour TikTok.');
    await sendToTikTok({ filePath: post.video_path, caption: (post.text || '').slice(0, 2200), title: post.text.split('\n')[0] || 'Reel', channel: post.channel_name, path: postPath });
    await folder('markPost', { path: postPath, patch: { tiktok: { statut: 'publie', published_at: new Date().toISOString() } } });
    await setJob({ running: false, done: true, error: null, auto, message: 'Publié sur TikTok.' });
  } catch (error) {
    const message = friendly(error);
    await folder('markPost', { path: postPath, patch: { tiktok: { statut: 'echec', erreur: message } } }).catch(() => {});
    await setJob({ running: false, done: false, error: message, message });
  }
}

// ------------------------------------------------------ Facebook posts

// The Page of a post: its own publication.json / planning.json, otherwise the
// channel's Facebook page (reglages-publication.json or the side panel).
async function postPage(post) {
  if (post.page) return post.page;
  return ownOf(await folderSettings(), { channel_key: post.channel_key }).facebookPageUrl || null;
}

// Publishes one ready post (photo, text or Reel) on its Page, then writes
// "statut": "publie" into its publication.json. A failed post is not retried
// on its own (never a double post): it shows in the panel with its error.
async function publishFacebookPost(post, { auto = false } = {}) {
  const page = await postPage(post);
  if (!page) throw new Error(`${post.channel_name} : lien de la page Facebook à renseigner (planning.json ou reglages-publication.json).`);
  await chrome.storage.session.set({ job: { running: true, source: 'facebook', kind: 'post', path: post.path, auto, title: post.text.split('\n')[0].slice(0, 80) || 'Post Facebook', channel: post.channel_name, message: 'Ouverture de Facebook…', startedAt: Date.now() } });
  await folder('markPost', { path: post.path, patch: { statut: 'en_cours', started_at: new Date().toISOString() } });
  let tabId = null;
  try {
    // Groups ticked in the composer itself, while publishing (9 at most).
    // While publishing (« Suivant » → « Partager dans les groupes »): the
    // groups of the list found by name, completed at random among the groups
    // Facebook offers, up to the number asked (9 at most per publication).
    const plan = await groupsFor(post);
    const names = (await folderSettings()).facebookGroupNames || {};
    const count = Math.min(SHARE_BATCH, await groupTarget(post, plan));
    const during = plan.filter((url) => names[url] && !(post.groups_shared && post.groups_shared[url] && post.groups_shared[url].statut === 'publie')).slice(0, SHARE_BATCH);
    const markDuring = (result) => {
      const picked = Array.isArray(result) ? result : (result && result.groups) || [];
      const extra = (result && Array.isArray(result.extra)) ? result.extra : [];
      const lower = picked.map((n) => n.toLowerCase());
      const shared = { ...(post.groups_shared || {}) };
      const at = new Date().toISOString();
      for (const url of during) if (lower.includes(names[url].toLowerCase())) shared[url] = { statut: 'publie', published_at: at, mode: 'publication' };
      for (const name of extra) shared[`facebook:${name}`] = { statut: 'publie', published_at: at, mode: 'publication', nom: name };
      post.groups_shared = shared;
    };
    if (post.type === 'reel') {
      markDuring(await publishFacebookReel({ title: '', description: post.text }, post.channel_name, page, post.video_path,
        { groups: during.map((url) => names[url]), groupCount: count }));
    } else {
      tabId = await openFacebookReel(page);
      await whileShown(tabId, async () => {
        await step(tabId, 'openPost', { photo: post.type === 'photo' });
        if (post.image_path) {
          await setJob({ message: 'Photo…' });
          await step(tabId, 'receiveFile', { kind: 'image', path: post.image_path,
            src: chrome.runtime.getURL(`bridge.html?path=${encodeURIComponent(post.image_path)}`) });
          await sleep(2500);
        }
        await setJob({ message: 'Texte…' });
        await step(tabId, 'fillCaption', { caption: post.text });
        await setJob({ message: count ? `Publication sur la Page et dans ${count} groupe(s)…` : 'Publication…' });
        markDuring(await postStep(tabId, 'sendPost', { groups: during.map((url) => names[url]), groupCount: count }));
      });
      closeStudioTab(tabId); // only a tab opened for this post is closed
    }
    await folder('markPost', { path: post.path, patch: { statut: 'publie', published_at: new Date().toISOString(), erreur: null,
      ...(Object.keys(post.groups_shared || {}).length ? { groupes_partages: post.groups_shared } : {}) } });
    // The groups not ticked while publishing (more than 9, or no option): right after.
    const shared = await shareInGroups(post).catch(() => null);
    await setJob({ running: false, done: true, error: null, message: `Post publié sur Facebook${groupsText(shared)}.` });
  } catch (error) {
    const message = friendly(error);
    await folder('markPost', { path: post.path, patch: { statut: 'echec', erreur: message } }).catch(() => {});
    await setJob({ running: false, done: false, error: message, message });
  }
}

// ------------------------------------------------------ Facebook groups

// The groups a post is shared in: its own "groupes" list (publication.json),
// otherwise the panel's list when « Partager dans les groupes » is ticked.
// One group after another, with a pause, so Facebook does not take it for spam.
const GROUP_PAUSE_MS = 40000;
const MAX_GROUPS = 25;   // groups for one post
const POOL_MAX = 500;    // groups in the list a post's groups are drawn from
const SHARE_BATCH = 9;   // Facebook's share window takes 9 groups at most at once
function groupUrl(url) {
  const m = facebookWww(String(url || '').trim()).match(/^https:\/\/www\.facebook\.com\/groups\/[^/?#\s]+/i);
  return m ? `${m[0]}/` : null;
}
// How many groups a post goes to: its own list, or « groupes par publication »
// when sharing is on for it (even with no list: Facebook's own list is used).
async function groupTarget(post, plan) {
  if (post.groups === false) return 0;
  if (Array.isArray(post.groups)) return plan.length;
  const settings = await folderSettings();
  if (!settings.facebookGroupsOn && post.groups !== true) return 0;
  return Math.max(plan.length, Math.min(MAX_GROUPS, Math.max(1, Number(settings.facebookGroupsPerPost) || 9)));
}

// A post's groups: its own list ("groupes" in publication.json), otherwise,
// when sharing is switched on, N groups drawn at random from the creator's
// list (N = « groupes par publication »), once: the draw is written into the
// post ("groupes_tires") so a retry uses the same groups.
async function groupsFor(post) {
  if (post.groups === false) return [];
  const clean = (list) => [...new Set((list || []).map(groupUrl).filter(Boolean))];
  if (Array.isArray(post.groups)) return clean(post.groups).slice(0, MAX_GROUPS);
  if (Array.isArray(post.groups_drawn) && post.groups_drawn.length) return clean(post.groups_drawn).slice(0, MAX_GROUPS);
  const settings = await folderSettings();
  if (!settings.facebookGroupsOn && post.groups !== true) return []; // true: this post, even with sharing off
  const pool = clean(settings.facebookGroups).slice(0, POOL_MAX);
  const count = Math.min(MAX_GROUPS, Math.max(1, Number(settings.facebookGroupsPerPost) || 9));
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const drawn = pool.slice(0, count);
  post.groups_drawn = drawn;
  if (drawn.length) await folder('markPost', { path: post.path, patch: { groupes_tires: drawn } }).catch(() => {});
  return drawn;
}
const groupsText = (r) => (!r || !r.total ? '' : `, partagé dans ${r.ok} groupe(s) sur ${r.total}${r.bad ? ` (${r.bad} échec(s) : « Repartager » dans le panneau)` : ''}`);

// All the groups this Facebook account is a member of: its « Vos groupes »
// page (then the groups feed, whose side list holds them too), scrolled until
// no new group appears. The list a post's groups are drawn from.
async function findMyGroups() {
  let found = [];
  for (const url of ['https://www.facebook.com/groups/joins/?nav_source=tab', 'https://www.facebook.com/groups/feed/']) {
    found = await groupsOnPage(url).catch(() => []);
    if (found.length) break;
  }
  if (!found.length) throw new Error('Aucun groupe trouvé. Vérifie que tu es connecté à Facebook dans ce Chrome, ou colle les liens de tes groupes à la main.');
  found = found.slice(0, POOL_MAX);
  await rememberGroupNames(Object.fromEntries(found.filter((g) => g.name).map((g) => [g.url, g.name])));
  return found.map((g) => g.url);
}

async function groupsOnPage(pageUrl) {
  const tabId = await openFacebookReel(pageUrl);
  try {
    const found = [];
    let quiet = 0;
    for (let i = 0; i < 120 && quiet < 6; i += 1) {
      await sleep(i ? 1500 : 3000);
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          // The page and every scrolling list in it (Facebook keeps the
          // groups in a side list that scrolls on its own).
          window.scrollBy(0, 1500);
          for (const el of document.querySelectorAll('div, ul, nav')) {
            if (el.scrollHeight > el.clientHeight + 80 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) el.scrollTop += 1500;
          }
          const skip = /^(feed|joins|discover|create|notifications|search|category|you|explore|membership_requests)$/i;
          return [...document.querySelectorAll('a[href*="/groups/"]')].map((a) => {
            const m = a.href.match(/facebook\.com\/groups\/([^/?#]+)/i);
            const name = (a.textContent || a.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
            return m && !skip.test(m[1]) ? { url: `https://www.facebook.com/groups/${m[1]}/`, name } : null;
          }).filter(Boolean);
        },
      });
      const before = found.length;
      for (const g of result || []) {
        const known = found.find((f) => f.url === g.url);
        if (!known) found.push(g);
        else if (!known.name && g.name) known.name = g.name;
      }
      quiet = found.length > before ? 0 : quiet + 1;
    }
    return found;
  } finally {
    closeStudioTab(tabId); // a tab opened for this is closed, the creator's own stays
  }
}

// Group names, learned from « Vos groupes » and from each group page visited:
// Facebook's share window lists groups by name, not by link.
async function rememberGroupNames(names) {
  if (!Object.keys(names).length) return;
  const current = await folderSettings();
  current.facebookGroupNames = { ...(current.facebookGroupNames || {}), ...names };
  await chrome.storage.local.set({ folder: current });
}

// All the groups at once, when Facebook allows it: on the Page, the post's
// « Partager » → « Groupe » window with a box to tick per group, then one
// « Publier », for SHARE_BATCH groups at most. Returns the groups shared that
// way; the others go one by one.
async function shareAllAtOnce(post, urls) {
  const settings = await folderSettings();
  if (settings.facebookGroupsAtOnce === false) return [];
  const names = settings.facebookGroupNames || {};
  const wanted = urls.filter((url) => names[url]).slice(0, SHARE_BATCH);
  const page = await postPage(post);
  if (!wanted.length || !page) return [];
  const snippet = String(post.text || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (snippet.length < 8) return []; // the post could not be told apart on the Page
  await setJob({ message: `Partage d’un coup dans ${wanted.length} groupe(s) Facebook…` });
  const tabId = await openFacebookReel(page);
  let confirmed = false;
  try {
    return await whileShown(tabId, async () => {
      const share = await step(tabId, 'openShareToGroups', { snippet });
      if (share.mode !== 'multi') { await step(tabId, 'closeDialogs').catch(() => {}); return []; }
      const { picked } = await step(tabId, 'pickGroups', { names: wanted.map((url) => names[url]) });
      if (!picked.length) { await step(tabId, 'closeDialogs').catch(() => {}); return []; }
      confirmed = true; // from here, never shared again one by one (no double post)
      await step(tabId, 'confirmShare', { caption: '' });
      const lower = picked.map((n) => n.toLowerCase());
      return wanted.filter((url) => lower.includes(names[url].toLowerCase()));
    });
  } catch (error) {
    if (confirmed) throw error;
    await step(tabId, 'closeDialogs').catch(() => {});
    return [];
  }
}

async function shareInGroups(post) {
  const groups = await groupsFor(post);
  const done = { ...(post.groups_shared || {}) };
  const already = Object.values(done).filter((g) => g.statut === 'publie').length;
  const target = Math.max(groups.length, await groupTarget(post, groups));
  // Only what is still missing (groups ticked while publishing count, even
  // the ones Facebook offered that are not in the list).
  let todo = groups.filter((url) => !(done[url] && done[url].statut === 'publie')).slice(0, Math.max(0, target - already));
  let ok = already;
  let bad = 0;
  // By packs of 9 (25 groups = 3 shares), as long as Facebook offers the boxes.
  for (let pack = 0; todo.length > 1 && pack < Math.ceil(MAX_GROUPS / SHARE_BATCH); pack += 1) {
    if (pack) await sleep(GROUP_PAUSE_MS);
    if (await isPaused()) { todo = []; break; }
    let atOnce = [];
    try {
      atOnce = await shareAllAtOnce(post, todo);
    } catch (error) {
      // « Publier » was clicked but Facebook did not confirm: check by hand, never post twice.
      const names = (await folderSettings()).facebookGroupNames || {};
      const pending = todo.filter((url) => names[url]).slice(0, SHARE_BATCH);
      for (const url of pending) done[url] = { statut: 'echec', erreur: `Partage groupé à vérifier sur Facebook : ${friendly(error)}` };
      bad += pending.length;
      todo = todo.filter((url) => !pending.includes(url));
      await folder('markPost', { path: post.path, patch: { groupes_partages: done } }).catch(() => {});
      break;
    }
    if (!atOnce.length) break;
    for (const url of atOnce) done[url] = { statut: 'publie', published_at: new Date().toISOString(), mode: 'partage' };
    ok += atOnce.length;
    todo = todo.filter((url) => !atOnce.includes(url));
    await folder('markPost', { path: post.path, patch: { groupes_partages: done } }).catch(() => {});
    if (!todo.length) break;
  }
  if (todo.length && ok) await sleep(GROUP_PAUSE_MS);
  const media = post.video_path || post.image_path;
  for (const [i, url] of todo.entries()) {
    if (i) await sleep(GROUP_PAUSE_MS);
    if (await isPaused()) break; // « Pause » stops the remaining groups
    await setJob({ message: `Partage dans les groupes Facebook (${i + 1}/${todo.length})…` });
    try {
      const tabId = await openFacebookReel(url);
      const tab = await chrome.tabs.get(tabId);
      if (!/\/groups\//.test(tab.url || '')) throw new Error('Groupe introuvable, ou tu n’en es pas membre avec ce compte.');
      const name = String(tab.title || '').replace(/\s*[|·-]\s*Facebook\s*$/i, '').replace(/^\(\d+\)\s*/, '').trim();
      if (name && !/^facebook$/i.test(name)) await rememberGroupNames({ [url]: name }).catch(() => {});
      await whileShown(tabId, async () => {
        await step(tabId, 'openPost', { photo: !!media });
        if (media) {
          await step(tabId, 'receiveFile', { kind: post.video_path ? 'video' : 'image', path: media,
            src: chrome.runtime.getURL(`bridge.html?path=${encodeURIComponent(media)}`) });
          await sleep(post.video_path ? 3000 : 2500);
        }
        await step(tabId, 'fillCaption', { caption: post.text });
        await postStep(tabId, 'sendPost', { timeout: post.video_path ? 15 * 60000 : 90000 });
      });
      done[url] = { statut: 'publie', published_at: new Date().toISOString() };
      ok += 1;
    } catch (error) {
      done[url] = { statut: 'echec', erreur: friendly(error) };
      bad += 1;
    }
    await folder('markPost', { path: post.path, patch: { groupes_partages: done } }).catch(() => {});
  }
  return { ok, bad, total: Math.max(target, ok + bad) };
}

// Next post whose time has come. On time, it goes at its time. When posts
// are late (Chrome closed, computer asleep…), they never go out all at once:
// they leave one by one, twice as fast as the usual spacing between posts
// (2 min 30 at least), until the delay is caught up, then the normal rhythm.
const ON_TIME_MS = 10 * 60000;
function catchUpGap(posts) {
  const times = posts.map((p) => p.due_at).filter(Boolean).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < times.length; i += 1) {
    const gap = times[i] - times[i - 1];
    if (gap > 0 && gap <= 24 * 3600000) gaps.push(gap);
  }
  gaps.sort((a, b) => a - b);
  const usual = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 30 * 60000;
  return Math.min(30 * 60000, Math.max(150000, usual / 2));
}
async function nextDuePost() {
  const posts = await postsList().catch(() => []);
  // A post without a known Page waits (no failure) until the link is given.
  const ready = [];
  for (const post of posts.filter((p) => p.ready)) if (await postPage(post)) ready.push(post);
  if (!ready.length) { await chrome.storage.local.remove('catchUp'); return null; }
  const now = Date.now();
  const late = ready.length > 1 || (ready[0].due_at && now - ready[0].due_at > ON_TIME_MS);
  if (late) {
    const gap = catchUpGap(posts);
    const { lastAutoPostAt } = await chrome.storage.local.get('lastAutoPostAt');
    const next = (lastAutoPostAt || 0) + gap;
    await chrome.storage.local.set({ catchUp: { count: ready.length, gap, next: Math.max(now, next) } });
    if (now < next) return null; // the precise alarm wakes up at `next`
  } else {
    await chrome.storage.local.remove('catchUp');
  }
  return ready[0];
}

// Last uploads of this profile, shown in the popup.
async function remember(entry) {
  const { history } = await chrome.storage.local.get('history');
  await chrome.storage.local.set({ history: [entry, ...(history || [])].slice(0, 30) });
}

// Every few minutes: send the next ready video of an automatic channel.
// True when a video with the same title is already on the channel's public
// page: such a video was published before KappGen, never send it twice.
const sameTitle = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
async function alreadyOnChannel(video, own) {
  const channelId = channelIdOf(own.channelId) || channelIdOf(own.youtubeChannelId);
  if (!channelId) return false;
  const { channelCache } = await chrome.storage.session.get('channelCache');
  const cache = channelCache || {};
  let entry = cache[channelId];
  if (!entry || Date.now() - entry.at > 30 * 60 * 1000) {
    try {
      entry = { at: Date.now(), titles: (await channelVideos(channelId)).map((v) => sameTitle(v.title)) };
    } catch {
      return false;
    }
    cache[channelId] = entry;
    await chrome.storage.session.set({ channelCache: cache });
  }
  return entry.titles.includes(sameTitle(video.title));
}

// A job with no news for this long is dead (Chrome closed the tab, the
// service worker was stopped mid-post): it must not block the queue forever.
const STALE_JOB_MS = 30 * 60 * 1000;

// Wakes up exactly at the time of the next Facebook post (the regular pass
// is only every 5 minutes, and Chrome may have put the extension to sleep).
async function planNextDue() {
  const posts = [];
  for (const net of ['facebook', ...POST_NETS]) posts.push(...await postsList(net).catch(() => []));
  let next = posts.filter((p) => p.statut === 'a_publier' && p.due_at && p.due_at > Date.now())
    .reduce((min, p) => Math.min(min, p.due_at), Infinity);
  // Catching up late posts: wake up for the next one of them.
  const { catchUp } = await chrome.storage.local.get('catchUp');
  if (catchUp && catchUp.next > Date.now()) next = Math.min(next, catchUp.next);
  await chrome.storage.local.set({ nextDueAt: Number.isFinite(next) ? next : null });
  if (Number.isFinite(next)) await chrome.alarms.create('due', { when: next + 5000 });
  else await chrome.alarms.clear('due');
}

async function autoTick() {
  try {
    await autoPass();
  } finally {
    await planNextDue().catch(() => {});
  }
}

const isPaused = async () => !!(await chrome.storage.local.get('autoPaused')).autoPaused;

// After a publication that went well, straight on to the next step (the
// same publication on the next network). After a failure, the regular pass.
async function chainIfDone(since) {
  const { job } = await chrome.storage.session.get('job');
  if (job && job.done && !job.error && (job.startedAt || 0) >= since) autoTick();
}

// What is already out (a video on YouTube, a post on Facebook) goes on to
// the person's other networks: all the networks of one publication, in
// order, before the next publication. A network with its own folder
// (Réglages → Dossiers) only takes that folder's posts. Nothing is retried
// on its own after a failure (the panel shows « Réessayer »).
async function spreadNext(settings, sent, own) {
  const on = (net) => networkOn(settings, net);
  // « Mes vidéos YouTube sur ma Page » is on by default: without a start
  // date kept, « since now » moved at every pass and nothing ever went
  // (before 1.18.1). From now on, plus the videos of the last 7 days.
  if (!settings.facebookFromYoutubeSince) {
    settings.facebookFromYoutubeSince = Date.now() - 7 * 24 * 3600000;
    await chrome.storage.local.set({ folder: settings });
  }
  // X / LinkedIn ticked before their start date was kept: from now on.
  for (const net of ['x', 'linkedin']) {
    if (on(net) && !settings[`${net}Since`]) {
      settings[`${net}Since`] = Date.now();
      await chrome.storage.local.set({ folder: settings });
    }
  }
  const after = (v, since) => !!v.published_at && v.published_at >= (since || Infinity);
  const videos = sent.filter((v) => v.youtube_id).sort((a, b) => (a.published_at || 0) - (b.published_at || 0));
  const todo = [];
  for (const v of videos) {
    const ch = ownOf(settings, v);
    const fb = on('facebook') && ch.facebook && ch.facebookPageUrl && after(v, ch.facebookSince || 1);
    const steps = [
      // Its Short (vertical version) on YouTube.
      [on('youtube') && v.vertical_path && !v.short_youtube_id && !v.short_error && ch.auto !== false,
        () => publishShortOnly(v.relative_path, { auto: true })],
      // On the Facebook Page: the long video, then its Short as a Reel.
      [fb && !v.facebook_published_at && !v.facebook_error, () => publishFacebookOnly(v.relative_path, { auto: true, as: 'video' })],
      // The Reel once the Short is on YouTube (or when YouTube's Short failed / is not used).
      [fb && v.vertical_path && (v.short_youtube_id || v.short_error || !on('youtube')) && !v.facebook_reel_at && !v.facebook_reel_error,
        () => publishFacebookOnly(v.relative_path, { auto: true, as: 'reel' })],
      [on('tiktok') && settings.tiktokAuto && !own('tiktok') && !v.tiktok_published_at && !v.tiktok_error && after(v, settings.tiktokSince),
        () => publishTikTokVideo(v.relative_path, { auto: true })],
      [on('instagram') && settings.instagramAuto && !own('instagram') && v.vertical_path && !v.instagram_published_at && !v.instagram_error
        && after(v, settings.instagramSince), () => publishInstagramVideo(v.relative_path, { auto: true })],
      [on('x') && !own('x') && settings.xFromYoutube !== false && !v.x_published_at && !v.x_error && after(v, settings.xSince),
        () => publishXVideo(v.relative_path, { auto: true })],
      [on('linkedin') && !own('linkedin') && settings.linkedinFromYoutube !== false && !v.linkedin_published_at && !v.linkedin_error && after(v, settings.linkedinSince),
        () => publishLinkedinVideo(v.relative_path, { auto: true })],
    ];
    const step = steps.find(([due]) => due);
    // The oldest publication first, video or post.
    if (step) { todo.push([v.published_at || 0, step[1]]); break; }
  }
  // Facebook's posts on X and LinkedIn: once out on Facebook; without
  // Facebook, at their own time.
  const now = Date.now();
  const fbOn = on('facebook');
  const posts = (await postsList().catch(() => []))
    .sort((a, b) => (Date.parse(a.published_at || 0) || a.due_at || 0) - (Date.parse(b.published_at || 0) || b.due_at || 0));
  find: for (const p of posts) {
    for (const [net, send] of [['x', publishXPost], ['linkedin', publishLinkedinPost]]) {
      if (!on(net) || own(net) || settings[`${net}FromFacebook`] === false || p[`${net}_statut`]) continue;
      const since = settings[`${net}Since`];
      const due = p.statut === 'publie' ? p.published_at && Date.parse(p.published_at) >= since
        : !fbOn && p.statut === 'a_publier' && p.due_at && p.due_at <= now && p.due_at >= since;
      if (due) { todo.push([Date.parse(p.published_at || 0) || p.due_at || 0, () => send(p.path, { auto: true })]); break find; }
    }
  }
  todo.sort((a, b) => a[0] - b[0]);
  if (!todo.length) return false;
  await todo[0][1]();
  return true;
}

// The next post of a network's own folder whose time has come (TikTok and
// Instagram need a video).
async function ownPostNext(settings) {
  const ready = [];
  for (const net of POST_NETS) {
    if (!networkOn(settings, net)) continue;
    ready.push(...(await postsList(net).catch(() => []))
      .filter((p) => p.ready && (!['tiktok', 'instagram'].includes(net) || p.video_path)));
  }
  ready.sort((a, b) => (a.due_at || 0) - (b.due_at || 0));
  const post = ready[0];
  if (!post) return false;
  const send = { x: publishXPost, linkedin: publishLinkedinPost, tiktok: publishTikTokPost, instagram: publishInstagramPost }[post.network];
  await send(post.path, { auto: true });
  return true;
}

async function autoPass() {
  await chrome.storage.local.set({ lastAutoTick: Date.now() });
  // « Pause » in the panel: nothing goes out on its own until « Reprendre ».
  if (await isPaused()) { await autoState('paused'); return; }
  const { job } = await chrome.storage.session.get('job');
  if (job && job.running) {
    const { pending } = await chrome.storage.local.get('pending');
    const quiet = Date.now() - (job.updatedAt || job.startedAt || 0);
    if (pending || resuming || quiet < STALE_JOB_MS) { await autoState('busy', { title: job.title || null }); return; }
    const message = 'Publication interrompue (sans nouvelles depuis 30 min) : vérifie sur le réseau si elle est partie.';
    await chrome.storage.session.set({ job: { ...job, running: false, done: false, error: message, message, updatedAt: Date.now() } });
  }
  if (!(await publishAccess()).active) {
    chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
    chrome.action.setBadgeText({ text: '!' });
    await autoState('subscription');
    return;
  }
  const settings = await folderSettings();
  const access = await folder('access').catch(() => ({ state: 'none' }));
  if (access.state === 'prompt') await askAccess().catch(() => {});
  // No folder chosen yet: nothing to reopen, the panel's first step says what to do.
  if (access.state === 'none') { await autoState('nofolder'); return; }
  if (access.state !== 'granted') {
    // Chrome asks again for folder access after some restarts — re-granting
    // an existing handle needs a real click (requestPermission can't be
    // called from background/alarm code), so this can never be fully
    // silent. A quiet red badge was easy to miss for hours; a one-shot
    // desktop notification (not repeated every 5 min while still
    // unauthorized) makes the "one click needed" moment actually noticeable.
    chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
    chrome.action.setBadgeText({ text: '!' });
    const { permissionNotified } = await chrome.storage.session.get('permissionNotified');
    if (!permissionNotified) {
      await chrome.storage.session.set({ permissionNotified: true });
      chrome.notifications.create('kappgen-folder-access', {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'KappGen Publish : accès au dossier à confirmer',
        message: "Clique ici puis « Autoriser » (choisis « Autoriser à chaque visite ») pour que les publications reprennent.",
        priority: 2,
      });
    }
    await autoState('folder');
    return;
  }
  chrome.action.setBadgeText({ text: '' });
  await autoState('ok');
  await chrome.storage.session.remove('permissionNotified');
  if ((await folder('fbAccess').catch(() => ({}))).state === 'prompt') await askAccess().catch(() => {});
  const { videos, sent } = await folderQueue();
  const own = await ownFolders();
  const passAt = Date.now();
  // What is already out somewhere goes on to the other networks first: one
  // publication on all its networks, then the next one.
  if (await spreadNext(settings, sent, own)) { await chainIfDone(passAt); return; }
  // A post whose time has come: it has a time, a new video has not.
  const duePost = networkOn(settings, 'facebook') ? await nextDuePost() : null;
  if (duePost) {
    await chrome.storage.local.set({ lastAutoPostAt: Date.now() });
    await publishFacebookPost(duePost, { auto: true });
    await chainIfDone(passAt); // then the same post on the other networks
    return;
  }
  // Each network's own posts (its folder, or <NETWORK>/A-PUBLIER), at their time.
  if (await ownPostNext(settings)) { await chainIfDone(passAt); return; }
  let next = null;
  for (const candidate of networkOn(settings, 'youtube') ? videos.filter((v) => v.auto_ok) : []) {
    if (await alreadyOnChannel(candidate, ownOf(settings, candidate))) {
      await folder('mark', { path: candidate.relative_path, status: 'ignored', data: { reason: 'déjà sur la chaîne (même titre)' } }).catch(() => {});
      continue;
    }
    next = candidate;
    break;
  }
  if (next) {
    // Per channel: unlisted by default (the creator makes it public himself),
    // or straight to public for news channels where timing matters.
    const visibility = channelVisibility(ownOf(settings, next));
    await publish('folder', next.id, visibility, { auto: true });
    autoTick(); // more may be waiting
    return;
  }
  // Nothing to send: keep the sent videos in line with their sheet and thumbnail.
  let stale = null;
  for (const v of networkOn(settings, 'youtube') ? sent : []) {
    if (!v.youtube_id || !v.has_content || ownOf(settings, v).auto === false) continue;
    if (!v.applied_hash && !v.force_update) {
      // first time this video is watched: what is on YouTube now is the reference
      await folder('mark', { path: v.relative_path, status: 'applied', data: { hash: v.hash } }).catch(() => {});
    } else if (v.applied_hash !== v.hash && v.update_tried_hash !== v.hash) {
      stale = stale || v;
    }
  }
  if (!stale) return;
  await updateVideo(stale.relative_path, true);
  autoTick();
}

// "Chrome connecté" in the app: check in with KappGen every minute.
async function heartbeat() {
  api('/studio-upload/status').catch(() => {});
  selfUpdate().catch(() => {});
  checkNewRelease().catch(() => {});
  dailyReport().catch(() => {}); // tried again next minute if the server did not answer
  // Safety net: the automatic pass must run even if its alarm went missing.
  await ensureAlarms();
  const { lastAutoTick } = await chrome.storage.local.get('lastAutoTick');
  if (!lastAutoTick || Date.now() - lastAutoTick > (AUTO_EVERY_MINUTES + 1) * 60000) autoTick().catch(() => {});
}

// Installed from the zip, the extension cannot replace its own files: when a
// newer version is out on GitHub, tell the creator once (notification + badge).
const RELEASES_URL = 'https://api.github.com/repos/rosby17/kappgen-uploader/releases/latest';
const UPDATE_GUIDE = 'https://rosby17.github.io/kappgen-uploader/#maj';
const newer = (a, b) => {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};
async function checkNewRelease({ maxAge = 6 * 3600 * 1000 } = {}) {
  const { releaseCheck } = await chrome.storage.local.get('releaseCheck');
  const current = chrome.runtime.getManifest().version;
  let latest = releaseCheck && releaseCheck.latest;
  if (!releaseCheck || Date.now() - releaseCheck.at > maxAge) {
    const response = await fetch(RELEASES_URL, { cache: 'no-store' });
    if (!response.ok) return;
    latest = String((await response.json()).tag_name || '').replace(/^v/, '');
    await chrome.storage.local.set({ releaseCheck: { at: Date.now(), latest, notified: releaseCheck && releaseCheck.notified } });
  }
  if (!latest || !newer(latest, current)) return;
  const { releaseCheck: saved } = await chrome.storage.local.get('releaseCheck');
  if (saved.notified === latest) return;
  await chrome.storage.local.set({ releaseCheck: { ...saved, notified: latest } });
  chrome.notifications.create('kappgen-update', {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: `KappGen Publish ${latest} est disponible`,
    message: `Tu as la version ${current}. Clique ici pour voir comment mettre à jour (2 minutes, tes réglages sont gardés).`,
    priority: 1,
  });
}

// chrome.alarms.create replaces an alarm of the same name and restarts its
// countdown. The worker wakes every minute (heartbeat), so recreating 'auto'
// (every 5 min) at each wake meant it never fired: only create what is missing.
async function ensureAlarms() {
  const wanted = { heartbeat: 1, auto: AUTO_EVERY_MINUTES };
  for (const [name, period] of Object.entries(wanted)) {
    const alarm = await chrome.alarms.get(name);
    if (!alarm || alarm.periodInMinutes !== period) await chrome.alarms.create(name, { periodInMinutes: period });
  }
}

// Unpacked install, several Chrome profiles: each profile keeps running the
// code it loaded until someone clicks ↻. When the files on disk carry a newer
// version, reload by ourselves (never in the middle of an upload).
async function selfUpdate() {
  // Never in the middle of a publication; but one with no news for 30 min is
  // dead (it would otherwise block every update forever), and an upload being
  // followed is picked up again after the reload (resume()).
  const { job } = await chrome.storage.session.get('job');
  const quiet = job && job.running ? Date.now() - (job.updatedAt || job.startedAt || 0) : Infinity;
  if (quiet < STALE_JOB_MS) return;
  const { pending } = await chrome.storage.local.get('pending');
  if (pending && resuming) return;
  const disk = await (await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' })).json();
  if (disk.version && disk.version !== chrome.runtime.getManifest().version) chrome.runtime.reload();
}
// YouTube → Facebook switch: on by default, for videos published from now on
// (never the whole older catalogue at once).
(async () => {
  const settings = await folderSettings().catch(() => null);
  if (settings && !settings.facebookFromYoutubeSince) {
    settings.facebookFromYoutubeSince = Date.now();
    await chrome.storage.local.set({ folder: settings });
  }
})();
ensureAlarms().catch(() => {});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'heartbeat') heartbeat();
  if (alarm.name === 'auto' || alarm.name === 'due') autoTick().catch(() => {});
});
// Clicking the icon opens the side panel: everything happens there.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
// Clicking the "re-authorize" notification should land the creator straight
// on the panel instead of just dismissing a toast — same one-click re-grant
// as clicking the extension icon itself.
chrome.notifications.onClicked.addListener(async (id) => {
  if (id === 'kappgen-update') { chrome.tabs.create({ url: UPDATE_GUIDE }); return; }
  if (id !== 'kappgen-folder-access') return;
  await askAccess({ force: true }).catch(() => {});
});
// Copies of KappGen Publish with another id (the ones installed before 1.16.14
// fixed the id): switched off at once, so a post never goes out twice. Chrome
// does not let an extension remove another one without its own confirmation
// window, so they stay listed (switched off) in chrome://extensions.
const isOldCopy = (e) => e.id !== chrome.runtime.id && e.type === 'extension'
  && /^KappGen (Publish|Uploader)/i.test(e.name || '') && !/libre/i.test(e.name || '');
async function oldCopies() {
  const all = await chrome.management.getAll().catch(() => []);
  return all.filter(isOldCopy);
}
async function disableOldCopies() {
  for (const e of await oldCopies()) if (e.enabled) await chrome.management.setEnabled(e.id, false).catch(() => {});
}
chrome.runtime.onStartup.addListener(() => { heartbeat(); resume(); disableOldCopies(); });
chrome.runtime.onInstalled.addListener(() => { heartbeat(); resume(); closeOldKeeper(); disableOldCopies(); });
disableOldCopies();
resume(); // service worker restarted while an upload was being followed

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target === 'offscreen') return false;
  const handlers = {
    account: () => api('/auth/session').catch((error) => { if (error.status === 401) return null; throw error; }),
    login: () => api('/auth/login', { method: 'POST', body: JSON.stringify({ email: message.email, password: message.password }) }),
    logout: async () => { await chrome.storage.local.remove(['publishAccess', 'pendingOrder']); return api('/auth/logout', { method: 'POST' }); },
    status: () => api('/studio-upload/status'),
    queue: () => api('/studio-upload/queue'),
    folderQueue: () => folderQueue(),
    folderMark: () => folder('mark', { path: message.path, status: message.status }),
    channelVideos: () => channelVideos(message.channelId),
    facebookPosts: () => postsList(),
    findGroups: async () => ({ groups: await findMyGroups() }),
    referrals: () => api('/referrals/me'),
    claimReferral: () => api('/referrals/claim', { method: 'POST', body: JSON.stringify({ code: message.code }) }),
    // The groups where an already published post failed (or new ones).
    shareGroups: async () => {
      await requireAccess();
      const { job } = await chrome.storage.session.get('job');
      if (job && job.running) throw new Error('Une publication est déjà en cours.');
      const post = (await postsList()).find((p) => p.path === message.path);
      if (!post) throw new Error('Post introuvable (déplacé ?).');
      for (const [url, state] of Object.entries(post.groups_shared || {})) if (state.statut === 'echec') delete post.groups_shared[url];
      await chrome.storage.session.set({ job: { running: true, source: 'facebook', kind: 'groups', path: post.path,
        title: post.text.split('\n')[0].slice(0, 80) || 'Post Facebook', message: 'Partage dans les groupes Facebook…', startedAt: Date.now() } });
      shareInGroups(post).then(
        (r) => setJob({ running: false, done: true, error: r.bad ? `${r.bad} groupe(s) en échec.` : null, message: `Partagé dans ${r.ok} groupe(s) sur ${r.total}.` }),
        (e) => setJob({ running: false, done: false, error: friendly(e), message: friendly(e) }));
      return { started: true };
    },
    postNow: async () => {
      await requireAccess();
      const { job } = await chrome.storage.session.get('job');
      if (job && job.running) throw new Error('Un envoi est déjà en cours.');
      const post = (await postsList()).find((p) => p.path === message.path);
      if (!post) throw new Error('Post introuvable (déplacé ?).');
      if (!await postPage(post)) throw new Error('Ajoute d’abord le lien de ta page Facebook (en haut de l’onglet Facebook).');
      publishFacebookPost(post).catch(() => {}); // runs on; the panel follows chrome.storage
      return { started: true };
    },
    autoNow: async () => { autoTick().catch(() => {}); return {}; },
    access: () => publishAccess({ fresh: !!message.fresh }),
    startTrial: async () => {
      await api('/publish/trial', { method: 'POST' });
      const state = await publishAccess({ fresh: true });
      autoTick().catch(() => {});
      return state;
    },
    // Opens the payment page; the order is checked when the creator comes back.
    subscribe: async () => {
      const data = await api('/publish/checkout', { method: 'POST', body: JSON.stringify({ provider: message.provider, offer: message.offer || 'monthly' }) });
      await chrome.storage.local.set({ pendingOrder: data.order_id });
      await chrome.tabs.create({ url: data.redirect_url, active: true });
      return data;
    },
    checkPayment: async () => {
      const { pendingOrder } = await chrome.storage.local.get('pendingOrder');
      if (pendingOrder) {
        const result = await api(`/billing/verify?order_id=${encodeURIComponent(pendingOrder)}`).catch(() => ({ status: 'pending' }));
        if (result.status === 'success') await chrome.storage.local.remove('pendingOrder');
      }
      const state = await publishAccess({ fresh: true });
      if (state.active) autoTick().catch(() => {});
      return state;
    },
    publish: async () => {
      await requireAccess();
      const { job } = await chrome.storage.session.get('job');
      if (job && job.running) throw new Error('Un envoi est déjà en cours.');
      // runs on; the popup follows chrome.storage
      publish(message.source || 'app', message.videoId, message.visibility);
      return { started: true };
    },
    update: async () => {
      await requireAccess();
      const { job } = await chrome.storage.session.get('job');
      if (job && job.running) throw new Error('Un envoi est déjà en cours.');
      updateVideo(message.path);
      return { started: true };
    },
    facebook: async () => {
      await requireAccess();
      const { job } = await chrome.storage.session.get('job');
      if (job && job.running) throw new Error('Une publication est déjà en cours.');
      const { sent } = await folderQueue();
      const video = sent.find((item) => item.relative_path === message.path);
      if (video && !ownOf(await folderSettings(), video).facebookPageUrl) {
        throw new Error('Ajoute d’abord le lien de ta page Facebook (en haut de l’onglet Facebook).');
      }
      publishFacebookOnly(message.path, { as: message.as === 'reel' || message.as === 'video' ? message.as : null });
      return { started: true };
    },
    x: async () => {
      await requireAccess();
      const { job } = await chrome.storage.session.get('job');
      if (job && job.running) throw new Error('Une publication est déjà en cours.');
      publishXVideo(message.path).catch(() => {});
      return { started: true };
    },
    xPost: async () => {
      await requireAccess();
      const { job } = await chrome.storage.session.get('job');
      if (job && job.running) throw new Error('Une publication est déjà en cours.');
      publishXPost(message.path).catch(() => {});
      return { started: true };
    },
    linkedin: async () => {
      await requireAccess();
      const { job } = await chrome.storage.session.get('job');
      if (job && job.running) throw new Error('Une publication est déjà en cours.');
      publishLinkedinVideo(message.path).catch(() => {});
      return { started: true };
    },
    linkedinPost: async () => {
      await requireAccess();
      const { job } = await chrome.storage.session.get('job');
      if (job && job.running) throw new Error('Une publication est déjà en cours.');
      publishLinkedinPost(message.path).catch(() => {});
      return { started: true };
    },
    networkPosts: async () => postsList(message.net),
    folders: async () => folder('folders'),
    tiktok: async () => {
      await requireAccess();
      const { job } = await chrome.storage.session.get('job');
      if (job && job.running) throw new Error('Une publication est déjà en cours.');
      publishTikTokVideo(message.path, { long: !!message.long }).catch(() => {});
      return { started: true };
    },
    shortYoutube: async () => {
      await requireAccess();
      const { job } = await chrome.storage.session.get('job');
      if (job && job.running) throw new Error('Un envoi est déjà en cours.');
      publishShortOnly(message.path).catch(() => {});
      return { started: true };
    },
    instagram: async () => {
      await requireAccess();
      const { job } = await chrome.storage.session.get('job');
      if (job && job.running) throw new Error('Une publication est déjà en cours.');
      publishInstagramVideo(message.path).catch(() => {});
      return { started: true };
    },
    instagramPost: async () => {
      await requireAccess();
      const { job } = await chrome.storage.session.get('job');
      if (job && job.running) throw new Error('Une publication est déjà en cours.');
      publishInstagramPost(message.path).catch(() => {});
      return { started: true };
    },
    instagramAuto: async () => {
      const settings = await folderSettings();
      settings.instagramAuto = !!message.on;
      if (message.on && !settings.instagramSince) settings.instagramSince = new Date().toISOString();
      await chrome.storage.local.set({ folder: settings });
      return { on: settings.instagramAuto };
    },
    tiktokPost: async () => {
      await requireAccess();
      const { job } = await chrome.storage.session.get('job');
      if (job && job.running) throw new Error('Une publication est déjà en cours.');
      publishTikTokPost(message.path).catch(() => {});
      return { started: true };
    },
    // The video is on YouTube but its link was not recorded: record it, then
    // the sheet and thumbnail of the folder are applied to it.
    linkYoutube: async () => {
      const id = String(message.url || '').match(/(?:youtu\.be\/|[?&]v=|\/video\/|\/shorts\/|\/live\/)([A-Za-z0-9_-]{11})/) || String(message.url || '').match(/^([A-Za-z0-9_-]{11})$/);
      if (!id) throw new Error('Lien YouTube non reconnu : colle le lien de la vidéo (youtu.be/… ou studio.youtube.com/video/…).');
      await folder('mark', { path: message.path, status: 'published', data: { youtubeId: id[1], forceUpdate: true } });
      autoTick().catch(() => {});
      return { youtubeId: id[1] };
    },
    // Send the video again, with the sheet and thumbnail of the folder.
    republish: async () => {
      await requireAccess();
      const { job } = await chrome.storage.session.get('job');
      if (job && job.running) throw new Error('Un envoi est déjà en cours.');
      await folder('mark', { path: message.path, status: 'reset' });
      publish('folder', message.path, 'CHANNEL');
      return { started: true };
    },
    // A job that never finished (tab closed, Facebook stuck) must not block everything.
    // « Annuler »: the work tab is stopped (reloaded if it is the creator's own,
    // closed otherwise), so the running step ends at once; the publication is
    // marked « Publication annulée. » and never sent again on its own.
    cancelJob: async () => {
      cancelRequested = true;
      if (workTabId) {
        if ((await borrowedTabs()).has(workTabId)) await chrome.tabs.reload(workTabId).catch(() => {});
        else await chrome.tabs.remove(workTabId).catch(() => {});
      }
      await chrome.storage.local.remove('pending');
      // Safety net: a step that does not end by itself is closed after 15 s.
      setTimeout(async () => {
        const { job } = await chrome.storage.session.get('job');
        if (job && job.running) await setJob({ running: false, done: false, error: 'Publication annulée.', message: 'Publication annulée.' });
        cancelRequested = false;
      }, 15000);
      return {};
    },
    unblockJob: async () => {
      await chrome.storage.session.set({ job: { running: false, done: false, error: 'Envoi arrêté à la main. Vérifie sur YouTube / Facebook s’il est parti avant de relancer.', message: 'Envoi arrêté à la main. Vérifie sur YouTube / Facebook s’il est parti avant de relancer.' } });
      return {};
    },
    // Panel opened: look for a newer version (at most once every 15 min).
    checkRelease: async () => { await checkNewRelease({ maxAge: 15 * 60 * 1000 }); return {}; },
    clearJob: async () => {
      const { job } = await chrome.storage.session.get('job');
      if (!job || !job.running) await chrome.storage.session.remove('job');
      return {};
    },
  };
  const handler = handlers[message.type];
  if (!handler) return false;
  handler().then((data) => sendResponse({ ok: true, data }), (error) => sendResponse({ ok: false, error: String(error.message || error) }));
  return true;
});
