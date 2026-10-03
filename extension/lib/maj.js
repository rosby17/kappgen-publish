// One-click update of the unpacked extension, from the side panel.
//
// Chrome cannot replace an unpacked extension by itself, but the extension may
// write into its own folder once the creator has pointed at it (File System
// Access API, one folder pick the first time, kept in IndexedDB). On a click:
//   1. ask for the folder (first time) or for write access again (one click),
//   2. download the latest release zip from GitHub and check its SHA-256,
//   3. unzip it in memory, write every file, manifest.json last,
//   4. reload: this profile right away, the other Chrome profiles that load
//      the same folder within a minute (selfUpdate() in background.js).
// Nothing is written unless the zip is complete and verified; a folder whose
// manifest is not this extension's (same name and key) is refused.
const KappMaj = (() => {
  const REPO = 'rosby17/kappgen-publish';
  const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
  const ZIP_NAME = 'kappgen-publish.zip';
  const DB_NAME = 'kappgen-maj';

  // -------------------------------------------------------------- folder

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
  const loadFolder = () => kv('readonly', (store) => store.get('extension')).catch(() => null);
  const saveFolder = (handle) => kv('readwrite', (store) => store.put(handle, 'extension'));
  const forgetFolder = () => kv('readwrite', (store) => store.delete('extension'));

  async function readManifest(dir) {
    try {
      const file = await (await dir.getFileHandle('manifest.json')).getFile();
      return JSON.parse(await file.text());
    } catch {
      return null;
    }
  }
  // Is this folder the one holding this very extension (same name and key)?
  const isOurs = (manifest, own) => !!manifest && manifest.name === own.name && (manifest.key || '') === (own.key || '');

  // The chosen folder, or the folder right inside it (picked one level too high).
  async function extensionDir(picked, own) {
    if (isOurs(await readManifest(picked), own)) return picked;
    for await (const entry of picked.values()) {
      if (entry.kind === 'directory' && isOurs(await readManifest(entry), own)) return entry;
    }
    return null;
  }

  // Must run first in the click: Chrome only shows its prompts with a fresh click.
  async function folderWithAccess(own) {
    const saved = await loadFolder();
    if (saved) {
      const state = await saved.requestPermission({ mode: 'readwrite' }).catch(() => 'denied');
      if (state === 'granted' && isOurs(await readManifest(saved), own)) return saved;
      if (state === 'granted') await forgetFolder(); // moved or replaced: pick again
      else throw new Error('Accès au dossier de l’extension refusé. Clique encore et choisis « Autoriser ».');
    }
    let picked;
    try {
      picked = await window.showDirectoryPicker({ id: 'kappgen-extension', mode: 'readwrite' });
    } catch (error) {
      if (error && error.name === 'AbortError') throw new Error('Mise à jour annulée : aucun dossier choisi.');
      throw error;
    }
    const dir = await extensionDir(picked, own);
    if (!dir) throw new Error(`« ${picked.name} » n’est pas le dossier de KappGen Publish. Choisis le dossier indiqué dans chrome://extensions → KappGen Publish → Détails → « Chargée depuis ».`);
    await saveFolder(dir);
    return dir;
  }

  // ------------------------------------------------------------ download

  async function latestRelease() {
    const response = await fetch(RELEASES_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error(`GitHub ne répond pas (${response.status}). Réessaie dans quelques minutes.`);
    const release = await response.json();
    const asset = (name) => (release.assets || []).find((item) => item.name === name);
    const zip = asset(ZIP_NAME);
    const sha = asset(`${ZIP_NAME}.sha256`);
    if (!zip || !sha) throw new Error('La dernière version publiée n’a pas son archive complète.');
    return { version: String(release.tag_name || '').replace(/^v/, ''), zipUrl: zip.browser_download_url, shaUrl: sha.browser_download_url };
  }

  async function download(url, what) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Téléchargement ${what} impossible (${response.status}).`);
    return response;
  }

  const hex = (buffer) => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  async function sha256(bytes) {
    return hex(await crypto.subtle.digest('SHA-256', bytes));
  }

  // ---------------------------------------------------------------- unzip

  // Zip archives made by publier-version.sh (stored or deflated, no zip64).
  async function unzip(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
    }
    if (end < 0) throw new Error('Archive illisible.');
    const count = view.getUint16(end + 10, true);
    let at = view.getUint32(end + 16, true);
    const files = [];
    const decoder = new TextDecoder();
    for (let n = 0; n < count; n++) {
      if (view.getUint32(at, true) !== 0x02014b50) throw new Error('Archive abîmée.');
      const method = view.getUint16(at + 10, true);
      const size = view.getUint32(at + 20, true);
      const fullSize = view.getUint32(at + 24, true);
      const nameLength = view.getUint16(at + 28, true);
      const skip = nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
      const local = view.getUint32(at + 42, true);
      const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
      at += 46 + skip;
      if (name.endsWith('/')) continue;
      const parts = name.split('/');
      if (name.startsWith('/') || parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) {
        throw new Error(`Chemin refusé dans l’archive : ${name}`);
      }
      if (view.getUint32(local, true) !== 0x04034b50) throw new Error('Archive abîmée.');
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const raw = bytes.subarray(start, start + size);
      let data;
      if (method === 0) data = raw.slice();
      else if (method === 8) data = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
      else throw new Error(`Compression non prise en charge : ${name}`);
      if (data.length !== fullSize) throw new Error(`Fichier incomplet dans l’archive : ${name}`);
      files.push({ path: parts, data });
    }
    return files;
  }

  // ---------------------------------------------------------------- write

  async function writeFile(dir, parts, data) {
    let node = dir;
    for (const part of parts.slice(0, -1)) node = await node.getDirectoryHandle(part, { create: true });
    const writable = await (await node.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
    await writable.write(data);
    await writable.close();
  }

  // Every file, manifest.json last: stopped halfway, the folder keeps the old
  // version number and the next click starts again.
  async function install(dir, files, progress = () => {}) {
    const isManifest = (file) => file.path.length === 1 && file.path[0] === 'manifest.json';
    const ordered = [...files.filter((file) => !isManifest(file)), ...files.filter(isManifest)];
    for (let i = 0; i < ordered.length; i++) {
      await writeFile(dir, ordered[i].path, ordered[i].data);
      progress(i + 1, ordered.length);
    }
  }

  // ------------------------------------------------------------- the click

  async function canUpdateHere() {
    try {
      return (await chrome.management.getSelf()).installType === 'development' && typeof window.showDirectoryPicker === 'function';
    } catch {
      return false;
    }
  }

  async function update(progress = () => {}) {
    const own = chrome.runtime.getManifest();
    const dir = await folderWithAccess(own);
    progress('Recherche de la dernière version…');
    const release = await latestRelease();
    progress(`Téléchargement de la ${release.version}…`);
    const [zipResponse, shaResponse] = await Promise.all([download(release.zipUrl, 'de l’archive'), download(release.shaUrl, 'de l’empreinte')]);
    const bytes = new Uint8Array(await zipResponse.arrayBuffer());
    const expected = ((await shaResponse.text()).match(/[0-9a-f]{64}/i) || [''])[0].toLowerCase();
    if (!expected || (await sha256(bytes)) !== expected) throw new Error('Archive téléchargée corrompue (empreinte SHA-256 différente). Rien n’a été modifié.');
    const files = await unzip(bytes);
    const manifestFile = files.find((file) => file.path.join('/') === 'manifest.json');
    const next = manifestFile && JSON.parse(new TextDecoder().decode(manifestFile.data));
    if (!isOurs(next, own)) throw new Error('L’archive ne contient pas KappGen Publish. Rien n’a été modifié.');
    progress('Installation…');
    await install(dir, files, (done, total) => progress(`Installation… ${done}/${total}`));
    progress(`Version ${next.version} installée, redémarrage…`);
    setTimeout(() => chrome.runtime.reload(), 400);
    return next.version;
  }

  return { update, canUpdateHere, unzip, install, extensionDir, isOurs };
})();

if (typeof module !== 'undefined') module.exports = KappMaj;
