import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { APP_ROOT } from './config.js';

function migrationFiles(dir) {
  const files = readdirSync(dir)
    .filter((name) => /^\d{3}_.+\.sql$/.test(name))
    .map((name) => ({ name, version: Number(name.slice(0, 3)) }))
    .sort((a, b) => a.version - b.version);
  const versions = new Set();
  for (const file of files) {
    if (file.version === 0 || versions.has(file.version)) {
      throw new Error(`Invalid migration ${join(dir, file.name)}. Use a unique version starting at 001.`);
    }
    versions.add(file.version);
  }
  return files;
}

function schemaVersion(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get()) {
    return 0;
  }
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  const version = row ? Number(row.value) : 0;
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error('Invalid meta.schema_version in jobforge.db. Restore a valid database backup.');
  }
  return version;
}

export function openDb(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'jobforge.db'));
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function latestSchemaVersion(dir = join(APP_ROOT, 'server', 'migrations')) {
  return migrationFiles(dir).at(-1)?.version ?? 0;
}

export function migrate(db, {
  dir = join(APP_ROOT, 'server', 'migrations'),
  backupDir,
  log = console,
} = {}) {
  const files = migrationFiles(dir);
  const from = schemaVersion(db);
  const to = files.at(-1)?.version ?? 0;
  if (from > to) {
    throw new Error(`Database schema version ${from} is newer than code version ${to}. Upgrade JobForge to matching code; downgrades are not supported.`);
  }
  const pending = files.filter((file) => file.version > from);
  let backup = null;
  if (pending.length && from > 0) {
    if (!backupDir) {
      throw new Error('Missing backupDir for database migration. Provide a backup directory before upgrading.');
    }
    mkdirSync(backupDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    backup = join(backupDir, `jobforge-v${from}-${timestamp}.db`);
    db.prepare('VACUUM INTO ?').run(backup);
    const message = `Database backup saved before migration: ${backup}`;
    if (typeof log === 'function') log(message);
    else log.log(message);
  }
  for (const file of pending) {
    const sql = readFileSync(join(dir, file.name), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(String(file.version));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${file.name} failed and was rolled back. Fix the migration before restarting: ${error.message}`, { cause: error });
    }
  }
  return { from, to, backup };
}
