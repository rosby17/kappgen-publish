import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const pace = require('../extension/lib/rythme.js');
const at = (h, m = 0) => new Date(2026, 9, 4, h, m, 0, 0).getTime();
const day = pace.dayStartOf(at(12));
const seeded = (seed) => () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

test('par défaut : une publication toutes les 45 min, à intervalle régulier (Roosevelt, 10/10)', () => {
  const p = pace.normalize(undefined);
  assert.equal(p.mode, 'interval');
  assert.equal(p.intervalMinutes, 45);
  assert.equal(pace.normalize({ mode: 'n’importe quoi' }).mode, 'interval');
  assert.equal(pace.gate(undefined, at(3), [], () => []).next, at(8));                  // la nuit : rien avant 8 h
  assert.deepEqual(pace.gate(undefined, at(10), [at(9, 10)], () => []), { ok: true });   // 50 min après la dernière
  assert.equal(pace.gate(undefined, at(9, 30), [at(9)], () => []).next, at(9, 45));     // 30 min après : attendre 45 min
});

test('jamais moins de 45 min entre deux publications automatiques', () => {
  assert.equal(pace.normalize({ mode: 'interval', intervalMinutes: 10 }).intervalMinutes, 45);
  assert.equal(pace.normalize({ mode: 'random', minGapMinutes: 5 }).minGapMinutes, 45);
  assert.equal(pace.normalize({ mode: 'auto' }).minGapMinutes, 45);
});

test('30 publications automatiques par jour au plus, quel que soit le mode', () => {
  assert.equal(pace.normalize({ mode: 'random', perDay: 200 }).perDay, 30);
  const trente = Array.from({ length: 30 }, (_, i) => at(0, 1) + i * 60000);
  const lendemain = pace.dayStartOf(day + 36 * 3600000);
  assert.deepEqual(pace.gate({ mode: 'asap' }, at(13), trente, () => []), { ok: false, next: lendemain });
  assert.deepEqual(pace.gate({ mode: 'asap' }, at(13), trente.slice(1), () => []), { ok: true });
  assert.equal(pace.gate({ mode: 'interval', from: '00:00', to: '23:59' }, at(13), trente, () => []).ok, false);
});

test('intervalle régulier : une publication toutes les N minutes, dans la plage horaire', () => {
  const p = { mode: 'interval', intervalMinutes: 90, from: '08:00', to: '22:00' };
  assert.equal(pace.gate(p, at(7, 30), [], () => []).next, at(8));                       // avant la plage
  assert.deepEqual(pace.gate(p, at(9), [], () => []), { ok: true });                    // première du jour
  assert.deepEqual(pace.gate(p, at(10, 0), [at(9)], () => []), { ok: false, next: at(10, 30) });
  assert.deepEqual(pace.gate(p, at(10, 31), [at(9)], () => []), { ok: true });
  assert.equal(pace.gate(p, at(21, 10), [at(21, 0)], () => []).next, at(8) + 24 * 3600000);   // dépasserait la plage : demain
  assert.equal(pace.gate(p, at(23), [], () => []).next, at(8) + 24 * 3600000);
});

test('aléatoire : N heures irrégulières dans la plage, écart minimal respecté, jamais deux jours pareils', () => {
  const p = { mode: 'random', perDay: 8, from: '08:00', to: '22:00', minGapMinutes: 20 };
  const a = pace.buildPlan(p, day, seeded(7));
  const b = pace.buildPlan(p, day, seeded(99));
  assert.equal(a.length, 8);
  for (const t of a) assert.ok(t >= at(8) && t <= at(22));
  for (let i = 1; i < a.length; i += 1) assert.ok(a[i] - a[i - 1] >= 20 * 60000);
  assert.notDeepEqual(a, b);
  const gaps = a.slice(1).map((t, i) => t - a[i]);
  assert.ok(new Set(gaps.map((g) => Math.round(g / 60000))).size > 3, 'les écarts doivent varier');
});

test('aléatoire : suit le plan du jour, rattrape ce qui est en retard un par un, puis attend demain', () => {
  const p = { mode: 'random', perDay: 3, from: '08:00', to: '22:00', minGapMinutes: 30 };
  const plans = (d) => pace.buildPlan(p, d, seeded(5));
  const plan = plans(day);
  assert.deepEqual(pace.gate(p, plan[0] - 1000, [], plans), { ok: false, next: plan[0] });
  assert.deepEqual(pace.gate(p, plan[0] + 1000, [], plans), { ok: true });
  // une publication faite : la suivante attend sa case du plan (ou l’écart minimal)
  const g = pace.gate(p, plan[0] + 2000, [plan[0] + 1000], plans);
  assert.equal(g.ok, false);
  assert.equal(g.next, Math.max(plan[1], plan[0] + 1000 + 30 * 60000));
  // les 3 du jour sont faites : prochaine = première heure de demain
  const done = [plan[0], plan[1], plan[2]];
  const after = pace.gate(p, plan[2] + 60000, done, plans);
  assert.equal(after.ok, false);
  assert.equal(after.next, plans(pace.dayStartOf(day + 36 * 3600000))[0]);
});

test('automatique : l’extension décide (8 par jour, 8 h – 22 h, irrégulier), quels que soient les autres réglages', () => {
  const n = pace.normalize({ mode: 'auto', perDay: 1, from: '00:00', to: '01:00' });
  assert.deepEqual([n.perDay, n.from, n.to], [8, '08:00', '22:00']);
  const plans = (d) => pace.buildPlan(n, d, seeded(3));
  assert.equal(plans(day).length, 8);
  assert.equal(pace.gate(n, at(6), [], plans).ok, false);
  assert.deepEqual(pace.gate(n, plans(day)[0] + 1000, [], plans), { ok: true });
});
