// Rythme de publication (Réglages → « Rythme de publication »), commun à tous les réseaux.
//   auto     : l'extension décide pour la personne : irrégulier comme une personne, 8 publications par jour de 8 h à 22 h
//   asap     : dès que c'est prêt (comportement d'origine)
//   interval : une publication toutes les N minutes, dans la plage horaire choisie
//   random   : N publications par jour à des heures irrégulières, comme une personne (jamais à intervalle fixe)
// Règles de Roosevelt (10/10) : par défaut, une publication toutes les 45 min (intervalle régulier) ; jamais moins de 45 min entre deux
// publications automatiques (sauf « dès que c'est prêt ») ; jamais plus de 30 publications automatiques par jour, quel que soit le mode.
// Chaque envoi sur un réseau compte pour une publication. Les fonctions sont pures (l'heure et le hasard sont passés en paramètres)
// pour être testées sans navigateur.
const KappPace = (() => {
  const MODES = ['asap', 'auto', 'interval', 'random'];
  const MIN_GAP = 45;          // minutes, au moins, entre deux publications automatiques
  const MAX_PER_DAY = 30;      // publications automatiques par jour, au plus
  const AUTO = { perDay: 8, from: '08:00', to: '22:00', minGapMinutes: MIN_GAP };
  const DEFAULTS = { mode: 'interval', intervalMinutes: MIN_GAP, perDay: 8, from: '08:00', to: '22:00', minGapMinutes: MIN_GAP };
  const clampInt = (v, min, max, fallback) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  const validTime = (v, fallback) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '')) ? String(v) : fallback);

  function normalize(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const p = {
      mode: MODES.includes(r.mode) ? r.mode : DEFAULTS.mode,
      intervalMinutes: clampInt(r.intervalMinutes, MIN_GAP, 24 * 60, DEFAULTS.intervalMinutes),
      perDay: clampInt(r.perDay, 1, MAX_PER_DAY, DEFAULTS.perDay),
      from: validTime(r.from, DEFAULTS.from),
      to: validTime(r.to, DEFAULTS.to),
      minGapMinutes: clampInt(r.minGapMinutes, MIN_GAP, 600, DEFAULTS.minGapMinutes),
    };
    if (p.to <= p.from) { p.from = DEFAULTS.from; p.to = DEFAULTS.to; }
    return p.mode === 'auto' ? { ...p, ...AUTO } : p;      // automatique : les réglages de la personne ne comptent pas, l'extension choisit
  }

  const atClock = (dayStart, hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    const d = new Date(dayStart);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  };
  const dayStartOf = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

  // The day's irregular times: the window is cut into perDay bands and one moment is drawn inside each (so the day is covered
  // without ever being regular), then a minimum gap between two posts is enforced. random() returns [0, 1).
  function buildPlan(pace, dayStart, random = Math.random) {
    const p = normalize(pace);
    const from = atClock(dayStart, p.from);
    const to = atClock(dayStart, p.to);
    const band = (to - from) / p.perDay;
    const minGap = Math.min(p.minGapMinutes * 60000, band * 0.9);
    const times = [];
    for (let i = 0; i < p.perDay; i += 1) {
      let t = Math.round(from + (i + random()) * band);
      if (times.length && t < times[times.length - 1] + minGap) t = times[times.length - 1] + minGap;
      times.push(Math.min(t, to));
    }
    return times;
  }

  // Can a publication go out now? `log` = start times of the automatic publications already done (ms, ascending).
  // plans(dayStart) returns the day's plan (kept by the caller so that it does not change at every pass).
  // → { ok: true } or { ok: false, next } (when the next one may go out).
  function gate(pace, now, log, plans) {
    const p = normalize(pace);
    const last = (log && log.length) ? log[log.length - 1] : 0;
    const today = dayStartOf(now);
    const tomorrow = dayStartOf(today + 36 * 3600000);
    const doneToday = (log || []).filter((t) => t >= today && t < tomorrow).length;
    if (p.mode === 'asap') return doneToday >= MAX_PER_DAY ? { ok: false, next: tomorrow } : { ok: true };
    if (doneToday >= MAX_PER_DAY) return { ok: false, next: p.mode === 'interval' ? atClock(tomorrow, p.from) : plans(tomorrow)[0] };
    const start = atClock(today, p.from);
    const end = atClock(today, p.to);
    const irregular = p.mode === 'random' || p.mode === 'auto';
    const nextDayStart = () => (irregular ? plans(tomorrow)[0] : atClock(tomorrow, p.from));
    if (now < start) return { ok: false, next: irregular ? Math.max(start, plans(today)[0]) : start };
    if (now > end) return { ok: false, next: nextDayStart() };
    let next;
    if (p.mode === 'interval') {
      next = last ? last + p.intervalMinutes * 60000 : now;
    } else {
      const plan = plans(today);
      const used = (log || []).filter((t) => t >= start && t <= end + 3600000).length;
      if (used >= plan.length) return { ok: false, next: nextDayStart() };
      next = Math.max(plan[used], last ? last + p.minGapMinutes * 60000 : 0);
    }
    if (next > end) return { ok: false, next: nextDayStart() };
    return now >= next ? { ok: true } : { ok: false, next };
  }

  const api = { MODES, DEFAULTS, AUTO, MIN_GAP, MAX_PER_DAY, normalize, buildPlan, gate, dayStartOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
