import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { check } from '../server/guard.js';
import { getApplication, listApplications } from '../server/services/applications.js';
import { seedDemo } from '../server/services/seed.js';
import { applicationInput, applicationTestServer, demoExample, fakeApplicationPdf, startApplicationServer } from './helpers.js';

async function emptyServer(t) {
  const app = await startApplicationServer({ deps: { renderPdf: fakeApplicationPdf, chrome: { bin: 'fake-chrome' } } });
  t.after(() => app.close());
  return app;
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
