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
