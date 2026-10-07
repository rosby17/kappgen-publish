import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const flow = require('../extension/lib/facebook-flow.js');

test('Facebook group selection is always capped at nine', () => {
  assert.equal(flow.groupLimit(15, 0), 9);
  assert.equal(flow.groupLimit(4, 7), 7);
  assert.equal(flow.groupLimit(0, 0), 0);
});

test('Terminé is distinct from Enregistrer in the group picker', () => {
  assert.match('Terminé', flow.GROUPS_DONE_BUTTON);
  assert.match('Done', flow.GROUPS_DONE_BUTTON);
  assert.doesNotMatch('Enregistrer', flow.GROUPS_DONE_BUTTON);
  assert.doesNotMatch('Save', flow.GROUPS_DONE_BUTTON);
});

test('only an exact final publication action is accepted', () => {
  for (const label of ['Publier', 'Publier maintenant', 'Publish', 'Post']) assert.match(label, flow.PUBLISH_BUTTON);
  for (const label of ['Enregistrer', 'Save', 'Terminé', 'Partager dans des groupes']) assert.doesNotMatch(label, flow.PUBLISH_BUTTON);
});

test('a saved draft is never classified as a published post', () => {
  assert.equal(flow.noticeKind('Publication enregistrée dans les brouillons'), 'draft');
  assert.equal(flow.noticeKind('Draft saved'), 'draft');
  assert.equal(flow.noticeKind('Votre publication a été publiée'), 'published');
});

test('only the real Facebook group picker can supply group checkboxes', () => {
  assert.match('Sélectionnez des groupes', flow.GROUP_PICKER_TITLE);
  assert.match('Select groups', flow.GROUP_PICKER_TITLE);
  assert.doesNotMatch('Paramètres de la publication', flow.GROUP_PICKER_TITLE);
  for (const label of ['Booster la publication', 'Mention IA désactivée', 'Partager dans la story', 'Options de planification']) {
    assert.match(label, flow.FORBIDDEN_GROUP_CONTROL);
  }
  assert.doesNotMatch('Kylian Mbappé Réal Madrid Fan', flow.FORBIDDEN_GROUP_CONTROL);
});

test('Facebook advertising destinations are rejected', () => {
  assert.equal(flow.isPromotionUrl('https://www.facebook.com/ad_center/create/boostpost/?page_id=1'), true);
  assert.equal(flow.isPromotionUrl('https://web.facebook.com/adsmanager/manage/campaigns'), true);
  assert.equal(flow.isPromotionUrl('https://www.facebook.com/centvingtminutes/'), false);
});

test('a video longer than the Reel limit is posted as a normal video, a short one stays a Reel', () => {
  // hf-01 (12 min 47 s) and hf-02 (18 min 04 s) of HiddenFix: never a Reel.
  for (const seconds of [767, 1084, flow.REEL_MAX_SECONDS + 1]) {
    const choice = flow.videoFormat('reel', { duration: seconds, size: 364e6 });
    assert.equal(choice.format, 'video');
    assert.match(choice.reason, /trop longue pour un Reel/);
  }
  assert.deepEqual(flow.videoFormat('reel', { duration: 58, size: 30e6 }), { format: 'reel', reason: null });
  assert.equal(flow.videoFormat('reel', { duration: flow.REEL_MAX_SECONDS }).format, 'reel');
  assert.equal(flow.videoFormat('video', { duration: 20 }).format, 'video');
  // Unreadable duration: the Reel stays, unless the file is far too heavy for one.
  assert.equal(flow.videoFormat('reel', { duration: null, size: 40e6 }).format, 'reel');
  assert.equal(flow.videoFormat('reel', { duration: null, size: 641e6 }).format, 'video');
  assert.equal(flow.videoFormat('reel', {}).format, 'reel');
});

test('the wait for the upload grows with the size of the file, within bounds', () => {
  const MIN = 60000;
  assert.equal(flow.uploadPlan(5e6).expectedMs, 15 * MIN);
  const big = flow.uploadPlan(640864487); // hf-02 : 611 Mio
  assert.ok(big.expectedMs > 15 * MIN, 'a 641 Mo file gets more than the old fixed 15 min');
  assert.equal(big.expectedMs, (5 + 62) * MIN);
  assert.equal(flow.uploadPlan(20e9).expectedMs, 120 * MIN);
});

test('an upload whose percentage keeps moving is waited for; one stuck or endless fails clearly', () => {
  const MIN = 60000;
  const plan = flow.uploadPlan(640864487);
  // Before the expected time: keep waiting, with or without a percentage.
  assert.equal(flow.uploadVerdict({ elapsedMs: 20 * MIN, sinceAdvanceMs: 0, percent: 40, plan }), null);
  assert.equal(flow.uploadVerdict({ elapsedMs: 20 * MIN, sinceAdvanceMs: 20 * MIN, percent: null, plan }), null);
  // Past the expected time, the percentage still moves: keep waiting.
  assert.equal(flow.uploadVerdict({ elapsedMs: plan.expectedMs + 30 * MIN, sinceAdvanceMs: MIN, percent: 92, plan }), null);
  // Stuck for 10 min: stalled, with the percentage in the message.
  const stalled = flow.uploadVerdict({ elapsedMs: 25 * MIN, sinceAdvanceMs: 10 * MIN, percent: 37.4, plan });
  assert.equal(stalled.code, 'stalled');
  assert.match(stalled.message, /bloqué à 37 % depuis 10 min/);
  // No percentage readable past the expected time, or the 3 h cap: too long.
  const late = flow.uploadVerdict({ elapsedMs: plan.expectedMs, sinceAdvanceMs: plan.expectedMs, percent: null, plan });
  assert.equal(late.code, 'too_long');
  assert.match(late.message, /encore en cours après 67 min/);
  assert.equal(flow.uploadVerdict({ elapsedMs: plan.hardCapMs, sinceAdvanceMs: 0, percent: 99, plan }).code, 'too_long');
  // These messages never say « introuvable » (KappGen would read it as a changed page).
  assert.doesNotMatch(stalled.message + late.message, /introuvable/);
});
