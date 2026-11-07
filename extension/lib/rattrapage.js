// Rattrapage des posts en retard, réinsérés DANS le planning de la journée (Roosevelt, 06/11 : « que dans le calendrier l'heure soit
// toujours croissante »). Avant, les retards partaient à intervalle fixe à partir de maintenant, sans regarder les posts programmés :
// un retard annoncé à 9 h 07 après un post de 9 h, et un post programmé qui arrivait à son heure passait derrière tous les retards.
// Maintenant :
//   - un post programmé part À SON HEURE (Roosevelt, 06/11 : « oui, à leur heure »), sans attendre le rythme de publication ;
//   - les retards, dans leur ordre, prennent les trous libres : chacun `ecart` après le précédent, et seulement s'il reste `ecart`
//     avant le prochain post programmé ; sinon ils passent après lui (au plus tôt `ecart` après lui).
// Les heures du plan sont donc toujours croissantes. Fonction pure (heures en paramètre) pour être testée sans navigateur.
const KappRattrapage = (() => {
  // retards : posts dus depuis un moment, du plus ancien au plus récent ; prevus : posts à leur heure ou à venir ({ due_at }).
  // maintenant : l'heure actuelle (un post programmé déjà dû part tout de suite) ; depart : premier moment possible pour un retard
  // (maintenant, `ecart` après le dernier post envoyé, ou la prochaine heure permise par le rythme). Renvoie [{ post, at, retard }].
  function planifier({ retards = [], prevus = [], maintenant = 0, depart, ecart }) {
    const enRetard = [...retards];
    const aVenir = [...prevus].filter((p) => p && p.due_at).sort((a, b) => a.due_at - b.due_at);
    const plan = [];
    let t = Math.max(depart, maintenant);
    let j = 0;
    while (enRetard.length) {
      const prochain = aVenir[j];
      if (prochain && prochain.due_at < t + ecart) {
        // Pas la place d'un retard avant ce post programmé : il part à son heure, le retard suivant après lui.
        const at = Math.max(prochain.due_at, maintenant, plan.length ? plan[plan.length - 1].at : 0);
        plan.push({ post: prochain, at, retard: false });
        t = Math.max(t, at + ecart);
        j += 1;
      } else {
        plan.push({ post: enRetard.shift(), at: t, retard: true });
        t += ecart;
      }
    }
    return plan;
  }

  const api = { planifier };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
