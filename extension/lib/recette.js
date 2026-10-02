// What KappGen Publish knows about the pages it fills (selectors, button
// names in each language, texts it waits for) is not in the extension: the
// KappGen server sends it as data to accounts with an active trial or
// subscription. background.js puts it in window.__kappgenRecipe before
// injecting a network's script; this file reads it, at the moment of use,
// so a newer recipe applies without reloading the page.
(() => {
  const missing = (where) => new Error(`KappGen Publish : recette de publication indisponible (${where}). Ouvre le panneau KappGen Publish : abonnement ou connexion à vérifier.`);
  const compiled = new Map();
  function get(network, kind, key) {
    const recipe = window.__kappgenRecipe;
    const value = recipe && recipe[network] && recipe[network][kind] && recipe[network][kind][key];
    if (value == null) throw missing(`${network}.${key}`);
    return value;
  }
  window.KappRecipe = {
    // CSS selector; {name} placeholders are filled from vars.
    sel(network, key, vars) {
      let selector = get(network, 'sel', key);
      for (const [name, value] of Object.entries(vars || {})) selector = selector.split(`{${name}}`).join(value);
      return selector;
    },
    // Regular expression, stored as "/source/flags".
    re(network, key) {
      const raw = get(network, 're', key);
      if (!compiled.has(raw)) {
        const parts = /^\/([\s\S]*)\/([a-z]*)$/.exec(raw);
        if (!parts) throw missing(`${network}.${key}`);
        compiled.set(raw, new RegExp(parts[1], parts[2]));
      }
      return compiled.get(raw);
    },
  };
})();
