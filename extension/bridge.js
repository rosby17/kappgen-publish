// Loaded in a hidden frame inside YouTube Studio by studio.js. Reads one file
// of the chosen folder and hands it to the page: the File is passed by
// reference (Chrome reads it from disk), so even a 10 GB video costs no memory.
(async () => {
  const token = new URLSearchParams(location.search).get('token');
  const target = location.ancestorOrigins && location.ancestorOrigins[0]
    ? location.ancestorOrigins[0]
    : (() => { try { return new URL(document.referrer).origin; } catch { return '*'; } })();
  const reply = (data) => parent.postMessage({ kappgen: 'file', token, ...data }, target);
  try {
    if (!token) throw new Error('Autorisation de fichier absente.');
    const grant = await chrome.runtime.sendMessage({ type: 'consumeBridgeGrant', token });
    if (!grant || !grant.ok) throw new Error((grant && grant.error) || 'Autorisation de fichier expirée.');
    const path = grant.data && grant.data.path;
    if (!path) throw new Error('Autorisation de fichier invalide.');
    reply({ file: await KappDossier.fileAt(path) });
  } catch (error) {
    reply({ error: String((error && error.message) || error) });
  }
})();
