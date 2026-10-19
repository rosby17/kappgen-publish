import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

class MemoryFile {
  constructor(name, text = '', { size = null, lastModified = 1 } = {}) {
    this.kind = 'file';
    this.name = name;
    this.body = text;
    this.fixedSize = size;
    this.lastModified = lastModified;
  }

  async getFile() {
    return {
      name: this.name,
      size: this.fixedSize ?? Buffer.byteLength(this.body),
      lastModified: this.lastModified,
      text: async () => this.body,
    };
  }

  async createWritable() {
    return {
      write: async (value) => { this.body = String(value); this.fixedSize = null; this.lastModified += 1; },
      close: async () => {},
    };
  }
}

class MemoryDirectory {
  constructor(name) {
    this.kind = 'directory';
    this.name = name;
    this.children = new Map();
  }

  dir(name) {
    const value = new MemoryDirectory(name);
    this.children.set(name, value);
    return value;
  }

  file(name, text = '', options = {}) {
    const value = new MemoryFile(name, text, options);
    this.children.set(name, value);
    return value;
  }

  async *entries() { yield* this.children.entries(); }

  async getFileHandle(name, options = {}) {
    let value = this.children.get(name);
    if (!value && options.create) {
      value = this.file(name);
    }
    if (!value || value.kind !== 'file') throw new DOMException(`${name} not found`, 'NotFoundError');
    return value;
  }

  async getDirectoryHandle(name) {
    const value = this.children.get(name);
    if (!value || value.kind !== 'directory') throw new DOMException(`${name} not found`, 'NotFoundError');
    return value;
  }

  async queryPermission() { return 'granted'; }
  async resolve(other) { return other === this ? [] : null; }
}

function library() {
  const context = vm.createContext({ console, DOMException, indexedDB: {} });
  const fiches = readFileSync(join(root, 'extension/lib/fiches.js'), 'utf8');
  const dossier = readFileSync(join(root, 'extension/lib/dossier.js'), 'utf8');
  vm.runInContext(`${fiches}\n${dossier}\nthis.KappFiches = KappFiches; this.KappDossier = KappDossier;`, context);
  return context;
}

function scheduleLibrary() {
  const context = vm.createContext({});
  const source = readFileSync(join(root, 'extension/lib/schedule.js'), 'utf8');
  vm.runInContext(`${source}\nthis.KappSchedule = KappSchedule;`, context);
  return context.KappSchedule;
}

function project(parent, name, videoName, modified) {
  const dir = parent.dir(name);
  dir.file(videoName, '', { size: 6 * 1024 * 1024, lastModified: modified });
  dir.file('publication.md', `## Titre\n${name}\n\n## Description\nDescription de ${name}`);
  return dir;
}

test('publishing sheets are parsed and sanitized', () => {
  const { KappFiches } = library();
  const sheet = KappFiches.read('publication.md', '## Titre\nUn titre\n\n## Tags\n#un, deux mots');
  assert.equal(sheet.title, 'Un titre');
  assert.deepEqual([...sheet.tags], ['un', 'deux mots']);
  assert.equal(KappFiches.clean('<titre>', 100), '‹titre›');
});

test('publication slots are normalized and invalid times are rejected', () => {
  const schedule = scheduleLibrary();
  assert.equal(JSON.stringify(schedule.parseTimes('18:30, 08h00, 18:30')), '[[8,0],[18,30]]');
  assert.equal(schedule.normalizeTimes('8h00 18:45'), '08:00, 18:45');
  assert.equal(schedule.normalizeTimes('24:00'), null);
  assert.equal(schedule.normalizeTimes('12:17'), null);
});

test('watchSince blocks pre-existing videos but allows later stable renders', async () => {
  const { KappDossier } = library();
  const disk = new MemoryDirectory('VIDEOS');
  const channel = disk.dir('CHAINE');
  project(channel, 'Ancienne', 'ancienne.mp4', 4_000_000);
  project(channel, 'Nouvelle', 'nouvelle.mp4', 6_000_000);
  KappDossier._setTestRoot(disk);

  const queue = await KappDossier.scan({ watchSince: 5_000_000, now: 10_000_000 });
  const oldVideo = queue.videos.find((item) => item.relative_path.endsWith('/ancienne.mp4'));
  const newVideo = queue.videos.find((item) => item.relative_path.endsWith('/nouvelle.mp4'));
  assert.equal(oldVideo.auto_ok, false);
  assert.match(oldVideo.auto_blocked, /déjà dans le dossier/);
  assert.equal(newVideo.auto_ok, true);
});

test('social updates never move the original YouTube publication timestamp', async () => {
  const { KappDossier } = library();
  const disk = new MemoryDirectory('VIDEOS');
  const channel = disk.dir('CHAINE');
  project(channel, 'Episode', 'episode.mp4', 1_000_000);
  KappDossier._setTestRoot(disk);

  const path = 'CHAINE/Episode/episode.mp4';
  const first = await KappDossier.mark(path, 'published', { youtubeId: 'abcdefghijk' });
  const publishedAt = first.youtubePublishedAt;
  await new Promise((resolve) => setTimeout(resolve, 2));
  const social = await KappDossier.mark(path, 'published', { xPublishedAt: new Date().toISOString() });
  assert.equal(social.youtubePublishedAt, publishedAt);
  assert.equal(social.publishedAt, publishedAt);
});

test('invalid publication.json is visible and can never be ready', async () => {
  const { KappDossier } = library();
  const disk = new MemoryDirectory('VIDEOS');
  const facebook = new MemoryDirectory('FACEBOOK');
  const post = facebook.dir('2026-10-02-1200-test');
  post.file('texte.txt', 'Texte à publier');
  post.file('publication.json', '{ invalide');
  KappDossier._setTestRoot(disk);
  KappDossier._setTestFbRoot(facebook);

  const [item] = await KappDossier.facebookPosts({ now: Date.now(), net: 'facebook' });
  assert.equal(item.statut, 'configuration_invalide');
  assert.equal(item.ready, false);
  assert.match(item.configuration_error, /JSON invalide/);
});

test('a corrupted tracking file blocks scanning instead of risking a duplicate upload', async () => {
  const { KappDossier } = library();
  const disk = new MemoryDirectory('VIDEOS');
  disk.file('.kappgen-publications.json', '{ état corrompu');
  const channel = disk.dir('CHAINE');
  project(channel, 'Episode', 'episode.mp4', 1_000_000);
  KappDossier._setTestRoot(disk);

  await assert.rejects(
    KappDossier.scan({ now: 10_000_000 }),
    /\.kappgen-publications\.json est invalide.*Aucune publication/s,
  );
});

test('invalid channel settings block scanning instead of applying unsafe defaults', async () => {
  const { KappDossier } = library();
  const disk = new MemoryDirectory('VIDEOS');
  const channel = disk.dir('CHAINE');
  channel.file('reglages-publication.json', '{ invalide');
  project(channel, 'Episode', 'episode.mp4', 1_000_000);
  KappDossier._setTestRoot(disk);

  await assert.rejects(KappDossier.scan({ now: 10_000_000 }), /JSON invalide dans reglages-publication\.json/);
});

test('mistyped channel automation settings are rejected instead of coerced', async () => {
  const { KappDossier } = library();
  const disk = new MemoryDirectory('VIDEOS');
  const channel = disk.dir('CHAINE');
  channel.file('reglages-publication.json', JSON.stringify({ youtube: { auto: 'false' } }));
  project(channel, 'Episode', 'episode.mp4', 1_000_000);
  KappDossier._setTestRoot(disk);

  await assert.rejects(KappDossier.scan({ now: 10_000_000 }), /youtube\.auto doit valoir true ou false/);
});

test('channel schedule files accept quarter-hours only', async () => {
  const { KappDossier } = library();
  const disk = new MemoryDirectory('VIDEOS');
  const channel = disk.dir('CHAINE');
  channel.file('reglages-publication.json', JSON.stringify({ youtube: { heures: ['12:17'] } }));
  project(channel, 'Episode', 'episode.mp4', 1_000_000);
  KappDossier._setTestRoot(disk);

  await assert.rejects(KappDossier.scan({ now: 10_000_000 }), /youtube\.heures.*quarts d’heure/);
});

test('invalid network planning blocks every affected post', async () => {
  const { KappDossier } = library();
  const disk = new MemoryDirectory('VIDEOS');
  const facebook = new MemoryDirectory('FACEBOOK');
  facebook.file('planning.json', '[]');
  const post = facebook.dir('publication-test');
  post.file('texte.txt', 'Texte à publier');
  KappDossier._setTestRoot(disk);
  KappDossier._setTestFbRoot(facebook);

  const [item] = await KappDossier.facebookPosts({ now: Date.now(), net: 'facebook' });
  assert.equal(item.statut, 'configuration_invalide');
  assert.equal(item.ready, false);
  assert.match(item.configuration_error, /planning\.json doit contenir un objet JSON/);
});

test('an invalid Facebook destination is blocked instead of falling back to a profile', async () => {
  const { KappDossier } = library();
  const disk = new MemoryDirectory('VIDEOS');
  const facebook = new MemoryDirectory('FACEBOOK');
  const post = facebook.dir('publication-test');
  post.file('texte.txt', 'Texte à publier');
  post.file('publication.json', JSON.stringify({ page: 'https://example.com/mauvaise-page' }));
  KappDossier._setTestRoot(disk);
  KappDossier._setTestFbRoot(facebook);

  const [item] = await KappDossier.facebookPosts({ now: Date.now(), net: 'facebook' });
  assert.equal(item.ready, false);
  assert.match(item.configuration_error, /champ page.*facebook\.com/);
});

test('the planning template marker falls back to the Page configured in the panel', async () => {
  const { KappDossier } = library();
  const disk = new MemoryDirectory('VIDEOS');
  const facebook = new MemoryDirectory('FACEBOOK');
  facebook.file('planning.json', JSON.stringify({
    page: "[À COMPLÉTER — ou laisser l'extension utiliser la page déjà configurée dans son panneau]",
  }));
  const post = facebook.dir('publication-test');
  post.file('texte.txt', 'Texte à publier');
  KappDossier._setTestRoot(disk);
  KappDossier._setTestFbRoot(facebook);

  const [item] = await KappDossier.facebookPosts({ now: Date.now(), net: 'facebook' });
  assert.equal(item.configuration_error, null);
  assert.equal(item.page, null);
  assert.equal(item.ready, true);
});

test('explicit missing media and mistyped group settings block a post', async () => {
  const { KappDossier } = library();
  const disk = new MemoryDirectory('VIDEOS');
  const facebook = new MemoryDirectory('FACEBOOK');
  const post = facebook.dir('publication-test');
  post.file('texte.txt', 'Le mauvais texte ne doit pas servir de repli');
  post.file('publication.json', JSON.stringify({ texte: 'absent.txt', groupes: 'false' }));
  KappDossier._setTestRoot(disk);
  KappDossier._setTestFbRoot(facebook);

  const [item] = await KappDossier.facebookPosts({ now: Date.now(), net: 'facebook' });
  assert.equal(item.ready, false);
  assert.match(item.configuration_error, /champ texte.*présent/);
});

test('invalid group links and tracking states are rejected instead of silently skipped', async () => {
  const { KappDossier } = library();
  const disk = new MemoryDirectory('VIDEOS');
  const facebook = new MemoryDirectory('FACEBOOK');
  const post = facebook.dir('publication-test');
  post.file('texte.txt', 'Texte à publier');
  post.file('publication.json', JSON.stringify({
    groupes: ['https://example.com/faux-groupe'],
    groupes_partages: { 'https://www.facebook.com/groups/exemple/': { statut: 'publiee' } },
  }));
  KappDossier._setTestRoot(disk);
  KappDossier._setTestFbRoot(facebook);

  const [item] = await KappDossier.facebookPosts({ now: Date.now(), net: 'facebook' });
  assert.equal(item.ready, false);
  assert.match(item.configuration_error, /champ groupes.*liens.*facebook\.com\/groups/);
});

test('invalid cross-network state blocks the shared post instead of hiding a destination', async () => {
  const { KappDossier } = library();
  const disk = new MemoryDirectory('VIDEOS');
  const facebook = new MemoryDirectory('FACEBOOK');
  const post = facebook.dir('publication-test');
  post.file('texte.txt', 'Texte à publier');
  post.file('publication.json', JSON.stringify({ x: { statut: 'publiee' } }));
  KappDossier._setTestRoot(disk);
  KappDossier._setTestFbRoot(facebook);

  const [item] = await KappDossier.facebookPosts({ now: Date.now(), net: 'facebook' });
  assert.equal(item.ready, false);
  assert.match(item.configuration_error, /Statut invalide pour x/);
});

test('an uncertain Facebook submission stays blocked pending human verification', async () => {
  const { KappDossier } = library();
  const disk = new MemoryDirectory('VIDEOS');
  const facebook = new MemoryDirectory('FACEBOOK');
  const post = facebook.dir('publication-test');
  post.file('texte.txt', 'Texte à vérifier');
  post.file('publication.json', JSON.stringify({ statut: 'a_verifier', erreur: 'Facebook a ouvert le parcours publicitaire.' }));
  KappDossier._setTestRoot(disk);
  KappDossier._setTestFbRoot(facebook);

  const [item] = await KappDossier.facebookPosts({ now: Date.now(), net: 'facebook' });
  assert.equal(item.configuration_error, null);
  assert.equal(item.statut, 'a_verifier');
  assert.equal(item.ready, false);
  assert.match(item.error, /parcours publicitaire/);
});

// The extension's own history (lib/historique.js) receives every publication.
function libraryWithHistory() {
  const added = [];
  const context = vm.createContext({ console, DOMException, indexedDB: {}, KappHistorique: { add: async (entry) => { added.push(entry); } } });
  const fiches = readFileSync(join(root, 'extension/lib/fiches.js'), 'utf8');
  const dossier = readFileSync(join(root, 'extension/lib/dossier.js'), 'utf8');
  vm.runInContext(`${fiches}\n${dossier}\nthis.KappDossier = KappDossier;`, context);
  return { KappDossier: context.KappDossier, added };
}

test('a published Facebook post and its X copy go into the history', async () => {
  const { KappDossier, added } = libraryWithHistory();
  const disk = new MemoryDirectory('VIDEOS');
  const facebook = new MemoryDirectory('FACEBOOK');
  const post = facebook.dir('2026-10-02-1200-zidane');
  post.file('texte.txt', 'Zidane : « On méritait mieux »\nLe reste du texte');
  post.file('publication.json', '{}');
  KappDossier._setTestRoot(disk);
  KappDossier._setTestFbRoot(facebook);
  const path = 'fb:2026-10-02-1200-zidane';

  await KappDossier.markPost(path, { statut: 'en_cours', started_at: new Date().toISOString() });
  assert.equal(added.length, 0, 'a post being sent is not published yet');
  await KappDossier.markPost(path, { statut: 'publie', published_at: '2026-10-02T12:01:00.000Z' });
  await KappDossier.markPost(path, { x: { statut: 'publie', published_at: '2026-10-02T12:05:00.000Z' } });
  assert.deepEqual(added.map((e) => [e.net, e.kind, e.path, e.title, e.at]), [
    ['facebook', 'texte', path, 'Zidane : « On méritait mieux »', Date.parse('2026-10-02T12:01:00.000Z')],
    ['x', 'texte', path, 'Zidane : « On méritait mieux »', Date.parse('2026-10-02T12:05:00.000Z')],
  ]);
});

test('a YouTube video, its Short and its Reel go into the history with their links', async () => {
  const { KappDossier, added } = libraryWithHistory();
  const disk = new MemoryDirectory('VIDEOS');
  project(disk.dir('CHAINE'), 'Episode', 'episode.mp4', 1_000_000);
  KappDossier._setTestRoot(disk);
  const path = 'CHAINE/Episode/episode.mp4';

  await KappDossier.mark(path, 'started');
  await KappDossier.mark(path, 'published', { youtubeId: 'abcdefghijk', shortYoutubeId: 'shortshort1' });
  await KappDossier.mark(path, 'published', { facebookReelAt: '2026-10-02T13:00:00.000Z' });
  await KappDossier.mark(path, 'published', { facebookReelAt: '2026-10-02T13:00:00.000Z' }); // nothing new
  assert.deepEqual(added.map((e) => [e.net, e.kind, e.url]), [
    ['youtube', 'video', 'https://youtu.be/abcdefghijk'],
    ['youtube', 'short', 'https://www.youtube.com/shorts/shortshort1'],
    ['facebook', 'reel', null],
  ]);
  assert.ok(added.every((e) => e.path === path && e.title));
});

test('a YouTube draft enters the history only once the upload is finished', async () => {
  const { KappDossier, added } = libraryWithHistory();
  const disk = new MemoryDirectory('VIDEOS');
  project(disk.dir('CHAINE'), 'Episode', 'episode.mp4', 1_000_000);
  KappDossier._setTestRoot(disk);
  const path = 'CHAINE/Episode/episode.mp4';
  await KappDossier.mark(path, 'published', { youtubeId: 'abcdefghijk', draft: true });
  assert.equal(added.length, 0);
  await KappDossier.mark(path, 'published', { youtubeId: 'abcdefghijk' });
  assert.deepEqual(added.map((e) => [e.net, e.kind, e.url]), [['youtube', 'video', 'https://youtu.be/abcdefghijk']]);
});

test('organisation « marques » : une vidéo de contenus/<id>/06-rendu appartient à sa marque (marque.json), avec sa chaîne YouTube', async () => {
  const { KappDossier } = library();
  const disk = new MemoryDirectory('ESPACE');
  const niche = disk.dir('religion');
  const marque = niche.dir('lumiere-divine');
  marque.file('marque.json', JSON.stringify({ type: 'marque', nom: 'Lumière Divine', youtube: 'https://www.youtube.com/channel/UCgUSOtJy27hKmxOETSZnv3Q' }));
  const rendu = marque.dir('contenus').dir('2026-10-05_003_peur').dir('06-rendu');
  rendu.file('ld-03.mp4', '', { size: 6_000_000, lastModified: 1 });
  rendu.file('publication.md', '## Titre\nQuand tu as peur de demain\n');
  KappDossier._setTestRoot(disk);
  const queue = await KappDossier.scan({ now: 10_000_000 });
  const video = queue.videos.find((item) => item.relative_path.endsWith('/ld-03.mp4'));
  assert.ok(video, 'la vidéo est trouvée');
  assert.equal(video.channel_key, 'religion/lumiere-divine');
  assert.equal(video.channel_name, 'lumiere-divine');
  assert.equal(video.title, 'Quand tu as peur de demain');
  assert.equal(queue.channels.find((c) => c.key === 'religion/lumiere-divine').config.channelId, 'UCgUSOtJy27hKmxOETSZnv3Q');
});

test('organisation « marques » : les posts de comptes/facebook-<compte>/a-publier sont trouvés et rattachés à la marque', async () => {
  const { KappDossier } = library();
  const disk = new MemoryDirectory('ESPACE');
  const marque = disk.dir('sport').dir('ballon-viral');
  marque.file('marque.json', JSON.stringify({ type: 'marque', nom: 'Ballon Viral' }));
  const compte = marque.dir('comptes').dir('facebook-ballon-viral');
  compte.file('compte.json', JSON.stringify({ type: 'compte', reseau: 'facebook' }));
  const post = compte.dir('a-publier').dir('2026-10-05-1200-test');
  post.file('texte.txt', 'Un post');
  post.file('publication.json', JSON.stringify({ date_locale: '2026-10-05', heure_prevue: '12:00', statut: 'a_publier' }));
  KappDossier._setTestRoot(disk);
  const items = await KappDossier.facebookPosts({ now: Date.now(), net: 'facebook' });
  const item = items.find((p) => p.path.endsWith('2026-10-05-1200-test'));
  assert.ok(item, 'le post est trouvé');
  assert.equal(item.path, 'sport/ballon-viral/comptes/facebook-ballon-viral/a-publier/2026-10-05-1200-test');
  assert.equal(item.channel_name, 'ballon-viral');
});

test('an unfinished YouTube draft is never « déjà publiée » and can be sent again without re-posting Facebook', async () => {
  const { KappDossier } = library();
  const disk = new MemoryDirectory('VIDEOS');
  const channel = disk.dir('CHAINE');
  const dir = project(channel, 'Match', 'match.mp4', 1_000_000);
  KappDossier._setTestRoot(disk);
  const path = 'CHAINE/Match/match.mp4';

  // Studio showed the link, then the « Visibilité » step failed: a draft.
  await KappDossier.mark(path, 'published', { youtubeId: 'abcdefghijk', draft: true });
  await KappDossier.mark(path, 'published', { facebookPublishedAt: '2026-10-06T09:16:50.610Z' });
  const failed = await KappDossier.mark(path, 'published', { youtubeError: 'YouTube Studio : étape « Visibilité » introuvable.' });
  assert.equal(failed.draft, true);
  assert.match(failed.youtubeError, /Visibilité/);
  assert.equal(dir.children.has('DEJA-PUBLIEE.txt'), false);       // no « already published » marker for a draft

  let queue = await KappDossier.scan({ now: 10_000_000 });
  const sent = queue.sent.find((v) => v.relative_path === path);
  assert.equal(sent.youtube_draft, true);
  assert.match(sent.youtube_error, /Visibilité/);
  assert.equal(queue.videos.some((v) => v.relative_path === path), false);   // never re-sent on its own (no duplicate)

  // « Renvoyer sur YouTube »: back in the queue, Facebook kept, broken draft remembered.
  const reset = await KappDossier.mark(path, 'resetYoutube');
  assert.equal(reset.facebookPublishedAt, '2026-10-06T09:16:50.610Z');
  assert.equal(reset.youtubeId, undefined);
  assert.equal(reset.status, undefined);
  assert.deepEqual([...reset.brokenDraftIds], ['abcdefghijk']);
  queue = await KappDossier.scan({ now: 10_000_000 });
  assert.equal(queue.videos.some((v) => v.relative_path === path), true);

  // Finished for real: no longer a draft, the error is gone, the marker is written.
  const done = await KappDossier.mark(path, 'published', { youtubeId: 'zyxwvutsrqp' });
  assert.equal(done.draft, undefined);
  assert.equal(done.youtubeError, undefined);
  assert.equal(done.facebookPublishedAt, '2026-10-06T09:16:50.610Z');
  assert.equal(dir.children.has('DEJA-PUBLIEE.txt'), true);
});

test('KappGen work folder: sheet and thumbnail found, and the published copy wins over the duplicate', async () => {
  const { KappDossier } = library();
  const disk = new MemoryDirectory('YOUTUBE');
  const fiche = '## Titre\n```\nPourquoi tu ne te remets pas d\'un deuil\n```\n\n## Description\n```\nUne description.\n```\n';
  // dossier de travail de KappGen : 06-rendu/video.mp4, 02-texte/fiche.md, 07-miniature/miniature.png
  const travail = disk.dir('BOUDDHISME').dir('paz-nirvana').dir('contenus').dir('2026-10-15_004');
  travail.dir('06-rendu').file('video.mp4', '', { size: 521192373, lastModified: 1 });
  travail.dir('02-texte').file('fiche.md', fiche);
  travail.dir('07-miniature').file('miniature.png', 'png', { size: 1000 });
  KappDossier._setTestRoot(disk);
  let queue = await KappDossier.scan({ now: 10_000_000 });
  assert.equal(queue.videos.length, 1);
  assert.equal(queue.videos[0].title, 'Pourquoi tu ne te remets pas d’un deuil'.replace('’', "'"));
  assert.match(queue.videos[0].thumbnail_path, /07-miniature\/miniature\.png$/);
  // la copie rangée par KappGen dans « KappGen - à publier » : une seule carte, celle du dossier de publication à égalité de fiche
  const rangee = disk.dir('KappGen - à publier').dir('Paz Nirvana').dir('2026-10-15_004');
  rangee.file('video.mp4', '', { size: 521192373, lastModified: 1 });
  rangee.file('publication.md', fiche);
  rangee.file('miniature.png', 'png', { size: 1000 });
  queue = await KappDossier.scan({ now: 10_000_000 });
  assert.equal(queue.videos.length, 1);
  assert.match(queue.videos[0].relative_path, /^KappGen - à publier\//);
});

test('KappGen : une vidéo montée AVANT le choix du dossier part seule dès que sa miniature et sa fiche sont là (Roosevelt, 19/10)', async () => {
  const { KappDossier } = library();
  const disk = new MemoryDirectory('YOUTUBE');
  const fiche = '## Titre\n```\nPourquoi tu t\'épuises\n```\n';
  const c = disk.dir('BOUDDHISME').dir('paz-nirvana').dir('contenus').dir('2026-10-15_002');
  c.dir('06-rendu').file('video.mp4', '', { size: 553771273, lastModified: 1_000_000 });          // montée le 16/10
  c.dir('02-texte').file('fiche.md', fiche, { lastModified: 1_000_000 });
  const mini = c.dir('07-miniature');
  KappDossier._setTestRoot(disk);
  // dossier choisi le 18/10 (watchSince 5 000 000), miniature pas encore faite : elle attend sa miniature, jamais envoyée sans
  let v = (await KappDossier.scan({ watchSince: 5_000_000, now: 10_000_000 })).videos[0];
  assert.equal(v.auto_ok, false);
  assert.match(v.auto_blocked, /en attente de sa miniature/);
  // miniature arrivée APRÈS le choix du dossier : la vidéo est complète maintenant, elle part toute seule
  mini.file('miniature.jpg', 'jpg', { size: 1000, lastModified: 8_000_000 });
  v = (await KappDossier.scan({ watchSince: 5_000_000, now: 10_000_000 })).videos[0];
  assert.equal(v.auto_ok, true, v.auto_blocked);
  // tout était complet avant le choix : elle attend un clic, comme avant
  mini.file('miniature.jpg', 'jpg', { size: 1000, lastModified: 2_000_000 });
  v = (await KappDossier.scan({ watchSince: 5_000_000, now: 10_000_000 })).videos[0];
  assert.match(v.auto_blocked, /déjà dans le dossier/);
  // miniature toute fraîche (moins de 10 min) : on attend qu'elle soit stable
  mini.file('miniature.jpg', 'jpg', { size: 1000, lastModified: 9_900_000 });
  v = (await KappDossier.scan({ watchSince: 5_000_000, now: 10_000_000 })).videos[0];
  assert.match(v.auto_blocked, /moins de 10 min/);
});

test('Studio reçoit le fichier sous le nom de son dossier (Roosevelt, 19/10)', () => {
  const src = readFileSync(join(root, 'extension/studio.js'), 'utf8');
  const nomPourStudio = new Function(`${src.slice(src.indexOf('function nomPourStudio'), src.indexOf('if (typeof module'))}; return nomPourStudio;`)();
  assert.equal(nomPourStudio('BOUDDHISME/paz-nirvana/contenus/2026-10-15_003_x/06-rendu/video.mp4', 'video.mp4'), '2026-10-15_003_x.mp4');
  assert.equal(nomPourStudio('contenus/2026-10-15_003_x/06-rendu/short.mp4', 'short.mp4'), '2026-10-15_003_x-short.mp4');
  assert.equal(nomPourStudio('VIDEO/04-puits-canadien/final.mp4', 'final.mp4'), '04-puits-canadien.mp4');
  assert.equal(nomPourStudio('Mes vidéos/cuisine.mp4', 'cuisine.mp4'), null);            // un fichier déjà bien nommé garde son nom
});

test('le dossier des marques est trouvé dans un dossier choisi plus haut, grâce au marqueur de KappGen', async () => {
  const context = vm.createContext({ console, DOMException, AbortController, setTimeout, clearTimeout, fetch: async () => { throw new Error('hors ligne'); } });
  vm.runInContext(`${readFileSync(join(root, 'extension/lib/kappgen-local.js'), 'utf8')}\nthis.KappLocal = KappLocal;`, context);
  const documents = new MemoryDirectory('Documents');
  documents.dir('Factures');
  const youtube = documents.dir('Motion').dir('YOUTUBE');
  youtube.file('.kappgen-marques.json', '{}');
  youtube.dir('BOUDDHISME').dir('paz-nirvana').file('marque.json', '{}');
  assert.equal((await context.KappLocal.racineDans(documents)).name, 'YOUTUBE');
  assert.equal((await context.KappLocal.racineDans(youtube)).name, 'YOUTUBE');
  assert.equal(await context.KappLocal.racineDans(documents.children.get('Factures')), null);
  assert.equal(await context.KappLocal.dossier(), null);                                     // KappGen absent : aucune erreur
});

test('chaque vidéo programmée reçoit son heure à l’avance : les créneaux libres suivants, dans l’ordre d’envoi (Roosevelt, 19/10)', () => {
  const S = scheduleLibrary();
  const now = new Date(2026, 9, 19, 3, 0).getTime();                       // lundi 19/10 à 3 h
  const at = (d, h, m = 0) => new Date(2026, 9, d, h, m).getTime();
  const videos = [{ id: 'a', channel_key: 'paz' }, { id: 'b', channel_key: 'paz' }, { id: 'c', channel_key: 'paz' },
    { id: 'd', channel_key: 'libre' }, { id: 'e', channel_key: 'paz', schedule_at: at(25, 12) }];
  const plan = S.plan(videos, (v) => (v.channel_key === 'paz' ? '06:00, 18:00' : null), { paz: [at(19, 6)] }, now);
  assert.equal(plan.get('a'), at(19, 18));            // 06:00 déjà pris par une vidéo programmée
  assert.equal(plan.get('b'), at(20, 6));
  assert.equal(plan.get('c'), at(20, 18));
  assert.equal(plan.has('d'), false);                 // chaîne « dès que prête » : pas d’heure
  assert.equal(plan.get('e'), at(25, 12));            // heure choisie à la main : gardée
  assert.equal(S.freeSlots('06:00', [], 1, at(19, 5, 30))[0], at(20, 6));      // jamais moins d’une heure après maintenant
});

test('Facebook a ses propres heures dans les réglages de la marque, indépendantes de YouTube (Roosevelt, 19/10)', async () => {
  const { KappDossier } = library();
  const disk = new MemoryDirectory('MARQUES');
  const marque = disk.dir('paz');
  marque.file('reglages-publication.json', JSON.stringify({ youtube: { visibilite: 'programmee', heures: ['06:00', '18:00'] }, facebook: { heures: ['12:00', '20h30'] } }));
  project(marque, 'Video', 'video.mp4', 1_000_000);
  KappDossier._setTestRoot(disk);
  const v = (await KappDossier.scan({ now: 10_000_000 })).videos[0];
  assert.equal(v.channel_config.facebookTimes, '12:00, 20:30');
  assert.equal(v.channel_config.times, '06:00, 18:00');
  marque.file('reglages-publication.json', JSON.stringify({ facebook: { heures: ['12:07'] } }));
  await assert.rejects(KappDossier.scan({ now: 10_000_000 }), /facebook\.heures/);
});
