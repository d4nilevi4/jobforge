import { request as httpRequest } from 'node:http';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createToken } from '../server/auth.js';
import { check } from '../server/guard.js';
import { createRouter } from '../server/http.js';
import { registerAll } from '../server/routes/index.js';
import { validateDocument } from '../server/upgrade.js';
import { loadSchema, validate } from '../server/validate.js';
import { demoExample, fakeApplicationPdf, startTestServer } from './helpers.js';

const guide = await readFile(new URL('../docs/agent-guide.md', import.meta.url), 'utf8');
const guardSource = await readFile(new URL('../server/guard.js', import.meta.url), 'utf8');
const router = createRouter();
registerAll(router);

function assertRoute(method, path) {
  const segments = path.split('?')[0].split('/');
  assert.ok(router.routes.some((route) => {
    const pattern = route.pattern.split('/');
    return route.method === method && pattern.length === segments.length
      && pattern.every((segment, index) => segment.startsWith(':') || segment === segments[index]);
  }), `Guide mentions an unregistered route: ${method} ${path}`);
}

function completeExample() {
  const examples = [...guide.matchAll(/```json\n([\s\S]*?)\n```/gu)].map(([, text]) => JSON.parse(text));
  const requests = examples.filter((value) => value.vacancy && value.resume && value.cover);
  assert.equal(requests.length, 1, 'Keep one complete, parseable application request example in the guide.');
  return requests[0];
}

test('Every API method/path in guide prose and curl examples exists', () => {
  const mentions = [...guide.matchAll(/\b(GET|PUT|POST|PATCH|DELETE)\s+(\/api\/v1\/[A-Za-z0-9_/:.{}-]+)/gu)];
  assert.ok(mentions.length > 10, 'Expected explicit endpoint references in the guide.');
  for (const [, method, path] of mentions) assertRoute(method, path);
  const shellBlocks = [...guide.matchAll(/```sh\n([\s\S]*?)\n```/gu)];
  let curlCount = 0;
  for (const [, block] of shellBlocks) {
    const lines = block.replace(/\\\n/gu, ' ').split('\n');
    for (const line of lines.filter((value) => value.startsWith('curl '))) {
      const path = /\{\{BASE_URL\}\}(\/api\/v1\/[^'"\s]+)/u.exec(line)?.[1];
      assert.ok(path, `Curl example must use {{BASE_URL}} and a real API path: ${line}`);
      const method = /-X\s+(GET|PUT|POST|PATCH|DELETE)\b/u.exec(line)?.[1] ?? 'GET';
      assertRoute(method, path);
      curlCount++;
    }
  }
  assert.ok(curlCount >= 10, 'Expected copy-pasteable HTTP examples.');
  for (const [, methodCell, pathCell] of guide.matchAll(/^\| ([A-Z, ]+) \| ([^|]+) \|/gmu)) {
    const methods = methodCell.match(/GET|PUT|POST|PATCH|DELETE/gu) ?? [];
    const paths = [...pathCell.matchAll(/`(\/[^`]+)`/gu)].map(([, path]) => path);
    for (const method of methods) {
      for (const path of paths) assertRoute(method, `/api/v1${path}`);
    }
  }
  assert.ok(guide.split('\n').length < 400, 'Keep the guide below 400 lines.');
});

test('Guide explains every guard error and warning code emitted by the implementation', () => {
  const issueCodes = [...guardSource.matchAll(/issue\(\s*(?:'[^']*'|`[^`]*`|[A-Za-z.]+)\s*,\s*'([a-z_]+)'/gu)].map(([, code]) => code);
  const ruleCodes = [...guardSource.matchAll(/add\(pattern,\s*'([a-z_]+)'/gu)].map(([, code]) => code);
  const codes = new Set([...issueCodes, ...ruleCodes]);
  assert.ok(codes.size >= 15, 'Guard-code extraction must include structured checks, rules, and warnings.');
  for (const code of [...codes, 'page_overflow']) {
    assert.ok(guide.includes(`\`${code}\``), `Explain guard/render code ${code} and how to fix it in the guide.`);
  }
});

test('Complete guide request satisfies schemas and the example profile guard', () => {
  const input = completeExample();
  const profile = demoExample('profile');
  assert.deepEqual(validate(loadSchema('application'), input), []);
  assert.deepEqual(validateDocument('content', input.resume.content).errors, []);
  assert.deepEqual(validateDocument('cover', input.cover.content).errors, []);
  const result = check({ content: input.resume.content, cover: input.cover.content, profile });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.ok(input.cover.content.text.trim().split(/\s+/u).length <= profile.rules.cover_max_words);
});

test('GET /api/v1/guide serves Markdown with the request origin and enforces read over HTTP', async (t) => {
  const app = await startTestServer({ deps: { renderPdf: fakeApplicationPdf, chrome: { bin: 'fake-chrome' } } });
  t.after(() => app.close());
  const agentToken = app.makeToken('agent');
  const response = await app.api('GET', '/api/v1/guide', undefined, { token: agentToken, raw: true });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.equal(response.body, guide.replaceAll('{{BASE_URL}}', app.url));
  assert.ok(response.body.includes(`${app.url}/api/v1/profile`));
  assert.ok(!response.body.includes('{{BASE_URL}}'));

  for (const host of ['example.com:9090', '[::1]:8787']) {
    // fetch() ignores a custom Host header, so use node:http
    const custom = await new Promise((resolve, reject) => {
      const req = httpRequest(`${app.url}/api/v1/guide`, { headers: { Authorization: `Bearer ${agentToken}`, Host: host } }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(custom.status, 200);
    assert.equal(custom.body, guide.replaceAll('{{BASE_URL}}', `http://${host}`));
  }
  const unauthenticated = await app.api('GET', '/api/v1/guide', undefined, { token: null });
  assert.equal(unauthenticated.status, 401);
  const token = createToken(app.db, { name: 'No read scope test', scopes: [] }).secret;
  const forbidden = await app.api('GET', '/api/v1/guide', undefined, { token });
  assert.equal(forbidden.status, 403);
  assert.match(forbidden.body.error.message, /scope read/u);

  assert.equal((await app.api('PUT', '/api/v1/profile', demoExample('profile'))).status, 200);
  const checked = await app.api('POST', '/api/v1/check', completeExample(), { token: agentToken });
  assert.equal(checked.status, 200, JSON.stringify(checked.body));
  assert.equal(checked.body.ok, true);
  const saved = await app.api('POST', '/api/v1/applications', completeExample(), { token: agentToken });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.equal(saved.body.status, 'draft');
});
