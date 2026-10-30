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
    thumbCheck: () => thumbCheck(message.path, message.youtubeId),
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

// Miniature du dossier comparée avec celle que YouTube montre (i.ytimg.com répond à tous, sans autorisation de plus).
// Rend { ecart } sur 256 (voir KappMajVideo.SEUIL_ECART), ou { ecart: null } quand la comparaison n'a pas de sens.
async function thumbCheck(path, youtubeId) {
  if (!/^[\w-]{11}$/.test(String(youtubeId || ''))) throw new Error('Identifiant YouTube invalide.');
  const local = await grayOf(await KappDossier.fileAt(path));
  if (!local) return { ecart: null, raison: 'miniature du dossier pas au format 16:9' };
  const reply = await fetch(`https://i.ytimg.com/vi/${youtubeId}/mqdefault.jpg?kg=${Date.now()}`, { cache: 'no-store' });
  if (!reply.ok) throw new Error(`Miniature YouTube introuvable (${reply.status}).`);
  const online = await grayOf(await reply.blob());
  if (!online) return { ecart: null, raison: 'miniature YouTube illisible' };
  return { ecart: KappMajVideo.ecartEmpreintes(KappMajVideo.empreinte(local), KappMajVideo.empreinte(online)) };
}

// L'image réduite à 16 × 16 en gris (en deux temps pour lisser), ou null si elle n'est pas en 16:9.
async function grayOf(blob) {
  const image = await createImageBitmap(blob);
  try {
    if (Math.abs(image.width / image.height - 16 / 9) > 0.05) return null;
    const step = new OffscreenCanvas(160, 90);
    const a = step.getContext('2d');
    a.imageSmoothingQuality = 'high';
    a.drawImage(image, 0, 0, 160, 90);
    const small = new OffscreenCanvas(16, 16);
    const b = small.getContext('2d');
    b.imageSmoothingQuality = 'high';
    b.drawImage(step, 0, 0, 16, 16);
    const { data } = b.getImageData(0, 0, 16, 16);
    const gray = [];
    for (let i = 0; i < data.length; i += 4) gray.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    return gray;
  } finally {
    image.close();
  }
}
