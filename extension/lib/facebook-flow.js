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
  const api = Object.freeze({ PUBLISH_BUTTON, GROUPS_DONE_BUTTON, SUCCESS_NOTICE, DRAFT_NOTICE,
    GROUP_PICKER_TITLE, FORBIDDEN_GROUP_CONTROL, MAX_GROUPS, groupLimit, noticeKind, isPromotionUrl });
  root.KappFacebookFlow = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
