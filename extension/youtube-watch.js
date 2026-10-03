// Injected into a YouTube watch page by background.js to post (and pin) the
// comment that goes with a video. It uses the YouTube session already open in
// this Chrome profile; nothing is read from it. A comment that was clicked
// « Commenter » but not seen afterwards is reported as « à vérifier » (never
// sent a second time).
(() => {
  const VERSION = chrome.runtime.getManifest().version;
  if (window.__kappgenWatch && window.__kappgenWatch.version === VERSION) return;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const visible = (node) => !!node && node.getClientRects().length > 0;
  const textOf = (node) => (node.textContent || '').replace(/\s+/g, ' ').trim();
  const plain = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const waitFor = async (finder, timeout, what, tick = 500) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const found = finder();
      if (found) return found;
      await sleep(tick);
    }
    throw new Error(`YouTube : ${what} introuvable.`);
  };
  const quiet = () => {
    const video = document.querySelector('video');
    if (video) { try { video.muted = true; video.pause(); } catch { /* not ours to fail on */ } }
  };
  const threads = () => [...document.querySelectorAll('ytd-comment-thread-renderer')];
  const ownerHref = () => {
    const link = document.querySelector('ytd-video-owner-renderer a[href], #owner a[href]');
    return link ? decodeURIComponent(link.getAttribute('href') || '').toLowerCase() : '';
  };

  async function commentVideo({ comment, pin = true }) {
    if (!comment) return { commented: false };
    const start = plain(comment).slice(0, 40);
    const mine = () => threads().find((t) => plain(textOf(t.querySelector('#content-text') || t)).includes(start)) || null;
    await sleep(2500);
    quiet();
    if (/vid[ée]o (priv[ée]e|indisponible)|video (unavailable|is private)|this video isn.t available/i.test(textOf(document.body).slice(0, 4000)) && !document.querySelector('#movie_player')) {
      throw new Error('[FINAL] YouTube : la vidéo n’est pas accessible (privée ou supprimée).');
    }
    // Comments load when scrolled to.
    const placeholder = await waitFor(() => {
      quiet();
      window.scrollBy(0, 500);
      const off = document.querySelector('ytd-comments-header-renderer')
        && /d[ée]sactiv|turned off|disabled/i.test(textOf(document.querySelector('ytd-comments #message, ytd-comments-header-renderer')));
      if (off) throw new Error('[FINAL] YouTube : les commentaires sont désactivés sur cette vidéo.');
      return document.querySelector('#simplebox-placeholder');
    }, 60000, 'la zone « Ajouter un commentaire »', 900);
    if (mine()) return { commented: true, already: true };
    placeholder.scrollIntoView({ block: 'center' });
    await sleep(600);
    placeholder.click();
    const box = await waitFor(() => {
      const el = document.querySelector('ytd-commentbox #contenteditable-root');
      return el && visible(el) ? el : null;
    }, 15000, 'le champ du commentaire');
    box.focus();
    document.execCommand('insertText', false, comment);
    for (let i = 0; i < 8 && !plain(textOf(box)).includes(start.slice(0, 20)); i += 1) await sleep(250);
    if (!plain(textOf(box)).includes(start.slice(0, 20))) {
      const data = new DataTransfer();
      data.setData('text/plain', comment);
      box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      await sleep(1000);
    }
    if (!plain(textOf(box)).includes(start.slice(0, 20))) throw new Error('YouTube : le commentaire n’a pas pu être écrit.');
    const send = await waitFor(() => {
      const button = document.querySelector('ytd-commentbox #submit-button button, ytd-commentbox #submit-button');
      return button && !button.disabled && button.getAttribute('aria-disabled') !== 'true' ? button : null;
    }, 10000, 'le bouton « Commenter »');
    send.click();
    // Sent: from here on, never sent again.
    let thread;
    try {
      thread = await waitFor(mine, 30000, 'le commentaire publié', 800);
    } catch {
      throw new Error('[A_VERIFIER] YouTube n’a pas confirmé le commentaire : regarde sous la vidéo avant de relancer.');
    }
    const author = thread.querySelector('#author-text');
    const authorHref = author ? decodeURIComponent(author.getAttribute('href') || '').toLowerCase() : '';
    const owner = ownerHref();
    const otherChannel = !!(authorHref && owner && !authorHref.includes(owner.replace(/^\/+/, '').split('/').pop()) && !owner.includes(authorHref.replace(/^\/+/, '').split('/').pop()));
    let pinned = false;
    if (pin) {
      try {
        const menu = thread.querySelector('#action-menu button, #action-menu yt-icon-button');
        if (!menu) throw new Error('menu');
        menu.click();
        const item = await waitFor(() => [...document.querySelectorAll('ytd-menu-service-item-renderer, tp-yt-paper-item')]
          .find((n) => visible(n) && /^(épingler|pin)/i.test(textOf(n))), 6000, 'l’option « Épingler »', 300);
        item.click();
        const confirm = await waitFor(() => document.querySelector('yt-confirm-dialog-renderer #confirm-button button, yt-confirm-dialog-renderer #confirm-button'), 6000, 'la confirmation', 300);
        confirm.click();
        await sleep(1500);
        pinned = true;
      } catch { /* the comment is posted; pinning can be done by hand */ }
    }
    return { commented: true, pinned, otherChannel };
  }

  window.__kappgenWatch = { version: VERSION, commentVideo };
})();
