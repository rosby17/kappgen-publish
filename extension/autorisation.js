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
  if (access.state === 'granted') return done();
  if (access.state === 'none') {
    message.className = 'warn';
    message.textContent = 'Aucun dossier choisi : ouvre le panneau KappGen Uploader et clique « Choisir le dossier ».';
    grant.hidden = true;
    return;
  }
  message.innerHTML = '';
  message.append('KappGen Uploader a besoin d’accéder au dossier ', Object.assign(document.createElement('strong'), { textContent: `« ${access.name} »` }), ' pour publier tes vidéos.');
})();

grant.addEventListener('click', async () => {
  const handle = await KappDossier.loadRoot();
  const state = handle ? await handle.requestPermission({ mode: 'readwrite' }).catch(() => 'denied') : 'none';
  if (state === 'granted') done();
  else {
    message.className = 'warn';
    message.textContent = 'Accès refusé. Clique de nouveau « Autoriser » quand tu es prêt.';
  }
});
