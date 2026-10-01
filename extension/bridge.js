// Loaded in a hidden frame inside YouTube Studio by studio.js. Reads one file
// of the chosen folder and hands it to the page: the File is passed by
// reference (Chrome reads it from disk), so even a 10 GB video costs no memory.
(async () => {
  const path = new URLSearchParams(location.search).get('path');
  const target = location.ancestorOrigins && location.ancestorOrigins[0]
    ? location.ancestorOrigins[0]
    : (() => { try { return new URL(document.referrer).origin; } catch { return '*'; } })();
  const reply = (data) => parent.postMessage({ kappgen: 'file', path, ...data }, target);
  try {
    reply({ file: await KappDossier.fileAt(path) });
  } catch (error) {
    reply({ error: String((error && error.message) || error) });
  }
})();
