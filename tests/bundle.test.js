import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { exportBundle, importBundle } from '../server/services/bundle.js';
import { applicationInput, applicationTestServer, demoExample, fakeApplicationPdf, startApplicationServer } from './helpers.js';

async function emptyServer(t, deps = {}) {
  const app = await startApplicationServer({ deps: { renderPdf: fakeApplicationPdf, chrome: { bin: 'fake-chrome' }, ...deps } });
  t.after(() => app.close());
  return app;
}

function comparable(bundle) {
  const { exported_at, ...rest } = bundle;
  return rest;
}

test('export and import roundtrip preserves ids, all document content, template versions and events without tokens or PDFs', async (t) => {
  const source = await applicationTestServer(t);
  await source.api('PUT', '/api/v1/profile', demoExample('profile'));
  const tracks = demoExample('tracks');
  for (const [id, track] of Object.entries(tracks)) assert.equal((await source.api('PUT', `/api/v1/tracks/${id}`, track)).status, 201);
  const classic = (await source.api('GET', '/api/v1/templates/classic')).body;
  await source.api('PUT', '/api/v1/templates/custom-bundle', classic);
  const input = applicationInput();
  input.resume.template = 'custom-bundle';
  const first = (await source.api('POST', '/api/v1/applications', input)).body;
  await source.api('POST', `/api/v1/applications/${first.id}/status`, { status: 'sent', note: 'Sent demo documents.' });
  await source.api('PUT', '/api/v1/templates/custom-bundle', { ...classic, source: `${classic.source}\n<!-- version two -->` });
  const second = (await source.api('POST', '/api/v1/applications', applicationInput(2, { verdict: 'skip' }))).body;
  const response = await source.api('GET', '/api/v1/export');
  assert.equal(response.status, 200);
  const bundle = response.body;
  assert.equal(bundle.bundle_version, 1);
  assert.equal(Object.hasOwn(bundle, 'tokens'), false);
  assert.equal(Object.hasOwn(bundle, 'files'), false);
  assert.equal(bundle.templates.length, 1);
  assert.equal(bundle.templates[0].versions.length, 2);
  assert.equal(bundle.applications[0].resume_template, 'custom-bundle@1');
  assert.equal(bundle.applications[0].resume_content.schema_version, 1);
  assert.equal(bundle.profile_revisions.length, 2);
  const destination = await emptyServer(t);
  const ownerCount = destination.db.prepare('SELECT COUNT(*) AS n FROM tokens').get().n;
  const imported = await destination.api('POST', '/api/v1/import', bundle);
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  assert.deepEqual(imported.body.rendered, [first.id]);
  assert.deepEqual(imported.body.render_errors, []);
  assert.equal(imported.body.imported, 2);
  const restored = (await destination.api('GET', '/api/v1/export')).body;
  assert.deepEqual(comparable(restored), comparable(bundle));
  assert.equal(destination.db.prepare('SELECT COUNT(*) AS n FROM tokens').get().n, ownerCount);
  const application = (await destination.api('GET', `/api/v1/applications/${first.id}`)).body;
  assert.equal(application.status, 'sent');
  assert.equal(application.resume_template, 'custom-bundle@1');
  assert.ok(application.files.resume_pdf);
  assert.equal(application.same_company[0].id, second.id);
  assert.equal((await destination.api('GET', application.files.resume_html, undefined, { raw: true })).status, 200);
  const third = await destination.api('POST', '/api/v1/applications', applicationInput(3));
  assert.equal(third.body.id, second.id + 1);
});

test('import preserves nonsequential application and event ids', async (t) => {
  const source = await applicationTestServer(t);
  const first = (await source.api('POST', '/api/v1/applications', applicationInput())).body;
  const second = (await source.api('POST', '/api/v1/applications', applicationInput(2))).body;
  await source.api('DELETE', `/api/v1/applications/${first.id}`);
  const bundle = exportBundle(source.db);
  const destination = await emptyServer(t);
  await importBundle(destination.db, bundle, { dataDir: destination.dataDir, chrome: { bin: '' } });
  assert.equal(exportBundle(destination.db).applications[0].id, second.id);
  assert.equal(exportBundle(destination.db).events[0].id, bundle.events[0].id);
});

test('export and import require admin scope and imported data never overwrites an existing instance', async (t) => {
  const source = await applicationTestServer(t);
  const bundle = exportBundle(source.db);
  const agent = source.makeToken('agent');
  assert.equal((await source.api('GET', '/api/v1/export', undefined, { token: agent })).status, 403);
  assert.equal((await source.api('POST', '/api/v1/import', bundle, { token: agent })).status, 403);
  const response = await source.api('POST', '/api/v1/import', bundle);
  assert.equal(response.status, 409);
  assert.match(response.body.error.message, /fresh DATA_DIR/);
  assert.deepEqual(exportBundle(source.db).profile, bundle.profile);
});

test('tracks, custom templates and applications independently prevent import', async (t) => {
  const fixture = await emptyServer(t);
  const bundle = exportBundle(fixture.db);
  for (const sql of [
    "INSERT INTO tracks(id, doc) VALUES ('demo', '{}')",
    "INSERT INTO templates(id, kind, current_version) VALUES ('custom-demo', 'resume', 1)",
    "INSERT INTO applications(id, status) VALUES (1, 'draft')"
  ]) {
    const app = await emptyServer(t);
    app.db.exec(sql);
    assert.equal((await app.api('POST', '/api/v1/import', bundle)).status, 409);
  }
});

test('unknown bundle versions and malformed shapes return 422 with upgrade instructions', async (t) => {
  const app = await emptyServer(t);
  for (const value of [null, {}, { bundle_version: 2 }, { bundle_version: '1' }]) {
    const response = await app.api('POST', '/api/v1/import', value);
    assert.equal(response.status, 422);
    assert.match(response.body.error.message, /Update the JobForge server/);
  }
  assert.equal((await app.api('POST', '/api/v1/import', { bundle_version: 1 })).status, 422);
});

test('import upgrades unversioned documents including track bases and application covers', async (t) => {
  const source = await applicationTestServer(t);
  await source.api('PUT', '/api/v1/tracks/unity-developer', demoExample('tracks')['unity-developer']);
  await source.api('POST', '/api/v1/applications', applicationInput());
  const bundle = exportBundle(source.db);
  delete bundle.profile.schema_version;
  for (const revision of bundle.profile_revisions) delete revision.doc.schema_version;
  delete bundle.tracks['unity-developer'].schema_version;
  delete bundle.tracks['unity-developer'].base.schema_version;
  delete bundle.applications[0].resume_content.schema_version;
  delete bundle.applications[0].cover_content.schema_version;
  const destination = await emptyServer(t);
  assert.equal((await destination.api('POST', '/api/v1/import', bundle)).status, 200);
  const restored = exportBundle(destination.db);
  assert.equal(restored.profile.schema_version, 1);
  assert.equal(restored.profile_revisions[0].doc.schema_version, 1);
  assert.equal(restored.tracks['unity-developer'].base.schema_version, 1);
  assert.equal(restored.applications[0].resume_content.schema_version, 1);
  assert.equal(restored.applications[0].cover_content.schema_version, 1);
});

test('a bad document or duplicate row rolls back the entire import transaction', async (t) => {
  const source = await applicationTestServer(t);
  await source.api('POST', '/api/v1/applications', applicationInput());
  const original = exportBundle(source.db);
  for (const mutate of [
    (bundle) => { bundle.applications[0].resume_content.schema_version = 999; },
    (bundle) => { bundle.applications.push(structuredClone(bundle.applications[0])); },
    (bundle) => { bundle.events[0].application_id = 999; }
  ]) {
    const destination = await emptyServer(t);
    const bundle = structuredClone(original);
    mutate(bundle);
    const result = await destination.api('POST', '/api/v1/import', bundle);
    assert.equal(result.status, 422, JSON.stringify(result));
    for (const table of ['profile', 'profile_revisions', 'applications', 'application_events']) assert.equal(destination.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  }
});

test('import commits documents without Chrome and collects best effort renderer failures', async (t) => {
  const source = await applicationTestServer(t);
  await source.api('POST', '/api/v1/applications', applicationInput());
  const bundle = exportBundle(source.db);
  const missing = await emptyServer(t, { chrome: { bin: '' } });
  const absent = await missing.api('POST', '/api/v1/import', bundle);
  assert.equal(absent.status, 200);
  assert.deepEqual(absent.body.rendered, []);
  assert.match(absent.body.render_errors[0].message, /Chrome is unavailable/);
  assert.equal(exportBundle(missing.db).applications.length, 1);
  const failure = await emptyServer(t, { renderPdf: async () => { throw new Error('Fake Chrome failure'); } });
  const failed = await failure.api('POST', '/api/v1/import', bundle);
  assert.equal(failed.status, 200);
  assert.match(failed.body.render_errors[0].message, /Fake Chrome failure/);
  assert.equal(exportBundle(failure.db).applications.length, 1);
});

test('CLI export writes only JSON to stdout or --out, and import reads --file', async (t) => {
  const source = await applicationTestServer(t);
  const run = (args, dataDir) => spawnSync(process.execPath, ['server/cli.js', ...args], { encoding: 'utf8', env: { ...process.env, DATA_DIR: dataDir }, timeout: 3000 });
  const stdout = run(['export'], source.dataDir);
  assert.equal(stdout.status, 0, stdout.stderr);
  assert.deepEqual(JSON.parse(stdout.stdout).profile, demoExample('profile'));
  const path = join(source.dataDir, 'bundle.json');
  const saved = run(['export', '--out', path], source.dataDir);
  assert.equal(saved.status, 0, saved.stderr);
  assert.equal(saved.stdout, '');
  const destination = await emptyServer(t);
  const imported = run(['import', '--file', path], destination.dataDir);
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(JSON.parse(imported.stdout).ok, true);
  assert.deepEqual(exportBundle(destination.db).profile, demoExample('profile'));
  const refused = run(['import', '--file', path], destination.dataDir);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /empty instance/);
  writeFileSync(path, '{invalid');
  const malformed = run(['import', '--file', path], source.dataDir);
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /Cannot read import JSON/);
  assert.ok(readFileSync(path, 'utf8'));
});
