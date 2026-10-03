import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extension = join(root, 'extension');
const KappMaj = createRequire(import.meta.url)(join(extension, 'lib', 'maj.js'));
const own = JSON.parse(readFileSync(join(extension, 'manifest.json'), 'utf8'));

function filesBelow(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesBelow(path) : [path];
  });
}

// Same command as publier-version.sh.
function zipExtension(extra = []) {
  const out = join(mkdtempSync(join(tmpdir(), 'maj-')), 'kappgen-publish.zip');
  execFileSync('zip', ['-rqX', ...extra, out, '.', '-x', '.*', '-x', '*/.DS_Store'], { cwd: extension });
  const bytes = new Uint8Array(readFileSync(out));
  rmSync(dirname(out), { recursive: true, force: true });
  return bytes;
}

class MemoryDir {
  constructor(name) { this.kind = 'directory'; this.name = name; this.children = new Map(); this.order = []; }
  async getDirectoryHandle(name, { create = false } = {}) {
    if (!this.children.has(name)) {
      if (!create) throw Object.assign(new Error(name), { name: 'NotFoundError' });
      this.children.set(name, new MemoryDir(name));
    }
    return this.children.get(name);
  }
  async getFileHandle(name, { create = false } = {}) {
    if (!this.children.has(name)) {
      if (!create) throw Object.assign(new Error(name), { name: 'NotFoundError' });
      const dir = this;
      const file = { kind: 'file', name, data: new Uint8Array(),
        getFile: async () => ({ text: async () => new TextDecoder().decode(file.data) }),
        createWritable: async () => ({ write: async (data) => { file.data = data; }, close: async () => { dir.order.push(name); } }) };
      this.children.set(name, file);
    }
    return this.children.get(name);
  }
  async *values() { yield* this.children.values(); }
}

test('unzips the release archive exactly as built by publier-version.sh', async () => {
  for (const extra of [[], ['-0']]) {
    const files = await KappMaj.unzip(zipExtension(extra));
    const byPath = new Map(files.map((file) => [file.path.join('/'), file.data]));
    const expected = filesBelow(extension).map((path) => relative(extension, path)).filter((path) => !path.split('/').some((part) => part.startsWith('.')));
    assert.deepEqual([...byPath.keys()].sort(), expected.sort());
    for (const path of expected) assert.deepEqual(Buffer.from(byPath.get(path)), readFileSync(join(extension, path)), path);
  }
});

test('refuses paths leaving the extension folder', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'maj-'));
  writeFileSync(join(dir, 'evil.js'), 'x');
  execFileSync('zip', ['-qX', 'a.zip', 'evil.js'], { cwd: dir });
  const bytes = new Uint8Array(readFileSync(join(dir, 'a.zip')));
  rmSync(dir, { recursive: true, force: true });
  // Rename "evil.js" to "../il.js" in both headers (same length).
  const text = Buffer.from(bytes).toString('latin1').replaceAll('evil.js', '../il.j');
  await assert.rejects(KappMaj.unzip(new Uint8Array(Buffer.from(text, 'latin1'))), /Chemin refusé/);
});

test('writes every file, manifest.json last, creating sub-folders', async () => {
  const dir = new MemoryDir('KappGen-Publish');
  const files = await KappMaj.unzip(zipExtension());
  let calls = 0;
  await KappMaj.install(dir, files, () => { calls += 1; });
  assert.equal(calls, files.length);
  assert.equal(dir.order[dir.order.length - 1], 'manifest.json');
  const lib = await dir.getDirectoryHandle('lib');
  assert.ok(lib.children.has('maj.js'));
});

test('recognises the extension folder, also when picked one level too high', async () => {
  const manifest = new TextEncoder().encode(JSON.stringify(own));
  const inner = new MemoryDir('KappGen-Publish');
  await KappMaj.install(inner, [{ path: ['manifest.json'], data: manifest }]);
  assert.equal(await KappMaj.extensionDir(inner, own), inner);
  const home = new MemoryDir('home');
  home.children.set('Documents', new MemoryDir('Documents'));
  home.children.set('KappGen-Publish', inner);
  assert.equal(await KappMaj.extensionDir(home, own), inner);
  assert.equal(await KappMaj.extensionDir(new MemoryDir('Documents'), own), null);
  assert.equal(KappMaj.isOurs({ ...own, key: 'autre' }, own), false);
});
