// One-click update, from the side panel's « Mettre à jour » button.
//
// Chrome does not let an extension write its own folder. The install command
// (app.kappgen.com/extension) also installs a small helper on the computer,
// declared to Chrome as the native messaging host below. On a click the helper
// runs the latest installer without asking anything: download, SHA-256 check,
// new version in every folder a Chrome profile loads KappGen Publish from.
// Then the extension restarts (the other profiles follow within a minute,
// selfUpdate() in background.js). No folder to pick, nothing to copy.
const KappMaj = (() => {
  const HOST = 'com.kappgen.publish';

  class NoHelper extends Error {}

  async function update(progress = () => {}) {
    progress('Téléchargement et installation…');
    let answer;
    try {
      answer = await chrome.runtime.sendNativeMessage(HOST, { action: 'update' });
    } catch (error) {
      const text = String((error && error.message) || error);
      if (/not found|forbidden|access to the specified native messaging host/i.test(text)) throw new NoHelper(text);
      throw new Error(`l’assistant de mise à jour ne répond pas (${text}).`);
    }
    if (!answer || !answer.ok) throw new Error((answer && answer.error) || 'l’installation a échoué.');
    const disk = await (await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' })).json().catch(() => ({}));
    const version = answer.version || disk.version || '';
    // Never cut a publication in progress: background.js restarts by itself
    // as soon as it is over (selfUpdate()).
    const { job } = await chrome.storage.session.get('job').catch(() => ({}));
    if (job && job.running) {
      progress(`Version ${version} installée : KappGen Publish redémarrera tout seul à la fin de la publication en cours.`);
      return { version, waiting: true };
    }
    progress(`Version ${version} installée, redémarrage…`);
    setTimeout(() => chrome.runtime.reload(), 600);
    return { version, waiting: false };
  }

  return { update, NoHelper };
})();
