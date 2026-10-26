import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createToken } from '../server/auth.js';
import { createRouter } from '../server/http.js';
import { registerAll } from '../server/routes/index.js';
import { startTestServer } from './helpers.js';

const openapi = JSON.parse(await readFile(new URL('../schema/openapi.json', import.meta.url), 'utf8'));
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const router = createRouter();
registerAll(router);
const methods = new Set(['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace']);

function documentedRoutes() {
  return Object.entries(openapi.paths).flatMap(([path, item]) => Object.keys(item)
    .filter((method) => methods.has(method))
    .map((method) => `${method.toUpperCase()} /api/v1${path}`));
}

function resolvePointer(pointer) {
  assert.ok(pointer.startsWith('#/'), `OpenAPI reference must be local: ${pointer}`);
  let value = openapi;
  for (const segment of pointer.slice(2).split('/')) {
    const key = segment.replaceAll('~1', '/').replaceAll('~0', '~');
    assert.ok(value && Object.hasOwn(value, key), `Unresolved OpenAPI reference: ${pointer}`);
    value = value[key];
  }
  return value;
}

function inspectReferences(value) {
  if (!value || typeof value !== 'object') return;
  if (value.$ref) resolvePointer(value.$ref);
  for (const child of Object.values(value)) inspectReferences(child);
}

test('OpenAPI documents every registered API method and pattern, with no extra routes', () => {
  const actual = router.routes.filter(({ pattern }) => pattern.startsWith('/api/v1/'))
    .map(({ method, pattern }) => `${method} ${pattern.replace(/:([A-Za-z_][A-Za-z0-9_]*)/gu, '{$1}')}`);
  const documented = documentedRoutes();
  assert.equal(new Set(actual).size, actual.length, 'Registered routes must be unique.');
  assert.equal(new Set(documented).size, documented.length, 'Documented routes must be unique.');
  assert.deepEqual(documented.sort(), actual.sort());
  for (const route of router.routes) {
    assert.deepEqual(Object.keys(route).sort(), ['method', 'pattern', 'scope']);
    const path = route.pattern.slice('/api/v1'.length).replace(/:([A-Za-z_][A-Za-z0-9_]*)/gu, '{$1}');
    const operation = openapi.paths[path][route.method.toLowerCase()];
    if (route.scope) assert.equal(operation['x-scope'], route.scope);
    if (path === '/version') assert.deepEqual(operation.security, []);
    if (path === '/applications/{id}/status') assert.match(operation.description, /write:applications.*approve/su);
    assert.ok(operation.responses['200'] || operation.responses['201']);
    assert.ok(operation.responses['422']);
    const parameters = [...(openapi.paths[path].parameters ?? []), ...(operation.parameters ?? [])];
    for (const [, name] of path.matchAll(/\{([^}]+)\}/gu)) {
      assert.ok(parameters.some((parameter) => parameter.in === 'path' && parameter.name === name && parameter.required));
    }
  }
});

test('OpenAPI has the package version, bearer authentication, valid references, and current schema copies', async () => {
  assert.equal(openapi.openapi, '3.1.0');
  assert.equal(openapi.info.version, packageJson.version);
  assert.deepEqual(openapi.servers, [{ url: '/api/v1' }]);
  assert.deepEqual(openapi.security, [{ bearerAuth: [] }]);
  assert.equal(openapi.components.securitySchemes.bearerAuth.type, 'http');
  assert.equal(openapi.components.securitySchemes.bearerAuth.scheme, 'bearer');
  inspectReferences(openapi);
  for (const [name, file] of Object.entries({ Profile: 'profile', Track: 'track', Content: 'content', Cover: 'cover', ApplicationInput: 'application' })) {
    const source = JSON.parse(await readFile(new URL(`../schema/${file}.schema.json`, import.meta.url), 'utf8'));
    const expected = JSON.parse(JSON.stringify(source).replaceAll('#/$defs/', `#/components/schemas/${name}/$defs/`));
    assert.deepEqual(openapi.components.schemas[name], expected, `Refresh the OpenAPI ${name} schema copy after schema changes.`);
  }
});

test('GET /api/v1/openapi.json serves the complete document and enforces read scope over HTTP', async (t) => {
  const app = await startTestServer({ withToken: 'agent', deps: { chrome: { bin: '' } } });
  t.after(() => app.close());
  const response = await app.api('GET', '/api/v1/openapi.json');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/json; charset=utf-8$/u);
  assert.deepEqual(response.body, openapi);
  assert.equal(response.headers.get('cache-control'), 'no-store');

  const unauthenticated = await app.api('GET', '/api/v1/openapi.json', undefined, { token: null });
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.body.error.code, 'unauthorized');
  const token = createToken(app.db, { name: 'No read scope test', scopes: ['write:applications'] }).secret;
  const forbidden = await app.api('GET', '/api/v1/openapi.json', undefined, { token });
  assert.equal(forbidden.status, 403);
  assert.match(forbidden.body.error.message, /scope read/u);
});
