// Shared validation for YouTube publication slots. Studio exposes quarter-hour
// choices, so accepting arbitrary minutes would create a schedule different
// from the one displayed to the user.
const KappSchedule = (() => {
  const pad2 = (value) => String(value).padStart(2, '0');

  function parseTimes(value, { defaultTime = '18:00' } = {}) {
    const raw = String(value || '').trim() || defaultTime;
    const tokens = raw.split(/[,;\s]+/).filter(Boolean);
    const unique = new Map();
    for (const token of tokens) {
      const match = token.match(/^(\d{1,2})[:hH](\d{2})$/);
      if (!match) throw new Error(`Créneau invalide « ${token} » : utilise HH:MM.`);
      const hour = Number(match[1]);
      const minute = Number(match[2]);
      if (hour > 23 || minute > 59) throw new Error(`Créneau invalide « ${token} ».`);
      if (minute % 15) throw new Error(`Créneau invalide « ${token} » : utilise 00, 15, 30 ou 45 minutes.`);
      unique.set(`${hour}:${minute}`, [hour, minute]);
    }
    return [...unique.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  }

  function normalizeTimes(value) {
    try {
      const slots = parseTimes(value, { defaultTime: '' });
      return slots.length ? slots.map(([hour, minute]) => `${pad2(hour)}:${pad2(minute)}`).join(', ') : null;
    } catch {
      return null;
    }
  }

  // Créneaux libres successifs d'une chaîne : au moins une heure après maintenant, jamais un créneau déjà pris par une vidéo programmée.
  function freeSlots(timesText, taken = [], count = 1, now = Date.now(), delay = 3600 * 1000) {
    const pris = new Set((taken || []).map(Number));
    const earliest = now + delay;
    const out = [];
    for (let day = 0; day < 400 && out.length < count; day += 1) {
      for (const [hour, minute] of parseTimes(timesText)) {
        const date = new Date(now);
        date.setDate(date.getDate() + day);
        date.setHours(hour, minute, 0, 0);
        if (date.getTime() >= earliest && !pris.has(date.getTime())) { out.push(date.getTime()); if (out.length >= count) break; }
      }
    }
    return out;
  }

  // Heure prévue de chaque vidéo qui partira toute seule (Roosevelt, 19/10 : « chacun doit avoir son heure de publication ») :
  // pour chaque chaîne programmée, dans l'ordre où elles partiront, le créneau libre suivant. Une heure choisie à la main reste la sienne.
  // videos : [{ id, channel_key, schedule_at }] ; scheduleOf(video) -> null (pas programmée) ou le texte des heures.
  function plan(videos, scheduleOf, scheduled = {}, now = Date.now()) {
    const out = new Map();
    const parChaine = new Map();
    for (const v of videos) {
      if (v.schedule_at && v.schedule_at > now) { out.set(v.id, v.schedule_at); continue; }
      const times = scheduleOf(v);
      if (!times) continue;
      if (!parChaine.has(v.channel_key)) parChaine.set(v.channel_key, { times, list: [] });
      parChaine.get(v.channel_key).list.push(v);
    }
    for (const [key, { times, list }] of parChaine) {
      const pris = [...((scheduled || {})[key] || []), ...videos.filter((v) => v.channel_key === key && v.schedule_at > now).map((v) => v.schedule_at)];
      let slots;
      try { slots = freeSlots(times, pris, list.length, now); } catch { continue; }
      list.forEach((v, i) => { if (slots[i]) out.set(v.id, slots[i]); });
    }
    return out;
  }

  return { parseTimes, normalizeTimes, freeSlots, plan };
})();
