// Pinned tab opened by background.js. Chrome drops a granted folder access
// when the last tab of the extension closes (e.g. the YouTube Studio tab
// that hosted bridge.html after an upload): this tab keeps one open. It also
// offers the one click needed when Chrome asks for the access again.
const state = document.getElementById('state');
const grant = document.getElementById('grant');

async function refresh() {
  const access = await KappDossier.access().catch(() => ({ state: 'none' }));
  grant.hidden = access.state !== 'prompt';
  if (access.state === 'granted') {
    state.className = 'ok';
    state.textContent = `Accès autorisé au dossier « ${access.name} ».`;
  } else if (access.state === 'prompt') {
    state.className = 'warn';
    state.textContent = `Chrome redemande l’accès au dossier « ${access.name} ».`;
  } else {
    state.className = 'warn';
    state.textContent = 'Aucun dossier choisi : ouvre le panneau KappGen (icône de l’extension).';
  }
  document.title = access.state === 'granted' ? 'KappGen Uploader · accès OK' : 'KappGen Uploader · accès à autoriser';
}

grant.addEventListener('click', async () => {
  const handle = await KappDossier.loadRoot();
  if (handle) await handle.requestPermission({ mode: 'readwrite' }).catch(() => {});
  await refresh();
  chrome.runtime.sendMessage({ type: 'autoNow' }).catch(() => {});
});

refresh();
setInterval(refresh, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
