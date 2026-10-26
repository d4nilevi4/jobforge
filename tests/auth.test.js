import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authenticate, createToken, ensureOwnerToken, hasScope, listTokens, PRESETS, revokeToken, SCOPES } from '../server/auth.js';
import { migrate, openDb } from '../server/db.js';
import { ApiError } from '../server/errors.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jobforge-auth-'));
  const db = openDb(dir);
  migrate(db);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

const request = (secret) => ({ headers: { authorization: `Bearer ${secret}` } });

test('createToken stores only a SHA-256 hash and listTokens never exposes credentials', (t) => {
  const db = fixture(t);
  const token = createToken(db, { name: 'example agent', preset: 'agent' });
  assert.match(token.secret, /^jf_[A-Za-z0-9_-]{43}$/);
  const row = db.prepare('SELECT * FROM tokens WHERE id = ?').get(token.id);
  assert.equal(row.hash, createHash('sha256').update(token.secret).digest('hex'));
  assert.equal(JSON.stringify(row).includes(token.secret), false);
  assert.deepEqual(JSON.parse(row.scopes), token.scopes);
  assert.match(row.created_at, /Z$/);
  const listed = listTokens(db);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, token.name);
  assert.equal('hash' in listed[0], false);
  assert.equal('secret' in listed[0], false);
  assert.notEqual(createToken(db, { name: 'another agent', preset: 'agent' }).secret, token.secret);
});

test('presets contain exactly the specified scopes and owner has all scopes', (t) => {
  const db = fixture(t);
  assert.deepEqual(SCOPES, ['read', 'write:applications', 'write:tracks', 'write:templates', 'write:profile', 'approve', 'admin']);
  assert.deepEqual(PRESETS.agent, SCOPES.slice(0, 4));
  assert.deepEqual(PRESETS.setup, SCOPES.slice(0, 5));
  assert.deepEqual(PRESETS.owner, SCOPES);
  for (const preset of ['agent', 'setup', 'owner']) {
    const token = createToken(db, { name: preset, preset });
    assert.deepEqual(token.scopes, PRESETS[preset]);
    for (const scope of SCOPES) assert.equal(hasScope(token, scope), PRESETS[preset].includes(scope));
  }
  assert.equal(hasScope(null, 'read'), false);
});

test('explicit scopes are validated, copied, and deduplicated', (t) => {
  const db = fixture(t);
  const scopes = ['read', 'read', 'admin'];
  const token = createToken(db, { name: 'custom', scopes });
  assert.deepEqual(token.scopes, ['read', 'admin']);
  assert.deepEqual(scopes, ['read', 'read', 'admin']);
  for (const options of [undefined, {}, { name: '' }, { name: 'example' }, { name: 'example', preset: 'unknown' },
    { name: 'example', preset: 'toString' }, { name: 'example', preset: 'agent', scopes: ['read'] },
    { name: 'example', scopes: 'read' }, { name: 'example', scopes: ['unknown'] },
    { name: 'example', scopes: [null] }, { name: 'example', scopes: new Array(1) }]) {
    assert.throws(() => createToken(db, options), (error) => error instanceof ApiError && error.status === 400);
  }
  assert.deepEqual(createToken(db, { name: 'no capabilities', scopes: [] }).scopes, []);
});

test('authentication rejects revoked, unknown, and malformed bearer tokens', (t) => {
  const db = fixture(t);
  const token = createToken(db, { name: 'example', preset: 'agent' });
  assert.deepEqual(authenticate(db, request(token.secret)), { id: token.id, name: token.name, scopes: token.scopes });
  assert.equal(authenticate(db, { headers: { authorization: `bEaReR ${token.secret}` } }).id, token.id);
  for (const authorization of [undefined, '', 'Basic abc', 'Bearer', 'Bearer wrong', `Bearer ${token.secret} extra`, [token.secret]]) {
    assert.equal(authenticate(db, { headers: { authorization } }), null);
  }
  assert.equal(revokeToken(db, token.id), true);
  const revokedAt = listTokens(db)[0].revoked_at;
  assert.match(revokedAt, /Z$/);
  assert.equal(authenticate(db, request(token.secret)), null);
  assert.equal(revokeToken(db, token.id), false);
  assert.equal(listTokens(db)[0].revoked_at, revokedAt);
  assert.equal(revokeToken(db, 999), false);
});

test('last_used_at is written at most once per minute per token', (t) => {
  const db = fixture(t);
  const token = createToken(db, { name: 'example', preset: 'agent' });
  authenticate(db, request(token.secret));
  const first = listTokens(db)[0].last_used_at;
  assert.match(first, /Z$/);
  const recent = new Date(Date.now() - 30_000).toISOString();
  db.prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?').run(recent, token.id);
  authenticate(db, request(token.secret));
  assert.equal(listTokens(db)[0].last_used_at, recent);
  db.prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?').run(new Date(Date.now() - 61_000).toISOString(), token.id);
  authenticate(db, request(token.secret));
  assert.ok(Date.now() - Date.parse(listTokens(db)[0].last_used_at) < 1000);
});

test('initial owner is created and logged once, even when all tokens are later revoked', (t) => {
  const db = fixture(t);
  const messages = [];
  const token = ensureOwnerToken(db, (message) => messages.push(message));
  assert.equal(token.name, 'owner');
  assert.deepEqual(token.scopes, SCOPES);
  assert.ok(messages[0].includes(token.secret));
  assert.equal(ensureOwnerToken(db, (message) => messages.push(message)), null);
  revokeToken(db, token.id);
  assert.equal(ensureOwnerToken(db, (message) => messages.push(message)), null);
  assert.equal(messages.length, 1);
  assert.equal(listTokens(db).length, 1);
});
