import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { migrate } from '../server/db.js';
import { register } from '../server/routes/tracks.js';
import { saveProfile } from '../server/services/profile.js';
import { deleteTrack, getTrack, listTracks, saveTrack } from '../server/services/tracks.js';
import { registerUpgrade, resetUpgrades } from '../server/upgrade.js';
import { loadSchema } from '../server/validate.js';
import { startApplicationServer as startTestServer } from './helpers.js';

const profile = JSON.parse(readFileSync(new URL('../examples/profile.example.json', import.meta.url), 'utf8'));
const example = JSON.parse(readFileSync(new URL('../examples/tracks.example.json', import.meta.url), 'utf8'))['unity-developer'];
const root = '/api/v1/tracks';

async function server(t, { withProfile = true } = {}) {
  const s = await startTestServer();
  t.after(() => s.close());
  if (withProfile) assert.equal((await s.api('PUT', '/api/v1/profile', profile)).status, 200);
  return s;
}

test('agent creates, reads, replaces, lists and deletes tracks', async (t) => {
  const s = await server(t);
  const agent = s.makeToken('agent');
  assert.deepEqual((await s.api('GET', root)).body, []);
  const created = await s.api('PUT', `${root}/unity-developer`, example, { token: agent });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.track, example);
  assert.deepEqual(created.body.warnings, []);
  assert.ok(created.body.updated_at);
  const read = await s.api('GET', `${root}/unity-developer`);
  assert.equal(read.status, 200);
  assert.deepEqual(read.body, { id: 'unity-developer', track: example, updated_at: created.body.updated_at });
  const replacement = { ...example, name: 'Unity tools' };
  const replaced = await s.api('PUT', `${root}/unity-developer`, replacement, { token: agent });
  assert.equal(replaced.status, 200);
  const listed = await s.api('GET', root);
  assert.deepEqual(listed.body, [{
    id: 'unity-developer', name: 'Unity tools', when_to_use: example.when_to_use,
    language: 'en', resume_template: 'classic', cover_template: 'letter', updated_at: replaced.body.updated_at
  }]);
  assert.deepEqual((await s.api('DELETE', `${root}/unity-developer`, undefined, { token: agent })).body, { ok: true });
  assert.equal((await s.api('GET', `${root}/unity-developer`)).status, 404);
  assert.equal((await s.api('DELETE', `${root}/unity-developer`)).status, 404);
});

test('track writes require a profile, a valid id and matching scope', async (t) => {
  const s = await server(t, { withProfile: false });
  const missing = await s.api('PUT', `${root}/unity`, example);
  assert.equal(missing.status, 422);
  assert.equal(missing.body.error.code, 'profile_missing');
  assert.match(missing.body.error.message, /PUT \/api\/v1\/profile/);
  for (const id of ['Uppercase', '-leading', 'under_score', 'a'.repeat(64), 'space%20name', 'slash%2Fname']) {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      assert.equal((await s.api(method, `${root}/${id}`, method === 'PUT' ? example : undefined)).status, 400);
    }
  }
  const readOnly = (await s.api('POST', '/api/v1/tokens', { name: 'read only', scopes: ['read'] })).body.secret;
  for (const method of ['PUT', 'DELETE']) {
    assert.equal((await s.api(method, `${root}/unity`, method === 'PUT' ? example : undefined, { token: readOnly })).status, 403);
  }
  for (const path of [root, `${root}/unity`]) {
    assert.equal((await s.api('GET', path, undefined, { token: null })).status, 401);
  }
});

test('track validation rejects malformed documents without storing them', async (t) => {
  const s = await server(t);
  for (const body of [null, [], {}, { ...example, schema_version: 2 }, { ...example, base: { ...example.base, skills: 1 } }]) {
    const result = await s.api('PUT', `${root}/invalid`, body);
    assert.equal(result.status, 422);
    assert.equal(result.body.error.code, 'validation_failed');
    assert.ok(result.body.error.details.length);
  }
  assert.equal(getTrack(s.db, 'invalid'), null);
});

test('track template errors identify path, required kind and valid ids', async (t) => {
  const s = await server(t);
  for (const [field, value, valid] of [
    ['resume_template', 'missing', 'classic'], ['resume_template', 'letter', 'classic'],
    ['resume_template', 'classic@99', 'classic'], ['resume_template', 'classic@bad', 'classic'],
    ['cover_template', 'classic', 'letter'], ['cover_template', 'missing', 'letter']
  ]) {
    const result = await s.api('PUT', `${root}/invalid`, { ...example, [field]: value });
    assert.equal(result.status, 422);
    assert.equal(result.body.error.details[0].path, field);
    assert.match(result.body.error.details[0].message, new RegExp(valid));
  }
  const noCover = structuredClone(example);
  delete noCover.cover_template;
  const saved = await s.api('PUT', `${root}/no-cover`, noCover);
  assert.equal(saved.status, 201);
  assert.equal(saved.body.track.cover_template, '');
  assert.equal((await s.api('PUT', `${root}/versioned`, { ...example, resume_template: 'classic@1', cover_template: 'letter@1' })).status, 201);
});

test('track fact errors have base paths and failed replacements preserve the old document', async (t) => {
  const s = await server(t);
  await s.api('PUT', `${root}/unity`, example);
  const unknown = structuredClone(example);
  unknown.base.experience[0].company = 'Unknown Example Employer';
  const result = await s.api('PUT', `${root}/unity`, unknown);
  assert.equal(result.status, 422);
  assert.ok(result.body.error.details.some(({ path, code }) => path === 'base.experience[0].company' && code === 'unknown_employer'));
  assert.deepEqual(getTrack(s.db, 'unity').doc, example);
  const forbiddenCover = { ...example, base_cover: 'I shipped console games.' };
  const coverResult = await s.api('PUT', `${root}/cover`, forbiddenCover);
  assert.equal(coverResult.status, 422);
  assert.ok(coverResult.body.error.details.some(({ path, code }) => path === 'base_cover' && code === 'do_not_claim'));
});

test('track warnings are returned without blocking a write', async (t) => {
  const s = await server(t);
  const track = structuredClone(example);
  track.base.experience[0].bullets.push('Built 987 lines of code.');
  const result = await s.api('PUT', `${root}/warnings`, track);
  assert.equal(result.status, 201);
  for (const code of ['number_not_in_profile', 'code_line_counts']) {
    assert.ok(result.body.warnings.some((warning) => warning.code === code && warning.path.startsWith('base.experience[0].bullets')));
  }
  assert.deepEqual(getTrack(s.db, 'warnings').doc, track);
});

test('track services upgrade legacy records and preserve creation time on replacement', (t) => {
  const s = { db: new DatabaseSync(':memory:') };
  t.after(() => s.db.close());
  migrate(s.db);
  const legacy = { ...example };
  delete legacy.schema_version;
  s.db.prepare('INSERT INTO tracks(id, doc, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('legacy', JSON.stringify(legacy), '2026-01-01', '2026-01-01');
  assert.equal(getTrack(s.db, 'legacy').doc.schema_version, 1);
  assert.equal(listTracks(s.db)[0].id, 'legacy');
  const saved = saveTrack(s.db, 'legacy', { ...example, name: 'Updated' });
  assert.equal(saved.doc.name, 'Updated');
  assert.equal(s.db.prepare('SELECT created_at FROM tracks WHERE id = ?').get('legacy').created_at, '2026-01-01');
  assert.equal(deleteTrack(s.db, 'legacy'), true);
  assert.equal(deleteTrack(s.db, 'legacy'), false);
});

test('embedded content versions are filled before validation, persisted and upgraded on reads', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  migrate(db);
  saveProfile(db, profile, null);
  const routes = new Map();
  register({ add(method, path, handler) { routes.set(`${method} ${path}`, handler); } });
  const put = (id, body) => routes.get(`PUT ${root}/:id`)({ db, body, params: { id } });
  const legacy = structuredClone(example);
  delete legacy.schema_version;
  delete legacy.base.schema_version;
  const before = structuredClone(legacy);
  const saved = put('legacy', legacy);
  assert.equal(saved.body.track.schema_version, 1);
  assert.equal(saved.body.track.base.schema_version, 1);
  assert.deepEqual(legacy, before);
  assert.equal(JSON.parse(db.prepare('SELECT doc FROM tracks WHERE id = ?').get('legacy').doc).base.schema_version, 1);
  assert.throws(() => put('invalid', { ...example, base: null }), (error) => error.status === 422 && error.details[0].path === 'base');
  assert.throws(() => put('future', { ...example, base: { ...example.base, schema_version: 2 } }),
    (error) => error.status === 422 && error.details[0].path === 'base.schema_version');

  const versionSchema = loadSchema('track').$defs.content.properties.schema_version;
  const previousVersion = versionSchema.const;
  t.after(() => {
    versionSchema.const = previousVersion;
    resetUpgrades();
  });
  // A version bump ships its schema alongside the registered transform.
  versionSchema.const = 2;
  let upgrades = 0;
  registerUpgrade('content', 1, (doc) => {
    upgrades += 1;
    const { legacy_headline: headline, ...rest } = doc;
    return { ...rest, headline: headline ?? doc.headline, summary: 'Content was upgraded.' };
  });
  legacy.base.legacy_headline = legacy.base.headline;
  delete legacy.base.headline;
  const upgraded = put('upgraded', legacy).body.track;
  assert.equal(upgrades, 1);
  assert.equal(upgraded.base.schema_version, 2);
  assert.equal(upgraded.base.headline, example.base.headline);
  assert.equal(upgraded.base.summary, 'Content was upgraded.');
  const stored = JSON.parse(db.prepare('SELECT doc FROM tracks WHERE id = ?').get('upgraded').doc);
  assert.deepEqual(stored, upgraded);
  assert.equal(Object.hasOwn(stored.base, 'legacy_headline'), false);
  assert.equal(saveTrack(db, 'service', legacy).doc.base.schema_version, 2);
  db.prepare('INSERT INTO tracks(id, doc) VALUES (?, ?)').run('old', JSON.stringify(legacy));
  assert.equal(getTrack(db, 'old').doc.base.schema_version, 2);
  assert.equal(listTracks(db).find(({ id }) => id === 'old').doc.base.summary, 'Content was upgraded.');
  assert.equal(Object.hasOwn(JSON.parse(db.prepare('SELECT doc FROM tracks WHERE id = ?').get('old').doc).base, 'schema_version'), false);
});

test('track language warnings map resume parts under base and cover text to base_cover', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  migrate(db);
  saveProfile(db, profile, null);
  const routes = new Map();
  register({ add(method, path, handler) { routes.set(`${method} ${path}`, handler); } });
  const body = structuredClone(example);
  body.base.experience[0].bullets = ['Создаю надёжные полезные инструменты.'];
  body.base_cover = 'Создаю надёжные полезные инструменты.';
  const result = routes.get(`PUT ${root}/:id`)({ db, body, params: { id: 'language' } });
  assert.deepEqual(result.body.warnings.map(({ code, path }) => [code, path]), [
    ['wrong_language', 'base.experience[0].bullets[0]'], ['wrong_language', 'base_cover']
  ]);
});

test('direct track handlers enforce validation, template kinds, fact checks and response statuses', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  migrate(db);
  const routes = new Map();
  register({ add(method, path, handler, options) { routes.set(`${method} ${path}`, { handler, ...options }); } });
  const call = (method, body = {}, id = 'example') => routes.get(`${method} ${root}/:id`).handler({ db, body, params: { id } });
  assert.throws(() => call('PUT', example), { status: 422, code: 'profile_missing' });
  assert.throws(() => call('PUT', example, 'Upper'), { status: 400 });
  saveProfile(db, profile, null);
  assert.equal(call('PUT', example).status, 201);
  assert.equal(call('PUT', { ...example, name: 'Updated' }).status, 200);
  assert.equal(call('GET').track.name, 'Updated');
  assert.equal(routes.get(`GET ${root}`).handler({ db })[0].id, 'example');
  assert.throws(() => call('PUT', {}), { status: 422, code: 'validation_failed' });
  for (const [field, value] of [['resume_template', 'missing'], ['resume_template', 'letter'], ['cover_template', 'classic'], ['resume_template', 'classic@99']]) {
    assert.throws(() => call('PUT', { ...example, [field]: value }), (error) => error.status === 422 && error.details[0].path === field);
  }
  const bad = structuredClone(example);
  bad.base.experience[0].company = 'Unknown Example Employer';
  assert.throws(() => call('PUT', bad), (error) => error.status === 422 && error.details.some(({ code, path }) => code === 'unknown_employer' && path === 'base.experience[0].company'));
  assert.throws(() => call('PUT', { ...example, base_cover: 'I shipped console games.' }), (error) => error.details.some(({ code, path }) => code === 'do_not_claim' && path === 'base_cover'));
  assert.equal(getTrack(db, 'example').doc.name, 'Updated');
  const warnings = structuredClone(example);
  warnings.base.experience[0].bullets.push('Built 987 lines of code.');
  const saved = call('PUT', warnings);
  assert.equal(saved.status, 200);
  assert.ok(saved.body.warnings.some(({ code }) => code === 'code_line_counts'));
  const noCover = structuredClone(example);
  delete noCover.cover_template;
  assert.equal(call('PUT', noCover).body.track.cover_template, '');
  assert.deepEqual(call('DELETE'), { ok: true });
  assert.throws(() => call('GET'), { status: 404 });
  assert.throws(() => call('DELETE'), { status: 404 });
  for (const [key, route] of routes) assert.equal(route.scope, key.startsWith('GET') ? 'read' : 'write:tracks');
});
