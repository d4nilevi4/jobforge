import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createToken } from '../server/auth.js';
import { startServer } from '../server/index.js';
import { findChrome } from '../server/render/pdf.js';
import { cleanContent, profile } from './guard-fixtures.js';

function withoutSockets(t) {
  t.mock.method(Server.prototype, 'listen', function(port, host, done) {
    queueMicrotask(done);
    return this;
  });
  t.mock.method(Server.prototype, 'address', () => ({ address: '127.0.0.1', port: 8787 }));
  t.mock.method(Server.prototype, 'close', function(done) {
    done();
    return this;
  });
  t.mock.method(Server.prototype, 'closeIdleConnections', () => {});
}

function request(instance, token, method, path, body) {
  return new Promise((resolve, reject) => {
    const req = new PassThrough();
    req.method = method;
    req.url = path;
    req.headers = token ? { authorization: `Bearer ${token}` } : {};
    const headers = new Headers();
    const res = {
      headersSent: false,
      writableEnded: false,
      setHeader(name, value) { headers.set(name, value); },
      getHeader(name) { return headers.get(name); },
      writeHead(status, values = {}) {
        this.statusCode = status;
        this.headersSent = true;
        for (const [name, value] of Object.entries(values)) headers.set(name, value);
      },
      end(value) {
        this.writableEnded = true;
        resolve({ status: this.statusCode, body: JSON.parse(String(value)), headers });
      },
      destroy() { reject(new Error('In-process response was destroyed. Inspect the route error.')); }
    };
    instance.server.emit('request', req, res);
    req.end(body === undefined ? '' : JSON.stringify(body));
  });
}

for (const validOverride of [true, false]) {
  test(`startup shares Chrome selection with version and rendering for a ${validOverride ? 'valid' : 'missing'} CHROME_BIN`, async (t) => {
    withoutSockets(t);
    const directory = await mkdtemp(join(tmpdir(), 'jobforge-correctness-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const executable = join(directory, 'google-chrome');
    await writeFile(executable, '#!/bin/sh\nprintf "JobForge test Chrome 1\\n"\n', { mode: 0o755 });
    const env = {
      DATA_DIR: join(directory, 'data'), PORT: '0', HOST: '127.0.0.1', PATH: directory,
      CHROME_BIN: validOverride ? executable : join(directory, 'missing-chrome')
    };
    const expected = findChrome(env);
    assert.ok(expected);
    if (validOverride) assert.equal(expected, executable);
    const warnings = [];
    const rendered = [];
    const instance = await startServer({
      env,
      log: { log() {}, warn(message) { warnings.push(message); }, error(message) { assert.fail(message); } },
      deps: {
        async renderPdf(input) {
          rendered.push(input.chrome);
          return { html: '<html></html>', pdf: Buffer.from('%PDF-1.7\n/Type /Pages /Count 1'), pages: 1 };
        }
      }
    });
    t.after(() => instance.close());
    if (validOverride) await rm(executable);
    const token = createToken(instance.db, { name: 'Correctness fixture', preset: 'owner' }).secret;
    const version = await request(instance, null, 'GET', '/api/v1/version');
    assert.equal(version.status, 200);
    assert.equal(version.body.chrome.found, true);
    assert.equal(version.body.chrome.path, expected);
    assert.equal(warnings.length, validOverride ? 0 : 1);
    if (!validOverride) assert.match(warnings[0], /CHROME_BIN.*ignored/u);
    const saved = await request(instance, token, 'PUT', '/api/v1/profile', profile);
    assert.equal(saved.status, 200);
    const result = await request(instance, token, 'POST', '/api/v1/check', {
      vacancy: { url: 'https://example.com/jobs/1', title: 'Engineer', company: 'Example Works', language: 'en', text: 'Build reliable tools.' },
      resume: { template: 'classic', content: cleanContent },
      cover: { template: 'letter', content: { language: 'en', text: 'I build reliable tools and welcome a discussion.' } }
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(rendered.length, 2);
    assert.ok(rendered.every((chrome) => chrome.chromeBin === expected));
    const again = await request(instance, null, 'GET', '/api/v1/version');
    assert.deepEqual(again.body.chrome, version.body.chrome);
    assert.equal(warnings.length, validOverride ? 0 : 1);
  });
}

test('spec render context and status graph describe the implemented contracts', async () => {
  const spec = await readFile(new URL('../docs/SPEC.md', import.meta.url), 'utf8');
  assert.equal(spec.includes('summary_html'), false);
  assert.equal(spec.includes('`rejected` and `skipped` are terminal'), false);
  assert.ok(spec.includes('`needs_review` -> `draft` | `skipped`'));
  assert.ok(spec.includes('`skipped` -> `draft`'));
  assert.ok(spec.includes('X-Total-Count'));
});
