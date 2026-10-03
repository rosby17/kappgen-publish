import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extension = join(root, 'extension');
const read = (path) => readFileSync(path, 'utf8');

function filesBelow(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesBelow(path) : [path];
  });
}

const manifest = JSON.parse(read(join(extension, 'manifest.json')));
const packageJson = JSON.parse(read(join(root, 'package.json')));
assert.equal(manifest.manifest_version, 3, 'manifest_version must be 3');
assert.match(manifest.version, /^\d+\.\d+\.\d+$/, 'manifest version must be semantic');
assert.equal(packageJson.version, manifest.version, 'package and manifest versions must match');
assert.ok(Number(manifest.minimum_chrome_version) >= 116, 'Chrome 116+ is required');
assert.ok(!manifest.permissions.includes('management'), 'management permission is intentionally forbidden');
assert.ok(manifest.permissions.includes('debugger'), 'direct local-app uploads require debugger');
assert.ok(!(manifest.optional_permissions || []).includes('debugger'), 'Chrome does not allow debugger as an optional permission');

const manifestPaths = [
  manifest.background?.service_worker,
  manifest.side_panel?.default_path,
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
  ...(manifest.web_accessible_resources || []).flatMap((entry) => entry.resources || []),
].filter(Boolean);
for (const path of manifestPaths) assert.ok(existsSync(join(extension, path)), `Missing manifest resource: ${path}`);

const background = read(join(extension, manifest.background.service_worker));
for (const [, path] of background.matchAll(/importScripts\(\s*["']([^"']+)["']\s*\)/g)) {
  assert.ok(existsSync(join(extension, path)), `Missing imported service-worker script: ${path}`);
}
for (const entry of manifest.web_accessible_resources || []) {
  assert.equal(entry.use_dynamic_url, true, 'web-accessible resources must use dynamic URLs');
}
assert.match(background, /await isLocalApp\(\)/, 'local file paths must be restricted to the local KappGen server');
assert.doesNotMatch(background, /permissions\.request\([^)]*debugger/s, 'debugger cannot be requested as an optional permission');

for (const path of filesBelow(extension).filter((item) => item.endsWith('.js'))) {
  execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' });
}

for (const path of filesBelow(extension).filter((item) => item.endsWith('.html'))) {
  const html = read(path);
  const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, `Duplicate id in ${relative(root, path)}`);
  for (const [, value] of html.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)) {
    if (/^(?:https?:|data:|#|mailto:)/.test(value)) continue;
    const clean = value.split(/[?#]/)[0];
    assert.ok(existsSync(join(dirname(path), clean)), `Missing HTML resource ${value} in ${relative(root, path)}`);
  }
}

const source = filesBelow(extension).filter((item) => item.endsWith('.js')).map(read).join('\n');
assert.ok(!source.includes('bridge.html?path='), 'disk paths must never be exposed through bridge URLs');
assert.match(read(join(extension, 'offscreen.js')), /watchSince:\s*message\.watchSince/, 'offscreen scan must preserve watchSince');

console.log(`Validated KappGen Publish ${manifest.version}: JavaScript, manifest, HTML and resources are coherent.`);
