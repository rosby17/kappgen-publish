// Hidden page used by the service worker to read the videos folder: the
// File System Access API is not available to service workers.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== 'offscreen') return false;
  const handlers = {
    access: () => KappDossier.access(),
    fbAccess: () => KappDossier.fbAccess(),
    folders: () => KappDossier.folders(),
    scan: () => KappDossier.scan({ channels: message.channels || {}, watchSince: message.watchSince || 0 }),
    mark: () => KappDossier.mark(message.path, message.status, message.data || {}),
    posts: () => KappDossier.facebookPosts({ times: message.times || '', net: message.net || 'facebook' }),
    markPost: () => KappDossier.markPost(message.path, message.patch || {}),
    exportState: () => KappDossier.exportState(message.state || {}),
  };
  const handler = handlers[message.type];
  if (!handler) return false;
  handler().then((data) => sendResponse({ ok: true, data }), (error) => sendResponse({ ok: false, error: String((error && error.message) || error) }));
  return true;
});
