// The videos folder chosen by the user (File System Access API).
//
// The folder handle lives in this extension's IndexedDB, so every extension
// page (options, offscreen scanner, the bridge frame inside YouTube Studio)
// reaches the same folder. Nothing is copied: files are read from disk when
// YouTube Studio asks for them.
//
// How a folder is understood, whatever tool made the videos:
//   - a video is an .mp4 / .m4v of at least 5 MB;
//   - folders starting with "." or "_" and work folders (build, tournage,
//     flow, sprites, images, scripts...) are skipped;
//   - renders/, export/, final/... : the heaviest video of the folder is the
//     project's video; its sheet sits in that folder or in the project folder;
//   - a folder holding a sheet (publication.md, youtube.md, metadata.json...)
//     is a project: its heaviest video is the one to publish;
//   - a sheet named like the video (ma-video.md / .txt / .json) belongs to it;
//   - the channel is the folder above the project, skipping containers such
//     as VIDEO/ or VIDEOS/; a loose video belongs to the folder holding it.
// What has been sent is written in each video's own folder (".kappgen.json",
// keyed by file name), so the record follows the video whatever folder is
// chosen in the panel; ".kappgen-publications.json" at the root of the chosen
// folder is still written and read for older records.
//
// A channel folder may hold "reglages-publication.json" (see
// NORME-PUBLICATION.md): YouTube channel, visibility, hours, Facebook
// page. Its values win over the panel's. The YouTube channel is also read
// from ADN/chaine.json ("youtube": channel URL) when present.

const KappDossier = (() => {
  const DB_NAME = 'kappgen-dossier';
  const STATE_FILE = '.kappgen-publications.json';
  const SIDE_FILE = '.kappgen.json';
  // Visible in Finder: tells at a glance that the folder's video is on YouTube.
  const MARKER_FILE = 'DEJA-PUBLIEE.txt';
  const CHANNEL_FILE = 'reglages-publication.json';
  const MIN_SIZE = 5 * 1024 * 1024;
  const SETTLE_MS = 10 * 60 * 1000;            // still being written if touched within 10 min
  const LOOSE_MAX_AGE = 14 * 24 * 3600 * 1000; // loose videos without a sheet: recent ones only
  const STARTED_LOCK_MS = 3 * 3600 * 1000;     // a "started" upload blocks other profiles for 3 h
  const MAX_DEPTH = 7;

  const VIDEO_EXT = /\.(mp4|m4v)$/i;
  // A vertical derivative belongs to its long video and must not appear as a
  // second item in the upload queue.  It is published to Shorts/Reels when
  // the channel enables the social distribution option.
  const DERIVATIVE_VIDEO = /(?:^|[-_ .])(short|shorts|reel|reels|vertical)(?:[-_ .]|$)/i;
  const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;
  // Technical folders only (work files, caches, raw footage); any other
  // folder, whatever its name, is looked into.
  const SKIP = new Set(['node modules', 'build', 'flow', 'neuves', 'sprites', 'src', 'wav', 'cache',
    'tmp', 'temp', 'captures', 'frames', 'proxy', 'proxies', 'rushes', 'brut', 'raw', 'library', 'bibliotheque']);
  // Text files that are never the text of a publication.
  const NOT_A_SHEET = /^(deja publiee|readme|lisez|prompt|script|journal|notes?|chapitres?|timing|transcri|sous titres?|subtitles?|modele|template|images a generer|planning|voix|sources?)\b/;
  const FALLBACK_MAX = 12000; // a description, not a script
  const RENDER_DIRS = new Set(['renders', 'render', 'export', 'exports', 'final', 'finals', 'output', 'outputs',
    'sortie', 'sorties', 'out', 'a publier', 'to publish', 'pret', 'prets', 'ready']);
  const CONTAINERS = new Set(['video', 'videos', 'videos longues', 'longues', 'long', 'shorts', 'episodes']);
  const SHEET_NAMES = /^(publication.*|youtube.*|metadata|meta|fiche.*)\.(md|json|txt)$|^(description|titre|title|tags)\.txt$/i;

  const norm = (name) => KappFiches.plain(name).replace(/[-_]+/g, ' ').trim();
  const stem = (name) => name.replace(/\.[^.]+$/, '');
  const isDerivativeVideo = (name) => DERIVATIVE_VIDEO.test(stem(name));

  // ------------------------------------------------------------- storage

  function db() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('kv');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function kv(mode, fn) {
    const base = await db();
    return new Promise((resolve, reject) => {
      const tx = base.transaction('kv', mode);
      const request = fn(tx.objectStore('kv'));
      tx.oncomplete = () => resolve(request && request.result);
      tx.onerror = () => reject(tx.error);
    });
  }

  const saveRoot = (handle) => kv('readwrite', (store) => store.put(handle, 'root'));
  const loadRoot = () => kv('readonly', (store) => store.get('root'));

  // The main folder ("root") serves every network. Each network may have its
  // own folder instead: YouTube (its videos), Facebook (posts and Reels,
  // the "fbroot" of older versions), Instagram, TikTok, X, LinkedIn (posts).
  // Paths inside a network's folder start with its prefix ("fb:", "x:"…) so
  // every reader knows which folder they belong to.
  const NETS = ['youtube', 'facebook', 'instagram', 'tiktok', 'x', 'linkedin'];
  const POST_NETS = ['instagram', 'tiktok', 'x', 'linkedin'];
  const netKey = (net) => (net === 'facebook' ? 'fbroot' : `root:${net}`);
  const FB_PREFIX = 'fb:';
  const MAIN_PREFIX = 'main:';
  const prefixOf = (net) => (net === 'facebook' ? FB_PREFIX : `${net}:`);
  // Folder names of a network inside the main folder (<chaîne>/X/A-PUBLIER…).
  const NET_DIRS = { facebook: ['facebook'], instagram: ['instagram'], tiktok: ['tiktok'], x: ['x', 'twitter'], linkedin: ['linkedin'] };
  const NET_DIR_NAMES = new Set(Object.values(NET_DIRS).flat());
  const testNets = {}; // set by tests only
  const saveNetRoot = (net, handle) => kv('readwrite', (store) => store.put(handle, netKey(net)));
  const loadNetRoot = async (net) => testNets[net] || kv('readonly', (store) => store.get(netKey(net)));
  const clearNetRoot = (net) => kv('readwrite', (store) => store.delete(netKey(net)));
  const saveFbRoot = (handle) => saveNetRoot('facebook', handle);
  const loadFbRoot = () => loadNetRoot('facebook');
  const clearFbRoot = () => clearNetRoot('facebook');

  async function stateOf(handle) {
    if (!handle) return { state: 'none' };
    const testing = handle === testRoot || Object.values(testNets).includes(handle);
    return { state: testing ? 'granted' : await handle.queryPermission({ mode: 'readwrite' }), name: handle.name };
  }

  // Every folder in use: { main, youtube, facebook, … }, each { state, name,
  // own } (own: false when the network takes the main folder).
  async function folders() {
    const main = await stateOf(testRoot || await loadRoot());
    const out = { main };
    for (const net of NETS) {
      const handle = await loadNetRoot(net);
      out[net] = handle ? { ...(await stateOf(handle)), own: true } : { ...main, own: false };
    }
    // Networks without their own folder post what Facebook posts.
    for (const net of POST_NETS) {
      if (!out[net].own && out.facebook && out.facebook.own) out[net] = { ...out.facebook, own: false, shared: 'facebook' };
    }
    return out;
  }

  async function fbAccess() {
    const handle = await loadFbRoot();
    if (!handle) return { state: 'none' };
    return stateOf(handle);
  }

  // The folder YouTube's videos are read from (its own, or the main one).
  // state: "granted", "prompt", "denied" or "none" (no folder chosen yet).
  async function access() {
    const handle = testRoot || await loadNetRoot('youtube') || await loadRoot();
    return stateOf(handle);
  }

  let testRoot = null; // set by tests only

  async function granted(handle, label) {
    if (!handle) return null;
    if ((await stateOf(handle)).state !== 'granted') {
      throw new Error(`Accès au dossier ${label} à autoriser : Réglages → Dossiers → « Autoriser l’accès ».`);
    }
    return handle;
  }
  const netRoot = async (net) => granted(await loadNetRoot(net), `« ${(await loadNetRoot(net) || {}).name || net} »`);

  async function mainRoot() {
    if (testRoot) return testRoot;
    const handle = await loadRoot();
    if (!handle) throw new Error('Aucun dossier choisi : Réglages → Dossiers → « Choisir le dossier principal ».');
    return granted(handle, 'principal');
  }

  // The folder a path belongs to, and the path inside it.
  async function dirFor(relativePath) {
    if (relativePath.startsWith(MAIN_PREFIX)) return [await mainRoot(), relativePath.slice(MAIN_PREFIX.length)];
    for (const net of NETS) {
      if (!relativePath.startsWith(prefixOf(net))) continue;
      const handle = await netRoot(net);
      if (!handle) throw new Error(`Aucun dossier ${net === 'facebook' ? 'Facebook' : net} choisi.`);
      return [handle, relativePath.slice(prefixOf(net).length)];
    }
    return [await root(), relativePath];
  }

  // YouTube's folder: its own, otherwise the main one.
  async function root() {
    if (testRoot && !testNets.youtube) return testRoot;
    const own = await loadNetRoot('youtube');
    if (own) return granted(own, `YouTube « ${own.name} »`);
    return mainRoot();
  }

  async function fileAt(relativePath) {
    let [dir, inside] = await dirFor(relativePath);
    const parts = inside.split('/').filter(Boolean);
    const name = parts.pop();
    for (const part of parts) dir = await dir.getDirectoryHandle(part);
    return (await dir.getFileHandle(name)).getFile();
  }

  async function readTrackingFile(dir, name) {
    try {
      const file = await (await dir.getFileHandle(name)).getFile();
      const value = JSON.parse((await file.text()).replace(/^\uFEFF/, ''));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('un objet JSON est attendu');
      return value;
    } catch (error) {
      if (error && (error.name === 'NotFoundError' || /not found/i.test(error.message || ''))) return {};
      throw new Error(`${name} est invalide ou illisible (${error.message || error}). Aucune publication ne sera lancée avant sa correction.`);
    }
  }

  const readState = (dir) => readTrackingFile(dir, STATE_FILE);
  const readSide = (dir) => readTrackingFile(dir, SIDE_FILE);

  async function writeSide(dir, side) {
    const handle = await dir.getFileHandle(SIDE_FILE, { create: true });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(side, null, 2));
    await writable.close();
  }

  async function writeMarker(dir, side) {
    const lines = Object.entries(side).filter(([, r]) => r && r.status === 'published').map(([name, r]) => [
      `${name} : déjà publiée, ne pas la renvoyer.`,
      r.youtubeId ? `YouTube : https://youtu.be/${r.youtubeId}${r.visibility ? ` (${r.visibility})` : ''}` : null,
      r.facebookPublishedAt ? `Facebook : ${r.facebookPublishedAt}` : null,
      `Date : ${r.date || ''}`,
    ].filter(Boolean).join('\n'));
    if (!lines.length) {
      await dir.removeEntry(MARKER_FILE).catch(() => {});
      return;
    }
    const handle = await dir.getFileHandle(MARKER_FILE, { create: true });
    const writable = await handle.createWritable();
    await writable.write(`${lines.join('\n\n')}\n`);
    await writable.close();
  }

  // ---------------------------------------------------- channel settings

  const VISIBILITY_WORDS = { 'non repertoriee': 'UNLISTED', unlisted: 'UNLISTED', publique: 'PUBLIC', public: 'PUBLIC',
    privee: 'PRIVATE', private: 'PRIVATE', programmee: 'SCHEDULE', schedule: 'SCHEDULE', scheduled: 'SCHEDULE' };
  const channelIdIn = (text) => { const m = String(text || '').match(/UC[A-Za-z0-9_-]{22}/); return m ? m[0] : null; };
  const validFacebookPage = (value) => /^https:\/\/(?:www\.|web\.|m\.|mobile\.|business\.)?facebook\.com(?:\/|$)/i.test(String(value || '').trim());
  const validFacebookGroup = (value) => /^https:\/\/(?:www\.|web\.|m\.|mobile\.)?facebook\.com\/groups\/[^/?#\s]+(?:[/?#]|$)/i.test(String(value || '').trim());
  // The distributed planning template deliberately offers this marker when
  // the Page must come from the extension's panel. It is an instruction, not
  // a destination URL, and therefore behaves exactly like an absent field.
  const isPagePlaceholder = (value) => /^\s*\[\s*[àa]\s+compl[ée]ter\b/i.test(String(value || ''));

  // Channel settings written in the channel folder, in the panel's own
  // vocabulary ({ channelId, visibility, times, auto, monetization,
  // facebook, facebookPageUrl, facebookMode }). Only the keys present in the
  // files are returned.
  async function channelConfig(node) {
    if (!node || !node.handle) return {};
    const out = {};
    let adn = null;
    try {
      const result = await readObjectResult(await node.handle.getDirectoryHandle('ADN'), 'chaine.json');
      if (result.error) throw new Error(result.error);
      adn = result.value;
    } catch (error) {
      if (!(error && (error.name === 'NotFoundError' || /not found/i.test(error.message || '')))) throw error;
    }
    if (adn && channelIdIn(adn.youtube)) out.channelId = channelIdIn(adn.youtube);
    const channelResult = await readObjectResult(node.handle, CHANNEL_FILE);
    if (channelResult.error) throw new Error(channelResult.error);
    const file = channelResult.value;
    if (!file) return out;
    if (file.youtube != null && (!file.youtube || typeof file.youtube !== 'object' || Array.isArray(file.youtube))) {
      throw new Error(`${CHANNEL_FILE} : youtube doit contenir un objet JSON.`);
    }
    if (file.facebook != null && (!file.facebook || typeof file.facebook !== 'object' || Array.isArray(file.facebook))) {
      throw new Error(`${CHANNEL_FILE} : facebook doit contenir un objet JSON.`);
    }
    const yt = file.youtube || {};
    const fb = file.facebook || {};
    if (channelIdIn(yt.chaine || yt.channel)) out.channelId = channelIdIn(yt.chaine || yt.channel);
    const visibilityValue = yt.visibilite ?? yt.visibility;
    const vis = VISIBILITY_WORDS[norm(String(visibilityValue || ''))];
    if (visibilityValue != null && !vis) throw new Error(`${CHANNEL_FILE} : visibilité YouTube inconnue (${visibilityValue}).`);
    if (vis) out.visibility = vis;
    const hours = yt.heures ?? yt.times;
    if (hours != null) {
      if (!Array.isArray(hours) && typeof hours !== 'string') throw new Error(`${CHANNEL_FILE} : youtube.heures doit être une heure ou une liste d’heures.`);
      const times = (Array.isArray(hours) ? hours.join(', ') : hours).trim();
      const tokens = times.split(/[,;\s]+/).filter(Boolean);
      const valid = tokens.length && tokens.every((token) => {
        const match = token.match(/^(\d{1,2})[:hH](\d{2})$/);
        return match && Number(match[1]) < 24 && Number(match[2]) < 60 && Number(match[2]) % 15 === 0;
      });
      if (!valid) throw new Error(`${CHANNEL_FILE} : youtube.heures doit contenir des quarts d’heure valides (ex. 09:00, 18:30).`);
      out.times = times;
    }
    if (yt.auto != null && typeof yt.auto !== 'boolean') throw new Error(`${CHANNEL_FILE} : youtube.auto doit valoir true ou false.`);
    if (typeof yt.auto === 'boolean') out.auto = yt.auto;
    const monetizationValue = yt.monetisation ?? yt.monetization;
    const money = norm(String(monetizationValue || ''));
    if (money) {
      if (/^(oui|on|activee?)$/.test(money)) out.monetization = 'on';
      else if (/^(non|off|desactivee?)$/.test(money)) out.monetization = 'off';
      else if (/^(manuel|manual)$/.test(money)) out.monetization = 'manual';
      else throw new Error(`${CHANNEL_FILE} : monétisation inconnue (${monetizationValue}).`);
    }
    const publishValue = fb.publier ?? fb.publish;
    const mode = norm(String(publishValue || ''));
    if (mode) {
      if (!/^(video|reel|short|vertical|non|no|off|rien|oui|yes|on)$/.test(mode)) {
        throw new Error(`${CHANNEL_FILE} : facebook.publier est inconnu (${publishValue}).`);
      }
      out.facebook = !/^(non|no|off|rien)$/.test(mode);
      out.facebookMode = /reel|short|vertical/.test(mode) ? 'reel' : 'video';
    }
    if (fb.page) {
      if (!validFacebookPage(fb.page)) throw new Error(`${CHANNEL_FILE} : facebook.page doit être un lien https://www.facebook.com/…`);
      out.facebookPageUrl = String(fb.page).trim();
    }
    return out;
  }

  // Bridge with the KappGen software: the extension's state (networks, per-channel settings, last activity) is
  // written at the root of the chosen folder, so KappGen shows it without asking the user anything again.
  const BRIDGE_FILE = '.kappgen-extension.json';
  async function exportState(state) {
    const dir = await root();
    const handle = await dir.getFileHandle(BRIDGE_FILE, { create: true });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(state, null, 2));
    await writable.close();
    return { written: BRIDGE_FILE };
  }

  async function writeState(dir, state) {
    const handle = await dir.getFileHandle(STATE_FILE, { create: true });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(state, null, 2));
    await writable.close();
  }

  // ---------------------------------------------------------------- scan

  // Builds { name, path, files: Map(name -> handle), dirs: [], parent }.
  async function walk(handle, path, parent, depth) {
    const node = { name: handle.name, path, files: new Map(), dirs: [], parent, handle };
    for await (const [name, child] of handle.entries()) {
      if (name.startsWith('.') || name.startsWith('_')) continue;
      if (child.kind === 'file') {
        node.files.set(name, child);
      } else if (depth < MAX_DEPTH && !SKIP.has(norm(name)) && !NET_DIR_NAMES.has(norm(name))) {
        node.dirs.push(await walk(child, path ? `${path}/${name}` : name, node, depth + 1));
      }
    }
    return node;
  }

  const pathIn = (node, name) => (node.path ? `${node.path}/${name}` : name);

  async function readSheets(node, names) {
    const sheet = {};
    for (const name of names) {
      const file = await node.files.get(name).getFile();
      if (file.size > 512 * 1024) continue;
      const part = KappFiches.read(name, await file.text());
      for (const [key, value] of Object.entries(part)) {
        if (value && (!Array.isArray(value) || value.length)) sheet[key] = value;
      }
      sheet.sheetPath = sheet.sheetPath || pathIn(node, name);
    }
    return sheet;
  }

  const sharedSheets = (node) => [...node.files.keys()].filter((name) => SHEET_NAMES.test(name)).sort();
  // No sheet with a known name: any short .txt / .md of the folder (first
  // line = title, the rest = description). Names like texte/legende first.
  async function anyText(node) {
    const names = [...node.files.keys()]
      .filter((name) => /\.(txt|md)$/i.test(name) && name !== MARKER_FILE && !NOT_A_SHEET.test(norm(stem(name))))
      .sort((a, b) => Number(!/texte|text|legende|caption|description|post|titre|title/i.test(a)) - Number(!/texte|text|legende|caption|description|post|titre|title/i.test(b)) || a.localeCompare(b));
    for (const name of names) {
      const file = await node.files.get(name).getFile();
      if (file.size > 0 && file.size <= FALLBACK_MAX) return [name];
    }
    return [];
  }

  function ownSheets(node, videoName) {
    const base = stem(videoName).toLowerCase();
    return [...node.files.keys()].filter((name) => /\.(md|txt|json)$/i.test(name) && stem(name).toLowerCase() === base);
  }

  async function thumbnailIn(nodes, videoName) {
    const base = stem(videoName).toLowerCase();
    const rank = (name) => {
      const s = norm(stem(name));
      if (s === 'miniature' || s === 'thumbnail') return 0;
      if (stem(name).toLowerCase() === base) return 1;
      if (/^(miniature|thumbnail|thumb)/.test(s)) return 2;
      return 9;
    };
    for (const node of nodes) {
      if (!node) continue;
      const best = [...node.files.keys()]
        .filter((name) => IMAGE_EXT.test(name) && rank(name) < 9)
        .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0];
      if (best) {
        const file = await node.files.get(best).getFile();
        return { path: pathIn(node, best), size: file.size, modified: file.lastModified };
      }
    }
    // None named « miniature »: the image of the video's own folder.
    const own = nodes[0];
    const any = own && [...own.files.keys()].filter((name) => IMAGE_EXT.test(name)).sort()[0];
    if (any) {
      const file = await own.files.get(any).getFile();
      return { path: pathIn(own, any), size: file.size, modified: file.lastModified };
    }
    return null;
  }

  function channelOf(start, rootNode) {
    let node = start;
    while (node && node !== rootNode && CONTAINERS.has(norm(node.name))) node = node.parent;
    return node || rootNode;
  }

  async function videosOf(node) {
    const list = [];
    for (const [name, handle] of node.files) {
      if (!VIDEO_EXT.test(name)) continue;
      if (isDerivativeVideo(name)) continue;
      const file = await handle.getFile();
      if (file.size >= MIN_SIZE) list.push({ name, size: file.size, modified: file.lastModified });
    }
    return list.sort((a, b) => b.size - a.size);
  }

  async function verticalVideoIn(nodes, videoName) {
    const base = stem(videoName).toLowerCase();
    const candidates = [
      'short.mp4', 'short.m4v', 'shorts.mp4', 'reel.mp4', 'reels.mp4',
      'vertical.mp4', 'vertical.m4v',
      `${base}-short.mp4`, `${base}-short.m4v`, `${base}_short.mp4`,
      `${base}-reel.mp4`, `${base}_reel.mp4`, `${base}-vertical.mp4`,
    ];
    const candidateSet = new Set(candidates.map((name) => name.toLowerCase()));
    const dirs = [];
    for (const node of nodes) {
      if (!node) continue;
      dirs.push(node);
      for (const child of node.dirs || []) {
        if (/^(short|shorts|reel|reels|vertical|social)$/i.test(norm(child.name))) dirs.push(child);
      }
    }
    for (const node of dirs) {
      const names = [...node.files.keys()].filter((name) => {
        const lower = name.toLowerCase();
        return VIDEO_EXT.test(name) && (candidateSet.has(lower) || (isDerivativeVideo(name) && lower.startsWith(`${base}-`)));
      });
      if (!names.length) continue;
      const name = names.sort()[0];
      const file = await node.files.get(name).getFile();
      return { path: pathIn(node, name), size: file.size, modified: file.lastModified };
    }
    return null;
  }

  // Every video under the selected folder, with its sheet, thumbnail and
  // publication state. The selected folder may be VIDEO/ (all packages) or
  // one individual package. A package inherits a publication record from the
  // nearest .kappgen-publications.json above it, so changing the selected
  // folder cannot make an already published video look new.
  function hashOf(parts) {
    let h = 5381;
    for (const ch of parts.map((x) => String(x == null ? '' : x)).join('\u0001')) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
    return h.toString(36);
  }

  // watchSince: when the folder started being watched. Only videos finished
  // after it go out on their own; the ones already there wait for a click.
  async function scan({ channels: settings = {}, watchSince = 0, now = Date.now() } = {}) {
    const rootHandle = await root();
    const tree = await walk(rootHandle, '', null, 0);
    const states = new Map();

    async function stateFor(node) {
      if (!states.has(node)) states.set(node, await readState(node.handle));
      return states.get(node);
    }

    function recordFor(node, relativePath, videoName) {
      for (let current = node; current; current = current.parent) {
        const state = states.get(current) || {};
        const prefix = current.path ? `${current.path}/` : '';
        const localPath = relativePath.startsWith(prefix)
          ? relativePath.slice(prefix.length)
          : videoName;
        const record = state[localPath] || state[videoName];
        if (record) return record;
      }
      return {};
    }

    const sides = new Map();
    async function sideFor(node) {
      if (!sides.has(node)) sides.set(node, await readSide(node.handle));
      return sides.get(node);
    }
    const configs = new Map();
    async function configFor(node) {
      if (!configs.has(node)) configs.set(node, await channelConfig(node));
      return configs.get(node);
    }

    const units = [];

    async function visit(node) {
      await stateFor(node);
      const videos = await videosOf(node);
      if (videos.length) {
        const isRender = RENDER_DIRS.has(norm(node.name)) && node.parent;
        let shared = sharedSheets(node);
        if (!shared.length && !videos.some((video) => ownSheets(node, video.name).length)) shared = await anyText(node);
        const rest = [];
        for (const video of videos) {
          const own = ownSheets(node, video.name);
          if (own.length) {
            const start = isRender ? node.parent.parent || tree : node;
            units.push({ node, video, sheets: [[node, own]], thumbs: [node], channel: channelOf(start, tree), kind: 'fiche' });
          } else {
            rest.push(video);
          }
        }
        if (rest.length && isRender) {
          const project = node.parent;
          const sheets = shared.length ? [[node, shared]] : [[project, sharedSheets(project)]];
          units.push({ node, video: rest[0], sheets, thumbs: [node, project], channel: channelOf(project.parent || tree, tree), kind: 'projet' });
        } else if (rest.length && shared.length) {
          units.push({ node, video: rest[0], sheets: [[node, shared]], thumbs: [node], channel: channelOf(node.parent || tree, tree), kind: 'projet' });
          for (const video of rest.slice(1)) units.push({ node, video, sheets: [], thumbs: [], channel: channelOf(node, tree), kind: 'vrac' });
        } else {
          for (const video of rest) units.push({ node, video, sheets: [], thumbs: [], channel: channelOf(node, tree), kind: 'vrac' });
        }
      }
      for (const child of node.dirs) await visit(child);
    }
    await visit(tree);

    // Videos with a sheet tell which folders are channels. A loose video
    // belongs to the nearest of those above it (work copies, clip folders),
    // and a loose copy of a video already found with its sheet is dropped.
    const strong = new Set(units.filter((u) => u.kind !== 'vrac').map((u) => u.channel));
    const known = new Set(units.filter((u) => u.kind !== 'vrac').map((u) => `${u.video.name}|${u.video.size}`));
    for (let i = units.length - 1; i >= 0; i -= 1) {
      const unit = units[i];
      if (unit.kind !== 'vrac') continue;
      if (known.has(`${unit.video.name}|${unit.video.size}`)) {
        units.splice(i, 1);
        continue;
      }
      for (let node = unit.node; node; node = node.parent) {
        if (strong.has(node)) {
          unit.channel = node;
          break;
        }
      }
    }

    // Copies of a video already sent (same name and size, e.g. VIDEO/ and
    // renders/) must never go out a second time.
    const sentCopies = new Set();
    for (const unit of units) {
      const rec = (await sideFor(unit.node))[unit.video.name] || recordFor(unit.node, pathIn(unit.node, unit.video.name), unit.video.name);
      if (rec.status === 'published' || rec.status === 'ignored') sentCopies.add(`${unit.video.name}|${unit.video.size}`);
    }

    const videos = [];
    const channels = new Map();
    const sent = [];
    const excluded = []; // « Ne pas publier » : never sent, listed apart
    for (const unit of units) {
      const { node, video, channel } = unit;
      const relativePath = pathIn(node, video.name);
      const side = await sideFor(node);
      const record = side[video.name] || recordFor(node, relativePath, video.name);
      // The chosen folder may itself be a channel: it gets its own key (its
      // name), so two channel folders chosen one after the other never share
      // settings or the YouTube channel learned at the first upload.
      const channelKey = channel.path || `./${tree.name}`;
      const fileConfig = await configFor(channel);
      const channelName = channel.path ? channel.name : tree.name;
      // "Déjà publiée" (published by hand) counts as sent: it is listed in the
      // YouTube tab, never sent again, never "updated" (no YouTube link).
      if (record.status === 'excluded') {
        excluded.push({ relative_path: relativePath, channel_key: channelKey, channel_name: channelName, name: video.name,
          size_bytes: video.size, date: record.date || null });
        continue;
      }
      const isSent = record.status === 'published' || record.status === 'ignored';
      if (!isSent && sentCopies.has(`${video.name}|${video.size}`)) continue;
      if (!isSent && unit.kind === 'vrac' && now - video.modified > LOOSE_MAX_AGE) continue;

      let sheet = {};
      for (const [owner, names] of unit.sheets) {
        if (owner && names.length) sheet = { ...sheet, ...(await readSheets(owner, names)) };
      }
      // "## Destination" in the sheet without YouTube (e.g. site only): not ours.
      if (sheet.destination && !isSent) {
        const d = KappFiches.plain(sheet.destination);
        const notYoutube = !/youtube/.test(d) || /\b(non|pas|jamais|sans|not|no)\b[^.\n]{0,40}youtube/.test(d)
          || /\b(site|facebook|tiktok|instagram)\b[^.\n]{0,40}\b(uniquement|seulement|only|exclusi)/.test(d);
        if (notYoutube) continue;
      }
      const thumb = await thumbnailIn(unit.thumbs, video.name);
      const vertical = await verticalVideoIn([node, node.parent, node.parent && node.parent.parent], video.name);
      // What YouTube should show: changes to it are applied automatically.
      // Independent of the chosen folder: only the thumbnail's own name counts.
      const hash = hashOf([sheet.title, sheet.description, (sheet.tags || []).join(','), thumb && thumb.path.split('/').pop(), thumb && thumb.size, thumb && thumb.modified]);
      if (isSent) {
        sent.push({ manual: record.status === 'ignored', relative_path: relativePath, channel_key: channelKey, channel_name: channelName, size_bytes: video.size,
          youtube_id: record.youtubeId || null, date: record.date,
          title: sheet.title ? KappFiches.clean(sheet.title, 100) : null,
          description: KappFiches.clean(sheet.description, 5000),
          tags: KappFiches.fitTags(sheet.tags),
          thumbnail_path: thumb && thumb.size <= 2 * 1024 * 1024 ? thumb.path : null,
          preview_path: thumb ? thumb.path : null,
          hash, has_content: !!(sheet.title || sheet.description || thumb),
          applied_hash: record.appliedHash || null, update_tried_hash: record.updateTriedHash || null,
          force_update: !!record.forceUpdate, update_error: record.updateError || null,
          vertical_path: vertical && vertical.path, vertical_size_bytes: vertical && vertical.size,
          short_youtube_id: record.shortYoutubeId || null, facebook_published_at: record.facebookPublishedAt || null,
          facebook_error: record.facebookError || null, published_at: record.youtubePublishedAt || record.publishedAt || null,
          tiktok_published_at: record.tiktokPublishedAt || null, tiktok_error: record.tiktokError || null,
          instagram_published_at: record.instagramPublishedAt || null, instagram_error: record.instagramError || null,
          short_error: record.shortError || null,
          facebook_reel_at: record.facebookReelAt || null, facebook_reel_error: record.facebookReelError || null,
          x_published_at: record.xPublishedAt || null, x_error: record.xError || null,
          linkedin_published_at: record.linkedinPublishedAt || null, linkedin_error: record.linkedinError || null,
          channel_config: fileConfig });
        continue;
      }
      if (!channels.has(channelKey)) channels.set(channelKey, { key: channelKey, name: channelName, videos: 0, config: fileConfig });
      channels.get(channelKey).videos += 1;

      const config = { ...(settings[channelKey] || {}), ...fileConfig };
      const running = record.status === 'started' && now - (record.startedAt || 0) < STARTED_LOCK_MS;
      // Started long ago and never finished: the video may already be on
      // YouTube (Studio stuck, extension reloaded). Never re-send it alone.
      const interrupted = record.status === 'started' && !running;
      let blocked = null;
      if (config.auto === false) blocked = 'publication automatique désactivée pour cette chaîne';
      else if (!sheet.title) blocked = 'pas de fiche avec un titre : envoi manuel seulement';
      else if (now - video.modified < SETTLE_MS) blocked = 'fichier modifié il y a moins de 10 min';
      else if (watchSince && video.modified < watchSince) blocked = 'déjà dans le dossier quand tu l’as choisi : clique « Publier sur YouTube » pour l’envoyer';
      else if (record.status === 'failed') blocked = 'dernier envoi en échec : relance-le à la main';
      else if (running) blocked = 'envoi déjà en cours';
      else if (interrupted) blocked = 'envoi précédent interrompu : vérifie dans YouTube Studio qu’elle n’y est pas déjà, puis relance à la main';

      const bigThumb = thumb && thumb.size > 2 * 1024 * 1024;
      videos.push({
        id: relativePath,
        relative_path: relativePath,
        title: KappFiches.clean(sheet.title || stem(video.name).replace(/[-_]+/g, ' '), 100),
        titles: sheet.titles || null,
        has_sheet: !!sheet.title,
        description: KappFiches.clean(sheet.description, 5000),
        tags: KappFiches.fitTags(sheet.tags),
        comment: sheet.comment || null,
        sheet_path: sheet.sheetPath || null,
        thumbnail_path: thumb && !bigThumb ? thumb.path : null,
        preview_path: thumb ? thumb.path : null,
        hash,
        thumbnail_warning: bigThumb ? 'miniature de plus de 2 Mo : YouTube la refuse' : null,
        channel_key: channelKey,
        channel_name: channelName,
        kind: unit.kind,
        size_bytes: video.size,
        finished_at: video.modified,
        auto_ok: !blocked,
        auto_blocked: blocked,
        running,
        last_error: record.status === 'failed' ? record.error : null,
        schedule_at: record.scheduleAt || null,
        vertical_path: vertical && vertical.path,
        vertical_size_bytes: vertical && vertical.size,
        channel_config: fileConfig,
        interrupted,
      });
    }
    // Channels with only sent videos still show in the settings.
    for (const unit of units) {
      const key = unit.channel.path || `./${tree.name}`;
      if (!channels.has(key)) channels.set(key, { key, name: unit.channel.path ? unit.channel.name : tree.name, videos: 0, config: await configFor(unit.channel) });
    }
    // A re-render or a renamed file is not the same name+size, but the same
    // title on the same channel is the same video: never send it again alone.
    const titleKey = (key, title) => `${key}|${String(title || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()}`;
    const sentTitles = new Map(sent.filter((s) => s.title).map((s) => [titleKey(s.channel_key, s.title), s]));
    for (const v of videos) {
      const twin = v.has_sheet && sentTitles.get(titleKey(v.channel_key, v.title));
      const node = units.find((u) => pathIn(u.node, u.video.name) === v.relative_path);
      if (twin) {
        v.already_sent = twin.youtube_id || true;
        v.auto_ok = false;
        v.auto_blocked = `déjà publiée sous le même titre (${twin.youtube_id ? `youtu.be/${twin.youtube_id}` : twin.relative_path}) : vérifie avant de la renvoyer à la main`;
      } else if (node && node.node.files.has(MARKER_FILE)) {
        v.already_sent = true;
        v.auto_ok = false;
        v.auto_blocked = `dossier marqué ${MARKER_FILE} : vidéo déjà publiée, vérifie avant de la renvoyer à la main`;
      }
    }
    videos.sort((a, b) => a.channel_key.localeCompare(b.channel_key) || a.relative_path.localeCompare(b.relative_path));
    for (const v of [...videos, ...sent]) {
      scanInfo.set(v.relative_path, { title: v.title, thumb: v.thumbnail_path || v.preview_path || null, channel: v.channel_name || null });
    }
    return { folder: tree.name, videos, sent, excluded, channels: [...channels.values()].sort((a, b) => a.key.localeCompare(b.key)) };
  }

  // --------------------------------------------------------------- state

  // ------------------------------------------------------------ history
  //
  // Every publication written below also goes into the extension's own
  // history (lib/historique.js), with a title, a thumbnail and a link.
  const scanInfo = new Map(); // relative_path → { title, thumb, channel } of the last scan
  const history = () => (typeof KappHistorique !== 'undefined' ? KappHistorique : null);
  // What a video record gained: [field, network, kind, link].
  const VIDEO_MARKS = [
    ['youtubeId', 'youtube', 'video', (id) => `https://youtu.be/${id}`],
    ['shortYoutubeId', 'youtube', 'short', (id) => `https://www.youtube.com/shorts/${id}`],
    ['facebookPublishedAt', 'facebook', 'video'], ['facebookReelAt', 'facebook', 'reel'],
    ['xPublishedAt', 'x', 'video'], ['linkedinPublishedAt', 'linkedin', 'video'],
    ['tiktokPublishedAt', 'tiktok', 'video'], ['instagramPublishedAt', 'instagram', 'reel'],
  ];
  async function fileIn(dir, name) {
    try { return await (await dir.getFileHandle(name)).getFile(); } catch { return null; }
  }
  async function recordVideo(relativePath, videoDir, videoName, before, after, manual) {
    const h = history();
    if (!h || !after) return;
    // A YouTube draft (link known before the upload is finished) is not a
    // publication yet: it enters the history once the upload is done.
    const gained = VIDEO_MARKS.filter(([key]) => after[key] && (after[key] !== (before || {})[key]
      || (key === 'youtubeId' && before && before.draft && !after.draft)))
      .filter(([key]) => !(key === 'youtubeId' && after.draft));
    if (!gained.length) return;
    const info = scanInfo.get(relativePath) || {};
    let thumbFile = null;
    if (info.thumb) thumbFile = await fileAt(info.thumb).catch(() => null);
    if (!thumbFile) {
      const images = [];
      for await (const [name, handle] of videoDir.entries()) if (handle.kind === 'file' && IMAGE_EXT.test(name)) images.push(name);
      images.sort((a, b) => Number(!/miniature|thumb/i.test(a)) - Number(!/miniature|thumb/i.test(b)) || a.localeCompare(b));
      thumbFile = images.length ? await fileIn(videoDir, images[0]) : await fileIn(videoDir, videoName);
    }
    const title = info.title || stem(videoName).replace(/[-_]+/g, ' ');
    for (const [key, net, kind, link] of gained) {
      const value = after[key];
      const at = typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : Date.now();
      await h.add({ net, kind, path: relativePath, title, at, url: link ? link(value) : null, channel: info.channel, manual, thumbFile });
    }
  }
  async function recordPost(path, dir, info, patch) {
    const h = history();
    if (!h) return;
    const nets = [];
    if (patch.statut === 'publie') nets.push(['facebook', patch]);
    for (const net of POST_NETS) if (patch[net] && patch[net].statut === 'publie') nets.push([net, patch[net]]);
    if (!nets.length) return;
    const files = [];
    for await (const [name, handle] of dir.entries()) if (handle.kind === 'file') files.push(name);
    const textName = (typeof info.texte === 'string' && files.includes(info.texte) && info.texte)
      || files.filter((f) => /\.(txt|md)$/i.test(f) && f !== MARKER_FILE && !NOT_A_SHEET.test(norm(stem(f))))
        .sort((x, y) => Number(!/^texte/i.test(x)) - Number(!/^texte/i.test(y)) || x.localeCompare(y))[0];
    const textFile = textName ? await fileIn(dir, textName) : null;
    const text = textFile && textFile.size <= 64 * 1024 ? (await textFile.text()).trim() : '';
    const image = (typeof info.image === 'string' && files.includes(info.image) && info.image) || files.filter((f) => IMAGE_EXT.test(f)).sort()[0];
    const video = files.filter((f) => VIDEO_EXT.test(f)).sort()[0];
    const thumbFile = image ? await fileIn(dir, image) : video ? await fileIn(dir, video) : null;
    const kind = video ? 'reel' : image ? 'photo' : 'texte';
    for (const [net, state] of nets) {
      const at = Date.parse(state.published_at || '') || Date.now();
      await h.add({ net, kind, path, title: text.split('\n')[0] || dir.name, at, url: state.url || state.lien || null,
        manual: !!state.manuel, thumbFile });
    }
  }

  // status: started | published | failed | ignored | excluded | reset
  async function mark(relativePath, status, data = {}) {
    const rootHandle = await root();
    const state = await readState(rootHandle);
    const parts = relativePath.split('/');
    const videoName = parts.pop();
    let videoDir = rootHandle;
    for (const part of parts) videoDir = await videoDir.getDirectoryHandle(part);
    const side = await readSide(videoDir);
    // The video's own record wins; an older root record is carried over.
    if (side[videoName]) state[relativePath] = side[videoName];
    const before = state[relativePath] ? { ...state[relativePath] } : null;
    const now = Date.now();
    if (status === 'applied') {
      // Re-applied to YouTube after the sheet/thumbnail changed (status stays "published").
      const record = state[relativePath] || {};
      record.appliedAt = now;
      delete record.forceUpdate;
      if (data.error) Object.assign(record, { updateError: data.error, updateTriedHash: data.hash });
      else { record.appliedHash = data.hash; delete record.updateError; delete record.updateTriedHash; }
      state[relativePath] = record;
    } else if (status === 'schedule') {
      // Time chosen in the panel for this video (status unchanged).
      const record = state[relativePath] || {};
      if (data.at) record.scheduleAt = data.at; else delete record.scheduleAt;
      state[relativePath] = record;
    } else if (status === 'manual') {
      // « Déjà publié » : published by hand on a network. Only that network's
      // mark is written; the video's own date and state stay as they are (a
      // new date would make other networks think it is a new video).
      const record = state[relativePath] || {};
      const errors = { shortYoutubeId: 'shortError', facebookPublishedAt: 'facebookError', facebookReelAt: 'facebookReelError',
        xPublishedAt: 'xError', linkedinPublishedAt: 'linkedinError', tiktokPublishedAt: 'tiktokError', instagramPublishedAt: 'instagramError' };
      for (const [key, value] of Object.entries(data)) {
        if (!errors[key]) continue;
        record[key] = value;
        delete record[errors[key]];
        record.manual = { ...(record.manual || {}), [key]: new Date(now).toISOString() };
      }
      state[relativePath] = record;
    } else if (status === 'reset') {
      delete state[relativePath];
    } else {
      const record = state[relativePath] || {};
      if (status === 'started') {
        if (record.status === 'started' && now - (record.startedAt || 0) < STARTED_LOCK_MS) {
          throw new Error('Un autre profil Chrome envoie déjà cette vidéo.');
        }
        delete record.error;
      }
      const statusData = { status };
      // `publishedAt` is the date at which the long YouTube video was first
      // created. Social-network updates must never move that reference date:
      // it drives ordering and the "one publication at a time" scheduler.
      if (status !== 'published') {
        statusData[`${status}At`] = now;
        statusData.date = new Date(now).toISOString();
      }
      Object.assign(record, statusData);
      if (status === 'published') {
        if (data.youtubeId) {
          const firstPublishedAt = record.youtubePublishedAt || record.publishedAt || now;
          if (!record.youtubeId) record.date = new Date(firstPublishedAt).toISOString();
          Object.assign(record, { youtubeId: data.youtubeId, youtubePublishedAt: firstPublishedAt,
            publishedAt: firstPublishedAt, visibility: data.visibility || null,
            channel: data.channel || null, appliedHash: data.hash || null });
          // Link known at the start of the upload, before Visibility: a draft.
          if (data.draft) record.draft = true; else delete record.draft;
        } else if (record.youtubeId && !record.youtubePublishedAt && record.publishedAt) {
          // Lazy migration of records written by versions before 1.19.
          record.youtubePublishedAt = record.publishedAt;
        }
        if (data.shortYoutubeId) { record.shortYoutubeId = data.shortYoutubeId; delete record.shortError; }
        if (data.shortError) record.shortError = data.shortError;
        // Link given by hand: the sheet and thumbnail of the folder must be applied.
        if (data.forceUpdate) { record.forceUpdate = true; delete record.appliedHash; delete record.updateTriedHash; delete record.updateError; }
        if (data.facebookPublishedAt) { record.facebookPublishedAt = data.facebookPublishedAt; delete record.facebookError; }
        if (data.facebookError) record.facebookError = data.facebookError;
        if (data.facebookReelAt) { record.facebookReelAt = data.facebookReelAt; delete record.facebookReelError; }
        if (data.facebookReelError) record.facebookReelError = data.facebookReelError;
        if (data.xPublishedAt) { record.xPublishedAt = data.xPublishedAt; delete record.xError; }
        if (data.xError) record.xError = data.xError;
        if (data.linkedinPublishedAt) { record.linkedinPublishedAt = data.linkedinPublishedAt; delete record.linkedinError; }
        if (data.linkedinError) record.linkedinError = data.linkedinError;
        if (data.tiktokPublishedAt) { record.tiktokPublishedAt = data.tiktokPublishedAt; delete record.tiktokError; }
        if (data.tiktokError) record.tiktokError = data.tiktokError;
        if (data.instagramPublishedAt) { record.instagramPublishedAt = data.instagramPublishedAt; delete record.instagramError; }
        if (data.instagramError) record.instagramError = data.instagramError;
        if (data.commentAt) { record.commentAt = data.commentAt; delete record.commentError; }
        if (data.commentError) record.commentError = data.commentError;
      }
      if (status === 'failed') record.error = data.error || 'Erreur inconnue';
      state[relativePath] = record;
    }
    await writeState(rootHandle, state);
    if (state[relativePath]) side[videoName] = state[relativePath];
    else delete side[videoName];
    await writeSide(videoDir, side);
    await writeMarker(videoDir, side).catch(() => {});
    await recordVideo(relativePath, videoDir, videoName, before, state[relativePath], status === 'manual').catch(() => {});
    return state[relativePath] || null;
  }

  // ------------------------------------------------------ Facebook posts
  //
  // <CHAÎNE>/FACEBOOK/A-PUBLIER/<YYYY-MM-DD-HHMM-sujet>/ holds one post:
  // publication.json (date_locale, heure_prevue, statut, page…), texte.txt
  // and, for a photo post, an image (image.jpg…) or, for a Reel, a vertical
  // .mp4. A post is due once its date and time are reached; it is published
  // once ("statut": "publie" is written back into publication.json).
  // The page comes from publication.json, then FACEBOOK/planning.json.

  async function readJsonResult(dir, name) {
    try {
      const file = await (await dir.getFileHandle(name)).getFile();
      if (file.size > 256 * 1024) return { exists: true, value: null, error: `${name} est trop volumineux (256 Ko maximum).` };
      const text = (await file.text()).replace(/^\uFEFF/, '');
      try {
        return { exists: true, value: JSON.parse(text), error: null };
      } catch (error) {
        return { exists: true, value: null, error: `JSON invalide dans ${name} : ${error.message}` };
      }
    } catch (error) {
      if (error && (error.name === 'NotFoundError' || /not found/i.test(error.message || ''))) {
        return { exists: false, value: null, error: null };
      }
      return { exists: false, value: null, error: `Impossible de lire ${name} : ${error.message || error}` };
    }
  }

  async function readObjectResult(dir, name) {
    const result = await readJsonResult(dir, name);
    if (!result.error && result.value != null
      && (typeof result.value !== 'object' || Array.isArray(result.value))) {
      return { ...result, value: null, error: `${name} doit contenir un objet JSON.` };
    }
    return result;
  }

  // The <NETWORK> folders (FACEBOOK, X, LINKEDIN…) inside the main folder.
  async function findNetDirs(dir, path, depth, out, names) {
    for await (const [name, child] of dir.entries()) {
      if (child.kind !== 'directory' || name.startsWith('.') || name.startsWith('_')) continue;
      const childPath = path ? `${path}/${name}` : name;
      if (names.includes(norm(name))) out.push({ handle: child, path: childPath, channelPath: path, channelName: dir.name });
      else if (depth < 4 && !SKIP.has(norm(name)) && !NET_DIR_NAMES.has(norm(name))) await findNetDirs(child, childPath, depth + 1, out, names);
    }
  }

  function dueTime(info, folderName) {
    const date = info.date_locale || (folderName.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1];
    const time = info.heure_prevue || ((folderName.match(/^\d{4}-\d{2}-\d{2}-(\d{2})(\d{2})/) || []).slice(1).join(':')) || '00:00';
    if (!date) return null;
    const dateMatch = String(date).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const timeMatch = String(time).match(/^(\d{1,2})[:hH](\d{2})$/);
    if (!dateMatch) throw new Error(`date_locale invalide (${date}) : format attendu AAAA-MM-JJ`);
    if (!timeMatch) throw new Error(`heure_prevue invalide (${time}) : format attendu HH:MM`);
    const [, ys, ms, ds] = dateMatch;
    const [, hs, mins] = timeMatch;
    const [y, m, d, hh, mm] = [ys, ms, ds, hs, mins].map(Number);
    if (hh > 23 || mm > 59) throw new Error(`heure_prevue invalide (${time})`);
    const value = new Date(y, m - 1, d, hh, mm);
    if (value.getFullYear() !== y || value.getMonth() !== m - 1 || value.getDate() !== d) {
      throw new Error(`date_locale invalide (${date})`);
    }
    return value.getTime();
  }

  // Where a network's posts are. With its own folder chosen: every folder
  // inside it that holds an image, a video or a text is one post (any layout,
  // any names). Without one: the <NETWORK>/A-PUBLIER folders of the main
  // folder (FACEBOOK/A-PUBLIER, X/A-PUBLIER, LINKEDIN/A-PUBLIER…).
  async function postDirs(net = 'facebook') {
    const own = await netRoot(net);
    const out = [];
    const join = (...parts) => parts.filter(Boolean).join('/');
    // Posts, Reels and carousels are the same everywhere (Roosevelt, 02/10):
    // a network without a folder of its own takes Facebook's posts too, as
    // well as its own <NETWORK>/A-PUBLIER folders of the main folder if any.
    // Each network keeps its own state in the same publication.json.
    if (!own && net !== 'facebook' && !net.startsWith('__main:')) {
      const mine = await postDirs(`__main:${net}`);
      const seen = new Set(mine.map((d) => d.path));
      for (const d of await postDirs('facebook')) if (!seen.has(d.path)) mine.push({ ...d, shared: true });
      return mine;
    }
    if (net.startsWith('__main:')) net = net.slice('__main:'.length);
    if (!own) {
      const main = testRoot || await loadRoot();
      if (!main) return out;
      await mainRoot();
      // Paths of the main folder are YouTube's paths, unless YouTube has its own folder.
      const pre = !testRoot && await loadNetRoot('youtube') ? MAIN_PREFIX : '';
      const dirs = [];
      await findNetDirs(main, '', 0, dirs, NET_DIRS[net]);
      for (const fb of dirs) {
        let queue;
        try { queue = await fb.handle.getDirectoryHandle('A-PUBLIER'); } catch { continue; }
        const planningResult = await readObjectResult(fb.handle, 'planning.json');
        const planning = planningResult.value || {};
        for await (const [name, handle] of queue.entries()) {
          if (handle.kind !== 'directory' || name.startsWith('.') || name.startsWith('_')) continue;
          out.push({ handle, name, path: pre + join(fb.path, 'A-PUBLIER', name), planning,
            planningError: planningResult.error,
            channelKey: fb.channelPath || '.', channelName: fb.channelPath ? fb.channelName : `${fb.channelName} (dossier principal)` });
        }
      }
      return out;
    }
    // Inside the main folder? Then its channel (and its Page setting) is known.
    let inside = null;
    try {
      const main = testRoot || await loadRoot();
      if (main && (await stateOf(main)).state === 'granted') inside = await main.resolve(own);
    } catch { inside = null; }
    const channelOf = () => {
      // The channel is the folder above « FACEBOOK » / « A-PUBLIER » when there is one.
      const full = inside ? [...inside] : null;
      while (full && full.length && (NET_DIR_NAMES.has(norm(full[full.length - 1])) || norm(full[full.length - 1]) === 'a publier')) full.pop();
      if (full && full.length) return { channelKey: full.join('/'), channelName: full[full.length - 1] };
      return { channelKey: prefixOf(net), channelName: own.name };
    };
    const { channelKey, channelName } = channelOf();
    const planningResult = await readObjectResult(own, 'planning.json');
    const planning = planningResult.value || {};
    async function visit(dir, rel, depth) {
      const files = [];
      const children = [];
      for await (const [name, handle] of dir.entries()) {
        if (name.startsWith('.') || name.startsWith('_')) continue;
        if (handle.kind === 'file') files.push(name);
        else if (depth < 6 && !SKIP.has(norm(name))) children.push([name, handle]);
      }
      const media = files.some((f) => IMAGE_EXT.test(f) || VIDEO_EXT.test(f));
      const text = files.some((f) => /\.(txt|md)$/i.test(f) && f !== MARKER_FILE && !NOT_A_SHEET.test(norm(stem(f))));
      if (rel && (media || text || files.includes('publication.json'))) {
        out.push({ handle: dir, name: dir.name, path: `${prefixOf(net)}${rel}`, planning,
          planningError: planningResult.error, channelKey, channelName });
      }
      for (const [name, handle] of children) await visit(handle, join(rel, name), depth + 1);
    }
    await visit(own, '', 0);
    return out;
  }

  // net: "facebook" (the posts of the Facebook folder, also shared with the
  // other networks), or a network's own posts (its folder, or its
  // <NETWORK>/A-PUBLIER folders): their state is the one of that network.
  async function facebookPosts({ now = Date.now(), times = '', net = 'facebook' } = {}) {
    const posts = [];
    for (const dirInfo of await postDirs(net)) {
      const postDir = dirInfo.handle;
      const name = dirInfo.name;
      const config = await readJsonResult(postDir, 'publication.json');
      let configurationError = [config.error, dirInfo.planningError].filter(Boolean).join(' ') || null;
      const invalidate = (message) => { if (!configurationError) configurationError = message; };
      let info = config.value;
      if (info != null && (!info || typeof info !== 'object' || Array.isArray(info))) {
        invalidate('publication.json doit contenir un objet JSON.');
        info = null;
      }
      info = info || {};
      const files = [];
      for await (const [fileName, handle] of postDir.entries()) if (handle.kind === 'file') files.push(fileName);
      if (!files.some((f) => IMAGE_EXT.test(f) || VIDEO_EXT.test(f) || /\.(txt|md)$/i.test(f) || f === 'publication.json')) continue;
      const path = dirInfo.path;
      // The text: texte*.txt, or any short .txt / .md of the folder, as written.
      const texts = files.filter((f) => /\.(txt|md)$/i.test(f) && f !== MARKER_FILE && !NOT_A_SHEET.test(norm(stem(f))) && !/^commentaires?\b/.test(norm(stem(f))))
        .sort((x, y) => Number(!/^texte/i.test(x)) - Number(!/^texte/i.test(y)) || x.localeCompare(y));
      if (info.texte != null && (typeof info.texte !== 'string' || !files.includes(info.texte) || !/\.(txt|md)$/i.test(info.texte))) {
        invalidate('Le champ texte doit désigner un fichier .txt ou .md présent dans le dossier.');
      }
      const textName = info.texte && files.includes(info.texte) ? info.texte : texts[0];
      let text = '';
      if (textName) {
        const file = await (await postDir.getFileHandle(textName)).getFile();
        if (file.size <= 64 * 1024) text = (await file.text()).trim();
        else invalidate(`Le texte ${textName} dépasse 64 Ko.`);
      }
      // The comment posted under the post once it is out: "commentaire" in
      // publication.json, or a commentaire*.txt / .md file of the folder.
      let comment = typeof info.commentaire === 'string' ? info.commentaire.trim() : '';
      if (!comment) {
        const commentName = files.filter((f) => /\.(txt|md)$/i.test(f) && /^commentaires?\b/.test(norm(stem(f)))).sort()[0];
        if (commentName) {
          const file = await (await postDir.getFileHandle(commentName)).getFile();
          if (file.size <= 8 * 1024) comment = (await file.text()).trim();
        }
      }
      if (info.image != null && (typeof info.image !== 'string' || !files.includes(info.image) || !IMAGE_EXT.test(info.image))) {
        invalidate('Le champ image doit désigner une image présente dans le dossier.');
      }
      const image = info.image && files.includes(info.image) ? info.image : files.filter((f) => IMAGE_EXT.test(f)).sort()[0];
      const video = files.filter((f) => VIDEO_EXT.test(f)).sort()[0];
      let due = null;
      try { due = dueTime(info, name); } catch (error) { invalidate(error.message || String(error)); }
      const plannedPage = isPagePlaceholder(dirInfo.planning.page) ? null : dirInfo.planning.page;
      const page = info.page || plannedPage || null;
      if (net === 'facebook' && page && !validFacebookPage(page)) {
        invalidate('Le champ page doit être un lien https://www.facebook.com/…');
      }
      if (dirInfo.shared && due && due < new Date(now).setHours(0, 0, 0, 0)) continue;
      // A network's own post keeps its state under the network's name. Every
      // stored state is checked even while the Facebook view is being built:
      // a typo such as "publiee" must not silently suppress a destination.
      const allowedStates = new Set(['a_publier', 'en_cours', 'publie', 'echec', 'a_verifier']);
      const validateNetworkState = (state, label) => {
        if (!state || typeof state !== 'object' || Array.isArray(state)) {
          invalidate(`Le champ ${label} doit contenir un objet JSON.`);
          return false;
        }
        if (state.statut != null && (typeof state.statut !== 'string' || !allowedStates.has(state.statut))) {
          invalidate(`Statut invalide pour ${label} (${state.statut}).`);
        }
        for (const key of ['started_at', 'published_at']) {
          if (state[key] != null && (typeof state[key] !== 'string' || !Number.isFinite(Date.parse(state[key])))) {
            invalidate(`${label}.${key} doit être une date ISO valide.`);
          }
        }
        if (state.erreur != null && typeof state.erreur !== 'string') invalidate(`${label}.erreur doit contenir du texte.`);
        return true;
      };
      for (const target of POST_NETS) if (info[target] != null) validateNetworkState(info[target], target);
      const mine = net === 'facebook' ? info
        : (info[net] && typeof info[net] === 'object' && !Array.isArray(info[net]) ? info[net] : {});
      validateNetworkState(mine, net);
      if (net === 'facebook') {
        if (info.groupes != null && typeof info.groupes !== 'boolean'
          && (!Array.isArray(info.groupes) || info.groupes.some((url) => typeof url !== 'string' || !validFacebookGroup(url)))) {
          invalidate('Le champ groupes doit valoir true, false ou contenir des liens https://www.facebook.com/groups/… valides.');
        }
        if (info.groupes_tires != null
          && (!Array.isArray(info.groupes_tires) || info.groupes_tires.some((url) => typeof url !== 'string' || !validFacebookGroup(url)))) {
          invalidate('Le champ groupes_tires doit contenir une liste de liens de groupes Facebook valides.');
        }
        const validSharedState = (state) => state && typeof state === 'object' && !Array.isArray(state)
          && ['publie', 'echec'].includes(state.statut)
          && (state.published_at == null || (typeof state.published_at === 'string' && Number.isFinite(Date.parse(state.published_at))))
          && (state.erreur == null || typeof state.erreur === 'string');
        if (info.groupes_partages != null && (!info.groupes_partages || typeof info.groupes_partages !== 'object'
          || Array.isArray(info.groupes_partages) || Object.values(info.groupes_partages).some((state) => !validSharedState(state)))) {
          invalidate('Le champ groupes_partages doit contenir un objet d’états par groupe.');
        }
      }
      let statut = configurationError ? 'configuration_invalide' : (mine.statut || 'a_publier');
      // Stuck « en cours » (tab closed, envoi débloqué à la main): offer to retry.
      if (statut === 'en_cours' && mine.started_at && now - Date.parse(mine.started_at) > 20 * 60000) {
        statut = 'echec';
        mine.erreur = mine.erreur || 'Publication interrompue : vérifie si elle est partie, sinon « Réessayer ».';
      }
      const post = {
        id: path,
        path,
        channel_key: dirInfo.channelKey,
        channel_name: dirInfo.channelName,
        page,
        type: video ? 'reel' : image ? 'photo' : 'texte',
        text: text.slice(0, 63000),
        comment: comment.slice(0, 8000) || null,
        comment_delay: info.commentaire_delai != null && Number.isFinite(Number(info.commentaire_delai)) ? Math.min(1440, Math.max(0, Number(info.commentaire_delai))) : null,
        comment_statut: info.commentaire_statut || null,
        comment_error: info.commentaire_erreur || null,
        image_path: image ? `${path}/${image}` : null,
        video_path: video ? `${path}/${video}` : null,
        network: net,
        shared: !!dirInfo.shared,
        due_at: due,
        statut,
        error: configurationError || mine.erreur || null,
        configuration_error: configurationError || null,
        started_at: mine.started_at || null,
        published_at: mine.published_at || null,
        tiktok_statut: (info.tiktok && info.tiktok.statut) || null,
        tiktok_error: (info.tiktok && info.tiktok.erreur) || null,
        x_statut: (info.x && info.x.statut) || null,
        x_error: (info.x && info.x.erreur) || null,
        linkedin_statut: (info.linkedin && info.linkedin.statut) || null,
        linkedin_error: (info.linkedin && info.linkedin.erreur) || null,
        instagram_statut: (info.instagram && info.instagram.statut) || null,
        instagram_error: (info.instagram && info.instagram.erreur) || null,
        // Facebook groups: "groupes" in publication.json overrides the panel's
        // list for this post (false = none); what happened in each one.
        groups: Array.isArray(info.groupes) || typeof info.groupes === 'boolean' ? info.groupes : null,
        groups_shared: info.groupes_partages && typeof info.groupes_partages === 'object' ? info.groupes_partages : {},
        groups_drawn: Array.isArray(info.groupes_tires) ? info.groupes_tires : null,
      };
      posts.push(post);
    }
    // The time of a post is the one written in it (publication.json or the
    // folder name, set by whoever prepares the post). Without one, it goes now.
    for (const post of posts) {
      post.needs_times = false;
      post.ready = !post.configuration_error && post.statut === 'a_publier' && (!post.due_at || post.due_at <= now) && !!(post.text || post.image_path || post.video_path);
    }
    posts.sort((a, b) => (a.due_at || 0) - (b.due_at || 0) || a.path.localeCompare(b.path));
    return posts;
  }

  // Merges patch into the post's publication.json.
  async function markPost(path, patch) {
    let [dir, inside] = await dirFor(path);
    for (const part of inside.split('/').filter(Boolean)) dir = await dir.getDirectoryHandle(part);
    const parsed = await readJsonResult(dir, 'publication.json');
    if (parsed.error) throw new Error(`${parsed.error} Corrige le fichier avant de relancer la publication.`);
    const info = parsed.value == null ? {} : parsed.value;
    if (!info || typeof info !== 'object' || Array.isArray(info)) throw new Error('publication.json doit contenir un objet JSON.');
    Object.assign(info, patch);
    const handle = await dir.getFileHandle('publication.json', { create: true });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(info, null, 2));
    await writable.close();
    await recordPost(path, dir, info, patch).catch(() => {});
    return info;
  }

  return { NETS, POST_NETS, saveRoot, loadRoot, access, folders, saveNetRoot, loadNetRoot, clearNetRoot,
    saveFbRoot, loadFbRoot, clearFbRoot, fbAccess, fileAt, scan, mark, facebookPosts, markPost, exportState,
    _setTestRoot: (h) => { testRoot = h; }, _setTestFbRoot: (h) => { testNets.facebook = h; },
    _setTestNetRoot: (net, h) => { testNets[net] = h; } };
})();
