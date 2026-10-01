// Small popup window opened by background.js when Chrome asks again for
// access to the videos folder. One click grants it (a click is required by
// Chrome), then the window closes itself.
const message = document.getElementById('message');
const grant = document.getElementById('grant');

function done() {
  message.className = 'ok';
  message.textContent = 'Accès autorisé. Les publications reprennent.';
  grant.hidden = true;
  chrome.runtime.sendMessage({ type: 'autoNow' }).catch(() => {});
  setTimeout(() => window.close(), 1200);
}

(async () => {
  const access = await KappDossier.access().catch(() => ({ state: 'none' }));
  const fb = await KappDossier.fbAccess().catch(() => ({ state: 'none' }));
  if (access.state === 'granted' && fb.state !== 'prompt') return done();
  if (access.state === 'granted') {
    message.innerHTML = '';
    message.append('KappGen Publish a besoin d’accéder au dossier Facebook ', Object.assign(document.createElement('strong'), { textContent: `« ${fb.name} »` }), ' pour publier tes Reels et posts.');
    return;
  }
  if (access.state === 'none') {
    message.className = 'warn';
    message.textContent = 'Aucun dossier choisi : ouvre le panneau KappGen Publish et clique « Choisir le dossier ».';
    grant.hidden = true;
    return;
  }
  message.innerHTML = '';
  message.append('KappGen Publish a besoin d’accéder au dossier ', Object.assign(document.createElement('strong'), { textContent: `« ${access.name} »` }), ' pour publier tes vidéos.');
})();

// Loaded in advance: Chrome only shows its prompt when requestPermission is
// called right in the click, with nothing awaited before it.
let rootHandle = null;
KappDossier.loadRoot().then((handle) => { rootHandle = handle; }).catch(() => {});
let fbHandle = null;
KappDossier.loadFbRoot().then((handle) => { fbHandle = handle; }).catch(() => {});

grant.addEventListener('click', async () => {
  const handle = rootHandle || await KappDossier.loadRoot();
  let state = handle ? await handle.requestPermission({ mode: 'readwrite' }).catch(() => 'denied') : 'none';
  // Then the Facebook folder, if Chrome asks for it too (may need a 2nd click).
  if (state === 'granted' && fbHandle && await fbHandle.queryPermission({ mode: 'readwrite' }) === 'prompt') {
    if (await fbHandle.requestPermission({ mode: 'readwrite' }).catch(() => 'denied') !== 'granted') {
      message.className = 'warn';
      message.textContent = 'Dossier des vidéos autorisé. Clique encore « Autoriser » pour le dossier Facebook.';
      return;
    }
  }
  if (state === 'granted') done();
  else {
    message.className = 'warn';
    message.textContent = 'Accès refusé. Clique de nouveau « Autoriser » quand tu es prêt.';
  }
});
