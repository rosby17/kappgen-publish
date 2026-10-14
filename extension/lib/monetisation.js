// Étape « Monétisation » de YouTube Studio : reconnaître « Activée » / « Désactivée » quel que soit le libellé du moment.
// Échec du 14/10 (Ballon Viral) : le menu s'ouvrait, mais aucun choix n'était reconnu, et la seule ligne « vue » était la
// barre de mise en ligne du bas de l'écran (« bv-23-….mp4 Mise en ligne effectuée à 1 % »). Studio change souvent ses
// libellés (Activée / Activer / On…) : la recette du serveur reste prioritaire, ces formes connues servent de filet.
// Fonctions pures (le texte est passé en paramètre) pour être testées sans navigateur.
(() => {
  const ON = /^\s*(on|activ(?:[ée]e?|er|ate|ated)|ein|activad[ao]|ativad[ao])(?![a-zà-ÿ])/i;
  const OFF = /^\s*(off|d[ée]sactiv(?:[ée]e?|er)|deactivate|turn off|aus|desactivad[ao]|desativad[ao])(?![a-zà-ÿ])/i;
  // Ligne de la file de mise en ligne (nom de fichier, pourcentage) : jamais un choix de monétisation.
  const UPLOAD_ROW = /\.(mp4|mov|m4v|webm|mkv|avi)\b|mise en ligne (effectu|interrompu|termin)|importation\s*:?\s*\d|upload(ing|ed)?\b.*\d+\s*%|\d+\s*%/i;
  // Conteneurs de cette file, à écarter entièrement.
  const UPLOAD_PANEL = 'ytcp-multi-progress-monitor, ytcp-uploads-mini-indicator, ytcp-upload-progress, #progress-list';
  // Menus et petites fenêtres que Studio ouvre au-dessus de la fenêtre d'envoi.
  const OVERLAYS = 'tp-yt-iron-dropdown, ytcp-text-menu, tp-yt-paper-listbox, [role="listbox"], [role="menu"], tp-yt-paper-dialog, ytcp-dialog, ytcp-video-monetization-edit-dialog';

  const isUploadRow = (text) => UPLOAD_ROW.test(String(text || ''));

  // Le texte d'un élément est-il le choix voulu ? recipeRe : l'expression de la recette du serveur (prioritaire).
  function matches(text, mode, recipeRe) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 200 || isUploadRow(t)) return false;
    if (recipeRe && recipeRe.test(t)) return true;
    return (mode === 'on' ? ON : OFF).test(t);
  }

  const api = { ON, OFF, UPLOAD_PANEL, OVERLAYS, isUploadRow, matches };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  // Sur la page : window.KappMonetisation (le fichier peut être injecté plusieurs fois dans le même onglet).
  if (typeof window !== 'undefined') window.KappMonetisation = api;
})();
