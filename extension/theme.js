// Thème du panneau, posé avant l'affichage : sombre par défaut, clair au choix
// (bouton de l'en-tête), comme sur app.kappgen.com.
document.documentElement.dataset.theme = localStorage.getItem('kgTheme') === 'clair' ? 'clair' : 'sombre';
