import { upgradeDocument } from '../upgrade.js';

export function getProfile(db) {
  const row = db.prepare('SELECT doc, updated_at FROM profile WHERE id = 1').get();
  if (!row) return null;
  const revision = db.prepare('SELECT id FROM profile_revisions ORDER BY id DESC LIMIT 1').get();
  return {
    doc: upgradeDocument('profile', JSON.parse(row.doc)),
    revisionId: revision?.id ?? null,
    updatedAt: row.updated_at
  };
}

export function saveProfile(db, doc, tokenId) {
  const stored = upgradeDocument('profile', doc);
  const json = JSON.stringify(stored);
  const updatedAt = new Date().toISOString();
  db.exec('SAVEPOINT save_profile');
  try {
    db.prepare('INSERT INTO profile(id, doc, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at')
      .run(json, updatedAt);
    const revision = db.prepare('INSERT INTO profile_revisions(doc, created_at, token_id) VALUES (?, ?, ?)')
      .run(json, updatedAt, tokenId ?? null);
    db.exec('RELEASE save_profile');
    return { doc: stored, revisionId: Number(revision.lastInsertRowid), updatedAt };
  } catch (error) {
    db.exec('ROLLBACK TO save_profile; RELEASE save_profile');
    throw error;
  }
}

export function listRevisions(db) {
  return db.prepare(`SELECT r.id, r.created_at, t.name AS token_name
    FROM profile_revisions r LEFT JOIN tokens t ON t.id = r.token_id
    ORDER BY r.id DESC LIMIT 50`).all().map((row) => ({ ...row }));
}

export function getRevision(db, id) {
  const row = db.prepare('SELECT doc FROM profile_revisions WHERE id = ?').get(id);
  return row ? upgradeDocument('profile', JSON.parse(row.doc)) : null;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function mergePatch(target, patch) {
  if (!isObject(patch)) return structuredClone(patch);
  const result = isObject(target) ? structuredClone(target) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else Object.defineProperty(result, key, {
      value: mergePatch(Object.hasOwn(result, key) ? result[key] : undefined, value),
      enumerable: true, configurable: true, writable: true
    });
  }
  return result;
}
