import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createToken } from '../server/auth.js';
import { migrate } from '../server/db.js';
import { register } from '../server/routes/profile.js';
import { getProfile, getRevision, listRevisions, mergePatch, saveProfile } from '../server/services/profile.js';
import { startApplicationServer as startTestServer } from './helpers.js';

const profile = JSON.parse(readFileSync(new URL('../examples/profile.example.json', import.meta.url), 'utf8'));
const tracks = JSON.parse(readFileSync(new URL('../examples/tracks.example.json', import.meta.url), 'utf8'));
const root = '/api/v1/profile';

async function server(t, options) {
  const instance = await startTestServer(options);
  t.after(() => instance.close());
  return instance;
}

test('merge patch merges objects, deletes nulls, replaces arrays and scalar roots without mutation', () => {
  const target = { identity: { name: 'Alex Example', email: 'alex@example.com' }, tags: ['a', 'b'], obsolete: true };
  const patch = { identity: { email: null, location: 'Remote' }, tags: ['c'], obsolete: null };
  assert.deepEqual(mergePatch(target, patch), { identity: { name: 'Alex Example', location: 'Remote' }, tags: ['c'] });
  assert.equal(target.identity.email, 'alex@example.com');
  assert.deepEqual(target.tags, ['a', 'b']);
  assert.deepEqual(patch.tags, ['c']);
  assert.deepEqual(mergePatch([], { nested: { missing: null, value: 1 } }), { nested: { value: 1 } });
  for (const value of [null, 'replacement', 2, false, [1, 2]]) assert.deepEqual(mergePatch(target, value), value);
  const special = mergePatch({}, JSON.parse('{"__proto__":{"safe":true},"constructor":{"value":1}}'));
  assert.equal(Object.hasOwn(special, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(special), Object.prototype);
  assert.equal({}.safe, undefined);
  assert.deepEqual(special.constructor, { value: 1 });
});

test('profile starts empty and schema and revision endpoints require read access', async (t) => {
  const s = await server(t);
  const empty = await s.api('GET', root);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, { profile: null, empty: true, revision_id: null, updated_at: null });
  const schema = await s.api('GET', `${root}/schema`);
  assert.equal(schema.status, 200);
  assert.ok(schema.body.required.includes('identity'));
  assert.deepEqual((await s.api('GET', `${root}/revisions`)).body, []);
  for (const path of [root, `${root}/schema`, `${root}/revisions`, `${root}/revisions/1`]) {
    assert.equal((await s.api('GET', path, undefined, { token: null })).status, 401);
  }
  assert.equal((await s.api('GET', `${root}/revisions/1`)).status, 404);
  for (const id of ['0', '-1', '1.5', 'abc', '9007199254740992']) {
    assert.equal((await s.api('GET', `${root}/revisions/${id}`)).status, 400);
  }
  const patch = await s.api('PATCH', root, {});
  assert.equal(patch.status, 422);
  assert.match(patch.body.error.message, /PUT \/api\/v1\/profile/);
});

test('setup writes profile, revisions grow on each write and preserve documents and token names', async (t) => {
  const s = await server(t, { withToken: 'setup' });
  const first = await s.api('PUT', root, profile);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.profile, profile);
  assert.equal(first.body.revision_id, 1);
  assert.deepEqual(first.body.tracks_failing, []);
  assert.ok(!Number.isNaN(Date.parse(first.body.updated_at)));
  const second = await s.api('PATCH', root, {
    identity: { phone: null, location: 'Remote' },
    experience: [profile.experience[0]], about: null,
    rules: { cover_max_words: 100 }
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.revision_id, 2);
  assert.equal(second.body.profile.identity.name, 'Alex Example');
  assert.equal(second.body.profile.identity.email, 'alex@example.com');
  assert.equal(second.body.profile.identity.location, 'Remote');
  assert.equal(Object.hasOwn(second.body.profile.identity, 'phone'), false);
  assert.equal(Object.hasOwn(second.body.profile, 'about'), false);
  assert.deepEqual(second.body.profile.experience, [profile.experience[0]]);
  assert.equal(second.body.profile.rules.cover_max_words, 100);
  assert.deepEqual(second.body.profile.rules.forbid_patterns, profile.rules.forbid_patterns);
  const third = await s.api('PUT', root, second.body.profile);
  assert.equal(third.body.revision_id, 3);
  const current = await s.api('GET', root);
  assert.equal(current.body.empty, false);
  assert.equal(current.body.revision_id, 3);
  assert.deepEqual(current.body.profile, second.body.profile);
  const revisions = await s.api('GET', `${root}/revisions`);
  assert.deepEqual(revisions.body.map((row) => row.id), [3, 2, 1]);
  assert.ok(revisions.body.every((row) => row.token_name === 'setup test token' && row.created_at));
  assert.deepEqual((await s.api('GET', `${root}/revisions/1`)).body, profile);
  assert.deepEqual((await s.api('GET', `${root}/revisions/2`)).body, second.body.profile);
});

test('revision API keeps an array body, reports the total header and supports pagination after sixty writes', async (t) => {
  const s = await server(t);
  const empty = await s.api('GET', `${root}/revisions`);
  assert.deepEqual(empty.body, []);
  assert.equal(empty.headers.get('X-Total-Count'), '0');
  for (let index = 0; index < 65; index += 1) {
    const response = await s.api('PUT', root, { ...profile, about: `Revision ${index}` });
    assert.equal(response.status, 200);
  }
  const all = await s.api('GET', `${root}/revisions`);
  assert.equal(all.body.length, 65);
  assert.equal(all.headers.get('X-Total-Count'), '65');
  const page = await s.api('GET', `${root}/revisions?limit=5&offset=60`);
  assert.deepEqual(page.body.map(({ id }) => id), [5, 4, 3, 2, 1]);
  assert.equal(page.headers.get('X-Total-Count'), '65');
  const beyond = await s.api('GET', `${root}/revisions?offset=100`);
  assert.deepEqual(beyond.body, []);
  assert.equal(beyond.headers.get('X-Total-Count'), '65');
  for (const query of ['limit=-1', 'limit=1.5', 'limit=abc', 'limit=', 'offset=-1', 'offset=1.5', 'offset=9007199254740992']) {
    const response = await s.api('GET', `${root}/revisions?${query}`);
    assert.equal(response.status, 400, query);
    assert.equal(response.body.error.code, 'bad_request');
    assert.match(response.body.error.message, /query\.(?:limit|offset).*non-negative integer/u);
  }
});

test('revision pagination defaults to two hundred and caps requested limits at one thousand', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  migrate(db);
  const doc = { schema_version: 1, identity: { name: 'Alex Example' }, experience: [], skills: [] };
  for (let index = 0; index < 1005; index += 1) saveProfile(db, doc, null);
  assert.equal(listRevisions(db).items.length, 200);
  const capped = listRevisions(db, { limit: '2000' });
  assert.equal(capped.items.length, 1000);
  assert.equal(capped.total, 1005);
  assert.equal(capped.items[999].id, 6);
  assert.deepEqual(listRevisions(db, { limit: 0, offset: 1000 }), { items: [], total: 1005 });
});

test('invalid writes explain profile paths, do not store revisions, and agent cannot write', async (t) => {
  const s = await server(t);
  const agent = s.makeToken('agent');
  for (const method of ['PUT', 'PATCH']) {
    assert.equal((await s.api(method, root, profile, { token: agent })).status, 403);
  }
  const invalid = await s.api('PUT', root, { ...profile, identity: { name: 'Alex Example', secret: true } });
  assert.equal(invalid.status, 422);
  assert.equal(invalid.body.error.code, 'validation_failed');
  assert.ok(invalid.body.error.details.some((issue) => issue.path === 'profile.identity.secret'));
  for (const body of [null, [], 1, { ...profile, schema_version: 100 }, { ...profile, skills: null }]) {
    const result = await s.api('PUT', root, body);
    assert.equal(result.status, 422);
    assert.ok(result.body.error.details.every((issue) => issue.path.startsWith('profile')));
  }
  assert.equal(getProfile(s.db), null);
  await s.api('PUT', root, profile);
  for (const patch of [{ identity: null }, null, [], { unexpected: 'field' }]) {
    assert.equal((await s.api('PATCH', root, patch)).status, 422);
  }
  assert.equal(listRevisions(s.db).items.length, 1);
  assert.deepEqual(getProfile(s.db).doc, profile);
});

test('profile writes report affected tracks without blocking the new facts', async (t) => {
  const s = await server(t);
  await s.api('PUT', root, profile);
  assert.equal((await s.api('PUT', '/api/v1/tracks/unity', tracks['unity-developer'])).status, 201);
  const unaffected = { ...tracks['go-backend'], base: { ...tracks['go-backend'].base, experience: [tracks['go-backend'].base.experience[0]] } };
  assert.equal((await s.api('PUT', '/api/v1/tracks/backend', unaffected)).status, 201);
  const result = await s.api('PATCH', root, { experience: profile.experience.filter(({ company }) => company !== 'Northwind Games') });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.tracks_failing, ['unity']);
  assert.equal(result.body.profile.experience.length, 2);
});

test('profile services upgrade legacy reads, paginate revisions and save atomically', (t) => {
  const s = { db: new DatabaseSync(':memory:') };
  t.after(() => s.db.close());
  migrate(s.db);
  const legacy = { ...profile };
  delete legacy.schema_version;
  s.db.prepare('INSERT INTO profile(id, doc, updated_at) VALUES (1, ?, ?)').run(JSON.stringify(legacy), '2026-01-01');
  assert.equal(getProfile(s.db).doc.schema_version, 1);
  assert.equal(getProfile(s.db).revisionId, null);
  for (let index = 0; index < 65; index++) saveProfile(s.db, { ...profile, about: `Revision ${index}` }, null);
  assert.equal(listRevisions(s.db).total, 65);
  assert.deepEqual(listRevisions(s.db).items.map(({ id }) => id), Array.from({ length: 65 }, (_, index) => 65 - index));
  assert.equal(listRevisions(s.db).items[0].token_name, null);
  assert.deepEqual(listRevisions(s.db, { limit: 5, offset: 60 }).items.map(({ id }) => id), [5, 4, 3, 2, 1]);
  assert.equal(getRevision(s.db, 1).about, 'Revision 0');
  assert.equal(getRevision(s.db, 999), null);
  s.db.exec("CREATE TRIGGER reject_revision BEFORE INSERT ON profile_revisions BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
  assert.throws(() => saveProfile(s.db, profile, null), /test failure/);
  assert.equal(getProfile(s.db).doc.about, 'Revision 64');
  assert.equal(getProfile(s.db).revisionId, 65);
});

test('direct profile handlers validate documents, preserve revisions and report failing tracks', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  migrate(db);
  const token = createToken(db, { name: 'setup fixture', preset: 'setup' });
  const routes = new Map();
  register({ add(method, path, handler, options) { routes.set(`${method} ${path}`, { handler, ...options }); } });
  const headers = new Map();
  const res = { setHeader(name, value) { headers.set(name, value); } };
  const call = (method, suffix = '', body = {}, params = {}) => routes.get(`${method} ${root}${suffix}`).handler({ db, body, params, token, res });
  assert.deepEqual(call('GET'), { profile: null, empty: true, revision_id: null, updated_at: null });
  assert.throws(() => call('PATCH'), { status: 422, code: 'validation_failed' });
  assert.ok(call('GET', '/schema').required.includes('identity'));
  assert.deepEqual(call('GET', '/revisions'), []);
  const first = call('PUT', '', profile);
  assert.equal(first.revision_id, 1);
  assert.deepEqual(first.profile, profile);
  const track = tracks['unity-developer'];
  db.prepare('INSERT INTO tracks(id, doc) VALUES (?, ?)').run('unity', JSON.stringify(track));
  const changed = call('PATCH', '', {
    experience: profile.experience.filter(({ company }) => company !== 'Northwind Games'),
    identity: { phone: null, location: 'Remote' }
  });
  assert.deepEqual(changed.tracks_failing, ['unity']);
  assert.equal(changed.revision_id, 2);
  assert.equal(changed.profile.identity.name, 'Alex Example');
  assert.equal(Object.hasOwn(changed.profile.identity, 'phone'), false);
  assert.equal(changed.profile.experience.length, 2);
  assert.equal(call('GET').revision_id, 2);
  assert.deepEqual(call('GET', '/revisions').map(({ id, token_name }) => ({ id, token_name })), [
    { id: 2, token_name: 'setup fixture' }, { id: 1, token_name: 'setup fixture' }
  ]);
  assert.deepEqual(call('GET', '/revisions/:id', {}, { id: '1' }), profile);
  assert.throws(() => call('GET', '/revisions/:id', {}, { id: '3' }), { status: 404 });
  assert.throws(() => call('GET', '/revisions/:id', {}, { id: 'bad' }), { status: 400 });
  for (const body of [null, [], { ...profile, identity: { unknown: true } }, { ...profile, schema_version: 100 }]) {
    assert.throws(() => call('PUT', '', body), (error) => error.status === 422 && error.details.every(({ path }) => path.startsWith('profile')));
  }
  for (const field of ['name_localized', 'availability']) {
    const invalid = structuredClone(profile);
    invalid.identity[field].en = { toString: 1 };
    assert.throws(() => call('PUT', '', invalid), (error) => error.status === 422
      && error.details.some(({ path, code }) => path === `profile.identity.${field}.en` && code === 'type'));
  }
  assert.equal(listRevisions(db).items.length, 2);
  for (const [key, route] of routes) assert.equal(route.scope, key.startsWith('GET') ? 'read' : 'write:profile');
});
