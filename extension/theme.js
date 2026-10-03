// Thème du panneau, posé avant l'affichage, comme sur app.kappgen.com : le choix de l'utilisateur (bouton de l'en-tête ou
// menu du compte, et le thème réglé sur son compte KappGen), sinon celui de l'ordinateur.
(() => {
  const choix = localStorage.getItem('kgTheme');
  document.documentElement.dataset.theme = choix === 'clair' || choix === 'sombre' ? choix
    : (matchMedia('(prefers-color-scheme: light)').matches ? 'clair' : 'sombre');
})();
