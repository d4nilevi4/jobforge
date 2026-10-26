import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable, Writable } from 'node:stream';
import { createToken } from '../server/auth.js';
import { APP_ROOT } from '../server/config.js';
import { migrate, openDb } from '../server/db.js';
import { createRouter } from '../server/http.js';
import { startServer } from '../server/index.js';
import { registerAll } from '../server/routes/index.js';
import { startTestServer } from './helpers.js';

async function fixture(t, options) {
  const instance = await startTestServer(options);
  t.after(() => instance.close());
  return instance;
}

function assertError(response, status, code) {
  assert.equal(response.status, status);
  assert.equal(response.body.error.code, code);
  assert.equal(typeof response.body.error.message, 'string');
  assert.ok(Array.isArray(response.body.error.details));
}

test('protected routes require a bearer token and name missing scopes', async (t) => {
  const server = await fixture(t);
  assertError(await server.api('GET', '/api/v1/tokens', undefined, { token: null }), 401, 'unauthorized');
  assertError(await server.api('GET', '/api/v1/tokens', undefined, { token: 'invalid' }), 401, 'unauthorized');
  const forbidden = await server.api('GET', '/api/v1/tokens', undefined, { token: server.makeToken('agent') });
  assertError(forbidden, 403, 'forbidden');
  assert.match(forbidden.body.error.message, /admin/);
});

test('unknown API paths return a 404 envelope and known paths reject other methods with 405', async (t) => {
  const server = await fixture(t);
  assertError(await server.api('GET', '/api/v1/missing'), 404, 'not_found');
  assertError(await server.api('GET', '/api/v1/version/extra'), 404, 'not_found');
  assertError(await server.api('GET', '/api/v1/version/'), 404, 'not_found');
  const response = await server.api('PUT', '/api/v1/version', {});
  assertError(response, 405, 'method_not_allowed');
  assert.equal(response.headers.get('allow'), 'GET');
});

test('invalid JSON and bodies over 2 MB receive useful API errors', async (t) => {
  const server = await fixture(t);
  const invalid = await server.api('POST', '/api/v1/tokens', '{broken', { raw: true });
  assertError({ ...invalid, body: JSON.parse(invalid.body) }, 400, 'bad_request');
  assert.match(JSON.parse(invalid.body).error.message, /JSON/);
  const oversized = await server.api('POST', '/api/v1/tokens', JSON.stringify({ name: 'x'.repeat(2 * 1024 * 1024), preset: 'agent' }), { raw: true });
  assertError({ ...oversized, body: JSON.parse(oversized.body) }, 413, 'payload_too_large');
  assert.equal(oversized.headers.get('connection'), 'close');
  assert.equal((await server.api('GET', '/api/v1/version')).status, 200);
});

test('chunked bodies cannot bypass the size limit', async (t) => {
  const server = await fixture(t);
  const response = await new Promise((resolve, reject) => {
    const req = request(`${server.url}/api/v1/tokens`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${server.token}`, 'Transfer-Encoding': 'chunked' },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    for (let index = 0; index < 33; index += 1) req.write(Buffer.alloc(64 * 1024, 32));
    req.end();
  });
  assertError(response, 413, 'payload_too_large');
});

test('version is public and includes schema, Chrome status, and API security headers', async (t) => {
  const server = await fixture(t, { withToken: null });
  const response = await server.api('GET', '/api/v1/version');
  assert.equal(response.status, 200);
  assert.equal(response.body.name, 'jobforge');
  assert.equal(response.body.api, 'v1');
  assert.equal(response.body.schema_version, 1);
  assert.equal(typeof response.body.version, 'string');
  assert.equal(typeof response.body.chrome.found, 'boolean');
  assert.equal(typeof response.body.chrome.path, 'string');
  assert.equal(typeof response.body.chrome.version, 'string');
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('root serves HTML and missing static paths and traversal attempts are refused', async (t) => {
  const server = await fixture(t);
  const response = await server.api('GET', '/', undefined, { raw: true, token: null });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.equal(response.headers.get('cache-control'), 'no-cache');
  if (!existsSync(join(APP_ROOT, 'ui', 'index.html'))) assert.match(response.body, /UI is not built yet/);
  for (const path of ['/missing-file.png', '/..%2f..%2fpackage.json', '/..%2fpackage.json', '/%00', '/%invalid']) {
    const missing = await server.api('GET', path, undefined, { raw: true });
    assert.equal(missing.status, 404, path);
    assert.match(missing.headers.get('content-type'), /text\/plain/);
    assert.equal(missing.body, 'Not found.');
  }
});

test('tokens can be created, listed without secrets, and revoked', async (t) => {
  const server = await fixture(t);
  const created = await server.api('POST', '/api/v1/tokens', { name: 'example agent', preset: 'agent' });
  assert.equal(created.status, 201);
  assert.match(created.body.secret, /^jf_/);
  assert.equal(created.body.name, 'example agent');
  const listed = await server.api('GET', '/api/v1/tokens');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.length, 2);
  assert.equal(JSON.stringify(listed.body).includes(created.body.secret), false);
  assert.ok(listed.body.every((entry) => !('hash' in entry) && !('secret' in entry)));
  const revoked = await server.api('DELETE', `/api/v1/tokens/${created.body.id}`);
  assert.equal(revoked.status, 200);
  assert.deepEqual(revoked.body, { ok: true });
  assertError(await server.api('GET', '/api/v1/tokens', undefined, { token: created.body.secret }), 401, 'unauthorized');
  const after = await server.api('GET', '/api/v1/tokens');
  assert.match(after.body.find((entry) => entry.id === created.body.id).revoked_at, /Z$/);
});

test('the last active admin cannot revoke itself, but another admin allows self-revocation', async (t) => {
  const server = await fixture(t);
  const listed = await server.api('GET', '/api/v1/tokens');
  const ownerId = listed.body[0].id;
  assertError(await server.api('DELETE', `/api/v1/tokens/${ownerId}`), 409, 'conflict');
  const other = await server.api('POST', '/api/v1/tokens', { name: 'second admin', scopes: ['admin'] });
  assert.equal(other.status, 201);
  assert.equal((await server.api('DELETE', `/api/v1/tokens/${ownerId}`)).status, 200);
  assertError(await server.api('GET', '/api/v1/tokens'), 401, 'unauthorized');
  assert.equal((await server.api('GET', '/api/v1/tokens', undefined, { token: other.body.secret })).status, 200);
  assertError(await server.api('DELETE', `/api/v1/tokens/${other.body.id}`, undefined, { token: other.body.secret }), 409, 'conflict');
});

test('invalid token bodies and ids are rejected without creating tokens', async (t) => {
  const server = await fixture(t);
  for (const body of [null, [], 'example', {}, { name: 'example', preset: 'unknown' }, { name: 'example', scopes: ['unknown'] }]) {
    assertError(await server.api('POST', '/api/v1/tokens', body), 400, 'bad_request');
  }
  const empty = await server.api('POST', '/api/v1/tokens');
  assertError(empty, 400, 'bad_request');
  for (const id of ['abc', '0', '-1', '1.5', '9007199254740992']) {
    assertError(await server.api('DELETE', `/api/v1/tokens/${id}`), 400, 'bad_request');
  }
  assertError(await server.api('DELETE', '/api/v1/tokens/999'), 404, 'not_found');
  assert.equal((await server.api('GET', '/api/v1/tokens')).body.length, 1);
});

async function customRouter(t) {
  const instance = await fixture(t);
  const router = createRouter();
  const messages = [];
  const server = createServer((req, res) => router.handle(req, res, {
    db: instance.db, config: {}, log: { error: (message) => messages.push(message) },
  }));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeIdleConnections();
  }));
  return { router, url: `http://127.0.0.1:${server.address().port}`, token: instance.token, messages };
}

test('router decodes exact segments and query values and supports all result shapes', async (t) => {
  const { router, url } = await customRouter(t);
  router.add('GET', '/api/v1/items/:id/files/:name', ({ params, query }) => ({ params, query }), { scope: null });
  router.add('POST', '/api/v1/echo', ({ body }) => ({ status: 201, body }), { scope: null });
  router.add('GET', '/api/v1/raw', () => ({ status: 202, headers: { 'Content-Type': 'text/plain', 'X-Example': 'yes' }, raw: Buffer.from('example') }), { scope: null });
  router.add('GET', '/api/v1/manual', ({ res }) => { res.end('manual'); }, { scope: null });
  const response = await fetch(`${url}/api/v1/items/hello%20world/files/cover%2Epdf?q=Alex+Example&__proto__=safe`);
  assert.deepEqual(await response.json(), { params: { id: 'hello world', name: 'cover.pdf' }, query: { q: 'Alex Example', ['__proto__']: 'safe' } });
  const echo = await fetch(`${url}/api/v1/echo`, { method: 'POST' });
  assert.equal(echo.status, 201);
  assert.deepEqual(await echo.json(), {});
  const raw = await fetch(`${url}/api/v1/raw`);
  assert.equal(raw.status, 202);
  assert.equal(raw.headers.get('content-type'), 'text/plain');
  assert.equal(raw.headers.get('x-example'), 'yes');
  assert.equal(await raw.text(), 'example');
  assert.equal(await (await fetch(`${url}/api/v1/manual`)).text(), 'manual');
  const badEncoding = await fetch(`${url}/api/v1/items/%GG/files/name`);
  assertError({ status: badEncoding.status, body: await badEncoding.json() }, 400, 'bad_request');
});

test('unexpected handler errors are logged and never leaked to clients', async (t) => {
  const { router, url, messages } = await customRouter(t);
  router.add('GET', '/api/v1/fail', () => { throw new Error('private diagnostic detail'); }, { scope: null });
  const response = await fetch(`${url}/api/v1/fail`);
  const body = await response.json();
  assertError({ status: response.status, body }, 500, 'internal');
  assert.equal(JSON.stringify(body).includes('private diagnostic'), false);
  assert.match(messages[0], /Error: private diagnostic detail/);
});

test('server reuses existing tokens after restart and close is idempotent', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'jobforge-server-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const messages = [];
  const options = { env: { DATA_DIR: dataDir, PORT: '0', HOST: '127.0.0.1' }, log: (message) => messages.push(message) };
  const first = await startServer(options);
  await first.close();
  await first.close();
  const second = await startServer(options);
  try {
    assert.equal(second.db.prepare('SELECT count(*) AS count FROM tokens').get().count, 1);
    assert.equal(messages.length, 1);
    assert.equal((await fetch(`${second.url}/api/v1/version`)).status, 200);
  } finally {
    await second.close();
  }
});

test('CLI creates tokens and backups and doctor reports diagnostics', (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'jobforge-cli-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const cli = (...args) => spawnSync(process.execPath, [join(APP_ROOT, 'server', 'cli.js'), ...args], {
    env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8', timeout: 3000,
  });
  const token = cli('token', '--name', 'example agent', '--preset', 'agent');
  assert.equal(token.status, 0, token.stderr);
  assert.equal(token.stdout.match(/jf_[A-Za-z0-9_-]{43}/g).length, 1);
  const custom = cli('token', '--name', 'example admin', '--scopes', 'read,admin');
  assert.equal(custom.status, 0, custom.stderr);
  const backup = cli('backup');
  assert.equal(backup.status, 0, backup.stderr);
  const files = readdirSync(join(dataDir, 'backups'));
  assert.equal(files.length, 1);
  assert.match(files[0], /^jobforge-manual-.*Z\.db$/);
  const db = new DatabaseSync(join(dataDir, 'backups', files[0]), { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT count(*) AS count FROM tokens').get().count, 2);
  } finally {
    db.close();
  }
  const doctor = cli('doctor');
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.match(doctor.stdout, /Node: .*satisfies >=22\.13/);
  assert.ok(doctor.stdout.includes(`Data directory: ${dataDir} (writable: true)`));
  assert.match(doctor.stdout, /Schema version: 1/);
  assert.match(doctor.stdout, /Chrome:/);
  for (const command of ['export', 'import', 'seed-demo']) {
    const result = cli(command);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not implemented yet/);
  }
  assert.equal(cli('unknown').status, 1);
  assert.match(cli().stderr, /Usage:/);
  assert.equal(cli('token', '--name', 'example', '--preset', 'agent', '--scopes', 'read').status, 1);
});

class MemoryResponse extends Writable {
  constructor() {
    super();
    this.statusCode = 200;
    this.headersSent = false;
    this.headers = new Map();
    this.chunks = [];
  }

  setHeader(name, value) {
    this.headers.set(name.toLowerCase(), value);
  }

  getHeader(name) {
    return this.headers.get(name.toLowerCase());
  }

  writeHead(status, headers = {}) {
    this.statusCode = status;
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    this.headersSent = true;
    return this;
  }

  _write(chunk, encoding, done) {
    this.chunks.push(Buffer.from(chunk));
    done();
  }
}

function memoryRouter(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'jobforge-router-'));
  const db = openDb(dataDir);
  migrate(db);
  t.after(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const router = createRouter();
  registerAll(router);
  const token = createToken(db, { name: 'owner', preset: 'owner' });
  const errors = [];
  const ctx = { db, config: { version: '0.1.0', chromeBin: '' }, log: { error: (error) => errors.push(error) } };
  return {
    db, router, token, errors,
    async api(method, path, body, { secret = token.secret, raw = false, chunked = false } = {}) {
      const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(raw ? body : JSON.stringify(body));
      const chunks = [];
      for (let offset = 0; offset < bytes.length; offset += 64 * 1024) chunks.push(bytes.subarray(offset, offset + 64 * 1024));
      const req = Readable.from(chunks);
      req.url = path;
      req.method = method;
      req.headers = {};
      if (secret) req.headers.authorization = `Bearer ${secret}`;
      if (!chunked) req.headers['content-length'] = String(bytes.length);
      const res = new MemoryResponse();
      const finished = new Promise((resolve, reject) => {
        res.on('finish', resolve);
        res.on('error', reject);
      });
      await router.handle(req, res, ctx);
      await finished;
      const text = Buffer.concat(res.chunks).toString('utf8');
      return {
        status: res.statusCode,
        headers: res.headers,
        body: res.getHeader('Content-Type')?.includes('application/json') ? JSON.parse(text) : text,
        request: req,
      };
    },
  };
}

test('in-memory router enforces authentication, scopes, exact paths, and methods', async (t) => {
  const server = memoryRouter(t);
  assertError(await server.api('GET', '/api/v1/tokens', undefined, { secret: null }), 401, 'unauthorized');
  const agent = createToken(server.db, { name: 'example agent', preset: 'agent' });
  const forbidden = await server.api('GET', '/api/v1/tokens', undefined, { secret: agent.secret });
  assertError(forbidden, 403, 'forbidden');
  assert.match(forbidden.body.error.message, /admin/);
  assertError(await server.api('GET', '/api/v1/missing'), 404, 'not_found');
  assertError(await server.api('GET', '/api/v1/version/'), 404, 'not_found');
  assertError(await server.api('DELETE', '/api/v1/tokens/'), 404, 'not_found');
  const method = await server.api('PUT', '/api/v1/version', {});
  assertError(method, 405, 'method_not_allowed');
  assert.equal(method.headers.get('allow'), 'GET');
  assert.equal(method.headers.get('cache-control'), 'no-store');
});

test('in-memory router handles malformed JSON, empty bodies, and both body limit paths', async (t) => {
  const server = memoryRouter(t);
  assertError(await server.api('POST', '/api/v1/tokens', '{broken', { raw: true }), 400, 'bad_request');
  assertError(await server.api('POST', '/api/v1/tokens'), 400, 'bad_request');
  server.router.add('PATCH', '/api/v1/echo', ({ body }) => ({ status: 202, body }), { scope: null });
  assert.deepEqual((await server.api('PATCH', '/api/v1/echo')).body, {});
  for (const chunked of [false, true]) {
    const response = await server.api('POST', '/api/v1/tokens', 'x'.repeat(2 * 1024 * 1024 + 1), { raw: true, chunked });
    assertError(response, 413, 'payload_too_large');
    assert.equal(response.headers.get('connection'), 'close');
    assert.equal(response.request.destroyed, true);
  }
  const exactLimit = `"${'x'.repeat(2 * 1024 * 1024 - 2)}"`;
  const accepted = await server.api('PATCH', '/api/v1/echo', exactLimit, { raw: true, chunked: true });
  assert.equal(accepted.status, 202);
  assert.equal(accepted.body.length, 2 * 1024 * 1024 - 2);
});

test('in-memory version and static handlers provide public responses and refuse traversal', async (t) => {
  const server = memoryRouter(t);
  const version = await server.api('GET', '/api/v1/version', undefined, { secret: null });
  assert.equal(version.status, 200);
  assert.equal(version.body.schema_version, 1);
  assert.equal(version.body.name, 'jobforge');
  assert.equal(typeof version.body.chrome.found, 'boolean');
  assert.equal(version.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(version.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(version.headers.has('access-control-allow-origin'), false);
  const home = await server.api('GET', '/');
  assert.equal(home.status, 200);
  assert.equal(home.headers.get('cache-control'), 'no-cache');
  if (!existsSync(join(APP_ROOT, 'ui', 'index.html'))) assert.match(home.body, /UI is not built yet/);
  for (const path of ['/missing-file.png', '/..%2f..%2fpackage.json', '/..%2fpackage.json', '/%00', '/%invalid']) {
    const response = await server.api('GET', path);
    assert.equal(response.status, 404, path);
    assert.equal(response.body, 'Not found.');
  }
});

test('in-memory token routes create, list, revoke, and protect the last active admin', async (t) => {
  const server = memoryRouter(t);
  assertError(await server.api('DELETE', `/api/v1/tokens/${server.token.id}`), 409, 'conflict');
  for (const body of [null, [], 'example', {}, { name: 'example', scopes: ['unknown'] }]) {
    assertError(await server.api('POST', '/api/v1/tokens', body), 400, 'bad_request');
  }
  const agent = await server.api('POST', '/api/v1/tokens', { name: 'example agent', preset: 'agent' });
  assert.equal(agent.status, 201);
  const listed = await server.api('GET', '/api/v1/tokens');
  assert.equal(listed.body.length, 2);
  assert.ok(listed.body.every((entry) => !('hash' in entry) && !('secret' in entry)));
  assert.equal((await server.api('DELETE', `/api/v1/tokens/${agent.body.id}`)).body.ok, true);
  assertError(await server.api('GET', '/api/v1/tokens', undefined, { secret: agent.body.secret }), 401, 'unauthorized');
  const other = await server.api('POST', '/api/v1/tokens', { name: 'another admin', scopes: ['admin'] });
  assert.equal((await server.api('DELETE', `/api/v1/tokens/${server.token.id}`)).status, 200);
  assertError(await server.api('GET', '/api/v1/tokens'), 401, 'unauthorized');
  assertError(await server.api('DELETE', `/api/v1/tokens/${other.body.id}`, undefined, { secret: other.body.secret }), 409, 'conflict');
});

test('in-memory router supports decoded params, query, arrays, raw responses, and direct writes', async (t) => {
  const server = memoryRouter(t);
  server.router.add('GET', '/api/v1/items/:id/files/:name', ({ params, query }) => ({ params, query }), { scope: null });
  server.router.add('GET', '/api/v1/array', () => ['example'], { scope: null });
  server.router.add('GET', '/api/v1/raw', () => ({ status: 202, headers: { 'Content-Type': 'text/plain' }, raw: Buffer.from('example') }), { scope: null });
  server.router.add('GET', '/api/v1/direct', ({ res }) => {
    res.setHeader('Content-Type', 'text/plain');
    res.end('direct');
  }, { scope: null });
  const response = await server.api('GET', '/api/v1/items/hello%20world/files/cover%2Epdf?q=Alex+Example&__proto__=safe');
  assert.deepEqual(response.body, { params: { id: 'hello world', name: 'cover.pdf' }, query: { q: 'Alex Example', ['__proto__']: 'safe' } });
  assert.deepEqual((await server.api('GET', '/api/v1/array')).body, ['example']);
  const raw = await server.api('GET', '/api/v1/raw');
  assert.equal(raw.status, 202);
  assert.equal(raw.body, 'example');
  assert.equal(raw.headers.get('cache-control'), 'no-store');
  assert.equal((await server.api('GET', '/api/v1/direct')).body, 'direct');
  assertError(await server.api('GET', '/api/v1/items/%GG/files/name'), 400, 'bad_request');
});

test('in-memory router logs unexpected errors and returns a generic internal envelope', async (t) => {
  const server = memoryRouter(t);
  server.router.add('GET', '/api/v1/fail', () => { throw new Error('private diagnostic detail'); }, { scope: null });
  const response = await server.api('GET', '/api/v1/fail');
  assertError(response, 500, 'internal');
  assert.equal(JSON.stringify(response.body).includes('private diagnostic'), false);
  assert.match(server.errors[0], /private diagnostic detail/);
  server.router.add('GET', '/api/v1/throw-null', () => { throw null; }, { scope: null });
  assertError(await server.api('GET', '/api/v1/throw-null'), 500, 'internal');
  const circular = {};
  circular.self = circular;
  server.router.add('GET', '/api/v1/circular', () => circular, { scope: null });
  assertError(await server.api('GET', '/api/v1/circular'), 500, 'internal');
});
