// Pure rules for Facebook's final publication screens. Kept separate from
// DOM automation so the dangerous button distinctions remain unit-tested.
((root) => {
  const PUBLISH_BUTTON = /^(publier|publish|post|publier maintenant|publish now)$/i;
  const GROUPS_DONE_BUTTON = /^(termin[ée]|done)$/i;
  const SUCCESS_NOTICE = /(?:publication|post).*(?:publi[ée]e?|published|en cours de publication|being published)|(?:publi[ée]e?|published).*(?:publication|post)/i;
  const DRAFT_NOTICE = /(?:enregistr[ée]|saved).*(?:brouillon|draft)|(?:brouillon|draft).*(?:enregistr[ée]|saved)/i;
  const GROUP_PICKER_TITLE = /(?:s[ée]lectionnez|choisissez) des groupes|select groups/i;
  const FORBIDDEN_GROUP_CONTROL = /booster|boost(?:er)? post|mention ia|ai label|contenu ia|story|audience|planification|scheduling|canal|channel/i;
  const MAX_GROUPS = 9;

  const groupLimit = (requested, named = 0) => Math.min(MAX_GROUPS, Math.max(0, Number(requested) || 0, Number(named) || 0));
  const noticeKind = (text) => DRAFT_NOTICE.test(String(text || '')) ? 'draft'
    : SUCCESS_NOTICE.test(String(text || '')) ? 'published' : null;
  const isPromotionUrl = (url) => /^https:\/\/(?:www\.|web\.)?facebook\.com\/(?:ad_center|adsmanager|ads\/)/i.test(String(url || ''));

  // ------------------------------------------------ Reel or normal video
  // Facebook's « Créer un reel » composer refuses long videos: a video longer
  // than this is posted as a normal video (« Photo/vidéo »), never as a Reel.
  const REEL_MAX_SECONDS = 90;
  // Without a readable duration, a file this heavy is not a short vertical clip.
  const REEL_MAX_BYTES_UNKNOWN = 250 * 1024 * 1024;
  const duration = (seconds) => {
    const s = Math.round(Number(seconds) || 0);
    const m = Math.floor(s / 60);
    return m ? `${m} min${s % 60 ? ` ${String(s % 60).padStart(2, '0')} s` : ''}` : `${s} s`;
  };
  // wanted: "reel" or "video"; info: { duration (s), size (bytes) } of the file.
  // Returns { format: "reel" | "video", reason } — reason says why a Reel became a video.
  function videoFormat(wanted, info = {}) {
    if (wanted !== 'reel') return { format: 'video', reason: null };
    const seconds = Number(info && info.duration);
    if (Number.isFinite(seconds) && seconds > 0) {
      return seconds > REEL_MAX_SECONDS
        ? { format: 'video', reason: `vidéo trop longue pour un Reel (${duration(seconds)}, ${duration(REEL_MAX_SECONDS)} au plus) : publiée en vidéo Facebook` }
        : { format: 'reel', reason: null };
    }
    const size = Number(info && info.size);
    if (Number.isFinite(size) && size > REEL_MAX_BYTES_UNKNOWN) {
      return { format: 'video', reason: `durée illisible et fichier de ${Math.round(size / 1048576)} Mo, trop lourd pour un Reel : publiée en vidéo Facebook` };
    }
    return { format: 'reel', reason: null };
  }

  // ------------------------------------------------ waiting for the upload
  // How long Facebook may take to receive a file: proportional to its size
  // (5 min + 1 min per 10 Mo, between 15 min and 2 h). Past that time the wait
  // goes on only while the percentage still moves, up to 3 h; a percentage
  // stuck for 10 min is a clear failure.
  const MIN = 60000;
  function uploadPlan(sizeBytes) {
    const mb = Math.max(0, Number(sizeBytes) || 0) / 1048576;
    const expectedMs = Math.min(120 * MIN, Math.max(15 * MIN, 5 * MIN + Math.ceil(mb / 10) * MIN));
    return { expectedMs, stallMs: 10 * MIN, hardCapMs: 180 * MIN, sizeMb: Math.round(mb) };
  }
  // elapsedMs: since the wait began; sinceAdvanceMs: since the percentage last
  // moved (or since the start); percent: last percentage read, null if none.
  // Returns null (keep waiting) or { code, message } (give up, with why).
  function uploadVerdict({ elapsedMs, sinceAdvanceMs, percent = null, plan }) {
    const minutes = (ms) => Math.max(1, Math.round(ms / MIN));
    const known = Number.isFinite(percent) && percent !== null;
    const size = plan.sizeMb ? `, fichier de ${plan.sizeMb} Mo` : '';
    const tooLong = () => ({ code: 'too_long',
      message: `Facebook : envoi de la vidéo encore en cours après ${minutes(elapsedMs)} min (${known ? `${Math.round(percent)} %` : 'progression illisible'}${size}). Connexion trop lente ? Termine l’action dans l’onglet Facebook resté ouvert, ou relance plus tard.` });
    if (elapsedMs >= plan.hardCapMs) return tooLong();
    if (known && sinceAdvanceMs >= plan.stallMs) {
      return { code: 'stalled',
        message: `Facebook : envoi de la vidéo bloqué à ${Math.round(percent)} % depuis ${minutes(sinceAdvanceMs)} min${size} (connexion coupée ?). Termine l’action dans l’onglet Facebook resté ouvert, ou relance.` };
    }
    if (!known && elapsedMs >= plan.expectedMs) return tooLong();
    return null;
  }

  const api = Object.freeze({ PUBLISH_BUTTON, GROUPS_DONE_BUTTON, SUCCESS_NOTICE, DRAFT_NOTICE,
    GROUP_PICKER_TITLE, FORBIDDEN_GROUP_CONTROL, MAX_GROUPS, groupLimit, noticeKind, isPromotionUrl,
    REEL_MAX_SECONDS, videoFormat, uploadPlan, uploadVerdict, duration });
  root.KappFacebookFlow = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
