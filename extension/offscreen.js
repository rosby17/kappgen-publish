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
    videoInfo: () => videoInfo(message.path),
  };
  const handler = handlers[message.type];
  if (!handler) return false;
  handler().then((data) => sendResponse({ ok: true, data }), (error) => sendResponse({ ok: false, error: String((error && error.message) || error) }));
  return true;
});

// Duration and size of one video of the folder (Reel or normal video on
// Facebook). Only the file's header is read; null fields when unreadable.
async function videoInfo(path) {
  const file = await KappDossier.fileAt(path);
  const url = URL.createObjectURL(file);
  try {
    const meta = await new Promise((resolve) => {
      const video = document.createElement('video');
      const done = (value) => { clearTimeout(timer); video.removeAttribute('src'); video.load(); resolve(value); };
      const timer = setTimeout(() => done({ duration: null, width: null, height: null }), 15000);
      video.preload = 'metadata';
      video.muted = true;
      video.onloadedmetadata = () => done({
        duration: Number.isFinite(video.duration) ? video.duration : null,
        width: video.videoWidth || null, height: video.videoHeight || null });
      video.onerror = () => done({ duration: null, width: null, height: null });
      video.src = url;
    });
    return { size: file.size, ...meta };
  } finally {
    URL.revokeObjectURL(url);
  }
}
