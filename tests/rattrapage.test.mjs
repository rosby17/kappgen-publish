import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { planifier } = require('../extension/lib/rattrapage.js');
const H = (h, m = 0) => Date.UTC(2026, 10, 6, h, m);
const min = 60000;

test('les retards prennent les trous du planning et les heures restent croissantes (exemple de Roosevelt, 06/11)', () => {
  const retards = ['r1', 'r2', 'r3'].map((path, i) => ({ path, due_at: H(7, i) }));
  const prevus = [{ path: 'p852', due_at: H(8, 52) }, { path: 'p900', due_at: H(9) }];
  const plan = planifier({ retards, prevus, depart: H(8, 40), ecart: 5 * min });
  assert.deepEqual(plan.map((e) => [e.post.path, new Date(e.at).toISOString().slice(11, 16)]), [
    ['r1', '08:40'], ['r2', '08:45'],      // 08:50 + 5 min dépasserait 08:52 : le post de 08:52 passe à son heure
    ['p852', '08:52'], ['p900', '09:00'],  // 08:57 + 5 dépasserait 09:00
    ['r3', '09:05'],
  ]);
  for (let i = 1; i < plan.length; i += 1) assert.ok(plan[i].at >= plan[i - 1].at + 5 * min, 'jamais deux posts trop proches');
});

test('un post arrivé à son heure pendant le rattrapage passe avant les vieux retards', () => {
  const plan = planifier({ retards: [{ path: 'vieux', due_at: H(6) }], prevus: [{ path: 'maintenant', due_at: H(10) }], maintenant: H(10, 1), depart: H(10, 1), ecart: 4 * min });
  assert.deepEqual(plan.map((e) => e.post.path), ['maintenant', 'vieux']);
  assert.equal(plan[0].at, H(10, 1));
  assert.equal(plan[1].at, H(10, 5));
});

test('sans post programmé, les retards partent un par un au rythme choisi', () => {
  const plan = planifier({ retards: [{ path: 'a', due_at: 1 }, { path: 'b', due_at: 2 }], prevus: [], depart: H(12), ecart: 3 * min });
  assert.deepEqual(plan.map((e) => e.at), [H(12), H(12, 3)]);
  assert.ok(plan.every((e) => e.retard));
});

test('un post programmé part à son heure même si le rythme de publication retient les retards', () => {
  // Rythme : prochaine publication permise à 09:30 ; un post est programmé à 09:00 et il est 08:50.
  const plan = planifier({ retards: [{ path: 'retard', due_at: H(7) }], prevus: [{ path: 'p900', due_at: H(9) }],
    maintenant: H(8, 50), depart: H(9, 30), ecart: 45 * min });
  assert.deepEqual(plan.map((e) => [e.post.path, new Date(e.at).toISOString().slice(11, 16)]), [['p900', '09:00'], ['retard', '09:45']]);
});

test('le background laisse partir un post à son heure malgré le rythme, hors quota', async () => {
  const { readFileSync } = await import('node:fs');
  const bg = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
  assert.match(bg, /if \(duePost && \(!paced \|\| aLHeure\)\)/);
  assert.match(bg, /await paceRecord\(\{ horsRythme: aLHeure \}\)/);
  assert.match(bg, /importScripts\('lib\/rattrapage\.js'\)/);
});

test('la liste du panneau suit l’heure réelle de départ (un retard replanifié descend à sa nouvelle place)', async () => {
  const { readFileSync } = await import('node:fs');
  const panel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  assert.match(panel, /const heureDe = \(p\) =>/);
  assert.match(panel, /dayGroups\(upcoming, \(p\) => heureDe\(p\) \|\| p\.due_at/);
});
