// Dedicated Update Handler for tab
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get('action') === 'update') {
  document.querySelector('h1').textContent = 'Mise à jour de KappGen Publish';
  const message = document.getElementById('message');
  const grant = document.getElementById('grant');
  message.textContent = 'Clique ci-dessous pour autoriser et installer la mise à jour en 1 clic.';
  grant.textContent = '⚡ Mettre à jour l’extension';
  grant.disabled = false;

  function getExtDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('kappgen-dossier', 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function saveExtHandle(handle) {
    try {
      const base = await getExtDb();
      const tx = base.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(handle, 'ext_handle');
    } catch (e) {}
  }

  async function unzipToDirectoryHandle(zipArrayBuffer, dirHandle) {
    const view = new DataView(zipArrayBuffer);
    let offset = 0;
    const len = zipArrayBuffer.byteLength;
    const uint8 = new Uint8Array(zipArrayBuffer);

    while (offset < len - 30) {
      const sig = view.getUint32(offset, true);
      if (sig !== 0x04034b50) break;

      const compMethod = view.getUint16(offset + 8, true);
      const compSize = view.getUint32(offset + 18, true);
      const nameLen = view.getUint16(offset + 26, true);
      const extraLen = view.getUint16(offset + 28, true);
      const nameBytes = uint8.subarray(offset + 30, offset + 30 + nameLen);
      const name = new TextDecoder().decode(nameBytes);
      const dataOffset = offset + 30 + nameLen + extraLen;
      const compData = uint8.subarray(dataOffset, dataOffset + compSize);

      let uncompData;
      if (compMethod === 0) {
        uncompData = compData;
      } else if (compMethod === 8) {
        try {
          const ds = new DecompressStream('deflate-raw');
          const writer = ds.writable.getWriter();
          writer.write(compData);
          writer.close();
          const reader = ds.readable.getReader();
          const chunks = [];
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
          }
          let total = 0;
          for (const c of chunks) total += c.length;
          uncompData = new Uint8Array(total);
          let pos = 0;
          for (const c of chunks) { uncompData.set(c, pos); pos += c.length; }
        } catch (e) {
          offset = dataOffset + compSize;
          continue;
        }
      } else {
        offset = dataOffset + compSize;
        continue;
      }

      if (!name.endsWith('/') && name.length > 0) {
        const parts = name.replace(/^[/\\]+/, '').split(/[/\\]+/).filter(Boolean);
        let currDir = dirHandle;
        for (let i = 0; i < parts.length - 1; i++) {
          currDir = await currDir.getDirectoryHandle(parts[i], { create: true });
        }
        const filename = parts[parts.length - 1];
        const fileHandle = await currDir.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(uncompData);
        await writable.close();
      }

      offset = dataOffset + compSize;
    }
  }

  grant.addEventListener('click', async () => {
    grant.disabled = true;
    grant.textContent = '⏳ Téléchargement...';
    message.textContent = 'Téléchargement de la dernière version depuis GitHub...';

    try {
      const tagRes = await fetch('https://api.github.com/repos/rosby17/kappgen-publish/releases/latest', {
        headers: { Accept: 'application/vnd.github+json' }
      });
      const tagData = await tagRes.json();
      const tag = String(tagData.tag_name || '').replace(/^v/, '');
      const zipUrl = `https://github.com/rosby17/kappgen-publish/releases/download/v${tag}/kappgen-publish.zip`;

      const zipRes = await fetch(zipUrl);
      if (!zipRes.ok) throw new Error(`HTTP ${zipRes.status}`);
      const zipBuf = await zipRes.arrayBuffer();

      grant.textContent = '📂 Sélection du dossier KappGen-Publish...';
      message.textContent = 'Sélectionne le dossier KappGen-Publish sur ton ordinateur pour autoriser l’accès...';

      const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      await saveExtHandle(dirHandle);

      grant.textContent = '⚙️ Remplacement des fichiers...';
      message.textContent = 'Installation des nouveaux fichiers en cours...';

      await unzipToDirectoryHandle(zipBuf, dirHandle);

      message.className = 'ok';
      message.textContent = '✓ Mise à jour réussie ! Redémarrage de Chrome...';
      grant.textContent = '✓ Terminé !';

      setTimeout(() => {
        chrome.runtime.reload();
        window.close();
      }, 1000);
    } catch (e) {
      grant.disabled = false;
      grant.textContent = '⚡ Réessayer';
      message.className = 'warn';
      message.textContent = `❌ Erreur : ${e.message || e}`;
    }
  }, { once: true });
} else {
// Small popup window opened by background.js when Chrome asks again for
// access to a chosen folder (the main one, or a network's own). One click per
// folder grants it (a click is required by Chrome), then the window closes.
const message = document.getElementById('message');
const grant = document.getElementById('grant');
const LABELS = { youtube: 'YouTube', facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok', x: 'X', linkedin: 'LinkedIn' };

function done() {
  message.className = 'ok';
  message.textContent = 'Accès autorisé. Les publications reprennent.';
  grant.hidden = true;
  chrome.runtime.sendMessage({ type: 'autoNow' }).catch(() => {});
  setTimeout(() => window.close(), 1200);
}

// Every chosen folder: [label, handle], loaded in advance — Chrome only shows
// its prompt when requestPermission is called right in the click.
let folders = [];
let pendingFirst = null; // the folder the next click asks for
async function load() {
  const list = [['principal', await KappDossier.loadRoot().catch(() => null)]];
  for (const net of KappDossier.NETS) list.push([LABELS[net], await KappDossier.loadNetRoot(net).catch(() => null)]);
  folders = list.filter(([, handle]) => handle);
}
async function waiting() {
  const out = [];
  for (const entry of folders) {
    if (await entry[1].queryPermission({ mode: 'readwrite' }).catch(() => 'denied') !== 'granted') out.push(entry);
  }
  return out;
}
function ask([label, handle]) {
  message.className = '';
  message.innerHTML = '';
  message.append('KappGen Publish a besoin d’accéder au dossier ', Object.assign(document.createElement('strong'), { textContent: `« ${handle.name} »` }),
    label === 'principal' ? ' (dossier principal).' : ` (${label}).`);
}

const ready = (async () => {
  await load();
  if (!folders.length) {
    message.className = 'warn';
    message.textContent = 'Aucun dossier choisi : ouvre le panneau KappGen Publish, Réglages → « Choisir le dossier principal ».';
    grant.hidden = true;
    return;
  }
  const left = await waiting();
  if (!left.length) return done();
  pendingFirst = left[0];
  ask(left[0]);
  grant.disabled = false;
})();

grant.addEventListener('click', async () => {
  // The first folder waiting is asked straight away (nothing awaited before).
  const first = pendingFirst;
  const state = first ? await first[1].requestPermission({ mode: 'readwrite' }).catch(() => 'denied') : 'granted';
  if (state !== 'granted') {
    message.className = 'warn';
    message.textContent = 'Accès refusé. Clique de nouveau « Autoriser » quand tu es prêt.';
    return;
  }
  const left = await waiting();
  pendingFirst = left[0] || null;
  if (!left.length) done();
  else { ask(left[0]); message.append(' Clique encore « Autoriser ».'); }
});
ready.catch((error) => {
  message.className = 'warn';
  message.textContent = `Impossible de lire les autorisations : ${error.message || error}`;
  grant.disabled = true;
});
ready.then(async () => { pendingFirst = (await waiting())[0] || null; });

}
