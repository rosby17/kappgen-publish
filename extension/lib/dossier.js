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
  const SKIP = new Set(['node modules', 'build', 'tournage', 'flow', 'neuves', 'sprites', 'src', 'wav', 'cache',
    'tmp', 'temp', 'captures', 'scripts', 'script', 'miniature', 'miniatures', 'images', 'image', 'img', 'avatar',
    'adn', 'marque', 'assets', 'frames', 'proxy', 'proxies', 'rushes', 'brut', 'raw', 'library', 'bibliotheque']);
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

  // state: "granted", "prompt", "denied" or "none" (no folder chosen yet).
  async function access() {
    const handle = await loadRoot();
    if (!handle) return { state: 'none' };
    return { state: await handle.queryPermission({ mode: 'readwrite' }), name: handle.name };
  }

  let testRoot = null; // set by tests only

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
    let dir = await root();
    const parts = relativePath.split('/');
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

  async function scan({ channels: settings = {}, autoSince = 0, now = Date.now() } = {}) {
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
        const shared = sharedSheets(node);
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
      if (rec.status === 'published') sentCopies.add(`${unit.video.name}|${unit.video.size}`);
    }

    const videos = [];
    const channels = new Map();
    const sent = [];
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
      if (record.status === 'ignored') continue;
      if (record.status !== 'published' && sentCopies.has(`${video.name}|${video.size}`)) continue;
      if (record.status !== 'published' && unit.kind === 'vrac' && now - video.modified > LOOSE_MAX_AGE) continue;

      let sheet = {};
      for (const [owner, names] of unit.sheets) {
        if (owner && names.length) sheet = { ...sheet, ...(await readSheets(owner, names)) };
      }
      // "## Destination" in the sheet without YouTube (e.g. site only): not ours.
      if (sheet.destination && record.status !== 'published') {
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
      if (record.status === 'published') {
        sent.push({ relative_path: relativePath, channel_key: channelKey, channel_name: channelName, size_bytes: video.size,
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
    videos.sort((a, b) => a.channel_key.localeCompare(b.channel_key) || a.relative_path.localeCompare(b.relative_path));
    return { folder: tree.name, videos, sent, channels: [...channels.values()].sort((a, b) => a.key.localeCompare(b.key)) };
  }

  // --------------------------------------------------------------- state

  // status: started | published | failed | ignored | reset
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
        if (data.shortYoutubeId) record.shortYoutubeId = data.shortYoutubeId;
        if (data.facebookPublishedAt) record.facebookPublishedAt = data.facebookPublishedAt;
      }
      if (status === 'failed') record.error = data.error || 'Erreur inconnue';
      state[relativePath] = record;
    }
    await writeState(rootHandle, state);
    if (state[relativePath]) side[videoName] = state[relativePath];
    else delete side[videoName];
    await writeSide(videoDir, side);
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

  async function facebookPosts({ now = Date.now() } = {}) {
    const rootHandle = await root();
    const dirs = [];
    await findFacebookDirs(rootHandle, '', 0, dirs);
    const posts = [];
    for (const fb of dirs) {
      const planning = (await readJson(fb.handle, 'planning.json')) || {};
      let queue;
      try { queue = await fb.handle.getDirectoryHandle('A-PUBLIER'); } catch { continue; }
      for await (const [name, postDir] of queue.entries()) {
        if (postDir.kind !== 'directory' || name.startsWith('.') || name.startsWith('_')) continue;
        const info = (await readJson(postDir, 'publication.json')) || {};
        const files = [];
        for await (const [fileName, handle] of postDir.entries()) if (handle.kind === 'file') files.push(fileName);
        const path = `${fb.path}/A-PUBLIER/${name}`;
        const textName = info.texte && files.includes(info.texte) ? info.texte : files.find((f) => /^texte.*\.txt$/i.test(f));
        let text = '';
        if (textName) text = (await (await (await postDir.getFileHandle(textName)).getFile()).text()).trim();
        const image = info.image && files.includes(info.image) ? info.image : files.find((f) => IMAGE_EXT.test(f));
        const video = files.find((f) => VIDEO_EXT.test(f));
        const due = dueTime(info, name);
        const statut = info.statut || 'a_publier';
        posts.push({
          id: path,
          path,
          channel_key: fb.channelPath || '.',
          channel_name: fb.channelPath ? fb.channelName : `${fb.channelName} (dossier principal)`,
          page: info.page || planning.page || null,
          type: video ? 'reel' : image ? 'photo' : 'texte',
          text: text.slice(0, 63000),
          image_path: image ? `${path}/${image}` : null,
          video_path: video ? `${path}/${video}` : null,
          due_at: due,
          statut,
          error: info.erreur || null,
          started_at: info.started_at || null,
          published_at: info.published_at || null,
          ready: statut === 'a_publier' && !!due && due <= now && !!(text || image || video),
        });
      }
    }
    posts.sort((a, b) => (a.due_at || 0) - (b.due_at || 0) || a.path.localeCompare(b.path));
    return posts;
  }

  // Merges patch into the post's publication.json.
  async function markPost(path, patch) {
    let dir = await root();
    for (const part of path.split('/')) dir = await dir.getDirectoryHandle(part);
    const info = (await readJson(dir, 'publication.json')) || {};
    Object.assign(info, patch);
    const handle = await dir.getFileHandle('publication.json', { create: true });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(info, null, 2));
    await writable.close();
    return info;
  }

  return { saveRoot, loadRoot, access, fileAt, scan, mark, facebookPosts, markPost, _setTestRoot: (h) => { testRoot = h; } };
})();
