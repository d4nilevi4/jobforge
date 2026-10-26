import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeCompany, normalizeUrl } from '../server/services/applications.js';
import { applicationInput, applicationTestServer, fakeApplicationPdf, startApplicationServer } from './helpers.js';

const root = '/api/v1/applications';

for (const [value, expected] of [
  [undefined, ''], ['', ''], ['not a url', ''], ['file:///tmp/job', ''], ['https://alex@example.com/job', ''],
  ['https://www.Example.com/job/1/?utm_source=x#top', 'https://example.com/job/1'],
  ['HTTPS://WWW.EXAMPLE.COM:443/job/?b=2&a=1&gclid=x&fbclid=y&ref=z&ref_src=q&utm_MEDIUM=a', 'https://example.com/job?a=1&b=2'],
  ['https://example.com/job?source=vacancy-1', 'https://example.com/job?source=vacancy-1'],
  ['http://www.example.com/', 'http://example.com'], ['https://example.com/job/?x=1&x=2#part', 'https://example.com/job?x=1&x=2']
]) {
  test(`normalizeUrl: ${String(value)}`, () => assert.equal(normalizeUrl(value), expected));
}

for (const [value, expected] of [
  [undefined, ''], ['', ''], ['NDA', ''], ['Hidden LLC', ''], ['Unknown', ''], ['Скрыто', ''], ['Компания скрыта', ''],
  ['Orbit Games, Inc.', 'orbitgames'], ['Ｏｒｂｉｔ Games LLC', 'orbitgames'], ['ООО «Ёлка»', 'елка'],
  ['ПАО Компания', 'компания'], ['Harbor Labs GmbH', 'harborlabs'], ['Alpha-Beta Ltd', 'alphabeta'],
  ['Incubator', 'incubator'], ['LLC', '']
]) {
  test(`normalizeCompany: ${String(value)}`, () => assert.equal(normalizeCompany(value), expected));
}

test('check merges request schema, document schema, guard, and both overflows without storing', async (t) => {
  const app = await applicationTestServer(t, { deps: { renderPdf: async (input) => ({ ...await fakeApplicationPdf(input), pages: 3 }) } });
  const input = applicationInput();
  input.score = 2;
  delete input.resume.content.headline;
  input.resume.content.experience[0].company = 'Invented Employer';
  input.cover.content.text = 'I am a rockstar.';
  const result = await app.api('POST', '/api/v1/check', input);
  assert.equal(result.status, 422);
  assert.equal(result.body.error.code, 'validation_failed');
  const issues = result.body.error.details;
  for (const [path, code] of [['score', 'maximum'], ['resume.content.headline', 'required'], ['resume.content.experience[0].company', 'unknown_employer'], ['cover.content.text', 'forbidden_pattern'], ['resume.content', 'page_overflow'], ['cover.content', 'page_overflow']]) {
    assert.ok(issues.some((issue) => issue.path === path && issue.code === code), JSON.stringify(issues));
  }
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM applications').get().n, 0);
  assert.equal(existsSync(join(app.dataDir, 'files')), false);
});

test('check can skip rendering, preserves warnings, and reports duplicate and same company', async (t) => {
  let renders = 0;
  const app = await applicationTestServer(t, { deps: { renderPdf: async (input) => { renders++; return fakeApplicationPdf(input); } } });
  const input = applicationInput();
  input.resume.content.experience[0].bullets.push('I propose a 47 minute planning discussion.');
  const created = await app.api('POST', root, input);
  assert.equal(created.status, 201);
  assert.equal(created.body.warnings[0].code, 'number_not_in_profile');
  const check = await app.api('POST', '/api/v1/check?render=0', input);
  assert.equal(check.status, 200);
  assert.equal(Object.hasOwn(check.body, 'pages'), false);
  assert.deepEqual(check.body.duplicate, { existing_id: created.body.id, status: 'draft' });
  assert.equal(check.body.same_company.length, 1);
  assert.equal(renders, 2);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM applications').get().n, 1);
});

test('missing profile and malformed documents produce actionable 422 errors', async (t) => {
  const empty = await startApplicationServer({ deps: { renderPdf: fakeApplicationPdf } });
  t.after(() => empty.close());
  assert.equal((await empty.api('POST', root, applicationInput())).body.error.code, 'profile_missing');
  const app = await applicationTestServer(t);
  for (const body of [null, 'invalid', [], {}, { vacancy: { text: '' }, cover: { template: 'letter', content: { text: 'hello' } } }]) {
    const response = await app.api('POST', root, body);
    assert.equal(response.status, 422, JSON.stringify(response));
  }
  const input = applicationInput();
  input.resume.content = { schema_version: 999 };
  input.cover.content = { schema_version: 999 };
  input.resume.template = 'letter';
  input.cover.template = 'missing';
  const response = await app.api('POST', root, input);
  assert.equal(response.status, 422);
  for (const path of ['resume.content.schema_version', 'cover.content.schema_version', 'resume.template', 'cover.template']) assert.ok(response.body.error.details.some((issue) => issue.path === path));
  assert.match(response.body.error.details.find((issue) => issue.path === 'resume.template').message, /classic/);
});

test('page overflow alone is render_failed and failed rendering writes nothing', async (t) => {
  const app = await applicationTestServer(t, { deps: { renderPdf: async (input) => ({ ...await fakeApplicationPdf(input), pages: 2 }) } });
  const result = await app.api('POST', root, applicationInput());
  assert.equal(result.status, 422);
  assert.equal(result.body.error.code, 'render_failed');
  assert.match(result.body.error.details[0].message, /Resume is 2 pages; template "classic" allows 1/);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM applications').get().n, 0);
});

test('create detects URL variants, normalizes language and company, and exposes events and full details', async (t) => {
  const app = await applicationTestServer(t);
  const input = applicationInput();
  input.vacancy.url = 'https://www.Example.com/job/1/?utm_source=x#top';
  input.vacancy.language = 'EN';
  input.resume.content.language = 'ru';
  const first = await app.api('POST', root, input);
  assert.equal(first.status, 201);
  assert.equal(first.body.status, 'draft');
  assert.equal(first.body.language, 'en');
  assert.equal(first.body.resume.content.language, 'en');
  assert.equal(first.body.profile_revision_id, 1);
  assert.equal(first.body.events[0].status, 'draft');
  assert.equal(first.body.events[0].token_id, first.body.created_by_token_id);
  assert.equal(first.body.resume.template, 'classic@1');
  assert.ok(first.body.files.resume_pdf);
  input.vacancy.url = 'https://example.com/job/1';
  const duplicate = await app.api('POST', root, input);
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.details[0].existing_id, first.body.id);
  assert.match(duplicate.body.error.details[0].message, /Use PUT/);
  input.vacancy.url = 'https://example.com/job/2';
  input.vacancy.company = 'Orbit Games LLC';
  const second = await app.api('POST', root, input);
  assert.equal(second.status, 201);
  assert.equal(second.body.same_company[0].id, first.body.id);
  const detail = await app.api('GET', `${root}/${first.body.id}`);
  assert.deepEqual(detail.body.vacancy, first.body.vacancy);
  assert.equal(detail.body.same_company[0].id, second.body.id);
  assert.equal((await app.api('GET', `${root}/999`)).status, 404);
  assert.equal((await app.api('GET', `${root}/0`)).status, 400);
});

test('anonymous companies never match and skip ignores documents without rendering', async (t) => {
  let renders = 0;
  const app = await applicationTestServer(t, { deps: { renderPdf: async (input) => { renders++; return fakeApplicationPdf(input); } } });
  for (const number of [1, 2]) {
    const input = applicationInput(number, { verdict: 'skip', resume: 'ignored', cover: false });
    input.vacancy.company = 'NDA';
    const response = await app.api('POST', root, input);
    assert.equal(response.status, 201);
    assert.equal(response.body.status, 'skipped');
    assert.equal(response.body.resume, null);
    assert.equal(response.body.files.resume_pdf, null);
    assert.deepEqual(response.body.same_company, []);
  }
  assert.equal(renders, 0);
});

test('listing filters, counts, sorting and pagination include required summaries', async (t) => {
  const app = await applicationTestServer(t);
  const one = (await app.api('POST', root, applicationInput(1))).body;
  const two = (await app.api('POST', root, applicationInput(2, { verdict: 'maybe', notes: 'Recruiter question', track_id: 'go-backend' }))).body;
  const third = applicationInput(3, { verdict: 'skip' });
  third.vacancy.company = 'Ledgerly';
  third.vacancy.source = 'hirify';
  await app.api('POST', root, third);
  await app.api('POST', `${root}/${two.id}/status`, { status: 'needs_review' });
  const filtered = (await app.api('GET', `${root}?status=draft&company=Orbit%20Games%20Inc`)).body;
  assert.equal(filtered.total, 1);
  assert.equal(filtered.items[0].id, one.id);
  assert.equal(filtered.counts.draft, 1);
  assert.equal(filtered.counts.needs_review, 1);
  assert.equal(filtered.counts.skipped, 0);
  assert.equal(filtered.items[0].same_company_count, 1);
  assert.equal(filtered.items[0].has_resume, true);
  assert.equal((await app.api('GET', `${root}?q=RECRUITER&track=go-backend&verdict=maybe`)).body.total, 1);
  assert.equal((await app.api('GET', `${root}?q=HIRIFY`)).body.total, 1);
  assert.equal((await app.api('GET', `${root}?q=UNITY`)).body.total, 3);
  const listed = (await app.api('GET', `${root}?limit=1&offset=1`)).body;
  assert.equal(listed.total, 3);
  assert.equal(listed.items.length, 1);
  const expected = app.db.prepare('SELECT id FROM applications ORDER BY updated_at DESC, id DESC LIMIT 1 OFFSET 1').get();
  assert.equal(listed.items[0].id, expected.id);
  for (const suffix of ['limit=-1', 'offset=x', 'status=other', 'verdict=no']) assert.equal((await app.api('GET', `${root}?${suffix}`)).status, 400);
  assert.equal((await app.api('GET', `${root}?limit=500`)).status, 200);
});

test('agents follow the graph, approve scope is required, and owners may choose any status', async (t) => {
  const app = await applicationTestServer(t);
  const agent = app.makeToken('agent');
  const id = (await app.api('POST', root, applicationInput(), { token: agent })).body.id;
  const status = (value, token = agent) => app.api('POST', `${root}/${id}/status`, { status: value, note: 'Reviewed example facts.' }, { token });
  assert.equal((await status('approved')).status, 403);
  assert.match((await status('sent')).body.error.message, /approve/);
  assert.equal((await status('draft')).status, 409);
  for (const value of ['needs_review', 'draft', 'skipped', 'draft']) assert.equal((await status(value)).status, 200);
  const approved = await status('approved', app.token);
  assert.equal(approved.status, 200);
  assert.equal(approved.body.events.at(-1).note, 'Reviewed example facts.');
  assert.equal((await status('draft')).status, 409);
  for (const value of ['sent', 'interview', 'offer', 'rejected', 'draft']) assert.equal((await status(value, app.token)).status, 200);
  assert.equal((await status('invalid')).status, 422);
  assert.equal((await status('draft', null)).status, 401);
  const skipped = (await app.api('POST', root, applicationInput(2, { verdict: 'skip' }))).body;
  assert.equal((await app.api('POST', `${root}/${skipped.id}/status`, { status: 'approved' })).status, 409);
  const reader = app.makeToken('agent');
  app.db.prepare('UPDATE tokens SET scopes = ? WHERE id = (SELECT MAX(id) FROM tokens)').run(JSON.stringify(['read']));
  const denied = await status('needs_review', reader);
  assert.equal(denied.status, 403);
  assert.match(denied.body.error.message, /write:applications/);
});

test('approval requires both PDFs and missing files can be restored before sending', async (t) => {
  const app = await applicationTestServer(t);
  const input = applicationInput();
  delete input.cover;
  const id = (await app.api('POST', root, input)).body.id;
  assert.equal((await app.api('POST', `${root}/${id}/status`, { status: 'approved' })).status, 409);
  await app.api('PUT', `${root}/${id}`, applicationInput());
  rmSync(join(app.dataDir, 'files', String(id), 'cover.pdf'));
  assert.equal((await app.api('POST', `${root}/${id}/status`, { status: 'sent' })).status, 409);
  assert.equal((await app.api('POST', `${root}/${id}/rerender`)).status, 200);
  assert.equal((await app.api('POST', `${root}/${id}/status`, { status: 'approved' })).status, 200);
});

test('PUT replaces editable applications, detects collisions, updates revision and removes obsolete files', async (t) => {
  const app = await applicationTestServer(t);
  const id = (await app.api('POST', root, applicationInput())).body.id;
  const other = (await app.api('POST', root, applicationInput(2))).body.id;
  assert.equal((await app.api('PUT', `${root}/${id}`, applicationInput(2))).status, 409);
  const input = applicationInput(1, { notes: 'New notes' });
  input.resume.content.headline = 'Unity Tools Engineer';
  await app.api('POST', `${root}/${id}/status`, { status: 'needs_review' });
  const updated = await app.api('PUT', `${root}/${id}`, input);
  assert.equal(updated.status, 200);
  assert.equal(updated.body.status, 'needs_review');
  assert.equal(updated.body.notes, 'New notes');
  assert.equal(updated.body.events.at(-1).status, 'updated');
  assert.match(readFileSync(join(app.dataDir, 'files', String(id), 'resume.pdf'), 'utf8'), /Unity Tools Engineer/);
  await app.api('POST', `${root}/${id}/status`, { status: 'approved' });
  assert.equal((await app.api('PUT', `${root}/${id}`, input)).status, 409);
  await app.api('POST', `${root}/${id}/status`, { status: 'draft' });
  const skipped = await app.api('PUT', `${root}/${id}`, applicationInput(1, { verdict: 'skip' }));
  assert.equal(skipped.body.status, 'skipped');
  assert.equal(existsSync(join(app.dataDir, 'files', String(id), 'resume.pdf')), false);
  assert.equal(existsSync(join(app.dataDir, 'files', String(other), 'resume.pdf')), true);
});

test('rerender uses current or selected template version without checking facts and refuses after sent', async (t) => {
  const app = await applicationTestServer(t);
  const classic = (await app.api('GET', '/api/v1/templates/classic')).body;
  await app.api('PUT', '/api/v1/templates/custom-demo', classic);
  const input = applicationInput();
  input.resume.template = 'custom-demo';
  const id = (await app.api('POST', root, input)).body.id;
  await app.api('PUT', '/api/v1/templates/custom-demo', { ...classic, source: `${classic.source}\n<!-- New version -->` });
  app.db.prepare('UPDATE profile SET doc = json_set(doc, \'$.experience\', json(\'[]\')) WHERE id = 1').run();
  const current = await app.api('POST', `${root}/${id}/rerender`);
  assert.equal(current.status, 200);
  assert.equal(current.body.resume_template, 'custom-demo@2');
  assert.equal((await app.api('POST', `${root}/${id}/rerender?version=1`)).body.resume_template, 'custom-demo@1');
  assert.equal((await app.api('POST', `${root}/${id}/rerender?version=0`)).status, 400);
  assert.equal((await app.api('POST', `${root}/${id}/rerender?version=9`)).status, 422);
  for (const value of ['sent', 'interview', 'offer', 'rejected']) {
    await app.api('POST', `${root}/${id}/status`, { status: value });
    assert.equal((await app.api('POST', `${root}/${id}/rerender`)).status, 409);
  }
});

test('files return PDFs, cover text, vacancy markdown, HTML and safe attachment filenames; deletion cleans all data', async (t) => {
  const app = await applicationTestServer(t);
  const input = applicationInput();
  input.vacancy.company = 'Orbit / Games "LLC"';
  const id = (await app.api('POST', root, input)).body.id;
  const file = (name) => app.api('GET', `${root}/${id}/files/${name}`, undefined, { raw: true });
  const pdf = await file('resume.pdf?dl=1');
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.match(pdf.headers.get('content-disposition'), /^attachment; filename="Alex_Example_Resume_Orbit_Games_LLC.pdf"$/);
  assert.equal(pdf.body, readFileSync(join(app.dataDir, 'files', String(id), 'resume.pdf'), 'utf8'));
  assert.equal((await file('cover.pdf')).status, 200);
  assert.equal((await file('cover.txt')).body, input.cover.content.text);
  const markdown = await file('vacancy.md');
  for (const value of [input.vacancy.title, input.vacancy.company, input.vacancy.source, input.vacancy.url, input.vacancy.text]) assert.ok(markdown.body.includes(value));
  const html = await file('resume.html');
  assert.equal(html.status, 200);
  assert.match(html.body, /Alex Example/);
  assert.match(html.headers.get('content-type'), /text\/html/);
  assert.equal((await file('unknown')).status, 404);
  rmSync(join(app.dataDir, 'files', String(id), 'resume.pdf'));
  assert.equal((await file('resume.pdf')).status, 404);
  assert.equal((await app.api('DELETE', `${root}/${id}`, undefined, { token: app.makeToken('agent') })).status, 403);
  assert.equal((await app.api('DELETE', `${root}/${id}`)).status, 200);
  assert.equal(existsSync(join(app.dataDir, 'files', String(id))), false);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM application_events WHERE application_id = ?').get(id).n, 0);
  assert.equal((await app.api('GET', `${root}/${id}`)).status, 404);
  assert.equal((await app.api('DELETE', `${root}/${id}`)).status, 404);
});

test('rerender cannot replace PDFs after a concurrent content update', async (t) => {
  let release;
  let started;
  let pause = false;
  const rendering = new Promise((resolve) => { started = resolve; });
  const app = await applicationTestServer(t, { deps: { renderPdf: async (input) => {
    if (pause) {
      pause = false;
      started();
      await new Promise((resolve) => { release = resolve; });
    }
    return fakeApplicationPdf(input);
  } } });
  const id = (await app.api('POST', root, applicationInput())).body.id;
  pause = true;
  const pending = app.api('POST', `${root}/${id}/rerender`);
  await rendering;
  const replacement = applicationInput();
  replacement.resume.content.headline = 'Latest Unity Engineer';
  assert.equal((await app.api('PUT', `${root}/${id}`, replacement)).status, 200);
  release();
  assert.equal((await pending).status, 409);
  assert.match(readFileSync(join(app.dataDir, 'files', String(id), 'resume.pdf'), 'utf8'), /Latest Unity Engineer/);
});
