import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authenticate, createToken, ensureOwnerToken, PRESETS } from '../server/auth.js';
import { migrate, openDb } from '../server/db.js';
import { check } from '../server/guard.js';
import { getApplication, listApplications } from '../server/services/applications.js';
import { seedDemo } from '../server/services/seed.js';
import { applicationInput, applicationTestServer, demoExample, fakeApplicationPdf, startApplicationServer } from './helpers.js';

async function emptyServer(t) {
  const app = await startApplicationServer({ deps: { renderPdf: fakeApplicationPdf, chrome: { bin: 'fake-chrome' } } });
  t.after(() => app.close());
  return app;
}

function emptyStore(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'jobforge-seed-store-'));
  const db = openDb(dataDir);
  migrate(db);
  t.after(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { db, dataDir };
}

test('demo seed uses the pipeline for six factual applications across all tracks and the expected statuses', async (t) => {
  const app = await emptyServer(t);
  let renders = 0;
  const result = await seedDemo(app.db, { dataDir: app.dataDir, deps: { renderPdf: async (input) => { renders++; return fakeApplicationPdf(input); } } });
  assert.equal(result.created.length, 6);
  assert.equal(renders, 10);
  const listing = listApplications(app.db);
  assert.deepEqual(listing.counts, { draft: 2, needs_review: 1, approved: 1, sent: 1, interview: 0, offer: 0, rejected: 0, skipped: 1 });
  const profile = demoExample('profile');
  assert.deepEqual(JSON.parse(app.db.prepare('SELECT doc FROM profile').get().doc), profile);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n, 3);
  const trackIds = new Set();
  for (const { id } of listing.items) {
    const application = getApplication(app.db, id, { dataDir: app.dataDir });
    trackIds.add(application.track_id);
    const words = application.vacancy.text.split(/\s+/u).length;
    assert.ok(words >= 100 && words <= 160, `${words} vacancy words`);
    assert.match(application.vacancy.url, /^https:\/\/example\.com\//);
    assert.equal(application.profile_revision_id, 1);
    assert.ok(application.created_by_token_id);
    assert.equal(application.events[0].status, application.verdict === 'skip' ? 'skipped' : 'draft');
    if (application.verdict === 'skip') {
      assert.equal(application.resume, null);
      assert.equal(application.cover, null);
      assert.equal(application.files.resume_pdf, null);
      assert.equal(existsSync(join(app.dataDir, 'files', String(id), 'resume.pdf')), false);
      continue;
    }
    assert.ok(application.files.resume_pdf);
    assert.ok(application.files.cover_pdf);
    assert.ok(application.cover.content.text.split(/\s+/u).length <= profile.rules.cover_max_words);
    assert.match(application.cover.content.text, /^I /);
    assert.deepEqual(check({ content: application.resume.content, cover: application.cover.content, profile }).errors, []);
    const base = demoExample('tracks')[application.track_id].base;
    for (const entry of application.resume.content.experience) {
      const original = base.experience.find(({ company }) => company === entry.company);
      assert.equal(entry.dates, original.dates);
      for (const bullet of entry.bullets) assert.ok(original.bullets.includes(bullet));
    }
    if (application.status === 'needs_review') {
      assert.ok(application.warnings.some(({ code }) => code === 'number_not_in_profile'));
      assert.match(application.events.at(-1).note, /45 minute/);
    }
    if (application.company === 'Orbit Games') assert.equal(application.same_company.length, 1);
  }
  assert.equal(trackIds.size, 3);
});

test('demo seed refuses existing applications even with force and leaves data untouched', async (t) => {
  const app = await applicationTestServer(t);
  await app.api('POST', '/api/v1/applications', applicationInput());
  const before = app.db.prepare('SELECT * FROM applications').all();
  for (const force of [false, true]) {
    await assert.rejects(seedDemo(app.db, { dataDir: app.dataDir, force, deps: { renderPdf: fakeApplicationPdf } }), (error) => error.status === 409 && /fresh DATA_DIR/.test(error.message));
  }
  assert.deepEqual(app.db.prepare('SELECT * FROM applications').all(), before);
});

test('demo seed requires Chrome unless a fake renderer is explicitly injected', async (t) => {
  const app = await emptyServer(t);
  await assert.rejects(seedDemo(app.db, { dataDir: app.dataDir, chrome: { bin: '' } }), (error) => error.code === 'render_failed' && /CHROME_BIN/.test(error.message));
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM profile').get().n, 0);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM applications').get().n, 0);
});

test('a seed rendering failure rolls back profile, tracks, applications, events and generated files', async (t) => {
  const app = await emptyServer(t);
  let calls = 0;
  await assert.rejects(seedDemo(app.db, { dataDir: app.dataDir, deps: { renderPdf: async (input) => {
    calls++;
    if (calls === 4) throw new Error('Injected seed render failure');
    return fakeApplicationPdf(input);
  } } }), /Injected seed render failure/);
  for (const table of ['profile', 'profile_revisions', 'tracks', 'applications', 'application_events']) assert.equal(app.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  assert.equal(existsSync(join(app.dataDir, 'files', '1')), false);
});

for (const [table, sql] of [
  ['profile', "INSERT INTO profile(id, doc) VALUES (1, '{\"about\":\"User data\"}')"],
  ['profile_revisions', "INSERT INTO profile_revisions(doc) VALUES ('{\"about\":\"User history\"}')"],
  ['tracks', "INSERT INTO tracks(id, doc) VALUES ('unity-developer', '{\"notes\":\"User track\"}')"],
  ['templates', "INSERT INTO templates(id, kind, current_version) VALUES ('custom-user', 'resume', 1)"],
  ['template_versions', "INSERT INTO template_versions(template_id, version, source) VALUES ('custom-user', 1, 'User template')"],
  ['applications', "INSERT INTO applications(id, status) VALUES (1, 'draft')"],
  ['application_events', "INSERT INTO application_events(application_id, status) VALUES (1, 'draft')"]
]) {
  test(`demo seed refuses existing ${table} with and without force, preserving every table`, async (t) => {
    const app = emptyStore(t);
    createToken(app.db, { name: 'Existing agent', preset: 'agent' });
    app.db.exec(sql);
    const tables = ['tokens', 'profile', 'profile_revisions', 'tracks', 'templates', 'template_versions', 'applications', 'application_events'];
    const snapshot = () => Object.fromEntries(tables.map((name) => [name, app.db.prepare(`SELECT * FROM ${name}`).all()]));
    const before = snapshot();
    for (const force of [false, true]) {
      await assert.rejects(seedDemo(app.db, { dataDir: app.dataDir, force, deps: { renderPdf: fakeApplicationPdf } }), (error) => {
        assert.equal(error.status, 409);
        assert.match(error.message, new RegExp(`${table} contains data`));
        assert.match(error.message, /never overwrites or deletes user data/);
        return true;
      });
      assert.deepEqual(snapshot(), before);
      assert.equal(existsSync(join(app.dataDir, 'files')), false);
    }
  });
}

test('fresh seed returns one usable owner secret, stores only its hash, and accepts preexisting tokens', async (t) => {
  const app = emptyStore(t);
  const agent = createToken(app.db, { name: 'Existing agent', preset: 'agent' });
  const result = await seedDemo(app.db, { dataDir: app.dataDir, deps: { renderPdf: fakeApplicationPdf } });
  assert.match(result.owner_token, /^jf_[A-Za-z0-9_-]{43}$/u);
  const owner = authenticate(app.db, { headers: { authorization: `Bearer ${result.owner_token}` } });
  assert.deepEqual(owner.scopes, PRESETS.owner);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM tokens').get().n, 2);
  assert.ok(authenticate(app.db, { headers: { authorization: `Bearer ${agent.secret}` } }));
  assert.equal(JSON.stringify(app.db.prepare('SELECT * FROM tokens').all()).includes(result.owner_token), false);
  const logs = [];
  assert.equal(ensureOwnerToken(app.db, (message) => logs.push(message)), null);
  assert.deepEqual(logs, []);
});

test('seed reuses an active owner-capable token and creates none or reveals no existing secret', async (t) => {
  const app = emptyStore(t);
  const owner = createToken(app.db, { name: 'Existing owner', preset: 'owner' });
  const before = app.db.prepare('SELECT * FROM tokens').all();
  const result = await seedDemo(app.db, { dataDir: app.dataDir, deps: { renderPdf: fakeApplicationPdf } });
  assert.equal(Object.hasOwn(result, 'owner_token'), false);
  assert.deepEqual(app.db.prepare('SELECT * FROM tokens').all(), before);
  for (const row of app.db.prepare('SELECT created_by_token_id FROM applications').all()) assert.equal(row.created_by_token_id, owner.id);
});

test('failed fresh seed rolls back its new owner token as well as all content and PDFs', async (t) => {
  const app = emptyStore(t);
  let calls = 0;
  await assert.rejects(seedDemo(app.db, { dataDir: app.dataDir, deps: { renderPdf: async (input) => {
    if (++calls === 4) throw new Error('Injected fresh seed failure');
    return fakeApplicationPdf(input);
  } } }), /Injected fresh seed failure/);
  for (const table of ['tokens', 'profile', 'profile_revisions', 'tracks', 'applications', 'application_events']) {
    assert.equal(app.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
  }
  assert.equal(existsSync(join(app.dataDir, 'files', '1')), false);
  assert.equal(existsSync(join(app.dataDir, 'files', '1.new')), false);
});

test('seed CLI prints the initial owner message and secret exactly once after a successful seed', (t) => {
  const app = emptyStore(t);
  const code = `
    import { main } from './server/cli.js';
    import { fakeApplicationPdf } from './tests/helpers.js';
    process.exitCode = await main(['seed-demo'], { deps: { renderPdf: fakeApplicationPdf } });
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8', env: { ...process.env, DATA_DIR: app.dataDir }, timeout: 5000
  });
  assert.equal(result.status, 0, result.stderr);
  const secrets = result.stdout.match(/jf_[A-Za-z0-9_-]{43}/gu);
  assert.equal(secrets?.length, 1);
  assert.ok(result.stdout.includes(`Created the initial owner token. Save this secret now; it will only be shown once: ${secrets[0]}`));
  const summary = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(summary.ok, true);
  assert.equal(Object.hasOwn(summary, 'owner_token'), false);
  const owner = authenticate(app.db, { headers: { authorization: `Bearer ${secrets[0]}` } });
  assert.deepEqual(owner.scopes, PRESETS.owner);
});
