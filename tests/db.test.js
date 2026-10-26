import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { APP_ROOT, loadConfig } from '../server/config.js';
import { latestSchemaVersion, migrate, openDb } from '../server/db.js';

const migrationsDir = join(APP_ROOT, 'server', 'migrations');

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'jobforge-db-'));
  const db = openDb(join(dir, 'data'));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { db, dir, backupDir: join(dir, 'backups') };
}

function extraMigrations(dir, sql) {
  const path = join(dir, 'migrations');
  mkdirSync(path);
  writeFileSync(join(path, '001_init.sql'), readFileSync(join(migrationsDir, '001_init.sql')));
  writeFileSync(join(path, '002_next.sql'), sql);
  return path;
}

test('config resolves defaults and environment settings without dependencies', () => {
  const config = loadConfig({});
  assert.equal(config.port, 8787);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.dataDir, join(process.cwd(), 'data'));
  assert.equal(config.chromeBin, '');
  assert.equal(config.docker, false);
  assert.equal(config.version, JSON.parse(readFileSync(join(APP_ROOT, 'package.json'))).version);
  const custom = loadConfig({ PORT: '0', HOST: '::1', DATA_DIR: './custom', CHROME_BIN: '/example/chrome', JOBFORGE_DOCKER: '1' });
  assert.equal(custom.port, 0);
  assert.equal(custom.host, '::1');
  assert.equal(custom.dataDir, join(process.cwd(), 'custom'));
  assert.equal(custom.chromeBin, '/example/chrome');
  assert.equal(custom.docker, true);
  for (const PORT of ['no', '-1', '65536', '1.5']) {
    assert.throws(() => loadConfig({ PORT }), /PORT/);
  }
});

test('fresh migration creates the exact schema, indexes, and UTC metadata', (t) => {
  const { db, backupDir } = fixture(t);
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(latestSchemaVersion(migrationsDir), 1);
  assert.deepEqual(migrate(db, { dir: migrationsDir, backupDir }), { from: 0, to: 1, backup: null });
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '1');
  assert.match(db.prepare("SELECT value FROM meta WHERE key = 'created_at'").get().value, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
  assert.deepEqual(tables, ['application_events', 'applications', 'meta', 'profile', 'profile_revisions', 'template_versions', 'templates', 'tokens', 'tracks']);
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((row) => row.name);
  for (const name of ['applications_url', 'applications_status', 'applications_company_norm', 'applications_track_id', 'application_events_application_id']) {
    assert.ok(indexes.includes(name), name);
  }
  assert.throws(() => db.prepare('INSERT INTO profile(id) VALUES (2)').run(), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO templates(id, kind) VALUES ('custom-example', 'invalid')").run(), /CHECK/);
  db.exec("INSERT INTO applications(vacancy_url_norm) VALUES (''), (''), ('https://example.com/job')");
  assert.throws(() => db.exec("INSERT INTO applications(vacancy_url_norm) VALUES ('https://example.com/job')"), /UNIQUE/);
});

test('migration rerun is idempotent and does not create a backup', (t) => {
  const { db, backupDir } = fixture(t);
  migrate(db, { dir: migrationsDir, backupDir });
  const before = db.prepare('SELECT * FROM meta ORDER BY key').all();
  assert.deepEqual(migrate(db, { dir: migrationsDir, backupDir }), { from: 1, to: 1, backup: null });
  assert.deepEqual(db.prepare('SELECT * FROM meta ORDER BY key').all(), before);
});

test('pending migration backs up WAL data before changing the populated database', (t) => {
  const { db, dir, backupDir } = fixture(t);
  migrate(db, { dir: migrationsDir, backupDir });
  db.prepare('INSERT INTO profile(id, doc, updated_at) VALUES (1, ?, ?)').run('{"identity":{"name":"Alex Example"}}', new Date().toISOString());
  const nextDir = extraMigrations(dir, 'ALTER TABLE profile ADD COLUMN note TEXT;');
  const messages = [];
  const result = migrate(db, { dir: nextDir, backupDir, log: (message) => messages.push(message) });
  assert.equal(result.from, 1);
  assert.equal(result.to, 2);
  assert.match(result.backup, /jobforge-v1-.*Z\.db$/);
  assert.equal(readdirSync(backupDir).length, 1);
  assert.ok(messages[0].includes(result.backup));
  const backup = new DatabaseSync(result.backup, { readOnly: true });
  try {
    assert.equal(backup.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '1');
    assert.equal(backup.prepare('SELECT doc FROM profile').get().doc, db.prepare('SELECT doc FROM profile').get().doc);
    assert.equal(backup.prepare('PRAGMA table_info(profile)').all().some((column) => column.name === 'note'), false);
    assert.equal(db.prepare('PRAGMA table_info(profile)').all().some((column) => column.name === 'note'), true);
  } finally {
    backup.close();
  }
});

test('database newer than the code is refused without changing its version', (t) => {
  const { db, backupDir } = fixture(t);
  migrate(db, { dir: migrationsDir, backupDir });
  db.exec("UPDATE meta SET value = '99' WHERE key = 'schema_version'");
  assert.throws(() => migrate(db, { dir: migrationsDir, backupDir }), /99.*newer.*1.*Upgrade/);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '99');
});

test('failing migration rolls back all changes and preserves data and schema version', (t) => {
  const { db, dir, backupDir } = fixture(t);
  migrate(db, { dir: migrationsDir, backupDir });
  db.exec("INSERT INTO tracks(id, doc) VALUES ('example', '{}')");
  const nextDir = extraMigrations(dir, "CREATE TABLE temporary_change(id INTEGER); UPDATE tracks SET doc = 'changed'; THIS IS BROKEN;");
  assert.throws(() => migrate(db, { dir: nextDir, backupDir, log() {} }), /002_next.sql.*rolled back/);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '1');
  assert.equal(db.prepare("SELECT doc FROM tracks WHERE id = 'example'").get().doc, '{}');
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'temporary_change'").get(), undefined);
  assert.equal(readdirSync(backupDir).length, 1);
});

test('migration files are applied in numeric order and unrelated files are ignored', (t) => {
  const { db, dir, backupDir } = fixture(t);
  const nextDir = extraMigrations(dir, 'CREATE TABLE ordered(value INTEGER); INSERT INTO ordered VALUES (2);');
  writeFileSync(join(nextDir, '010_last.sql'), 'INSERT INTO ordered VALUES (10);');
  writeFileSync(join(nextDir, '003_middle.sql'), 'INSERT INTO ordered VALUES (3);');
  writeFileSync(join(nextDir, 'notes.sql'), 'BROKEN');
  assert.equal(latestSchemaVersion(nextDir), 10);
  assert.deepEqual(migrate(db, { dir: nextDir, backupDir }), { from: 0, to: 10, backup: null });
  assert.deepEqual(db.prepare('SELECT value FROM ordered ORDER BY rowid').all().map((row) => row.value), [2, 3, 10]);
});
