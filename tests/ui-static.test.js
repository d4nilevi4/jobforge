import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { api, ApiError, getToken, setToken } from '../ui/js/api.js';
import { statuses } from '../ui/js/lib.js';

const root = fileURLToPath(new URL('../ui/', import.meta.url));

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]));
  return nested.flat();
}

test('every UI JavaScript module passes node --check and has resolvable local imports', async () => {
  const modules = (await files(join(root, 'js'))).filter(file => file.endsWith('.js'));
  assert.ok(modules.length >= 10);
  for (const file of modules) {
    assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', file], { stdio: 'pipe', timeout: 2000 }), relative(root, file));
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
      assert.ok(match[1].startsWith('.'), `Only local browser imports are allowed in ${file}: ${match[1]}`);
      await assert.doesNotReject(access(resolve(dirname(file), match[1])));
    }
  }
});

test('index references existing local files and loads an ES module', async () => {
  const html = await readFile(join(root, 'index.html'), 'utf8');
  assert.match(html, /<script\b[^>]*type="module"/);
  assert.match(html, /<link\b[^>]*rel="icon"[^>]*href="data:image\/svg\+xml,[^"]+"/);
  for (const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
    if (match[1].startsWith('data:image/svg+xml,')) continue;
    assert.ok(!/^(?:https?:)?\/\//.test(match[1]), `External asset: ${match[1]}`);
    await assert.doesNotReject(access(join(root, match[1].replace(/^\//, ''))));
  }
  assert.match(html, /aria-live="polite"/);
});

test('UI never assigns data to innerHTML or other HTML injection sinks', async () => {
  for (const file of await files(root)) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /\binnerHTML\s*=/, relative(root, file));
    assert.doesNotMatch(source, /\b(?:outerHTML\s*=|insertAdjacentHTML\s*\()/, relative(root, file));
  }
});

test('CSS supplies matching light and dark custom properties and small-screen layout', async () => {
  const css = await readFile(join(root, 'styles.css'), 'utf8');
  const light = css.match(/:root\s*\{([^}]+)\}/)?.[1];
  const dark = css.match(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]+)\}/)?.[1];
  assert.ok(light, 'Light custom properties are required.');
  assert.ok(dark, 'Dark custom properties are required.');
  const names = text => [...text.matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1]).sort();
  assert.ok(names(light).length >= 10);
  assert.deepEqual(names(light), names(dark));
  assert.match(css, /@media\s*\(max-width:\s*640px\)/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)/);
  assert.match(css, /@media\s*\(prefers-color-scheme:\s*dark\)/);
  assert.match(css, /:focus-visible/);
  assert.doesNotMatch(css.replace(/:root\s*\{[^}]+\}/g, ''), /#[\da-f]{3,8}\b/i, 'Colors outside root variables are not allowed.');
});

test('section navigation uses scroll handlers instead of building fragment anchors', async () => {
  for (const file of (await files(join(root, 'js'))).filter(file => file.endsWith('.js'))) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /\bhref\s*(?::|=)\s*['"`]#(?!\/)/, relative(root, file));
    assert.doesNotMatch(source, /['"]href=['"]?#['"]\s*\+/, relative(root, file));
  }
  const profile = await readFile(join(root, 'js/views/profile.js'), 'utf8');
  assert.match(profile, /scrollIntoView\(/);
  assert.match(profile, /event\.preventDefault\(\)/);
});

test('every status badge has a distinct palette with at least 4.5 to 1 text contrast in both themes', async t => {
  const css = await readFile(join(root, 'styles.css'), 'utf8');
  const themes = [...css.matchAll(/:root\s*\{([^}]+)\}/g)];
  assert.equal(themes.length, 2);
  function luminance(hex) {
    const channels = hex.match(/[\da-f]{2}/gi).map(value => parseInt(value, 16) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  }
  let minimum = Infinity;
  for (const [index, theme] of themes.entries()) {
    const colors = Object.fromEntries([...theme[1].matchAll(/(--[\w-]+):\s*(#[\da-f]{6})/gi)].map(match => [match[1], match[2]]));
    const backgrounds = new Set();
    const foregrounds = new Set();
    for (const status of statuses) {
      const background = colors[`--status-${status}-bg`];
      const foreground = colors[`--status-${status}-text`];
      assert.ok(background && foreground, `${status} needs both colors in theme ${index}.`);
      backgrounds.add(background);
      foregrounds.add(foreground);
      const values = [luminance(background), luminance(foreground)].sort((a, b) => a - b);
      const contrast = (values[1] + 0.05) / (values[0] + 0.05);
      minimum = Math.min(minimum, contrast);
      assert.ok(contrast >= 4.5, `${status} theme ${index} contrast is ${contrast.toFixed(2)}:1.`);
      assert.match(css, new RegExp(`\\.badge\\.${status}\\s*\\{[^}]*background: var\\(--status-${status}-bg\\);[^}]*color: var\\(--status-${status}-text\\)`));
    }
    assert.equal(backgrounds.size, statuses.length);
    assert.equal(foregrounds.size, statuses.length);
  }
  t.diagnostic(`Lowest status badge contrast: ${minimum.toFixed(2)}:1.`);
});

test('template HTML previews always use empty sandbox permissions', async () => {
  let previews = 0;
  for (const file of (await files(join(root, 'js'))).filter(file => file.endsWith('.js'))) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/h\('iframe',\s*\{([^\n]+)\}\)/g)) {
      if (!match[1].includes('srcdoc:')) continue;
      previews++;
      assert.match(match[1], /sandbox:\s*''/);
    }
  }
  assert.equal(previews, 2);
});

function browserGlobals(t) {
  const descriptors = Object.fromEntries(['localStorage', 'window', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const stored = new Map();
  const events = [];
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { dispatchEvent: event => events.push(event) } });
  t.after(() => {
    setToken('');
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return { stored, events };
}

test('API wrapper authenticates JSON, text, and blob requests and handles error envelopes', async t => {
  const { stored, events } = browserGlobals(t);
  setToken(' test-owner-token ');
  assert.equal(stored.get('jobforge.token'), 'test-owner-token');
  let request;
  globalThis.fetch = async (path, options) => { request = { path, options }; return new Response('{"saved":true}'); };
  assert.deepEqual(await api.put('/profile', { schema_version: 1 }), { saved: true });
  assert.equal(request.path, '/api/v1/profile');
  assert.equal(request.options.method, 'PUT');
  assert.equal(request.options.headers.Authorization, 'Bearer test-owner-token');
  assert.equal(request.options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(request.options.body), { schema_version: 1 });
  await api.get('/version', { public: true });
  assert.equal(request.options.headers.Authorization, undefined);
  await assert.rejects(api.get('//example.com'), error => error instanceof ApiError && error.code === 'bad_request');

  globalThis.fetch = async path => { request = { path }; return new Response('pdf bytes', { headers: { 'Content-Type': 'application/pdf' } }); };
  const blob = await api.getBlob('/api/v1/applications/1/files/resume.pdf');
  assert.equal(request.path, '/api/v1/applications/1/files/resume.pdf');
  assert.equal(blob.type, 'application/pdf');
  assert.equal(await blob.text(), 'pdf bytes');
  globalThis.fetch = async () => new Response('<html>Preview</html>');
  assert.equal(await api.post('/templates/classic/preview?format=html', {}, { format: 'text' }), '<html>Preview</html>');
  assert.equal(await api.getText('/guide'), '<html>Preview</html>');
  globalThis.fetch = async () => new Response(null, { status: 204 });
  assert.equal(await api.remove('/tracks/example'), null);

  const details = [{ path: 'identity.name', code: 'required', message: 'Add a name.' }];
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 'validation_failed', message: 'Profile is invalid.', details } }), { status: 422 });
  await assert.rejects(api.put('/profile', {}), error => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 422);
    assert.equal(error.code, 'validation_failed');
    assert.equal(error.message, 'Profile is invalid.');
    assert.deepEqual(error.details, details);
    return true;
  });
  globalThis.fetch = async () => new Response('invalid json');
  await assert.rejects(api.get('/profile'), { code: 'invalid_response' });
  globalThis.fetch = async () => { throw new TypeError('Network failed'); };
  await assert.rejects(api.get('/profile'), { code: 'network_error' });
  globalThis.fetch = async () => new Response('Unavailable', { status: 503 });
  await assert.rejects(api.get('/profile'), { status: 503, code: 'request_failed' });
  globalThis.fetch = async () => new Response('{"error":{"code":"unauthorized","message":"Token expired."}}', { status: 401 });
  await assert.rejects(api.get('/profile'), { status: 401, code: 'unauthorized' });
  assert.equal(getToken(), '');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'jobforge:unauthorized');
  assert.equal(stored.has('jobforge.token'), false);

  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { setItem() { throw new Error('Storage blocked'); }, removeItem() { throw new Error('Storage blocked'); }, getItem() { return 'stale-token'; } } });
  assert.doesNotThrow(() => setToken('session-only-token'));
  assert.equal(getToken(), 'session-only-token');
  assert.doesNotThrow(() => setToken(''));
  assert.equal(getToken(), '');
});

test('a delayed unauthorized response cannot clear a newer sign-in token', async t => {
  const { events } = browserGlobals(t);
  setToken('previous-test-token');
  let finish;
  globalThis.fetch = () => new Promise(resolve => { finish = resolve; });
  const pending = api.get('/profile');
  setToken('new-test-token');
  finish(new Response('{"error":{"code":"unauthorized","message":"Old token expired."}}', { status: 401 }));
  await assert.rejects(pending, { status: 401 });
  assert.equal(getToken(), 'new-test-token');
  assert.equal(events.length, 0);
});
