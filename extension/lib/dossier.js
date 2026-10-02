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
// A channel folder may hold "reglages-publication.json" (see LOCAL.md and
// YOUTUBE/NORME-PUBLICATION.md): YouTube channel, visibility, hours, Facebook
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
  // Second, optional folder: Facebook Reels and posts only. Paths inside it
  // start with FB_PREFIX so every reader knows which folder they belong to.
  const FB_PREFIX = 'fb:';
  const saveFbRoot = (handle) => kv('readwrite', (store) => store.put(handle, 'fbroot'));
  const loadFbRoot = () => kv('readonly', (store) => store.get('fbroot'));
  const clearFbRoot = () => kv('readwrite', (store) => store.delete('fbroot'));

  async function fbAccess() {
    const handle = testFbRoot || await loadFbRoot();
    if (!handle) return { state: 'none' };
    return { state: testFbRoot ? 'granted' : await handle.queryPermission({ mode: 'readwrite' }), name: handle.name };
  }

  // state: "granted", "prompt", "denied" or "none" (no folder chosen yet).
  async function access() {
    const handle = await loadRoot();
    if (!handle) return { state: 'none' };
    return { state: await handle.queryPermission({ mode: 'readwrite' }), name: handle.name };
  }

  let testRoot = null; // set by tests only
  let testFbRoot = null;

  async function fbRoot() {
    if (testFbRoot) return testFbRoot;
    const handle = await loadFbRoot();
    if (!handle) return null;
    if (await handle.queryPermission({ mode: 'readwrite' }) !== 'granted') {
      throw new Error('Accès au dossier Facebook à autoriser : onglet Facebook → « Autoriser l’accès ».');
    }
    return handle;
  }

  // The folder a path belongs to, and the path inside it.
  async function dirFor(relativePath) {
    if (relativePath.startsWith(FB_PREFIX)) {
      const handle = await fbRoot();
      if (!handle) throw new Error('Aucun dossier Facebook choisi.');
      return [handle, relativePath.slice(FB_PREFIX.length)];
    }
    return [await root(), relativePath];
  }

  async function root() {
    if (testRoot) return testRoot;
    const handle = await loadRoot();
    if (!handle) throw new Error('Aucun dossier choisi : ouvre les réglages de l’extension KappGen.');
    if (await handle.queryPermission({ mode: 'readwrite' }) !== 'granted') {
      throw new Error('Accès au dossier à autoriser : ouvre les réglages de l’extension KappGen et clique « Autoriser ».');
    }
    return handle;
  }

  async function fileAt(relativePath) {
    let [dir, inside] = await dirFor(relativePath);
    const parts = inside.split('/').filter(Boolean);
    const name = parts.pop();
    for (const part of parts) dir = await dir.getDirectoryHandle(part);
    return (await dir.getFileHandle(name)).getFile();
  }

  async function readState(dir) {
    try {
      const file = await (await dir.getFileHandle(STATE_FILE)).getFile();
      return JSON.parse(await file.text());
    } catch {
      return {};
    }
  }

  async function readSide(dir) {
    try {
      const file = await (await dir.getFileHandle(SIDE_FILE)).getFile();
      return JSON.parse(await file.text());
    } catch {
      return {};
    }
  }

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

  async function jsonIn(dir, name) {
    try {
      return JSON.parse(await (await (await dir.getFileHandle(name)).getFile()).text());
    } catch {
      return null;
    }
  }

  // Channel settings written in the channel folder, in the panel's own
  // vocabulary ({ channelId, visibility, times, auto, monetization,
  // facebook, facebookPageUrl, facebookMode }). Only the keys present in the
  // files are returned.
  async function channelConfig(node) {
    if (!node || !node.handle) return {};
    const out = {};
    let adn = null;
    try { adn = await jsonIn(await node.handle.getDirectoryHandle('ADN'), 'chaine.json'); } catch { /* no ADN */ }
    if (adn && channelIdIn(adn.youtube)) out.channelId = channelIdIn(adn.youtube);
    const file = await jsonIn(node.handle, CHANNEL_FILE);
    if (!file) return out;
    const yt = file.youtube || {};
    const fb = file.facebook || {};
    if (channelIdIn(yt.chaine || yt.channel)) out.channelId = channelIdIn(yt.chaine || yt.channel);
    const vis = VISIBILITY_WORDS[norm(String(yt.visibilite || yt.visibility || ''))];
    if (vis) out.visibility = vis;
    const hours = yt.heures || yt.times;
    if (hours) out.times = Array.isArray(hours) ? hours.join(', ') : String(hours);
    if (typeof yt.auto === 'boolean') out.auto = yt.auto;
    const money = norm(String(yt.monetisation || yt.monetization || ''));
    if (money) out.monetization = /^(oui|on|activee?)$/.test(money) ? 'on' : /^(non|off|desactivee?)$/.test(money) ? 'off' : 'manual';
    const mode = norm(String(fb.publier || fb.publish || ''));
    if (mode) {
      out.facebook = !/^(non|no|off|rien)$/.test(mode);
      out.facebookMode = /reel|short|vertical/.test(mode) ? 'reel' : 'video';
    }
    if (fb.page) out.facebookPageUrl = String(fb.page);
    return out;
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
      } else if (depth < MAX_DEPTH && !SKIP.has(norm(name))) {
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
          facebook_error: record.facebookError || null, published_at: record.publishedAt || null,
          tiktok_published_at: record.tiktokPublishedAt || null, tiktok_error: record.tiktokError || null,
          instagram_published_at: record.instagramPublishedAt || null, instagram_error: record.instagramError || null,
          short_error: record.shortError || null,
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
    return { folder: tree.name, videos, sent, excluded, channels: [...channels.values()].sort((a, b) => a.key.localeCompare(b.key)) };
  }

  // --------------------------------------------------------------- state

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
      Object.assign(record, { status, [`${status}At`]: now, date: new Date(now).toISOString() });
      if (status === 'published') {
        if (data.youtubeId) {
          Object.assign(record, { youtubeId: data.youtubeId, visibility: data.visibility || null, channel: data.channel || null, appliedHash: data.hash || null });
        }
        if (data.shortYoutubeId) { record.shortYoutubeId = data.shortYoutubeId; delete record.shortError; }
        if (data.shortError) record.shortError = data.shortError;
        // Link given by hand: the sheet and thumbnail of the folder must be applied.
        if (data.forceUpdate) { record.forceUpdate = true; delete record.appliedHash; delete record.updateTriedHash; delete record.updateError; }
        if (data.facebookPublishedAt) { record.facebookPublishedAt = data.facebookPublishedAt; delete record.facebookError; }
        if (data.facebookError) record.facebookError = data.facebookError;
        if (data.tiktokPublishedAt) { record.tiktokPublishedAt = data.tiktokPublishedAt; delete record.tiktokError; }
        if (data.tiktokError) record.tiktokError = data.tiktokError;
        if (data.instagramPublishedAt) { record.instagramPublishedAt = data.instagramPublishedAt; delete record.instagramError; }
        if (data.instagramError) record.instagramError = data.instagramError;
      }
      if (status === 'failed') record.error = data.error || 'Erreur inconnue';
      state[relativePath] = record;
    }
    await writeState(rootHandle, state);
    if (state[relativePath]) side[videoName] = state[relativePath];
    else delete side[videoName];
    await writeSide(videoDir, side);
    await writeMarker(videoDir, side).catch(() => {});
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

  async function readJson(dir, name) {
    try {
      return JSON.parse(await (await (await dir.getFileHandle(name)).getFile()).text());
    } catch {
      return null;
    }
  }

  async function findFacebookDirs(dir, path, depth, out) {
    for await (const [name, child] of dir.entries()) {
      if (child.kind !== 'directory' || name.startsWith('.') || name.startsWith('_')) continue;
      const childPath = path ? `${path}/${name}` : name;
      if (norm(name) === 'facebook') out.push({ handle: child, path: childPath, channelPath: path, channelName: dir.name });
      else if (depth < 4 && !SKIP.has(norm(name))) await findFacebookDirs(child, childPath, depth + 1, out);
    }
  }

  function dueTime(info, folderName) {
    const date = info.date_locale || (folderName.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1];
    const time = info.heure_prevue || ((folderName.match(/^\d{4}-\d{2}-\d{2}-(\d{2})(\d{2})/) || []).slice(1).join(':')) || '00:00';
    if (!date) return null;
    const [y, m, d] = date.split('-').map(Number);
    const [hh, mm] = time.split(':').map(Number);
    return new Date(y, m - 1, d, hh || 0, mm || 0).getTime();
  }

  // Where the posts are. With a Facebook folder chosen: every folder inside
  // it that holds an image, a video or a text is one post (any layout, any
  // names). Without one: the FACEBOOK/A-PUBLIER folders of the videos folder.
  async function postDirs() {
    const fbHandle = await fbRoot();
    const out = [];
    const join = (...parts) => parts.filter(Boolean).join('/');
    if (!fbHandle) {
      const dirs = [];
      await findFacebookDirs(await root(), '', 0, dirs);
      for (const fb of dirs) {
        let queue;
        try { queue = await fb.handle.getDirectoryHandle('A-PUBLIER'); } catch { continue; }
        const planning = (await readJson(fb.handle, 'planning.json')) || {};
        for await (const [name, handle] of queue.entries()) {
          if (handle.kind !== 'directory' || name.startsWith('.') || name.startsWith('_')) continue;
          out.push({ handle, name, path: join(fb.path, 'A-PUBLIER', name), planning,
            channelKey: fb.channelPath || '.', channelName: fb.channelPath ? fb.channelName : `${fb.channelName} (dossier principal)` });
        }
      }
      return out;
    }
    // Inside the videos folder? Then its channel (and its Page setting) is known.
    let inside = null;
    try {
      const main = testRoot || await loadRoot();
      if (main && (testRoot || await main.queryPermission({ mode: 'readwrite' }) === 'granted')) inside = await main.resolve(fbHandle);
    } catch { inside = null; }
    const channelOf = () => {
      // The channel is the folder above « FACEBOOK » / « A-PUBLIER » when there is one.
      const full = inside ? [...inside] : null;
      while (full && full.length && /^(facebook|a publier)$/.test(norm(full[full.length - 1]))) full.pop();
      if (full && full.length) return { channelKey: full.join('/'), channelName: full[full.length - 1] };
      return { channelKey: FB_PREFIX, channelName: fbHandle.name };
    };
    const { channelKey, channelName } = channelOf();
    const planning = (await readJson(fbHandle, 'planning.json')) || {};
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
        out.push({ handle: dir, name: dir.name, path: `${FB_PREFIX}${rel}`, planning, channelKey, channelName });
      }
      for (const [name, handle] of children) await visit(handle, join(rel, name), depth + 1);
    }
    await visit(fbHandle, '', 0);
    return out;
  }

  // times: "08:00, 12:30, 18:00" (panel). A post without its own date gets
  // the next free one, written into its publication.json so it stays put.
  function slotsFrom(times) {
    return String(times || '').split(/[,;\s]+/).map((t) => t.match(/^(\d{1,2})[:hH](\d{2})$/)).filter(Boolean)
      .map((m) => [Number(m[1]), Number(m[2])]).filter(([h, m]) => h < 24 && m < 60).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  }

  async function facebookPosts({ now = Date.now(), times = '' } = {}) {
    const posts = [];
    for (const dirInfo of await postDirs()) {
      const postDir = dirInfo.handle;
      const name = dirInfo.name;
      const info = (await readJson(postDir, 'publication.json')) || {};
      const files = [];
      for await (const [fileName, handle] of postDir.entries()) if (handle.kind === 'file') files.push(fileName);
      if (!files.some((f) => IMAGE_EXT.test(f) || VIDEO_EXT.test(f) || /\.(txt|md)$/i.test(f) || f === 'publication.json')) continue;
      const path = dirInfo.path;
      // The text: texte*.txt, or any short .txt / .md of the folder, as written.
      const texts = files.filter((f) => /\.(txt|md)$/i.test(f) && f !== MARKER_FILE && !NOT_A_SHEET.test(norm(stem(f))))
        .sort((x, y) => Number(!/^texte/i.test(x)) - Number(!/^texte/i.test(y)) || x.localeCompare(y));
      const textName = info.texte && files.includes(info.texte) ? info.texte : texts[0];
      let text = '';
      if (textName) {
        const file = await (await postDir.getFileHandle(textName)).getFile();
        if (file.size <= 64 * 1024) text = (await file.text()).trim();
      }
      const image = info.image && files.includes(info.image) ? info.image : files.filter((f) => IMAGE_EXT.test(f)).sort()[0];
      const video = files.filter((f) => VIDEO_EXT.test(f)).sort()[0];
      let due = dueTime(info, name);
      let statut = info.statut || 'a_publier';
      // Stuck « en cours » (tab closed, envoi débloqué à la main): offer to retry.
      if (statut === 'en_cours' && info.started_at && now - Date.parse(info.started_at) > 20 * 60000) {
        statut = 'echec';
        info.erreur = info.erreur || 'Publication interrompue : vérifie sur Facebook si elle est partie, sinon « Réessayer ».';
      }
      const post = {
        id: path,
        path,
        channel_key: dirInfo.channelKey,
        channel_name: dirInfo.channelName,
        page: info.page || dirInfo.planning.page || null,
        type: video ? 'reel' : image ? 'photo' : 'texte',
        text: text.slice(0, 63000),
        image_path: image ? `${path}/${image}` : null,
        video_path: video ? `${path}/${video}` : null,
        due_at: due,
        statut,
        error: info.erreur || null,
        started_at: info.started_at || null,
        published_at: info.published_at || null,
        tiktok_statut: (info.tiktok && info.tiktok.statut) || null,
        tiktok_error: (info.tiktok && info.tiktok.erreur) || null,
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
      post.ready = post.statut === 'a_publier' && (!post.due_at || post.due_at <= now) && !!(post.text || post.image_path || post.video_path);
    }
    posts.sort((a, b) => (a.due_at || 0) - (b.due_at || 0) || a.path.localeCompare(b.path));
    return posts;
  }

  // Merges patch into the post's publication.json.
  async function markPost(path, patch) {
    let [dir, inside] = await dirFor(path);
    for (const part of inside.split('/').filter(Boolean)) dir = await dir.getDirectoryHandle(part);
    const info = (await readJson(dir, 'publication.json')) || {};
    Object.assign(info, patch);
    const handle = await dir.getFileHandle('publication.json', { create: true });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(info, null, 2));
    await writable.close();
    return info;
  }

  return { saveRoot, loadRoot, access, saveFbRoot, loadFbRoot, clearFbRoot, fbAccess, fileAt, scan, mark, facebookPosts, markPost,
    _setTestRoot: (h) => { testRoot = h; }, _setTestFbRoot: (h) => { testFbRoot = h; } };
})();
