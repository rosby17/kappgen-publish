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
