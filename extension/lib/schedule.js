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

  return { parseTimes, normalizeTimes };
})();
