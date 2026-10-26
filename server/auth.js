import { createHash, randomBytes } from 'node:crypto';
import { badRequest } from './errors.js';

export const SCOPES = Object.freeze([
  'read', 'write:applications', 'write:tracks', 'write:templates',
  'write:profile', 'approve', 'admin',
]);

export const PRESETS = Object.freeze({
  agent: Object.freeze(SCOPES.slice(0, 4)),
  setup: Object.freeze(SCOPES.slice(0, 5)),
  owner: SCOPES,
});

export function createToken(db, { name, preset, scopes } = {}) {
  if (typeof name !== 'string' || !name.trim()) {
    throw badRequest('Token body.name must be a non-empty string. Provide a name for this token.');
  }
  if ((preset === undefined) === (scopes === undefined)) {
    throw badRequest('Token body must contain exactly one of preset or scopes. Choose agent, setup, owner, or an array of scopes.');
  }
  if (preset !== undefined) {
    if (typeof preset !== 'string' || !Object.hasOwn(PRESETS, preset)) {
      throw badRequest('Token body.preset is unknown. Use agent, setup, or owner.');
    }
    scopes = PRESETS[preset];
  }
  if (!Array.isArray(scopes) || Array.from(scopes).some((scope) => !SCOPES.includes(scope))) {
    throw badRequest(`Token body.scopes must be an array of known scopes. Allowed: ${SCOPES.join(', ')}.`);
  }
  scopes = [...new Set(scopes)];
  const secret = `jf_${randomBytes(32).toString('base64url')}`;
  const hash = createHash('sha256').update(secret).digest('hex');
  const result = db.prepare('INSERT INTO tokens(name, scopes, hash, created_at) VALUES (?, ?, ?, ?)')
    .run(name.trim(), JSON.stringify(scopes), hash, new Date().toISOString());
  return { id: Number(result.lastInsertRowid), name: name.trim(), scopes, secret };
}

export function authenticate(db, req) {
  const header = req.headers?.authorization;
  const match = typeof header === 'string' && /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
  if (!match) return null;
  const hash = createHash('sha256').update(match[1]).digest('hex');
  const row = db.prepare('SELECT id, name, scopes, last_used_at FROM tokens WHERE hash = ? AND revoked_at IS NULL').get(hash);
  if (!row) return null;
  const now = Date.now();
  if (!row.last_used_at || now - Date.parse(row.last_used_at) >= 60_000) {
    db.prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?').run(new Date(now).toISOString(), row.id);
  }
  return { id: row.id, name: row.name, scopes: JSON.parse(row.scopes) };
}

export function hasScope(token, scope) {
  return Boolean(token?.scopes?.includes(scope));
}

export function listTokens(db) {
  return db.prepare('SELECT id, name, scopes, created_at, last_used_at, revoked_at FROM tokens ORDER BY id')
    .all().map((row) => ({ ...row, scopes: JSON.parse(row.scopes) }));
}

export function revokeToken(db, id) {
  return db.prepare('UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .run(new Date().toISOString(), id).changes > 0;
}

export function ensureOwnerToken(db, log = console) {
  if (db.prepare('SELECT 1 FROM tokens LIMIT 1').get()) return null;
  const token = createToken(db, { name: 'owner', preset: 'owner' });
  const message = `Created the initial owner token. Save this secret now; it will only be shown once: ${token.secret}`;
  if (typeof log === 'function') log(message);
  else log.log(message);
  return token;
}
