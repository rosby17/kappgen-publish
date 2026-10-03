// The extension's own history of publications.
//
// Every publication (YouTube video or Short, Facebook post, Reel or video,
// X, LinkedIn, TikTok, Instagram, and the « Déjà publié » marks) is written
// here when it happens, with its title, a small thumbnail and its link. It is
// kept in this extension's IndexedDB, in Chrome: the « Déjà publiés » lists
// no longer depend on what stays in the folders (folder changed, posts moved
// or cleaned up, publication.json rewritten…).
const KappHistorique = (() => {
  const DB_NAME = 'kappgen-historique';
  const STORE = 'entries';
  const MAX = 5000; // oldest dropped beyond that
  const THUMB = 160;
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('kappgen-historique') : null;

  function db() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('at', 'at');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function tx(mode, fn) {
    const base = await db();
    return new Promise((resolve, reject) => {
      const t = base.transaction(STORE, mode);
      const request = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(request && request.result);
      t.onerror = () => reject(t.error);
    });
  }

  // A small JPEG (data: URL) of an image or of a video's first second.
  async function thumbOf(file) {
    if (!file || typeof document === 'undefined') return null;
    const url = URL.createObjectURL(file);
    try {
      let source;
      if (/^video\//.test(file.type) || /\.(mp4|mov|m4v|webm)$/i.test(file.name || '')) {
        source = document.createElement('video');
        source.muted = true;
        source.preload = 'auto';
        source.src = url;
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('vidéo trop lente')), 8000);
          source.addEventListener('loadeddata', () => { source.currentTime = Math.min(1, (source.duration || 2) / 2); }, { once: true });
          source.addEventListener('seeked', () => { clearTimeout(timer); resolve(); }, { once: true });
          source.addEventListener('error', () => { clearTimeout(timer); reject(new Error('vidéo illisible')); }, { once: true });
        });
      } else {
        source = await createImageBitmap(file);
      }
      const w = source.videoWidth || source.width;
      const h = source.videoHeight || source.height;
      if (!w || !h) return null;
      const scale = Math.min(1, THUMB / Math.max(w, h));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.72);
    } catch {
      return null;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // entry: { net, kind, path, title, at, url?, channel?, manual?, thumbFile? }
  // One entry per (network, kind, path): publishing the same item again
  // updates it instead of doubling it.
  async function add(entry) {
    if (!entry || !entry.net || !entry.path) return;
    const id = `${entry.net}|${entry.kind || 'post'}|${entry.path}`;
    const old = await tx('readonly', (store) => store.get(id)).catch(() => null);
    const thumb = (entry.thumbFile && await thumbOf(entry.thumbFile)) || (old && old.thumb) || null;
    const record = {
      id, net: entry.net, kind: entry.kind || 'post', path: entry.path,
      title: String(entry.title || '').slice(0, 300) || (old && old.title) || entry.path.split('/').pop(),
      at: entry.at || Date.now(), url: entry.url || (old && old.url) || null,
      channel: entry.channel || (old && old.channel) || null, manual: !!entry.manual, thumb,
    };
    await tx('readwrite', (store) => store.put(record));
    await trim().catch(() => {});
    if (channel) channel.postMessage('changed');
  }

  async function trim() {
    const count = await tx('readonly', (store) => store.count());
    if (count <= MAX) return;
    let extra = count - MAX;
    await tx('readwrite', (store) => {
      const request = store.index('at').openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || extra <= 0) return;
        cursor.delete();
        extra -= 1;
        cursor.continue();
      };
      return request;
    });
  }

  // Newest first; nets: list of networks to keep (all when empty).
  async function list({ nets = [] } = {}) {
    const all = await tx('readonly', (store) => store.getAll()).catch(() => []);
    return (all || []).filter((e) => !nets.length || nets.includes(e.net)).sort((a, b) => b.at - a.at);
  }

  function onChange(fn) {
    if (channel) channel.addEventListener('message', () => fn());
  }

  return { add, list, onChange, thumbOf };
})();

if (typeof module !== 'undefined') module.exports = KappHistorique;
