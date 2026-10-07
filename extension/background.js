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

importScripts('lib/schedule.js');
importScripts('lib/rythme.js');
importScripts('lib/facebook-flow.js');

// The user's KappGen account (session cookie of kappgen.com). The local
// Docker version is chosen in the panel's Help tab (http://localhost:8080).
const DEFAULT_APP_URL = 'https://app.kappgen.com';   // KappGen 2.0 : compte, abonnement et recette sont sur le même site (api.kappgen.com est abandonné)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeAppUrl(value) {
  let url;
  try { url = new URL(String(value || DEFAULT_APP_URL)); } catch { throw new Error('Adresse du serveur KappGen invalide.'); }
  const local = ['localhost', '127.0.0.1'].includes(url.hostname) && url.protocol === 'http:';
  const official = ['api.kappgen.com', 'app.kappgen.com'].includes(url.hostname) && url.protocol === 'https:';
  if ((!local && !official) || url.username || url.password || (official && url.port && url.port !== '443')) {
    throw new Error('Serveur refusé : utilise KappGen en HTTPS, ou localhost pour le développement.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function safeRedirectUrl(value) {
  let url;
  try { url = new URL(String(value || '')); } catch { throw new Error('Adresse de paiement invalide.'); }
  const local = ['localhost', '127.0.0.1'].includes(url.hostname) && url.protocol === 'http:';
  if ((url.protocol !== 'https:' && !local) || url.username || url.password) throw new Error('Adresse de paiement refusée.');
  return url.toString();
}

async function appUrl() {
  const { appUrl: saved } = await chrome.storage.local.get('appUrl');
  // Les profils déjà configurés sur l'ancienne API passent d'office sur le nouveau site.
  if (saved && /^https:\/\/api\.kappgen\.com\/?$/.test(saved)) return normalizeAppUrl(DEFAULT_APP_URL);
  return normalizeAppUrl(saved || DEFAULT_APP_URL);
}

async function isLocalApp() {
  const host = new URL(await appUrl()).hostname;
  return host === 'localhost' || host === '127.0.0.1';
}

async function api(path, options = {}) {
  const base = await appUrl();
  let response;
  let data;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    response = await fetch(`${base}/api${path}`, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      ...options,
      signal: options.signal || controller.signal,
    });
    data = await response.json().catch(() => ({}));
  } catch (error) {
    const timeoutMessage = error && error.name === 'AbortError' ? ' (délai de 20 secondes dépassé)' : '';
    throw new Error(`KappGen est injoignable${timeoutMessage}. Vérifie ta connexion Internet.`);
  } finally {
    clearTimeout(timeout);
  }
  if (response.status === 401 && path !== '/auth/login') throw Object.assign(new Error('Connecte-toi à ton compte KappGen.'), { status: 401 });
  if (response.status === 404) throw Object.assign(new Error('Fonction indisponible sur ce serveur KappGen.'), { status: 404 });
  if (!response.ok) {
    const message = typeof data.detail === 'string' ? data.detail : `Erreur KappGen (${response.status}).`;
    throw Object.assign(new Error(message), { status: response.status });
  }
  return data;
}

async function setJob(patch) {
  if (patch.running === false) workTabId = null;
  const { job } = await chrome.storage.session.get('job');
  // A publication ends: whatever tab it left open (error, timeout) is closed shortly after. A new one starts: tabs left by earlier ones too.
  if (patch.running === false && job && job.running) setTimeout(() => sweepOwnTabs({ minAge: 15000 }).catch(() => {}), 20000);
  if (patch.running === true && !(job && job.running)) sweepOwnTabs({ minAge: 60000 }).catch(() => {});
  const next = { ...(job || {}), ...patch, updatedAt: Date.now() };
  await chrome.storage.session.set({ job: next });
  // Every publication that ends (sent or failed) goes into the day's log,
  // told in one e-mail in the evening (no message for each one).
  if (job && job.running && patch.running === false && REPORTED_KINDS.has(job.kind)) await logDay(next).catch(() => {});
}

// ------------------------------------------------------- evening summary

// The day's publications, on this computer's clock; sent once in the evening
// (21:00) to creators who ticked « Bilan du soir par mail » (off by default).
const REPORTED_KINDS = new Set(['youtube', 'short', 'post', 'facebook', 'tiktok', 'instagram', 'snapchat', 'x', 'linkedin']);
const REPORT_HOUR = 21;
const pad2 = (n) => String(n).padStart(2, '0');
const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const hourMinute = (t) => { const d = new Date(t); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };

async function logDay(job) {
  const now = Date.now();
  const { dayLog } = await chrome.storage.local.get('dayLog');
  const oldest = dayKey(now - 8 * 86400000);
  const entry = { day: dayKey(now), time: hourMinute(now), kind: job.kind, title: String(job.title || '').slice(0, 300),
    ok: !job.error && !job.warning,
    error: job.error || job.warning ? String(job.error || job.warning).slice(0, 300) : null, url: job.youtubeUrl || null };
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
  const safeCached = cached ? { ...cached, active: cached.active === true } : null;
  if (!fresh && safeCached && Date.now() - safeCached.checkedAt < ACCESS_TTL) return safeCached;
  try {
    const data = await api('/publish/access');
    const state = { ...data, active: data && data.active === true, checkedAt: Date.now() };
    await chrome.storage.local.set({ publishAccess: state });
    return state;
  } catch (error) {
    if (error.status === 401) {
      await chrome.storage.local.remove('publishAccess');
      return { active: false, signedOut: true, checkedAt: Date.now() };
    }
    if (error.status === 404) return { active: false, unavailable: true, checkedAt: Date.now() };
    // Network trouble: the last answer, if recent and still running.
    if (safeCached && Date.now() - safeCached.checkedAt < 24 * 3600 * 1000
      && (!safeCached.expires_at || Date.parse(safeCached.expires_at) > Date.now())) return safeCached;
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
// reads them inside the page). Refreshed every 30 min and kept locally for a
// short, validated offline fallback when the MV3 worker restarts.
const RECIPE_TTL = 30 * 60 * 1000;
const RECIPE_OFFLINE_TTL = 7 * 24 * 3600 * 1000;
let recipeCache = null;

const RECIPE_LABELS = ['version', 'mark'];

function validateRecipe(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Recette de publication invalide.');
  let encoded;
  try { encoded = JSON.stringify(data); } catch { throw new Error('Recette de publication illisible.'); }
  if (encoded.length > 250000) throw new Error('Recette de publication trop volumineuse.');
  let count = 0;
  const visit = (value, depth = 0) => {
    count += 1;
    if (depth > 10 || count > 6000) throw new Error('Recette de publication trop complexe.');
    if (value == null || typeof value === 'boolean' || typeof value === 'number') return;
    if (typeof value === 'string') {
      if (value.length > 20000) throw new Error('Recette de publication invalide.');
      return;
    }
    if (Array.isArray(value)) { value.forEach((item) => visit(item, depth + 1)); return; }
    if (typeof value !== 'object') throw new Error('Recette de publication invalide.');
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Recette de publication non sûre.');
      visit(item, depth + 1);
    }
  };
  visit(data);
  for (const [network, config] of Object.entries(data)) {
    // Étiquettes du serveur (version de la recette, marque du compte) : de simples textes courts, pas des réglages.
    if (RECIPE_LABELS.includes(network) && (typeof config === 'string' || typeof config === 'number') && String(config).length <= 100) continue;
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`Recette invalide (${network}).`);
    for (const selector of Object.values(config.sel || {})) {
      if (typeof selector !== 'string' || selector.length > 2000) throw new Error(`Sélecteur invalide (${network}).`);
    }
    for (const raw of Object.values(config.re || {})) {
      const parts = typeof raw === 'string' && /^\/([\s\S]*)\/([dimsuv]*)$/.exec(raw);
      if (!parts) throw new Error(`Expression régulière invalide (${network}).`);
      try { new RegExp(parts[1], parts[2]); } catch { throw new Error(`Expression régulière invalide (${network}).`); }
    }
  }
  return data;
}

async function publishRecipe({ fresh = false } = {}) {
  if (!fresh && recipeCache && Date.now() - recipeCache.at < RECIPE_TTL) return recipeCache.data;
  await requireAccess();
  let data;
  try {
    const received = await api('/publish/recipe');
    try {
      data = validateRecipe(received);
    } catch (invalid) {
      // Le serveur a répondu : ce n'est pas un problème de connexion, on dit le vrai motif.
      throw Object.assign(new Error(`KappGen a envoyé une recette de publication que cette version de l'extension refuse (${invalid.message}). Mets à jour KappGen Publish.`), { invalidRecipe: true });
    }
  } catch (error) {
    if (error.invalidRecipe) throw error;
    if (error.status === 401) throw new Error('Connecte-toi à ton compte KappGen.');
    if (error.status === 402) throw new Error('Ton abonnement KappGen Publish n’est pas actif : ouvre le panneau pour t’abonner.');
    if (error.status === 404) throw new Error('Le serveur KappGen n’est pas encore à jour pour cette version de KappGen Publish.');
    const { publishRecipeCache: stored } = await chrome.storage.local.get('publishRecipeCache');
    const fallback = recipeCache || stored;
    if (fallback && Date.now() - fallback.at < RECIPE_OFFLINE_TTL) {
      recipeCache = { data: validateRecipe(fallback.data), at: fallback.at };
      return recipeCache.data;
    }
    throw new Error('Impossible de joindre KappGen pour préparer la publication (connexion Internet ?).');
  }
  recipeCache = { data, at: Date.now() };
  await chrome.storage.local.set({ publishRecipeCache: recipeCache });
  return data;
}

// Puts the recipe in the page, then the network's scripts.
// Injects extension files into a tab. While an update is being written to the extension's folder (the files are swapped in place), a file
// can be missing for a moment: « Could not load file ». It comes back within seconds, so the injection is tried again instead of failing the post.
async function injectFiles(tabId, files) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files });
      return;
    } catch (error) {
      if (attempt >= 5 || !/Could not load file|Cannot access contents of the extension|file.*not.*found/i.test(String(error && error.message))) throw error;
      await sleep(1500 * attempt);
    }
  }
}

async function injectScripts(tabId, files) {
  // Facebook is autonomous, but publishing still requires a valid account.
  if (files.length === 1 && files[0] === 'facebook.js') {
    await requireAccess();
    await injectFiles(tabId, ['lib/facebook-flow.js', ...files]);
    return;
  }
  const recipe = await publishRecipe();
  await chrome.scripting.executeScript({ target: { tabId }, func: (data) => { window.__kappgenRecipe = data; }, args: [recipe] });
  await injectFiles(tabId, ['lib/recette.js', ...files]);
}

async function recipeSelector(network, key) {
  const recipe = await publishRecipe();
  const selector = recipe && recipe[network] && recipe[network].sel && recipe[network].sel[key];
  if (!selector) throw new Error(`KappGen Publish : recette de publication incomplète (${network}.${key}).`);
  return selector;
}

// ------------------------------------------------------------ folder source

const AUTO_EVERY_MINUTES = 5;

let creatingOffscreen = null;
async function offscreenExists() {
  if (typeof chrome.offscreen.hasDocument === 'function') return chrome.offscreen.hasDocument();
  if (typeof chrome.runtime.getContexts === 'function') {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL('offscreen.html')] });
    return contexts.length > 0;
  }
  return self.clients ? (await self.clients.matchAll()).some((client) => client.url === chrome.runtime.getURL('offscreen.html')) : false;
}

async function ensureOffscreen() {
  if (await offscreenExists()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Lire le dossier de vidéos choisi par l’utilisateur.',
    }).catch((error) => {
      if (!/single offscreen/i.test(String(error && error.message))) throw error;
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
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

// A page never receives a disk path. It gets a short-lived, one-use grant
// bound to its own tab; bridge.html exchanges that token for the path.
const BRIDGE_GRANT_MS = 2 * 60 * 1000;
const bridgeGrantKey = (token) => `bridgeGrant:${token}`;
async function bridgeSource(tabId, path) {
  if (!Number.isInteger(tabId) || !path) throw new Error('Destination de fichier invalide.');
  const stored = await chrome.storage.session.get(null);
  const expired = Object.entries(stored).filter(([key, value]) => key.startsWith('bridgeGrant:')
    && (!value || !Number.isFinite(value.expiresAt) || value.expiresAt < Date.now())).map(([key]) => key);
  if (expired.length) await chrome.storage.session.remove(expired);
  const token = crypto.randomUUID();
  const key = bridgeGrantKey(token);
  await chrome.storage.session.set({ [key]: { tabId, path, expiresAt: Date.now() + BRIDGE_GRANT_MS } });
  return chrome.runtime.getURL(`bridge.html?token=${encodeURIComponent(token)}`);
}

async function consumeBridgeGrant(token, sender) {
  if (!/^[0-9a-f-]{36}$/i.test(String(token || ''))) throw new Error('Autorisation de fichier invalide.');
  const key = bridgeGrantKey(token);
  const stored = await chrome.storage.session.get(key);
  const grant = stored[key];
  await chrome.storage.session.remove(key);
  let bridgePage = false;
  try { bridgePage = new URL(sender.url || '').pathname === '/bridge.html'; } catch { /* invalid sender URL */ }
  if (!grant || grant.expiresAt < Date.now()) throw new Error('Autorisation de fichier expirée. Relance la publication.');
  if (sender.id !== chrome.runtime.id || !bridgePage || !sender.tab || sender.tab.id !== grant.tabId) {
    throw new Error('Autorisation de fichier refusée.');
  }
  return { path: grant.path };
}

// Facebook posts: each one at the time written in it (or right away).
// net: a network's own posts (its folder, or its <NETWORK>/A-PUBLIER folders).
async function postsList(net = 'facebook') {
  return folder('posts', { net });
}
const POST_NETS = ['instagram', 'tiktok', 'snapchat', 'x', 'linkedin'];
// A post by its path, whichever list it is in.
async function findPost(postPath) {
  for (const net of ['facebook', ...POST_NETS]) {
    const post = (await postsList(net).catch(() => [])).find((p) => p.path === postPath);
    if (post) return post;
  }
  return null;
}
function requireValidPost(post) {
  if (!post) throw new Error('Post introuvable (déplacé ?).');
  if (post.configuration_error) throw new Error(`${post.configuration_error} Corrige publication.json avant de publier.`);
  if (!post.text && !post.image_path && !post.video_path) throw new Error('Ce post ne contient aucun texte, aucune image et aucune vidéo à publier.');
  return post;
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
  ensureNotCancelled();
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

// sendPost / publish: when Facebook reloads right after « Publier », reinject
// the page helper and demand actual confirmation.  A click timestamp alone is
// never proof: Facebook can close the composer after saving a draft.
async function postStep(tabId, name, args) {
  try { await chrome.scripting.executeScript({ target: { tabId }, func: () => sessionStorage.removeItem('kappgenPublishAttempt') }); } catch { /* checked below */ }
  try {
    return await step(tabId, name, args, 'facebook.js');
  } catch (error) {
    if (!/impossible\.$/.test(String(error.message))) throw error;
    await sleep(4000);
    const [{ result } = {}] = await chrome.scripting.executeScript({ target: { tabId },
      func: () => { try { return JSON.parse(sessionStorage.getItem('kappgenPublishAttempt') || 'null'); } catch { return null; } } }).catch(() => [{}]);
    if (result && result.at && Date.now() - result.at < 30 * 60000) {
      await injectScripts(tabId, ['facebook.js']);
      return step(tabId, 'verifyPublication', { expectedText: args && args.expectedText, timeout: 120000 }, 'facebook.js');
    }
    throw error;
  }
}

async function step(tabId, name, args, recoveryScript = 'studio.js') {
  ensureNotCancelled();
  // Studio and Facebook sometimes reload the page under their helper script:
  // window.__kappgen is then gone. Reinject the helper for the current site
  // and retry once instead of accidentally loading the Studio helper on Facebook.
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
    await injectScripts(tabId, [recoveryScript]);
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

// Tabs the extension opened itself (never the creator's own): each one must be closed once its publication ends, even after an
// error, otherwise automatic publications pile up dozens of Facebook / X / Instagram tabs. The registry survives a sleeping worker.
const OWN_TABS_KEY = 'ownTabs';
async function ownTabs() {
  const { ownTabs: own } = await chrome.storage.session.get(OWN_TABS_KEY);
  return own || {};
}
async function setOwnTab(tabId, on) {
  const own = await ownTabs();
  if (on) own[tabId] = Date.now(); else delete own[tabId];
  await chrome.storage.session.set({ [OWN_TABS_KEY]: own });
}
async function createWorkTab(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  await setOwnTab(tab.id, true);
  return tab;
}
// Closes the tabs opened by the extension that nothing uses any more (older than minAge, not the one a publication is working in).
async function sweepOwnTabs({ minAge = 60000 } = {}) {
  const [own, borrowed] = [await ownTabs(), await borrowedTabs()];
  for (const [id, since] of Object.entries(own)) {
    const tabId = Number(id);
    if (tabId === workTabId || borrowed.has(tabId) || Date.now() - since < minAge) continue;
    await chrome.tabs.remove(tabId).catch(() => {});
    await setOwnTab(tabId, false);
  }
}

// Closes a Studio tab the extension opened by itself (automatic uploads),
// leaves the creator's own tab open.
async function closeStudioTab(tabId) {
  if (workTabId === tabId) workTabId = null;
  if ((await borrowedTabs()).has(tabId)) return;
  await chrome.tabs.remove(tabId).catch(() => {});
  await setOwnTab(tabId, false).catch(() => {});
}

// An already open tab of the site is used (the one in front first, then one
// of the current window, then any window); a new tab only when there is none.
async function tabToReuse(pattern, patterns) {
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  if (active && pattern.test(active.url || '')) return active;
  const here = await chrome.tabs.query({ url: patterns, lastFocusedWindow: true }).catch(() => []);
  if (here[0]) return here[0];
  const anywhere = await chrome.tabs.query({ url: patterns });
  return anywhere[0] || null;
}
const tiktokTabToReuse = () => tabToReuse(/^https:\/\/www\.tiktok\.com\//, ['https://www.tiktok.com/*']);
const instagramTabToReuse = () => tabToReuse(/^https:\/\/www\.instagram\.com\//, ['https://www.instagram.com/*']);
const snapchatTabToReuse = () => tabToReuse(/^https:\/\/(profile|my)\.snapchat\.com\//, ['https://profile.snapchat.com/*', 'https://my.snapchat.com/*']);
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
    tab = await createWorkTab(url);
  }
  workTabId = tab.id;
  await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  return tab;
}

// reuse: upload in the creator's own Studio tab (clicks); otherwise a tab of
// its own in the background (automatic uploads, so the tab the creator is
// working in is never taken over).
async function openStudioUpload(channelId, active = true, { reuse = false } = {}) {
  const url = channelId ? `https://studio.youtube.com/channel/${channelId}/videos/upload?d=ud` : 'https://www.youtube.com/upload';
  const tab = reuse ? await reuseOrOpen(studioTabToReuse, url)
    : await createWorkTab(url);
  workTabId = tab.id;
  await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  if (reuse || active) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  const start = Date.now();
  while (Date.now() - start < 90000) {
    ensureNotCancelled();
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
  if (!chrome.debugger) throw new Error('Chrome ne permet pas de remettre ce fichier à YouTube Studio.');
  if (!(await isLocalApp())) throw new Error('L’envoi par chemin local est réservé à l’application KappGen exécutée sur cet ordinateur.');
  if (typeof path !== 'string' || path.length > 4096 || /[\0\r\n]/.test(path)
    || !(/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path))) {
    throw new Error('Chemin de fichier local invalide.');
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
function ensureNotCancelled() {
  if (cancelRequested) throw new Error('Publication annulée.');
}
async function publicationSleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    ensureNotCancelled();
    await sleep(Math.min(500, end - Date.now()));
  }
  ensureNotCancelled();
}
chrome.tabs.onRemoved.addListener((tabId) => {
  setBorrowed(tabId, false).catch(() => {});
  setOwnTab(tabId, false).catch(() => {});
  if (workTabId === tabId) workTabId = null;
});
async function whileShown(tabId, fn) {
  workTabId = tabId;
  ensureNotCancelled();
  const tab = await chrome.tabs.get(tabId);
  const [previous] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  await chrome.tabs.update(tabId, { active: true });
  try {
    ensureNotCancelled();
    return await fn();
  } finally {
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
const DEFAULT_ON = new Set(['youtube', 'facebook', 'tiktok', 'instagram', 'snapchat']);
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
  return KappSchedule.parseTimes(text);
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
const FACEBOOK_HOST = /^https:\/\/(?:www\.|web\.|m\.|mobile\.|business\.)?facebook\.com(?=\/|$)/i;
const facebookWww = (url) => String(url || '').replace(FACEBOOK_HOST, 'https://www.facebook.com');
async function openFacebookReel(pageUrl, { reuse = true } = {}) {
  if (!FACEBOOK_HOST.test(String(pageUrl || ''))) throw new Error('Lien de page ou de groupe Facebook invalide. Utilise une adresse https://www.facebook.com/…');
  const safePage = facebookWww(pageUrl);
  const tab = reuse
    ? await reuseOrOpen(facebookTabToReuse, safePage, { sameIfStartsWith: safePage.replace(/\/+$/, ''), normalize: facebookWww })
    : await createWorkTab(safePage);
  workTabId = tab.id;
  await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  const start = Date.now();
  while (Date.now() - start < 90000) {
    ensureNotCancelled();
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

// Reel or normal video for this file: a video longer than Facebook's Reel
// limit always goes as a normal video. Its duration is read in the folder;
// unreadable, the Reel stays (unless the file is far too heavy for one).
async function facebookFormatOf(filePath) {
  const info = await folder('videoInfo', { path: filePath }).catch(() => null);
  return KappFacebookFlow.videoFormat('reel', info || {});
}

// filePath: the file to post (the long video, or its vertical version).
async function publishFacebookReel(video, channelName, pageUrl, filePath = video && video.vertical_path, { groups = [], groupCount = 0, reuse = true } = {}) {
  if (!filePath) throw new Error('Aucun fichier vertical associé à cette vidéo.');
  // The long video is a normal video post ("Photo/vidéo"); so is any file
  // too long for a Reel. Only a short (vertical) video is a Reel.
  const format = filePath === video.relative_path ? { format: 'video', reason: null } : await facebookFormatOf(filePath);
  const tabId = await openFacebookReel(pageUrl, { reuse });
  let complete = false;
  try {
    if (format.format === 'video') {
      let result = true;
      await whileShown(tabId, async () => {
        await step(tabId, 'openPost', { photo: true }, 'facebook.js');
        await setJob({ message: format.reason ? `Facebook : ${format.reason}. Envoi de la vidéo…` : 'Envoi de la vidéo sur Facebook…' });
        await step(tabId, 'receiveFile', { kind: 'video', path: filePath,
          src: await bridgeSource(tabId, filePath) }, 'facebook.js');
        await sleep(3000);
        // A YouTube video: its title only; a post of the Facebook folder: its text.
        const caption = video.title ? video.title.slice(0, 500) : (video.description || '').slice(0, 5000);
        await step(tabId, 'fillCaption', { caption }, 'facebook.js');
        await setJob({ message: 'Envoi de la vidéo à Facebook, puis publication (peut prendre plusieurs minutes)…' });
        // expectedText: what was actually written, so the page script can
        // recognise the new post in the feed and confirm the publication.
        // The wait for the upload itself depends on the file's size (facebook.js).
        result = await postStep(tabId, 'sendPost', { timeout: 15 * 60000, expectedText: caption, groups, groupCount });
      });
      complete = true;
      return result || true;
    }
    let picked = { groups: [], extra: [] };
    await whileShown(tabId, async () => {
      await step(tabId, 'openReel', {}, 'facebook.js');
      await step(tabId, 'receiveFile', {
        src: await bridgeSource(tabId, filePath),
        path: filePath,
      }, 'facebook.js');
      await setJob({ message: `Préparation de la publication Facebook (${channelName || 'page sélectionnée'})…` });
      // A YouTube video: its title only; a Reel post of the Facebook folder: its text.
      const caption = (video.title || video.description || '').slice(0, 5000);
      await step(tabId, 'fillCaption', { caption }, 'facebook.js');
      picked = await postStep(tabId, 'publish', { groups, groupCount, expectedText: caption });
    });
    complete = true;
    return picked;
  } finally {
    await step(tabId, 'cleanup', {}, 'facebook.js').catch(() => {});
    if (complete) await closeStudioTab(tabId);
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
        src: await bridgeSource(tabId, video.vertical_path),
        path: video.vertical_path,
      });
      await step(tabId, 'fillDetails', { title: `${video.title} — Short`, description: video.description });
      if (video.tags && video.tags.length) await step(tabId, 'fillTags', { tags: video.tags }).catch(() => {});
      await step(tabId, 'chooseVisibility', { visibility: shortVisibility, monetization });
    });
    return await finishUpload(job);
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
  let video = null;
  let attempted = false;
  try {
    const { sent } = await folderQueue();
    video = sent.find((item) => item.relative_path === relativePath);
    if (!video || !video.youtube_id) throw new Error('La vidéo longue doit d’abord être publiée sur YouTube.');
    if (!video.vertical_path) throw new Error('Aucune version verticale (short.mp4) dans le dossier de la vidéo.');
    if (video.short_youtube_id) throw new Error('Le Short de cette vidéo est déjà publié.');
    const own = ownOf(await folderSettings(), video);
    const channelId = channelIdOf(own.channelId) || channelIdOf(own.youtubeChannelId);
    await setJob({ title: video.title, message: 'Envoi du Short sur YouTube…' });
    attempted = true;
    const shortId = await publishShortYouTube(video, channelId, channelVisibility(own), { reuse: !auto, monetization: own.monetization || 'on' });
    if (shortId) await folder('mark', { path: relativePath, status: 'published', data: { shortYoutubeId: shortId } });
    await setJob({ running: false, done: true, error: null, auto, message: 'Short publié sur YouTube.' });
  } catch (error) {
    const message = friendly(error);
    // Not retried on its own (never a double Short): the panel offers « Réessayer ».
    if (video && attempted) await folder('mark', { path: relativePath, status: 'published', data: { shortError: message } }).catch(() => {});
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
        throw new Error('KappGen ne connaît pas l’emplacement des vidéos sur cet ordinateur. Configure KAPPGEN_DATA_DIR dans l’application KappGen locale.');
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
        hash: video.hash, vertical_path: video.vertical_path, comment: video.comment || null },
      scheduleAt, commentDelay: source === 'folder' ? Number(ownOf(await folderSettings(), video).commentDelay) : NaN };
    await chrome.storage.local.set({ pending: job });
    await whileShown(tabId, async () => {
      await step(tabId, 'waitForFilePicker');
      await setJob({ message: 'Sélection du fichier vidéo…' });
      const videoInput = 'videoInput';
      if (source === 'folder') {
        const src = await bridgeSource(tabId, video.relative_path);
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
          const src = await bridgeSource(tabId, video.thumbnail_path);
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
      // Draft left in Studio: never « published » in silence. Its error shows in
      // the panel (« Pas terminée sur YouTube ») with « Renvoyer sur YouTube ».
      if (linkedYoutubeId) await folder('mark', { path: video.relative_path, status: 'published', data: { youtubeError: message } }).catch(() => {});
    } else {
      if (!linkedYoutubeId) await api(`/studio-upload/${videoId}/failed`, { method: 'POST', body: JSON.stringify({ error: message }) }).catch(() => {});
    }
  }
}


// Link of the video being uploaded, as soon as the Details page shows it.
async function earlyLink(tabId, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    ensureNotCancelled();
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
  const { source, videoId, tabId, visibility, video, scheduleAt } = job;
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
  let pollingErrors = 0;
  const deadline = Date.now() + 8 * 3600 * 1000;
  while (calm < 3 && Date.now() < deadline) {
    ensureNotCancelled();
    let busy;
    try {
      busy = await step(tabId, 'stillUploading');
      pollingErrors = 0;
    } catch (error) {
      pollingErrors += 1;
      if (pollingErrors >= 3) throw error;
      await sleep(3000);
      continue;
    }
    calm = busy ? 0 : calm + 1;
    // A dialog still "Saving…" gets a few visible seconds now and then:
    // Studio only moves on while its tab is shown.
    if (job.saveStuck && calm === 0 && await step(tabId, 'saveState').catch(() => 'closed') !== 'closed') {
      await whileShown(tabId, () => sleep(4000));
    }
    await sleep(3000);
  }
  if (calm < 3) throw new Error('Le transfert YouTube n’a pas pu être confirmé après huit heures. Vérifie son état dans Studio avant toute relance.');
  // Transfer over and the upload dialog never finished saving: the video
  // exists (it has its link), so set its visibility from its own page.
  if (job.saveStuck && await step(tabId, 'saveState').catch(() => 'closed') !== 'closed') {
    await setJob({ message: 'Studio bloqué sur « Saving… » : visibilité réglée depuis la page de la vidéo…' });
    await applyVisibilityFromEdit(tabId, youtubeId, visibility);
  }
  await closeStudioTab(tabId);
  await chrome.storage.local.remove('pending');
  // A Short is a nested step: publishShortOnly() or the long video's social
  // chain owns the final job state. Marking the job done here would re-enable
  // every publish button while Facebook distribution is still running.
  if (job.social) return youtubeId;
  let socialMessage = '';
  let socialFailure = null;
  let socialWarning = null;
  if (source === 'folder') {
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
        socialFailure = { facebookError: 'Publication Facebook interrompue.' };
        await publishFacebookReel(publishedNow, video.channel_name, own.facebookPageUrl, publishedNow.relative_path, { reuse: !job.auto });
        await folder('mark', { path: video.relative_path, status: 'published', data: { facebookPublishedAt: new Date().toISOString() } });
        socialFailure = null;
        socialMessage = ' Publiée aussi sur Facebook.';
      } else if (own.facebook && own.facebookMode === 'reel' && video.vertical_path) {
        await setJob({ message: 'Vidéo envoyée sur YouTube — publication du Short et du Reel Facebook…' });
        const { sent } = await folderQueue();
        const published = sent.find((item) => item.relative_path === video.relative_path);
        if (published) {
          let shortId = published.short_youtube_id;
          if (!shortId) {
            const channelId = channelIdOf(own.channelId) || channelIdOf(own.youtubeChannelId);
            socialFailure = { shortError: 'Publication du Short interrompue.' };
            shortId = await publishShortYouTube(published, channelId, visibility, { reuse: !job.auto, monetization: own.monetization || 'on' });
            await folder('mark', { path: video.relative_path, status: 'published', data: { shortYoutubeId: shortId } });
            socialFailure = null;
          }
          if (!published.facebook_reel_at) {
            socialFailure = { facebookReelError: 'Publication du Réel Facebook interrompue.' };
            await publishFacebookReel(published, video.channel_name, own.facebookPageUrl, published.vertical_path, { reuse: !job.auto });
            await folder('mark', { path: video.relative_path, status: 'published', data: { facebookReelAt: new Date().toISOString() } });
            socialFailure = null;
          }
          socialMessage = ' Short YouTube et Reel Facebook publiés.';
        }
      } else if (own.facebook && own.facebookMode === 'reel' && !video.vertical_path) {
        socialMessage = ' Facebook activé, mais aucun fichier vertical associé n’a été trouvé.';
        socialWarning = socialMessage.trim();
      }
    } catch (error) {
      const message = friendly(error);
      if (socialFailure) {
        const key = Object.keys(socialFailure)[0];
        await folder('mark', { path: video.relative_path, status: 'published', data: { [key]: message } }).catch(() => {});
      }
      socialMessage = ` Distribution sociale interrompue : ${message}`;
      socialWarning = socialMessage.trim();
    }
  }
  await setJob({ running: false, done: true, error: null, youtubeUrl: `https://youtu.be/${youtubeId}`,
    ...(socialWarning ? { warning: socialWarning } : {}), message: `Vidéo envoyée sur YouTube.${socialMessage}` });
  await remember({ title: video.title, channel: video.channel_name, youtubeId, visibility, at: Date.now() });
  // The video's pinned comment, once it is public (at its scheduled time, or
  // a few minutes after the upload); never on a private video.
  const wantsComment = (await folderSettings()).youtubeComment === true;
  const { pinBlocked } = await chrome.storage.local.get('pinBlocked');
  const blockedAt = (pinBlocked || {})[video.channel_key || ''];
  const blocked = blockedAt && Date.now() - blockedAt < 30 * 24 * 3600 * 1000;
  if (source === 'folder' && wantsComment && !blocked && video.comment && visibility !== 'PRIVATE') {
    const delay = Number.isFinite(job.commentDelay) ? job.commentDelay : COMMENT_DELAY_MIN + 1;
    await queueComment({ id: `yt:${video.relative_path}`, network: 'youtube', path: video.relative_path, youtubeId, text: video.comment, pin: true, channelKey: video.channel_key,
      title: video.title, channel: video.channel_name, due: Math.max(Date.now(), scheduleAt || 0) + delay * 60000 }).catch(() => {});
  }
  return youtubeId;
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
    // Before the dialog has been saved, a worker restart leaves no reliable
    // indication that title, audience, monetization and visibility were all
    // applied. Never click Save blindly: leave Studio open and require a
    // deliberate check/retry. If its link was already known, its draft record
    // remains the source of truth and prevents a duplicate upload.
    if (pending.stage !== 'saved') {
      await chrome.storage.local.remove('pending');
      const kind = pending.social ? 'Short' : 'Envoi';
      const message = `${kind} interrompu avant l’enregistrement dans Studio : vérifie l’onglet resté ouvert avant de relancer.`;
      if (pending.source === 'folder' && pending.video && pending.video.relative_path) {
        if (pending.social) {
          await folder('mark', { path: pending.video.relative_path, status: 'published', data: { shortError: message } }).catch(() => {});
        } else if (!pending.youtubeId) {
          await folder('mark', { path: pending.video.relative_path, status: 'failed', data: { error: message } }).catch(() => {});
        } else {
          await folder('mark', { path: pending.video.relative_path, status: 'published', data: { youtubeError: message } }).catch(() => {});
        }
      } else if (pending.source === 'app' && !pending.youtubeId) {
        await api(`/studio-upload/${pending.videoId}/failed`, { method: 'POST', body: JSON.stringify({ error: message }) }).catch(() => {});
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
        const src = await bridgeSource(tabId, video.thumbnail_path);
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
  let video = null;
  let attempted = false;
  try {
    const { sent } = await folderQueue();
    video = sent.find((item) => item.relative_path === relativePath);
    if (!video) throw new Error('La vidéo longue doit d’abord être publiée sur YouTube.');
    const own = ownOf(await folderSettings(), video);
    // Without `as` (the « Publier » button): the Short as a Reel if there is one, else the video.
    if (as === null) reel = own.facebookMode !== 'video' && !!video.vertical_path;
    if (reel && !video.vertical_path) throw new Error('Pas de version verticale (short.mp4) pour un Réel.');
    const file = reel ? video.vertical_path : video.relative_path;
    await setJob({ title: video.title, message: reel ? 'Réel sur Facebook…' : 'Vidéo sur Facebook…' });
    attempted = true;
    await publishFacebookReel(video, video.channel_name, own.facebookPageUrl, file, { reuse: !auto });
    const at = new Date().toISOString();
    await folder('mark', { path: relativePath, status: 'published', data: reel ? { facebookReelAt: at } : { facebookPublishedAt: at } });
    await setJob({ running: false, done: true, error: null, message: reel ? 'Réel publié sur Facebook.' : 'Vidéo publiée sur Facebook.' });
  } catch (error) {
    const message = friendly(error);
    // Not retried on its own (never a double post): the panel offers « Réessayer ».
    if (video && attempted) await folder('mark', { path: relativePath, status: 'published', data: reel ? { facebookReelError: message } : { facebookError: message } }).catch(() => {});
    await setJob({ running: false, done: false, error: message, message });
  }
}

// ---------------------------------------------------------------- TikTok

// TikTok Studio's upload page, in the TikTok tab already open if there is one.
async function openTikTok({ reuse = true } = {}) {
  const url = 'https://www.tiktok.com/tiktokstudio/upload?from=webapp';
  const tab = reuse ? await reuseOrOpen(tiktokTabToReuse, url) : await createWorkTab(url);
  workTabId = tab.id;
  await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  const start = Date.now();
  while (Date.now() - start < 90000) {
    ensureNotCancelled();
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
async function sendToTikTok({ filePath, caption, title, channel, path, auto = false }) {
  await chrome.storage.session.set({ job: { running: true, source: 'tiktok', kind: 'tiktok', path, title, channel, message: 'Ouverture de TikTok Studio…', startedAt: Date.now() } });
  const tabId = await openTikTok({ reuse: !auto });
  try {
    await whileShown(tabId, async () => {
      await setJob({ message: 'Envoi de la vidéo à TikTok…' });
      await stepIn(tabId, '__kappgenTikTok', 'sendVideo', { path: filePath, src: await bridgeSource(tabId, filePath) });
      await setJob({ message: 'Envoi à TikTok (jusqu’à 100 %), puis description…' });
      await stepIn(tabId, '__kappgenTikTok', 'writeCaption', { caption });
      await setJob({ message: 'Publication sur TikTok…' });
      await stepIn(tabId, '__kappgenTikTok', 'post');
    });
  } finally { await stepIn(tabId, 'KappKit', 'cleanup').catch(() => {}); }
  closeStudioTab(tabId); // only a tab opened for this post is closed
}

const hashtags = (tags) => (tags || []).slice(0, 5).map((t) => `#${String(t).replace(/[^\p{L}\p{N}]+/gu, '')}`).filter((t) => t.length > 1).join(' ');

// A video already on YouTube: its vertical version if there is one, otherwise
// the video itself (TikTok takes horizontal videos too).
async function publishTikTokVideo(relativePath, { auto = false, long = false } = {}) {
  let video = null;
  let attempted = false;
  try {
    const { sent } = await folderQueue();
    video = sent.find((item) => item.relative_path === relativePath);
    if (!video) throw new Error('La vidéo doit d’abord être publiée sur YouTube.');
    // The vertical version first (TikTok's own format); the long one on request.
    const filePath = long ? video.relative_path : (video.vertical_path || video.relative_path);
    const caption = [video.title, hashtags(video.tags)].filter(Boolean).join(' ').slice(0, 2200);
    attempted = true;
    await sendToTikTok({ filePath, caption, title: video.title, channel: video.channel_name, path: relativePath, auto });
    await folder('mark', { path: relativePath, status: 'published', data: { tiktokPublishedAt: new Date().toISOString() } });
    await setJob({ running: false, done: true, error: null, auto, message: 'Publiée sur TikTok.' });
  } catch (error) {
    const message = friendly(error);
    if (video && attempted) await folder('mark', { path: relativePath, status: 'published', data: { tiktokError: message } }).catch(() => {});
    await setJob({ running: false, done: false, error: message, message });
  }
}

// ---------------------------------------------------------------- X

// X's « new post » window, in the X tab already open if there is one.
async function openX({ reuse = true } = {}) {
  const tab = reuse ? await reuseOrOpen(xTabToReuse, 'https://x.com/compose/post')
    : await createWorkTab('https://x.com/compose/post');
  workTabId = tab.id;
  await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  const start = Date.now();
  while (Date.now() - start < 90000) {
    ensureNotCancelled();
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

async function sendToX({ text, mediaPath, title, channel, path, auto = false }) {
  await chrome.storage.session.set({ job: { running: true, source: 'x', kind: 'x', path, title, channel, message: 'Ouverture de X…', startedAt: Date.now() } });
  const tabId = await openX({ reuse: !auto });
  try { await whileShown(tabId, async () => {
    await setJob({ message: 'Texte du post…' });
    await stepIn(tabId, '__kappgenX', 'writePost', { text });
    if (mediaPath) {
      await setJob({ message: 'Envoi du média à X…' });
      await stepIn(tabId, '__kappgenX', 'addMedia', { path: mediaPath, src: await bridgeSource(tabId, mediaPath) });
      await sleep(3000);
    }
    await setJob({ message: 'Publication sur X…' });
    await stepIn(tabId, '__kappgenX', 'send');
  }); } finally { await stepIn(tabId, 'KappKit', 'cleanup').catch(() => {}); }
  closeStudioTab(tabId); // only a tab opened for this post is closed
}

// A video already on YouTube: its title and link, with its Short attached
// when there is one (X takes short videos; the long one stays a link).
async function publishXVideo(relativePath, { auto = false } = {}) {
  let video = null;
  let attempted = false;
  try {
    const { sent } = await folderQueue();
    video = sent.find((item) => item.relative_path === relativePath);
    if (!video || !video.youtube_id) throw new Error('La vidéo doit d’abord être publiée sur YouTube.');
    attempted = true;
    await sendToX({ text: xText(video.title, `https://youtu.be/${video.youtube_id}`), mediaPath: video.vertical_path || null,
      title: video.title, channel: video.channel_name, path: relativePath, auto });
    await folder('mark', { path: relativePath, status: 'published', data: { xPublishedAt: new Date().toISOString() } });
    await setJob({ running: false, done: true, error: null, auto, message: 'Publiée sur X.' });
  } catch (error) {
    const message = friendly(error);
    if (video && attempted) await folder('mark', { path: relativePath, status: 'published', data: { xError: message } }).catch(() => {});
    await setJob({ running: false, done: false, error: message, message });
  }
}

// A post of the posts folder: its text, and its photo or video.
async function publishXPost(postPath, { auto = false } = {}) {
  const post = await findPost(postPath);
  try {
    requireValidPost(post);
    await sendToX({ text: xText(post.text), mediaPath: post.video_path || post.image_path || null,
      title: post.text.split('\n')[0].slice(0, 80) || 'Post', channel: post.channel_name, path: postPath, auto });
    await folder('markPost', { path: postPath, patch: { x: { statut: 'publie', published_at: new Date().toISOString() } } });
    await setJob({ running: false, done: true, error: null, auto, message: 'Publié sur X.' });
  } catch (error) {
    const message = friendly(error);
    if (post && !post.configuration_error) await folder('markPost', { path: postPath, patch: { x: { statut: 'echec', erreur: message } } }).catch(() => {});
    await setJob({ running: false, done: false, error: message, message });
  }
}

// ---------------------------------------------------------------- LinkedIn

// LinkedIn's « Commencer un post » window, in the LinkedIn tab already open if there is one.
const LINKEDIN_COMPOSE = 'https://www.linkedin.com/feed/?shareActive=true';
async function openLinkedin({ reuse = true } = {}) {
  const tab = reuse ? await reuseOrOpen(linkedinTabToReuse, LINKEDIN_COMPOSE)
    : await createWorkTab(LINKEDIN_COMPOSE);
  workTabId = tab.id;
  await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  const start = Date.now();
  let asked = false;
  while (Date.now() - start < 90000) {
    ensureNotCancelled();
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

async function sendToLinkedin({ text, mediaPath, title, channel, path, auto = false }) {
  await chrome.storage.session.set({ job: { running: true, source: 'linkedin', kind: 'linkedin', path, title, channel, message: 'Ouverture de LinkedIn…', startedAt: Date.now() } });
  const tabId = await openLinkedin({ reuse: !auto });
  try { await whileShown(tabId, async () => {
    await stepIn(tabId, '__kappgenLinkedin', 'openComposer');
    await setJob({ message: 'Texte du post…' });
    await stepIn(tabId, '__kappgenLinkedin', 'writePost', { text });
    if (mediaPath) {
      await setJob({ message: 'Envoi du média à LinkedIn…' });
      await stepIn(tabId, '__kappgenLinkedin', 'addMedia', { path: mediaPath, src: await bridgeSource(tabId, mediaPath) });
    }
    await setJob({ message: 'Publication sur LinkedIn…' });
    await stepIn(tabId, '__kappgenLinkedin', 'send');
  }); } finally { await stepIn(tabId, 'KappKit', 'cleanup').catch(() => {}); }
  closeStudioTab(tabId); // only a tab opened for this post is closed
}

// A video already on YouTube: its title, description start and link
// (LinkedIn shows the YouTube preview).
async function publishLinkedinVideo(relativePath, { auto = false } = {}) {
  let video = null;
  let attempted = false;
  try {
    const { sent } = await folderQueue();
    video = sent.find((item) => item.relative_path === relativePath);
    if (!video || !video.youtube_id) throw new Error('La vidéo doit d’abord être publiée sur YouTube.');
    const intro = String(video.description || '').split(/\n\s*\n/)[0].slice(0, 600);
    attempted = true;
    await sendToLinkedin({ text: [video.title, intro, `https://youtu.be/${video.youtube_id}`].filter(Boolean).join('\n\n'),
      mediaPath: null, title: video.title, channel: video.channel_name, path: relativePath, auto });
    await folder('mark', { path: relativePath, status: 'published', data: { linkedinPublishedAt: new Date().toISOString() } });
    await setJob({ running: false, done: true, error: null, auto, message: 'Publiée sur LinkedIn.' });
  } catch (error) {
    const message = friendly(error);
    if (video && attempted) await folder('mark', { path: relativePath, status: 'published', data: { linkedinError: message } }).catch(() => {});
    await setJob({ running: false, done: false, error: message, message });
  }
}

// A post (Facebook's, or LinkedIn's own): its text, and its photo or video.
async function publishLinkedinPost(postPath, { auto = false } = {}) {
  const post = await findPost(postPath);
  try {
    requireValidPost(post);
    await sendToLinkedin({ text: post.text.slice(0, 3000), mediaPath: post.video_path || post.image_path || null,
      title: post.text.split('\n')[0].slice(0, 80) || 'Post', channel: post.channel_name, path: postPath, auto });
    await folder('markPost', { path: postPath, patch: { linkedin: { statut: 'publie', published_at: new Date().toISOString() } } });
    await setJob({ running: false, done: true, error: null, auto, message: 'Publié sur LinkedIn.' });
  } catch (error) {
    const message = friendly(error);
    if (post && !post.configuration_error) await folder('markPost', { path: postPath, patch: { linkedin: { statut: 'echec', erreur: message } } }).catch(() => {});
    await setJob({ running: false, done: false, error: message, message });
  }
}

// ---------------------------------------------------------------- Instagram

// Instagram home, in the Instagram tab already open if there is one.
async function openInstagram({ reuse = true } = {}) {
  const tab = reuse ? await reuseOrOpen(instagramTabToReuse, 'https://www.instagram.com/')
    : await createWorkTab('https://www.instagram.com/');
  workTabId = tab.id;
  await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  const start = Date.now();
  while (Date.now() - start < 90000) {
    ensureNotCancelled();
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
async function sendToInstagram({ filePath, caption, title, channel, path, auto = false }) {
  await chrome.storage.session.set({ job: { running: true, source: 'instagram', kind: 'instagram', path, title, channel, message: 'Ouverture d’Instagram…', startedAt: Date.now() } });
  const tabId = await openInstagram({ reuse: !auto });
  try { await whileShown(tabId, async () => {
    await stepIn(tabId, '__kappgenInstagram', 'openComposer');
    await setJob({ message: 'Envoi de la vidéo à Instagram…' });
    await stepIn(tabId, '__kappgenInstagram', 'sendVideo', { path: filePath, src: await bridgeSource(tabId, filePath) });
    await stepIn(tabId, '__kappgenInstagram', 'next', { times: 2 });
    await setJob({ message: 'Légende…' });
    await stepIn(tabId, '__kappgenInstagram', 'writeCaption', { caption });
    await setJob({ message: 'Partage sur Instagram (envoi jusqu’au bout)…' });
    await stepIn(tabId, '__kappgenInstagram', 'share');
  }); } finally { await stepIn(tabId, 'KappKit', 'cleanup').catch(() => {}); }
  closeStudioTab(tabId); // only a tab opened for this post is closed
}

// A video already on YouTube, as a Reel: needs its vertical version
// (Instagram crops a horizontal video to a square).
async function publishInstagramVideo(relativePath, { auto = false } = {}) {
  let video = null;
  let attempted = false;
  try {
    const { sent } = await folderQueue();
    video = sent.find((item) => item.relative_path === relativePath);
    if (!video) throw new Error('La vidéo doit d’abord être publiée sur YouTube.');
    if (!video.vertical_path) throw new Error('Aucune version verticale (short.mp4) dans le dossier : Instagram recadrerait la vidéo.');
    const caption = [video.title, hashtags(video.tags)].filter(Boolean).join('\n\n').slice(0, 2200);
    attempted = true;
    await sendToInstagram({ filePath: video.vertical_path, caption, title: video.title, channel: video.channel_name, path: relativePath, auto });
    await folder('mark', { path: relativePath, status: 'published', data: { instagramPublishedAt: new Date().toISOString() } });
    await setJob({ running: false, done: true, error: null, auto, message: 'Publiée sur Instagram.' });
  } catch (error) {
    const message = friendly(error);
    if (video && attempted) await folder('mark', { path: relativePath, status: 'published', data: { instagramError: message } }).catch(() => {});
    await setJob({ running: false, done: false, error: message, message });
  }
}

// A video of the posts folder, as a Reel.
async function publishInstagramPost(postPath, { auto = false } = {}) {
  const post = await findPost(postPath);
  try {
    requireValidPost(post);
    if (!post.video_path) throw new Error('Ce post n’a pas de vidéo pour Instagram.');
    await sendToInstagram({ filePath: post.video_path, caption: (post.text || '').slice(0, 2200), title: post.text.split('\n')[0] || 'Reel', channel: post.channel_name, path: postPath, auto });
    await folder('markPost', { path: postPath, patch: { instagram: { statut: 'publie', published_at: new Date().toISOString() } } });
    await setJob({ running: false, done: true, error: null, auto, message: 'Publié sur Instagram.' });
  } catch (error) {
    const message = friendly(error);
    if (post && !post.configuration_error) await folder('markPost', { path: postPath, patch: { instagram: { statut: 'echec', erreur: message } } }).catch(() => {});
    await setJob({ running: false, done: false, error: message, message });
  }
}

// ---------------------------------------------------------------- Snapchat

// Snapchat's web uploader (« Post to Snapchat »), in the Snapchat tab already open if there is one.
// Snapchat access is optional (manifest « optional_host_permissions ») : asked in the panel when Snapchat is turned on,
// so adding Snapchat never disabled the extension for people who do not use it.
const SNAPCHAT_ORIGINS = ['https://profile.snapchat.com/*', 'https://my.snapchat.com/*'];
async function openSnapchat({ reuse = true } = {}) {
  if (!(await chrome.permissions.contains({ origins: SNAPCHAT_ORIGINS }).catch(() => false))) {
    throw new Error('Autorise d’abord Snapchat : panneau KappGen Publish → onglet Snapchat → « Autoriser Snapchat ».');
  }
  const url = 'https://profile.snapchat.com/';
  const tab = reuse ? await reuseOrOpen(snapchatTabToReuse, url) : await createWorkTab(url);
  workTabId = tab.id;
  await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  const start = Date.now();
  while (Date.now() - start < 90000) {
    ensureNotCancelled();
    const current = await chrome.tabs.get(tab.id);
    const now = current.url || current.pendingUrl || '';
    if (/accounts\.snapchat\.com|\/(login|signup)\b/.test(now)) throw new Error('Connecte-toi d’abord à Snapchat (profile.snapchat.com) dans ce navigateur, puis relance.');
    if (/^https:\/\/(profile|my)\.snapchat\.com\//.test(now) && current.status === 'complete') {
      await sleep(2500);
      await injectScripts(tab.id, ['lib/page-kit.js', 'snapchat.js']);
      return tab.id;
    }
    await sleep(700);
  }
  throw new Error('Snapchat ne s’est pas ouvert.');
}

// One vertical video (5 to 60 s) to Snapchat : Spotlight and/or Story, with its description.
async function sendToSnapchat({ filePath, caption, title, channel, path, auto = false }) {
  await chrome.storage.session.set({ job: { running: true, source: 'snapchat', kind: 'snapchat', path, title, channel, message: 'Ouverture de Snapchat…', startedAt: Date.now() } });
  const settings = await folderSettings();
  const dest = settings.snapchatDestination || 'spotlight';
  const tabId = await openSnapchat({ reuse: !auto });
  try { await whileShown(tabId, async () => {
    await setJob({ message: 'Envoi de la vidéo à Snapchat…' });
    await stepIn(tabId, '__kappgenSnapchat', 'sendVideo', { path: filePath, src: await bridgeSource(tabId, filePath) });
    await stepIn(tabId, '__kappgenSnapchat', 'chooseDestination', { spotlight: dest !== 'story', story: dest !== 'spotlight' });
    await setJob({ message: 'Description…' });
    await stepIn(tabId, '__kappgenSnapchat', 'writeCaption', { caption });
    await setJob({ message: 'Publication sur Snapchat…' });
    await stepIn(tabId, '__kappgenSnapchat', 'post');
  }); } finally { await stepIn(tabId, 'KappKit', 'cleanup').catch(() => {}); }
  closeStudioTab(tabId); // only a tab opened for this post is closed
}

// Snapchat keeps descriptions short : the title and a few #topics.
const snapCaption = (title, tags) => [title, hashtags(tags)].filter(Boolean).join(' ').slice(0, 160);

// A video already on YouTube, through its vertical version (Snapchat : 5 to 60 s, 9:16).
async function publishSnapchatVideo(relativePath, { auto = false } = {}) {
  let video = null;
  let attempted = false;
  try {
    const { sent } = await folderQueue();
    video = sent.find((item) => item.relative_path === relativePath);
    if (!video) throw new Error('La vidéo doit d’abord être publiée sur YouTube.');
    if (!video.vertical_path) throw new Error('Aucune version verticale (short.mp4) dans le dossier : Snapchat n’accepte que des vidéos verticales de 5 à 60 secondes.');
    attempted = true;
    await sendToSnapchat({ filePath: video.vertical_path, caption: snapCaption(video.title, video.tags), title: video.title, channel: video.channel_name, path: relativePath, auto });
    await folder('mark', { path: relativePath, status: 'published', data: { snapchatPublishedAt: new Date().toISOString() } });
    await setJob({ running: false, done: true, error: null, auto, message: 'Publiée sur Snapchat.' });
  } catch (error) {
    const message = friendly(error);
    if (video && attempted) await folder('mark', { path: relativePath, status: 'published', data: { snapchatError: message } }).catch(() => {});
    await setJob({ running: false, done: false, error: message, message });
  }
}

// A video of the posts folder (SNAPCHAT/ or Facebook's posts), on Snapchat.
async function publishSnapchatPost(postPath, { auto = false } = {}) {
  const post = await findPost(postPath);
  try {
    requireValidPost(post);
    if (!post.video_path) throw new Error('Ce post n’a pas de vidéo pour Snapchat.');
    await sendToSnapchat({ filePath: post.video_path, caption: (post.text || '').split('\n')[0].slice(0, 160), title: post.text.split('\n')[0] || 'Snap', channel: post.channel_name, path: postPath, auto });
    await folder('markPost', { path: postPath, patch: { snapchat: { statut: 'publie', published_at: new Date().toISOString() } } });
    await setJob({ running: false, done: true, error: null, auto, message: 'Publié sur Snapchat.' });
  } catch (error) {
    const message = friendly(error);
    if (post && !post.configuration_error) await folder('markPost', { path: postPath, patch: { snapchat: { statut: 'echec', erreur: message } } }).catch(() => {});
    await setJob({ running: false, done: false, error: message, message });
  }
}

// A Reel (vertical video) of the posts folder.
async function publishTikTokPost(postPath, { auto = false } = {}) {
  const post = await findPost(postPath);
  try {
    requireValidPost(post);
    if (!post.video_path) throw new Error('Ce post n’a pas de vidéo pour TikTok.');
    await sendToTikTok({ filePath: post.video_path, caption: (post.text || '').slice(0, 2200), title: post.text.split('\n')[0] || 'Reel', channel: post.channel_name, path: postPath, auto });
    await folder('markPost', { path: postPath, patch: { tiktok: { statut: 'publie', published_at: new Date().toISOString() } } });
    await setJob({ running: false, done: true, error: null, auto, message: 'Publié sur TikTok.' });
  } catch (error) {
    const message = friendly(error);
    if (post && !post.configuration_error) await folder('markPost', { path: postPath, patch: { tiktok: { statut: 'echec', erreur: message } } }).catch(() => {});
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
  requireValidPost(post);
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
    let groupWarning = null;
    const markDuring = (result) => {
      const picked = Array.isArray(result) ? result : (result && result.groups) || [];
      const extra = (result && Array.isArray(result.extra)) ? result.extra
        .map((name) => String(name || '').trim())
        .filter((name) => name && !/^(activ[ée]|d[ée]sactiv[ée]|on|off|checked|unchecked)$/i.test(name)
          && !/booster|boost(?:er)? post|mention ia|ai label|contenu ia|story|audience|planification|scheduling|canal|channel/i.test(name)) : [];
      if (result && result.warning) groupWarning = result.warning;
      const lower = picked.map((n) => n.toLowerCase());
      const shared = { ...(post.groups_shared || {}) };
      const at = new Date().toISOString();
      for (const url of during) if (lower.includes(names[url].toLowerCase())) shared[url] = { statut: 'publie', published_at: at, mode: 'publication' };
      for (const name of extra) shared[`facebook:${name}`] = { statut: 'publie', published_at: at, mode: 'publication', nom: name };
      post.groups_shared = shared;
      // Groups were asked but none could be ticked: say why (publication.json + panel).
      post.groups_error = count > 0 && !picked.length && !extra.length ? ((result && result.error) || 'aucun groupe coché') : null;
    };
    if (post.type === 'reel') {
      markDuring(await publishFacebookReel({ title: '', description: post.text }, post.channel_name, page, post.video_path,
        { groups: during.map((url) => names[url]), groupCount: count, reuse: !auto }));
    } else {
      tabId = await openFacebookReel(page, { reuse: !auto });
      await whileShown(tabId, async () => {
        await step(tabId, 'openPost', { photo: post.type === 'photo' }, 'facebook.js');
        if (post.image_path) {
          await setJob({ message: 'Photo…' });
          await step(tabId, 'receiveFile', { kind: 'image', path: post.image_path,
            src: await bridgeSource(tabId, post.image_path) }, 'facebook.js');
          await sleep(2500);
        }
        await setJob({ message: 'Texte…' });
        await step(tabId, 'fillCaption', { caption: post.text }, 'facebook.js');
        await setJob({ message: count ? `Publication sur la Page et dans ${count} groupe(s)…` : 'Publication…' });
        markDuring(await postStep(tabId, 'sendPost', { groups: during.map((url) => names[url]), groupCount: count, expectedText: post.text }));
      });
      closeStudioTab(tabId); // only a tab opened for this post is closed
    }
    await folder('markPost', { path: post.path, patch: { statut: 'publie', published_at: new Date().toISOString(), erreur: null,
      groupes_erreur: post.groups_error || null,
      ...(Object.keys(post.groups_shared || {}).length ? { groupes_partages: post.groups_shared } : {}) } });
    // The comment that goes with the post, a few minutes after it.
    if ((await folderSettings()).facebookComment === true && post.comment && post.comment_statut !== 'publie') {
      const delay = post.comment_delay != null ? post.comment_delay : COMMENT_DELAY_MIN;
      await queueComment({ id: `fb:${post.path}`, network: 'facebook', path: post.path, page, snippet: post.text,
        text: post.comment, title: post.text.split('\n')[0].slice(0, 80), channel: post.channel_name, due: Date.now() + delay * 60000 }).catch(() => {});
      await folder('markPost', { path: post.path, patch: { commentaire_statut: 'en_attente', commentaire_erreur: null } }).catch(() => {});
    }
    // The groups not ticked while publishing (more than 9, or no option): right after.
    let shared = null;
    let shareWarning = null;
    try {
      shared = await shareInGroups(post);
      if (shared.bad) shareWarning = `${shared.bad} partage(s) en groupe ont échoué. Utilise « Repartager » après vérification.`;
    } catch (error) {
      shareWarning = `Le post est publié, mais le partage en groupes a été interrompu : ${friendly(error)}`;
    }
    const warning = [groupWarning, shareWarning].filter(Boolean).join(' ');
    const groupSuffix = warning ? ` ${warning}` : '';
    await setJob({ running: false, done: true, error: null, ...(warning ? { warning } : {}),
      message: `Post publié sur Facebook${groupsText(shared)}.${groupSuffix}` });
  } catch (error) {
    const message = friendly(error);
    // Once « Publier » may have been clicked, an Ad Center redirect or missing
    // confirmation is ambiguous: never offer a blind retry that could duplicate
    // a post already present on the Page.
    const uncertain = /parcours publicitaire|n[’']a pas confirm[ée] la publication|v[ée]rifie la Page et les brouillons/i.test(message);
    await folder('markPost', { path: post.path, patch: { statut: uncertain ? 'a_verifier' : 'echec', erreur: message } }).catch(() => {});
    await setJob({ running: false, done: false, error: message, message });
  }
}

// ------------------------------------------------------ Facebook groups

// The groups a post is shared in: its own "groupes" list (publication.json),
// otherwise the panel's list when « Partager dans les groupes » is ticked.
// One group after another, with a pause, so Facebook does not take it for spam.
const GROUP_PAUSE_MS = 40000;
const MAX_GROUPS = 9;    // conservative anti-spam ceiling for one post
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
      const share = await step(tabId, 'openShareToGroups', { snippet }, 'facebook.js');
      if (share.mode !== 'multi') { await step(tabId, 'closeDialogs', {}, 'facebook.js').catch(() => {}); return []; }
      const { picked } = await step(tabId, 'pickGroups', { names: wanted.map((url) => names[url]) }, 'facebook.js');
      if (!picked.length) { await step(tabId, 'closeDialogs', {}, 'facebook.js').catch(() => {}); return []; }
      confirmed = true; // from here, never shared again one by one (no double post)
      await step(tabId, 'confirmShare', { caption: '' }, 'facebook.js');
      const lower = picked.map((n) => n.toLowerCase());
      return wanted.filter((url) => lower.includes(names[url].toLowerCase()));
    });
  } catch (error) {
    if (confirmed) throw error;
    await step(tabId, 'closeDialogs', {}, 'facebook.js').catch(() => {});
    return [];
  } finally {
    await step(tabId, 'cleanup', {}, 'facebook.js').catch(() => {});
    await closeStudioTab(tabId);
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
  // One conservative pack of at most 9, as long as Facebook offers the boxes.
  for (let pack = 0; todo.length > 1 && pack < Math.ceil(MAX_GROUPS / SHARE_BATCH); pack += 1) {
    if (pack) await publicationSleep(GROUP_PAUSE_MS);
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
  if (todo.length && ok) await publicationSleep(GROUP_PAUSE_MS);
  const media = post.video_path || post.image_path;
  for (const [i, url] of todo.entries()) {
    if (i) await publicationSleep(GROUP_PAUSE_MS);
    if (await isPaused()) break; // « Pause » stops the remaining groups
    await setJob({ message: `Partage dans les groupes Facebook (${i + 1}/${todo.length})…` });
    let tabId = null;
    try {
      tabId = await openFacebookReel(url);
      const tab = await chrome.tabs.get(tabId);
      if (!/\/groups\//.test(tab.url || '')) throw new Error('Groupe introuvable, ou tu n’en es pas membre avec ce compte.');
      const name = String(tab.title || '').replace(/\s*[|·-]\s*Facebook\s*$/i, '').replace(/^\(\d+\)\s*/, '').trim();
      if (name && !/^facebook$/i.test(name)) await rememberGroupNames({ [url]: name }).catch(() => {});
      await whileShown(tabId, async () => {
        await step(tabId, 'openPost', { photo: !!media }, 'facebook.js');
        if (media) {
          await step(tabId, 'receiveFile', { kind: post.video_path ? 'video' : 'image', path: media,
            src: await bridgeSource(tabId, media) }, 'facebook.js');
          await sleep(post.video_path ? 3000 : 2500);
        }
        await step(tabId, 'fillCaption', { caption: post.text }, 'facebook.js');
        await postStep(tabId, 'sendPost', { timeout: post.video_path ? 15 * 60000 : 90000, expectedText: post.text });
      });
      done[url] = { statut: 'publie', published_at: new Date().toISOString() };
      ok += 1;
    } catch (error) {
      done[url] = { statut: 'echec', erreur: friendly(error) };
      bad += 1;
    } finally {
      if (tabId) {
        await step(tabId, 'cleanup', {}, 'facebook.js').catch(() => {});
        await closeStudioTab(tabId);
      }
    }
    await folder('markPost', { path: post.path, patch: { groupes_partages: done } }).catch(() => {});
  }
  return { ok, bad, total: Math.max(target, ok + bad) };
}

// Next post whose time has come. On time, it goes at its time. When posts
// are late (Chrome closed, computer asleep…), they never go out all at once:
// they leave one by one until the delay is caught up, then the normal rhythm.
// Spacing: the one chosen in Réglages → « Rythme du rattrapage » (1 to 120 min),
// otherwise automatic: twice as fast as the usual spacing (2 min 30 at least).
const ON_TIME_MS = 10 * 60000;
const CATCH_UP_MINUTES_MAX = 120;
const chosenCatchUpMs = (settings) => {
  const minutes = Math.round(Number(settings && settings.catchUpMinutes));
  return minutes >= 1 ? Math.min(CATCH_UP_MINUTES_MAX, minutes) * 60000 : 0;
};
function catchUpGap(posts, settings) {
  const chosen = chosenCatchUpMs(settings);
  if (chosen) return chosen;
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
    const gap = catchUpGap(posts, await folderSettings());
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
  const { catchUp, paceNext } = await chrome.storage.local.get(['catchUp', 'paceNext']);
  if (catchUp && catchUp.next > Date.now()) next = Math.min(next, catchUp.next);
  if (paceNext && paceNext > Date.now()) next = Math.min(next, paceNext); // the rhythm chosen in Réglages: the next moment allowed
  await chrome.storage.local.set({ nextDueAt: Number.isFinite(next) ? next : null });
  if (Number.isFinite(next)) await chrome.alarms.create('due', { when: next + 5000 });
  else await chrome.alarms.clear('due');
}

// « Rythme du rattrapage » changed in Réglages: the next late post moves at once
// (the wake-up already planned could be up to 30 min away).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.folder) return;
  const before = chosenCatchUpMs(changes.folder.oldValue);
  const after = chosenCatchUpMs(changes.folder.newValue);
  if (before === after) return;
  (async () => {
    const { catchUp, lastAutoPostAt } = await chrome.storage.local.get(['catchUp', 'lastAutoPostAt']);
    if (catchUp) {
      const gap = after || catchUp.gap;
      await chrome.storage.local.set({ catchUp: { ...catchUp, gap, next: Math.max(Date.now(), (lastAutoPostAt || 0) + gap) } });
    }
    await planNextDue();
  })().catch(() => {});
});

// « Rythme de publication » changed in Réglages: the new rule applies at once.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.folder) return;
  const was = JSON.stringify((changes.folder.oldValue || {}).pace || null);
  const now = JSON.stringify((changes.folder.newValue || {}).pace || null);
  if (was !== now) autoTick();
});

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
  // TikTok / Instagram : « Mes vidéos YouTube » et « Les vidéos de mes posts Facebook » sont désactivés par défaut
  // (anciens réglages tiktokAuto / instagramAuto repris).
  const fromYt = (net) => (settings[`${net}FromYoutube`] ?? settings[`${net}Auto`]) === true;
  const fromFb = (net) => settings[`${net}FromFacebook`] === true;
  const snapAllowed = await chrome.permissions.contains({ origins: SNAPCHAT_ORIGINS }).catch(() => false);
  // X / LinkedIn ticked before their start date was kept: from now on (TikTok / Instagram as soon as one source is on).
  for (const net of ['x', 'linkedin', 'tiktok', 'instagram', 'snapchat']) {
    if (['tiktok', 'instagram', 'snapchat'].includes(net) && !fromYt(net) && !fromFb(net)) continue;
    if (on(net) && !settings[`${net}Since`]) {
      settings[`${net}Since`] = Date.now();
      await chrome.storage.local.set({ folder: settings });
    }
  }
  const after = (v, since) => {
    const boundary = typeof since === 'number' ? since : Date.parse(since || '') || Infinity;
    return !!v.published_at && v.published_at >= boundary;
  };
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
      [on('tiktok') && fromYt('tiktok') && !own('tiktok') && !v.tiktok_published_at && !v.tiktok_error && after(v, settings.tiktokSince),
        () => publishTikTokVideo(v.relative_path, { auto: true })],
      [on('instagram') && fromYt('instagram') && !own('instagram') && v.vertical_path && !v.instagram_published_at && !v.instagram_error
        && after(v, settings.instagramSince), () => publishInstagramVideo(v.relative_path, { auto: true })],
      [on('snapchat') && snapAllowed && fromYt('snapchat') && !own('snapchat') && v.vertical_path && !v.snapchat_published_at && !v.snapchat_error
        && after(v, settings.snapchatSince), () => publishSnapchatVideo(v.relative_path, { auto: true })],
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
    for (const [net, send] of [['x', publishXPost], ['linkedin', publishLinkedinPost], ['tiktok', publishTikTokPost], ['instagram', publishInstagramPost], ['snapchat', publishSnapchatPost]]) {
      const videoOnly = net === 'tiktok' || net === 'instagram' || net === 'snapchat';
      if (!on(net) || own(net) || p[`${net}_statut`] || (net === 'snapchat' && !snapAllowed)) continue;
      if (videoOnly ? (!fromFb(net) || !p.video_path) : settings[`${net}FromFacebook`] === false) continue;
      const savedSince = settings[`${net}Since`];
      const since = typeof savedSince === 'number' ? savedSince : Date.parse(savedSince || '') || Infinity;
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
    if (net === 'snapchat' && !(await chrome.permissions.contains({ origins: SNAPCHAT_ORIGINS }).catch(() => false))) continue;
    ready.push(...(await postsList(net).catch(() => []))
      .filter((p) => p.ready && (!['tiktok', 'instagram', 'snapchat'].includes(net) || p.video_path)));
  }
  ready.sort((a, b) => (a.due_at || 0) - (b.due_at || 0));
  const post = ready[0];
  if (!post) return false;
  const send = { x: publishXPost, linkedin: publishLinkedinPost, tiktok: publishTikTokPost, instagram: publishInstagramPost, snapchat: publishSnapchatPost }[post.network];
  await send(post.path, { auto: true });
  return true;
}

// Bridge with the KappGen software (see lib/dossier.js exportState): state written in the shared folder.
async function exportState(etat) {
  const { lastExport } = await chrome.storage.session.get('lastExport');
  if (lastExport && lastExport.etat === etat && Date.now() - lastExport.at < 4 * 60 * 1000) return;
  const settings = await folderSettings();
  const { lastAutoPostAt, lastAutoTick } = await chrome.storage.local.get(['lastAutoPostAt', 'lastAutoTick']);
  const state = {
    source: 'KappGen Publish', version: chrome.runtime.getManifest().version, maj: new Date().toISOString(), etat,
    pause: await isPaused(), reseaux: Object.fromEntries(['youtube', 'facebook', 'tiktok', 'instagram', 'snapchat', 'x', 'linkedin'].map((n) => [n, networkOn(settings, n)])),
    youtube: { visibilite: settings.visibility || 'UNLISTED', programmation: settings.schedule === 'times' ? 'heures' : 'tout-de-suite', heures: settings.times || '' },
    chaines: settings.channels || {}, dernier_passage: lastAutoTick || null, dernier_post: lastAutoPostAt || null,
  };
  await folder('exportState', { state }).catch(() => {});
  await chrome.storage.session.set({ lastExport: { etat, at: Date.now() } });
}

// ------------------------------------------------------ scheduled comments

// The comment that goes with a post or a video, posted some minutes after it
// is out (Facebook: under the post on the Page; YouTube: under the video,
// pinned). Kept in the browser's storage so it survives a restart; a pass of
// autoPass() takes the ones whose time has come, one at a time.
const COMMENT_DELAY_MIN = 2;
const COMMENT_TRIES = 4;
const commentQueue = async () => (await chrome.storage.local.get('commentQueue')).commentQueue || [];
const saveCommentQueue = (queue) => chrome.storage.local.set({ commentQueue: queue });
async function queueComment(item) {
  if (!item.text || !String(item.text).trim()) return;
  const queue = (await commentQueue()).filter((c) => c.id !== item.id);
  queue.push({ tries: 0, ...item, text: String(item.text).trim().slice(0, 8000) });
  await saveCommentQueue(queue);
  chrome.alarms.create('comment', { when: Math.max(item.due, Date.now() + 5000) });
}
async function markComment(item, ok, error) {
  const at = new Date().toISOString();
  if (item.network === 'facebook') {
    await folder('markPost', { path: item.path, patch: ok
      ? { commentaire_statut: 'publie', commentaire_publie_a: at, commentaire_erreur: null }
      : { commentaire_statut: error.verify ? 'a_verifier' : 'echec', commentaire_erreur: error.message } }).catch(() => {});
  } else {
    await folder('mark', { path: item.path, status: 'published', data: ok ? { commentAt: at } : { commentError: error.message } }).catch(() => {});
  }
}
async function postFacebookComment(item) {
  const tabId = await openFacebookReel(item.page, { reuse: false });
  try {
    return await whileShown(tabId, () => step(tabId, 'commentPost', { snippet: item.snippet, comment: item.text }, 'facebook.js'));
  } finally {
    await step(tabId, 'cleanup', {}, 'facebook.js').catch(() => {});
    await closeStudioTab(tabId);
  }
}
async function postYoutubeComment(item) {
  const tab = await createWorkTab(`https://www.youtube.com/watch?v=${encodeURIComponent(item.youtubeId)}`);
  workTabId = tab.id;
  await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  try {
    const start = Date.now();
    while (Date.now() - start < 60000) {
      ensureNotCancelled();
      const current = await chrome.tabs.get(tab.id);
      if (/accounts\.google\.com/.test(current.url || '')) throw new Error('[FINAL] Connecte-toi d’abord à YouTube dans ce navigateur.');
      if (current.status === 'complete') break;
      await sleep(700);
    }
    await injectFiles(tab.id, ['youtube-watch.js']);
    return await whileShown(tab.id, () => stepIn(tab.id, '__kappgenWatch', 'commentVideo', { comment: item.text, pin: item.pin !== false }));
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
    workTabId = null;
  }
}
// One due comment per pass. True when one was handled (or tried).
async function commentNext() {
  const now = Date.now();
  const item = (await commentQueue()).find((c) => c.due <= now);
  if (!item) return false;
  await chrome.storage.session.set({ job: { running: true, source: item.network, kind: 'comment', path: item.path, auto: true,
    title: item.title || 'Commentaire', channel: item.channel || '', message: `Commentaire sous le post ${item.network === 'facebook' ? 'Facebook' : 'YouTube'}…`, startedAt: now } });
  const remove = async () => saveCommentQueue((await commentQueue()).filter((c) => c.id !== item.id));
  try {
    const result = item.network === 'facebook' ? await postFacebookComment(item) : await postYoutubeComment(item);
    await remove();
    if (result && result.pinUnavailable) {
      // The channel cannot pin yet: no comment, and none is tried again for a while.
      const { pinBlocked } = await chrome.storage.local.get('pinBlocked');
      await chrome.storage.local.set({ pinBlocked: { ...(pinBlocked || {}), [item.channelKey || '']: Date.now() } });
      const why = result.deleted ? 'commentaire retiré' : 'commentaire à retirer à la main';
      await markComment(item, false, { message: `Épinglage indisponible sur cette chaîne (critères YouTube non atteints) : ${why}, rien n’est posté.` });
      await setJob({ running: false, done: true, error: null, message: 'Commentaire ignoré : cette chaîne ne peut pas encore épingler.',
        warning: result.deleted ? '' : 'Le commentaire est resté sous la vidéo : retire-le à la main.' });
      return true;
    }
    await markComment(item, true);
    const note = result && result.otherChannel ? ' Attention : posté depuis une autre chaîne que celle de la vidéo ?' : '';
    await setJob({ running: false, done: true, error: null, message: `Commentaire publié.${note}`, ...(note ? { warning: note.trim() } : {}) });
  } catch (error) {
    const raw = String((error && error.message) || error);
    const message = friendly(error).replace(/^\[(FINAL|A_VERIFIER)\]\s*/, '');
    const verify = /\[A_VERIFIER\]/.test(raw);
    const last = verify || /\[FINAL\]/.test(raw) || item.tries + 1 >= COMMENT_TRIES || /annul/i.test(message);
    if (last) {
      await remove();
      await markComment(item, false, { message, verify });
      await setJob({ running: false, done: false, error: `Commentaire non publié : ${message}`, message: `Commentaire non publié : ${message}` });
    } else {
      // Not out yet (video still processing, page slow…): again a little later.
      const queue = await commentQueue();
      const kept = queue.find((c) => c.id === item.id);
      if (kept) { kept.tries += 1; kept.due = Date.now() + 10 * 60000 * kept.tries; await saveCommentQueue(queue); }
      await setJob({ running: false, done: true, error: null, warning: `Commentaire pas encore publié (${message}) : nouvel essai dans quelques minutes.`, message: 'Commentaire reporté.' });
    }
  }
  return true;
}

// ---------------------------------------------------------------- rythme de publication (Réglages → « Rythme de publication »)
// Global to all networks: as soon as ready (default), at a regular interval, or at irregular times like a person (lib/rythme.js).
// Each automatic send on a network counts as one publication. Manual sends are never held back or counted.
async function paceGate(settings) {
  const pace = KappPace.normalize(settings && settings.pace);
  if (pace.mode === 'asap') { await chrome.storage.local.remove('paceNext'); return { ok: true }; }
  const { paceLog, pacePlans } = await chrome.storage.local.get(['paceLog', 'pacePlans']);
  const plans = pacePlans || {};
  const planFor = (dayStart) => {
    const key = `${dayStart}|${pace.perDay}|${pace.from}|${pace.to}|${pace.minGapMinutes}`;
    if (!plans[key]) plans[key] = KappPace.buildPlan(pace, dayStart);
    return plans[key];
  };
  const result = KappPace.gate(pace, Date.now(), paceLog || [], planFor);
  const oldest = KappPace.dayStartOf(Date.now()) - 2 * 24 * 3600000;
  for (const key of Object.keys(plans)) if (Number(key.split('|')[0]) < oldest) delete plans[key];
  await chrome.storage.local.set({ pacePlans: plans, paceNext: result.ok ? null : result.next });
  return result;
}
async function paceRecord() {
  const { paceLog } = await chrome.storage.local.get('paceLog');
  await chrome.storage.local.set({ paceLog: [...(paceLog || []), Date.now()].slice(-300), lastAutoPostAt: Date.now() });
}

// Chrome can run with no window open (everything closed, extension alive):
// opening a tab then fails with « No current window ». A minimised empty
// window is opened first so scheduled publications still go out.
async function ensureWindow() {
  try {
    if ((await chrome.windows.getAll()).length) return;
    await chrome.windows.create({ url: 'about:blank', focused: false, state: 'minimized' });
  } catch { /* the publication reports its own error */ }
}

async function autoPass() {
  await chrome.storage.local.set({ lastAutoTick: Date.now() });
  // « Pause » in the panel: nothing goes out on its own until « Reprendre ».
  if (await isPaused()) { await autoState('paused'); exportState('pause').catch(() => {}); return; }
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
  await ensureWindow();
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
  exportState('ok').catch(() => {});
  await chrome.storage.session.remove('permissionNotified');
  if ((await folder('fbAccess').catch(() => ({}))).state === 'prompt') await askAccess().catch(() => {});
  const { videos, sent } = await folderQueue();
  const own = await ownFolders();
  const passAt = Date.now();
  // A comment whose time has come goes under its post/video first.
  const commentAt = Date.now();
  if (await commentNext()) { await chainIfDone(commentAt); return; }
  // Pace chosen in Réglages: outside the allowed moments nothing is published (comments and the sheet updates below still go).
  const gate = await paceGate(settings);
  const paced = !gate.ok;
  if (paced) await autoState('paced', { next: gate.next });
  // What is already out somewhere goes on to the other networks first: one
  // publication on all its networks, then the next one.
  if (!paced && await spreadNext(settings, sent, own)) { await paceRecord(); await chainIfDone(passAt); return; }
  // A post whose time has come: it has a time, a new video has not.
  const duePost = !paced && networkOn(settings, 'facebook') ? await nextDuePost() : null;
  if (duePost) {
    await paceRecord();
    await publishFacebookPost(duePost, { auto: true });
    await chainIfDone(passAt); // then the same post on the other networks
    return;
  }
  // Each network's own posts (its folder, or <NETWORK>/A-PUBLIER), at their time.
  if (!paced && await ownPostNext(settings)) { await paceRecord(); await chainIfDone(passAt); return; }
  let next = null;
  for (const candidate of !paced && networkOn(settings, 'youtube') ? videos.filter((v) => v.auto_ok) : []) {
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
    await paceRecord();
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

// When a newer version is out on GitHub, tell the creator once (notification);
// the « Mettre à jour » button of the side panel installs it (lib/maj.js).
const RELEASES_URL = 'https://api.github.com/repos/rosby17/kappgen-publish/releases/latest';
const UPDATE_GUIDE = 'https://app.kappgen.com/extension#maj';
const newer = (a, b) => {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};
// A newer release is installed by itself through the helper of the computer
// (the one behind « Mettre à jour »): new files on disk, then selfUpdate()
// restarts the extension as soon as no publication is running. Without the
// helper, or if it fails, the notification asking for a click stays.
// Off with autoUpdate === false in the browser's storage.
async function autoInstall(version) {
  const { autoUpdate, autoInstallTry } = await chrome.storage.local.get(['autoUpdate', 'autoInstallTry']);
  if (autoUpdate === false) return false;
  if (autoInstallTry && autoInstallTry.version === version && Date.now() - autoInstallTry.at < 3600 * 1000) return autoInstallTry.ok === true;
  const { job } = await chrome.storage.session.get('job');
  if (job && job.running) return true; // later: nothing is installed in the middle of a publication
  let ok = false;
  try {
    const answer = await chrome.runtime.sendNativeMessage('com.kappgen.publish', { action: 'update' });
    ok = !!(answer && answer.ok);
  } catch { /* no helper: the notification takes over */ }
  await chrome.storage.local.set({ autoInstallTry: { version, at: Date.now(), ok } });
  if (ok) selfUpdate().catch(() => {});
  return ok;
}

async function checkNewRelease({ maxAge = 30 * 60 * 1000 } = {}) {
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
  if (await autoInstall(latest)) return;
  const { releaseCheck: saved } = await chrome.storage.local.get('releaseCheck');
  if (saved.notified === latest) return;
  await chrome.storage.local.set({ releaseCheck: { ...saved, notified: latest } });
  chrome.notifications.create('kappgen-update', {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: `KappGen Publish ${latest} est disponible`,
    message: `Tu as la version ${current}. Ouvre le panneau KappGen Publish et clique « Mettre à jour » (tes réglages sont gardés).`,
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
  const disk = await (await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' })).json();
  const waiting = disk.version && disk.version !== chrome.runtime.getManifest().version ? disk.version : '';
  // The side panel shows « Redémarrer » while a new version waits (installed
  // on disk, not running yet).
  const { restartPending } = await chrome.storage.local.get('restartPending');
  if ((restartPending || '') !== waiting) await chrome.storage.local.set({ restartPending: waiting });
  if (!waiting) return;
  // Never in the middle of a publication; but one with no news for 30 min is
  // dead (it would otherwise block every update forever), and an upload being
  // followed is picked up again after the reload (resume()).
  const { job } = await chrome.storage.session.get('job');
  const quiet = job && job.running ? Date.now() - (job.updatedAt || job.startedAt || 0) : Infinity;
  const { pending } = await chrome.storage.local.get('pending');
  if (quiet >= STALE_JOB_MS && !(pending && resuming)) { chrome.runtime.reload(); return; }
  // Held back by a publication: say it once per version, with how to apply it now.
  const { restartNotified } = await chrome.storage.local.get('restartNotified');
  if (restartNotified === waiting) return;
  await chrome.storage.local.set({ restartNotified: waiting });
  chrome.notifications.create('kappgen-restart', {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: `KappGen Publish ${waiting} est installée`,
    message: 'Elle s’activera à la fin de la publication en cours. Pour l’activer tout de suite : ouvre le panneau et clique « Redémarrer », ou quitte Chrome et rouvre-le (tous tes profils d’un coup).',
    priority: 1,
  });
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
  if (alarm.name === 'auto' || alarm.name === 'due' || alarm.name === 'comment') autoTick().catch(() => {});
});
// Clicking the icon opens the side panel: everything happens there.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
// Clicking the "re-authorize" notification should land the creator straight
// on the panel instead of just dismissing a toast — same one-click re-grant
// as clicking the extension icon itself.
chrome.notifications.onClicked.addListener(async (id) => {
  if (id === 'kappgen-update' || id === 'kappgen-restart') {
    // Straight to the panel and its button; the guide if Chrome refuses.
    const win = await chrome.windows.getLastFocused().catch(() => null);
    const opened = win && await chrome.sidePanel.open({ windowId: win.id }).then(() => true).catch(() => false);
    if (!opened && id === 'kappgen-update') chrome.tabs.create({ url: UPDATE_GUIDE });
    return;
  }
  if (id !== 'kappgen-folder-access') return;
  await askAccess({ force: true }).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => { heartbeat(); resume(); });
chrome.runtime.onInstalled.addListener(() => { heartbeat(); resume(); closeOldKeeper(); });
resume(); // service worker restarted while an upload was being followed

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target === 'offscreen') return false;
  const handlers = {
    consumeBridgeGrant: () => consumeBridgeGrant(message.token, sender),
    account: () => api('/auth/session').catch((error) => { if (error.status === 401) return null; throw error; }),
    login: () => api('/auth/login', { method: 'POST', body: JSON.stringify({ email: message.email, password: message.password }) }),
    // Thème choisi dans l'extension : enregistré aussi sur le compte KappGen (« » = automatique), comme sur le site et le logiciel.
    setTheme: () => api('/profil/theme', { method: 'POST', body: JSON.stringify({ theme: ['clair', 'sombre'].includes(message.theme) ? message.theme : '' }) }),
    logout: async () => { await chrome.storage.local.remove(['publishAccess', 'pendingOrder']); return api('/auth/logout', { method: 'POST' }); },
    status: () => api('/studio-upload/status'),
    queue: async () => (await isLocalApp() ? api('/studio-upload/queue') : { videos: [], host_storage_configured: false }),
    folderQueue: () => folderQueue(),
    folderMark: () => folder('mark', { path: message.path, status: message.status }),
    channelVideos: () => channelVideos(message.channelId),
    facebookPosts: () => postsList(),
    // Pause asked by a page script (Studio, Facebook, X…) while its tab is in
    // the background: Chrome slows a hidden tab's own timers down to one tick
    // a minute, the service worker's are not slowed down.
    pageSleep: async () => { await sleep(Math.max(0, Math.min(Number(message.ms) || 0, 30000))); return true; },
    // A long upload in progress (Facebook): the publication is alive, the
    // panel shows how far it is (and it is not taken for dead after 30 min).
    uploadProgress: async () => {
      const { job } = await chrome.storage.session.get('job');
      if (!job || !job.running || !sender.tab || sender.tab.id !== workTabId) return false;
      const percent = Number.isFinite(message.percent) ? `${Math.round(message.percent)} %` : 'en cours';
      const minutes = Math.round((Number(message.elapsedMs) || 0) / 60000);
      await setJob({ message: `Envoi de la vidéo à Facebook : ${percent}${minutes ? ` (depuis ${minutes} min)` : ''}…` });
      return true;
    },
    findGroups: async () => ({ groups: await findMyGroups() }),
    referrals: () => api('/referrals/me'),
    claimReferral: () => api('/referrals/claim', { method: 'POST', body: JSON.stringify({ code: message.code }) }),
    // The groups where an already published post failed (or new ones).
    shareGroups: async () => {
      await requireAccess();
      const { job } = await chrome.storage.session.get('job');
      if (job && job.running) throw new Error('Une publication est déjà en cours.');
      const post = (await postsList()).find((p) => p.path === message.path);
      requireValidPost(post);
      for (const [url, state] of Object.entries(post.groups_shared || {})) if (state.statut === 'echec') delete post.groups_shared[url];
      await chrome.storage.session.set({ job: { running: true, source: 'facebook', kind: 'groups', path: post.path,
        title: post.text.split('\n')[0].slice(0, 80) || 'Post Facebook', message: 'Partage dans les groupes Facebook…', startedAt: Date.now() } });
      shareInGroups(post).then(
        (r) => setJob({ running: false, done: true, error: null,
          ...(r.bad ? { warning: `${r.bad} groupe(s) en échec.` } : {}), message: `Partagé dans ${r.ok} groupe(s) sur ${r.total}.` }),
        (e) => setJob({ running: false, done: false, error: friendly(e), message: friendly(e) }));
      return { started: true };
    },
    postNow: async () => {
      await requireAccess();
      const { job } = await chrome.storage.session.get('job');
      if (job && job.running) throw new Error('Un envoi est déjà en cours.');
      const post = (await postsList()).find((p) => p.path === message.path);
      requireValidPost(post);
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
      const redirectUrl = safeRedirectUrl(data.redirect_url);
      if (!data.order_id) throw new Error('Réponse de paiement incomplète.');
      await chrome.storage.local.set({ pendingOrder: data.order_id });
      await chrome.tabs.create({ url: redirectUrl, active: true });
      return { ...data, redirect_url: redirectUrl };
    },
    checkPayment: async () => {
      const { pendingOrder } = await chrome.storage.local.get('pendingOrder');
      if (pendingOrder) {
        const result = await api('/publish/verify', { method: 'POST', body: JSON.stringify({ order_id: pendingOrder }) }).catch(() => ({ status: 'pending' }));
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
      requireValidPost(await findPost(message.path));
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
      requireValidPost(await findPost(message.path));
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
      requireValidPost(await findPost(message.path));
      publishInstagramPost(message.path).catch(() => {});
      return { started: true };
    },
    snapchat: async () => {
      await requireAccess();
      const { job } = await chrome.storage.session.get('job');
      if (job && job.running) throw new Error('Une publication est déjà en cours.');
      publishSnapchatVideo(message.path).catch(() => {});
      return { started: true };
    },
    snapchatPost: async () => {
      await requireAccess();
      const { job } = await chrome.storage.session.get('job');
      if (job && job.running) throw new Error('Une publication est déjà en cours.');
      requireValidPost(await findPost(message.path));
      publishSnapchatPost(message.path).catch(() => {});
      return { started: true };
    },
    instagramAuto: async () => {
      const settings = await folderSettings();
      settings.instagramAuto = !!message.on;
      if (message.on && !settings.instagramSince) settings.instagramSince = Date.now();
      await chrome.storage.local.set({ folder: settings });
      return { on: settings.instagramAuto };
    },
    tiktokPost: async () => {
      await requireAccess();
      const { job } = await chrome.storage.session.get('job');
      if (job && job.running) throw new Error('Une publication est déjà en cours.');
      requireValidPost(await findPost(message.path));
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
    // Unfinished YouTube draft (« Mise en ligne interrompue »…): send the video
    // to YouTube again; networks already done (Facebook…) are not posted twice.
    resendYoutube: async () => {
      await requireAccess();
      const { job } = await chrome.storage.session.get('job');
      if (job && job.running) throw new Error('Un envoi est déjà en cours.');
      await folder('mark', { path: message.path, status: 'resetYoutube' });
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
      await chrome.storage.session.set({ job: { running: false, done: false, error: 'Envoi arrêté à la main. Vérifie sur le réseau concerné s’il est parti avant de relancer.', message: 'Envoi arrêté à la main. Vérifie sur le réseau concerné s’il est parti avant de relancer.' } });
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
