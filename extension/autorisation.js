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
    if (await entry[1].queryPermission({ mode: 'readwrite' }).catch(() => 'granted') !== 'granted') out.push(entry);
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
  ask(left[0]);
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
ready.then(async () => { pendingFirst = (await waiting())[0] || null; });
