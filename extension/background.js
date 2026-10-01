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
  await chrome.storage.session.set({ job: { ...(job || {}), ...patch, updatedAt: Date.now() } });
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
  if (access.state !== 'prompt') return access.state === 'granted';
  const [open] = await chrome.tabs.query({ url: ASK_URL });
  if (open) {
    await chrome.windows.update(open.windowId, { focused: true, drawAttention: true }).catch(() => {});
  } else {
    const { askedAt } = await chrome.storage.session.get('askedAt');
    if (force || wait || !askedAt || Date.now() - askedAt > 30 * 60 * 1000) {
      await chrome.storage.session.set({ askedAt: Date.now() });
      const current = await chrome.windows.getLastFocused().catch(() => null);
      const width = 420, height = 330;
      const left = current ? Math.max(0, current.left + Math.round((current.width - width) / 2)) : undefined;
      const top = current ? Math.max(0, current.top + 120) : undefined;
      await chrome.windows.create({ url: ASK_URL, type: 'popup', width, height, left, top, focused: true });
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
  // Automatic is the default for every channel, but only for videos finished
  // after the first run: older ones stay manual (never a surprise mass upload).
  if (!current.autoSince) {
    current.autoSince = Date.now();
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

async function folderQueue() {
  const settings = await folderSettings();
  return folder('scan', { channels: settings.channels, autoSince: settings.autoSince });
}

// "UC…" id from an id, a channel link or a Studio link.
function channelIdOf(text) {
  const m = String(text || '').match(/UC[A-Za-z0-9_-]{22}/);
  return m ? m[0] : null;
}

// Runs one window.__kappgen step inside the Studio tab.
async function step(tabId, name, args) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (fn, input) => {
      try {
        return { ok: true, value: await window.__kappgen[fn](input) };
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) };
      }
    },
    args: [name, args || {}],
  });
  if (!result || !result.ok) throw new Error((result && result.error) || `Étape « ${name} » impossible.`);
  return result.value;
}

// Chrome's own messages ("Frame with ID 0 is showing error page"...) mean
// nothing to a creator; say what actually went wrong instead.
function friendly(error) {
  const message = String((error && error.message) || error);
  if (/error page|ERR_|Cannot access contents|No tab with id/i.test(message)) {
    return 'YouTube Studio n’a pas pu se charger (connexion Internet ?) ou l’onglet a été fermé. Relance l’envoi.';
  }
  if (/Another debugger is already attached/i.test(message)) {
    return 'Ferme les outils de développement (DevTools) de l’onglet YouTube Studio, puis relance.';
  }
  return message;
}

// channelId: open the upload dialog of that channel (several channels on one
// Google account); otherwise the channel last used in this Chrome profile.
async function openStudioUpload(channelId, active = true) {
  const url = channelId ? `https://studio.youtube.com/channel/${channelId}/videos/upload?d=ud` : 'https://www.youtube.com/upload';
  const tab = await chrome.tabs.create({ url, active });
  // Never let Chrome discard the tab: that would cancel the transfer.
  await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  const start = Date.now();
  while (Date.now() - start < 90000) {
    const current = await chrome.tabs.get(tab.id);
    const url = current.url || current.pendingUrl || '';
    if (url.startsWith('https://accounts.google.com')) {
      throw new Error('Connecte-toi d’abord à YouTube Studio dans ce navigateur, puis relance.');
    }
    if (url.startsWith('https://studio.youtube.com') && current.status === 'complete') {
      if (channelId && !url.includes(channelId)) {
        throw new Error(`Ce profil Chrome n’a pas accès à la chaîne ${channelId} dans YouTube Studio.`);
      }
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['studio.js'] });
      return tab.id;
    }
    await sleep(700);
  }
  throw new Error('YouTube Studio ne s’est pas ouvert.');
}

// Sets `path` on the first element matching `selector` without reading it.
async function setLocalFile(tabId, selector, path) {
  if (!chrome.debugger || !await chrome.permissions.contains({ permissions: ['debugger'] })) {
    throw new Error('Autorisation « contrôle de l’onglet » refusée : clique de nouveau « Envoyer » dans le panneau et accepte-la.');
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
async function whileShown(tabId, fn) {
  const tab = await chrome.tabs.get(tabId);
  const [previous] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  await chrome.tabs.update(tabId, { active: true });
  try {
    return await fn();
  } finally {
    if (previous && previous.id !== tabId) await chrome.tabs.update(previous.id, { active: true }).catch(() => {});
  }
}

// Settings of one channel: the side panel's, overridden by what the channel
// folder itself says (reglages-publication.json, ADN/chaine.json).
function ownOf(settings, video) {
  return { ...((settings.channels || {})[video.channel_key] || {}), ...((video && video.channel_config) || {}) };
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
async function openFacebookReel(pageUrl) {
  const safePage = /^https:\/\/(?:www\.)?facebook\.com\//i.test(String(pageUrl || '')) ? pageUrl : 'https://www.facebook.com/';
  const tab = await chrome.tabs.create({ url: safePage, active: false });
  const start = Date.now();
  while (Date.now() - start < 90000) {
    const current = await chrome.tabs.get(tab.id);
    const url = current.url || current.pendingUrl || '';
    if (/login|checkpoint|recover/i.test(url)) throw new Error('Connecte-toi d’abord à Facebook dans ce navigateur, puis relance.');
    if ((url.startsWith('https://www.facebook.com') || url.startsWith('https://facebook.com')) && current.status === 'complete') {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['facebook.js'] });
      return tab.id;
    }
    await sleep(700);
  }
  throw new Error('Facebook ne s’est pas ouvert.');
}

// filePath: the file to post (the long video, or its vertical version).
async function publishFacebookReel(video, channelName, pageUrl, filePath = video && video.vertical_path) {
  if (!filePath) throw new Error('Aucun fichier vertical associé à cette vidéo.');
  const tabId = await openFacebookReel(pageUrl);
  try {
    await whileShown(tabId, async () => {
      await step(tabId, 'openReel');
      await step(tabId, 'receiveFile', {
        src: chrome.runtime.getURL(`bridge.html?path=${encodeURIComponent(filePath)}`),
        path: filePath,
      });
      await setJob({ message: `Préparation de la publication Facebook (${channelName || 'page sélectionnée'})…` });
      const caption = [video.title, video.description].filter(Boolean).join('\n\n').slice(0, 5000);
      await step(tabId, 'fillCaption', { caption });
      await step(tabId, 'publish');
    });
    return true;
  } finally {
    // Keep Facebook visible after a successful post so the creator can see
    // the selected Page and the published Reel. On error, it stays open too
    // because the visible error is usually actionable in the composer.
  }
}

async function publishShortYouTube(video, channelId, visibility) {
  const tabId = await openStudioUpload(channelId, false);
  const shortVisibility = visibility === 'SCHEDULE' ? 'UNLISTED' : visibility;
  const job = { source: 'folder', social: true, videoId: video.id, tabId,
    visibility: shortVisibility, stage: 'filling',
    video: { title: `${video.title} — Short`, description: video.description, tags: video.tags,
      channel_name: video.channel_name, channel_key: video.channel_key,
      relative_path: video.relative_path, hash: video.hash } };
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['studio.js'] });
    await chrome.storage.local.set({ pending: job });
    await whileShown(tabId, async () => {
      await step(tabId, 'waitForFilePicker');
      await step(tabId, 'receiveFile', {
        selector: 'ytcp-uploads-dialog input[type="file"]',
        src: chrome.runtime.getURL(`bridge.html?path=${encodeURIComponent(video.vertical_path)}`),
        path: video.vertical_path,
      });
      await step(tabId, 'fillDetails', { title: `${video.title} — Short`, description: video.description });
      if (video.tags && video.tags.length) await step(tabId, 'fillTags', { tags: video.tags }).catch(() => {});
      await step(tabId, 'chooseVisibility', { visibility: shortVisibility, monetization: 'manual' });
    });
    await finishUpload(job);
    const { job: finished } = await chrome.storage.session.get('job');
    return finished && finished.youtubeId;
  } catch (error) {
    chrome.tabs.remove(tabId).catch(() => {});
    throw error;
  }
}

// Same steps for both sources; only where the video comes from differs.
async function publish(source, videoId, visibility, { auto = false } = {}) {
  await chrome.storage.session.set({ job: { running: true, source, videoId, auto, message: 'Préparation…', startedAt: Date.now() } });
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
        throw new Error('Accès au dossier non autorisé : clique « Autoriser » dans la petite fenêtre KappGen Uploader.');
      }
      const { videos } = await folderQueue();
      video = videos.find((v) => v.id === videoId);
      if (!video) throw new Error('Cette vidéo n’est plus dans le dossier (déplacée, renommée ou déjà envoyée).');
      const own = ownOf(await folderSettings(), video);
      // The channel is learned on the first upload (Studio's address); an
      // id typed by hand in older versions still wins.
      channelId = channelIdOf(own.channelId) || channelIdOf(own.youtubeChannelId);
      monetization = own.monetization || 'on';
      if (visibility === 'CHANNEL') visibility = channelVisibility(own);
      if (visibility === 'SCHEDULE') scheduleAt = await nextSlot(video.channel_key, own.times);
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
    tabId = await openStudioUpload(channelId, false);
    if (source === 'folder') {
      const learned = channelIdOf((await chrome.tabs.get(tabId)).url);
      if (learned) await rememberChannel(video.channel_key, learned);
    }
    // Written to disk: after an update/reload of the extension, resume()
    // picks this up and only follows the transfer already under way.
    job = { source, videoId, tabId, visibility, stage: 'filling',
      video: video && { title: video.title, description: video.description, tags: video.tags,
        channel_name: video.channel_name, channel_key: video.channel_key, relative_path: video.relative_path,
        hash: video.hash, vertical_path: video.vertical_path } };
    await chrome.storage.local.set({ pending: job });
    await whileShown(tabId, async () => {
      await step(tabId, 'waitForFilePicker');
      await setJob({ message: 'Sélection du fichier vidéo…' });
      const videoInput = 'ytcp-uploads-dialog input[type="file"]';
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
        const thumbInput = 'ytcp-uploads-dialog input#file-loader';
        if (source === 'folder') {
          const src = chrome.runtime.getURL(`bridge.html?path=${encodeURIComponent(video.thumbnail_path)}`);
          await step(tabId, 'receiveFile', { selector: thumbInput, src, path: video.thumbnail_path }).catch(() => {});
        } else {
          await setLocalFile(tabId, thumbInput, video.thumbnail_path).catch(() => {});
        }
      }

      await setJob({ message: 'Visibilité…' });
      await step(tabId, 'chooseVisibility', { visibility, monetization, scheduleAt });
    });
    if (scheduleAt) await rememberSlot(video.channel_key, scheduleAt);

    await finishUpload(job);
  } catch (error) {
    const message = friendly(error);
    await setJob({ running: false, done: false, error: message, message });
    await chrome.storage.local.remove('pending');
    if (source === 'folder' && !job.social) {
      if (marked && !linkedYoutubeId) await folder('mark', { path: video.relative_path, status: 'failed', data: { error: message } }).catch(() => {});
    } else {
      if (!linkedYoutubeId) await api(`/studio-upload/${videoId}/failed`, { method: 'POST', body: JSON.stringify({ error: message }) }).catch(() => {});
    }
  }
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
      await folder('mark', { path: video.relative_path, status: 'published', data: { youtubeId, visibility, channel: video.channel_key, hash: video.hash } });
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
  chrome.tabs.remove(tabId).catch(() => {});
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
            shortId = await publishShortYouTube(published, channelId, visibility);
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
  await chrome.scripting.executeScript({ target: { tabId }, files: ['studio.js'] });
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
    await chrome.scripting.executeScript({ target: { tabId: pending.tabId }, files: ['studio.js'] }); // no-op if already there
    try {
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
  await chrome.storage.session.set({ job: { running: true, source: 'folder', auto, message: 'Préparation de la mise à jour…', startedAt: Date.now() } });
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
    const tab = await chrome.tabs.create({ url: `https://studio.youtube.com/video/${video.youtube_id}/edit`, active: false });
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
    await chrome.scripting.executeScript({ target: { tabId }, files: ['studio.js'] });
    await whileShown(tabId, async () => {
      const thumbInput = 'ytcp-thumbnails-compact-editor-uploader input[type="file"], input#file-loader';
      if (video.thumbnail_path) {
        await setJob({ message: 'Miniature…' });
        const src = chrome.runtime.getURL(`bridge.html?path=${encodeURIComponent(video.thumbnail_path)}`);
        await step(tabId, 'receiveFile', { selector: thumbInput, src, path: video.thumbnail_path });
        await sleep(3000);
      }
      await setJob({ message: 'Titre, description, mots-clés…' });
      await step(tabId, 'editDetails', { title: video.title, description: video.description, tags: video.tags });
      await setJob({ message: 'Enregistrement…' });
      await step(tabId, 'saveEdit');
    });
    chrome.tabs.remove(tabId).catch(() => {});
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
async function publishFacebookOnly(relativePath) {
  await chrome.storage.session.set({ job: { running: true, source: 'folder', message: 'Préparation du Reel Facebook…', startedAt: Date.now() } });
  try {
    const { sent } = await folderQueue();
    const video = sent.find((item) => item.relative_path === relativePath);
    if (!video) throw new Error('La vidéo longue doit d’abord être publiée sur YouTube.');
    const own = ownOf(await folderSettings(), video);
    const file = own.facebookMode !== 'video' && video.vertical_path ? video.vertical_path : video.relative_path;
    await setJob({ title: video.title, message: 'Ouverture de Facebook…' });
    await publishFacebookReel(video, video.channel_name, own.facebookPageUrl, file);
    await folder('mark', { path: relativePath, status: 'published', data: { facebookPublishedAt: new Date().toISOString() } });
    await setJob({ running: false, done: true, error: null, message: 'Reel publié sur Facebook.' });
  } catch (error) {
    const message = friendly(error);
    await setJob({ running: false, done: false, error: message, message });
  }
}

// Last uploads of this profile, shown in the popup.
async function remember(entry) {
  const { history } = await chrome.storage.local.get('history');
  await chrome.storage.local.set({ history: [entry, ...(history || [])].slice(0, 30) });
}

// Every few minutes: send the next ready video of an automatic channel.
async function autoTick() {
  const { job } = await chrome.storage.session.get('job');
  if (job && job.running) return;
  const settings = await folderSettings();
  const access = await folder('access').catch(() => ({ state: 'none' }));
  if (access.state === 'prompt') await askAccess().catch(() => {});
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
        title: 'KappGen Uploader : accès au dossier à confirmer',
        message: "Clique ici puis « Autoriser » (choisis « Autoriser à chaque visite ») pour que les publications reprennent.",
        priority: 2,
      });
    }
    return;
  }
  chrome.action.setBadgeText({ text: '' });
  await chrome.storage.session.remove('permissionNotified');
  const { videos, sent } = await folderQueue();
  const next = videos.find((v) => v.auto_ok);
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
  for (const v of sent) {
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
function heartbeat() {
  api('/studio-upload/status').catch(() => {});
}
chrome.alarms.create('heartbeat', { periodInMinutes: 1 });
chrome.alarms.create('auto', { periodInMinutes: AUTO_EVERY_MINUTES });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'heartbeat') heartbeat();
  if (alarm.name === 'auto') autoTick().catch(() => {});
});
// Clicking the icon opens the side panel: everything happens there.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
// Clicking the "re-authorize" notification should land the creator straight
// on the panel instead of just dismissing a toast — same one-click re-grant
// as clicking the extension icon itself.
chrome.notifications.onClicked.addListener(async (id) => {
  if (id !== 'kappgen-folder-access') return;
  await askAccess({ force: true }).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => { heartbeat(); resume(); });
chrome.runtime.onInstalled.addListener(() => { heartbeat(); resume(); closeOldKeeper(); });
resume(); // service worker restarted while an upload was being followed

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target === 'offscreen') return false;
  const handlers = {
    account: () => api('/auth/session').catch((error) => { if (error.status === 401) return null; throw error; }),
    login: () => api('/auth/login', { method: 'POST', body: JSON.stringify({ email: message.email, password: message.password }) }),
    logout: () => api('/auth/logout', { method: 'POST' }),
    status: () => api('/studio-upload/status'),
    queue: () => api('/studio-upload/queue'),
    folderQueue: () => folderQueue(),
    folderMark: () => folder('mark', { path: message.path, status: message.status }),
    channelVideos: () => channelVideos(message.channelId),
    autoNow: async () => { autoTick().catch(() => {}); return {}; },
    publish: async () => {
      const { job } = await chrome.storage.session.get('job');
      if (job && job.running) throw new Error('Un envoi est déjà en cours.');
      // runs on; the popup follows chrome.storage
      publish(message.source || 'app', message.videoId, message.visibility);
      return { started: true };
    },
    update: async () => {
      const { job } = await chrome.storage.session.get('job');
      if (job && job.running) throw new Error('Un envoi est déjà en cours.');
      updateVideo(message.path);
      return { started: true };
    },
    facebook: async () => {
      const { job } = await chrome.storage.session.get('job');
      if (job && job.running) throw new Error('Une publication est déjà en cours.');
      publishFacebookOnly(message.path);
      return { started: true };
    },
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
