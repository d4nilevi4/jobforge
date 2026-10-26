import { ApiError } from '../errors.js';
import { upgradeDocument } from '../upgrade.js';

export function upgradeTrackDocument(doc) {
  const upgraded = upgradeDocument('track', doc);
  if (Object.hasOwn(upgraded, 'base')) {
    try {
      upgraded.base = upgradeDocument('content', upgraded.base);
    } catch (error) {
      if (error instanceof ApiError) {
        error.details = error.details.map((issue) => ({ ...issue, path: issue.path ? `base.${issue.path}` : 'base' }));
      }
      throw error;
    }
  }
  return upgraded;
}

function fromRow(row) {
  return row ? {
    id: row.id,
    doc: upgradeTrackDocument(JSON.parse(row.doc)),
    updatedAt: row.updated_at
  } : null;
}

export function listTracks(db) {
  return db.prepare('SELECT id, doc, updated_at FROM tracks ORDER BY id').all().map(fromRow);
}

export function getTrack(db, id) {
  return fromRow(db.prepare('SELECT id, doc, updated_at FROM tracks WHERE id = ?').get(id));
}

export function saveTrack(db, id, doc) {
  const stored = upgradeTrackDocument(doc);
  const updatedAt = new Date().toISOString();
  db.prepare(`INSERT INTO tracks(id, doc, created_at, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at`)
    .run(id, JSON.stringify(stored), updatedAt, updatedAt);
  return { id, doc: stored, updatedAt };
}

export function deleteTrack(db, id) {
  return db.prepare('DELETE FROM tracks WHERE id = ?').run(id).changes > 0;
}
