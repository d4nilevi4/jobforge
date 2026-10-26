import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { migrate } from '../server/db.js';
import { ApiError, renderFailed } from '../server/errors.js';
import { renderHtml } from '../server/render/index.js';
import { register } from '../server/routes/templates.js';
import { saveProfile } from '../server/services/profile.js';
import { deleteCustomTemplate, formatRef, getTemplate, listTemplates, parseRef, saveCustomTemplate } from '../server/services/templates.js';
import { startTestServer } from './helpers.js';

const root = '/api/v1/templates';
const profile = JSON.parse(readFileSync(new URL('../examples/profile.example.json', import.meta.url), 'utf8'));
const track = JSON.parse(readFileSync(new URL('../examples/tracks.example.json', import.meta.url), 'utf8'))['unity-developer'];

async function server(t, options = {}) {
  const s = await startTestServer(options);
  t.after(() => s.close());
  return s;
}

function customBody(s, kind = 'resume') {
  const template = getTemplate(s.db, kind === 'cover' ? 'letter' : 'classic');
  return { meta: template.meta, source: template.source };
}

test('template references accept optional positive versions and reject malformed references', () => {
  assert.deepEqual(parseRef('classic'), { id: 'classic', version: undefined });
  assert.deepEqual(parseRef('classic@1'), { id: 'classic', version: 1 });
  assert.equal(formatRef('custom-example', 2), 'custom-example@2');
  for (const ref of ['', null, 1, 'Classic', 'classic@0', 'classic@01', 'classic@-1', 'classic@1@2', 'classic@9007199254740992', '../classic']) {
    assert.throws(() => parseRef(ref), (error) => error instanceof ApiError && error.status === 400);
  }
  assert.throws(() => formatRef('classic', undefined), /positive integer version/);
});

test('built-in templates list by kind, expose source, samples and matching schemas', async (t) => {
  const s = await server(t);
  const listed = await s.api('GET', root);
  assert.equal(listed.status, 200);
  assert.ok(listed.body.some(({ id }) => id === 'classic'));
  for (const summary of listed.body) {
    assert.deepEqual(Object.keys(summary).sort(), ['id', 'name', 'kind', 'builtin', 'version', 'description', 'paper', 'max_pages', 'languages'].sort());
    assert.equal(summary.builtin, true);
  }
  for (const kind of ['resume', 'cover']) {
    const filtered = await s.api('GET', `${root}?kind=${kind}`);
    assert.equal(filtered.status, 200);
    assert.ok(filtered.body.length);
    assert.ok(filtered.body.every((template) => template.kind === kind));
    const detail = await s.api('GET', `${root}/${kind === 'resume' ? 'classic' : 'letter'}`);
    assert.equal(detail.status, 200);
    assert.ok(detail.body.content_schema.required.includes(kind === 'resume' ? 'headline' : 'text'));
    assert.ok(detail.body.source.includes('<!doctype html>'));
    assert.equal(detail.body.sample.profile_identity.name, 'Alex Example');
    assert.equal(detail.body.meta.version, detail.body.version);
  }
  assert.equal((await s.api('GET', `${root}?kind=unknown`)).status, 400);
  assert.equal((await s.api('GET', `${root}?kind=`)).status, 400);
  assert.equal((await s.api('GET', `${root}/missing`)).status, 404);
  assert.equal((await s.api('GET', `${root}/classic?version=1`)).status, 200);
  assert.equal((await s.api('GET', `${root}/classic?version=2`)).status, 404);
  for (const version of ['0', 'bad', '9007199254740992']) {
    assert.equal((await s.api('GET', `${root}/classic?version=${version}`)).status, 400);
  }
  for (const path of [root, `${root}/classic`]) {
    assert.equal((await s.api('GET', path, undefined, { token: null })).status, 401);
  }
  const clone = getTemplate(s.db, 'classic');
  clone.meta.name = 'Changed';
  clone.sample.profile_identity.name = 'Changed';
  assert.equal(getTemplate(s.db, 'classic').meta.name, 'Classic one-page');
  assert.equal(getTemplate(s.db, 'classic').sample.profile_identity.name, 'Alex Example');
});

test('agent manages custom versions, forks copies and deletion is refused until tracks release references', async (t) => {
  const s = await server(t, { withToken: 'agent' });
  const input = customBody(s);
  const first = await s.api('PUT', `${root}/custom-example`, input);
  assert.equal(first.status, 201);
  assert.equal(first.body.builtin, false);
  assert.equal(first.body.meta.id, 'custom-example');
  assert.equal(first.body.version, 1);
  assert.equal(input.meta.id, 'classic');
  const edited = { meta: { ...input.meta, version: 999, id: 'ignored', name: 'Edited example' }, source: '<!doctype html><p>{{identity.name}} {{resume.headline}}</p>' };
  const second = await s.api('PUT', `${root}/custom-example`, edited);
  assert.equal(second.status, 200);
  assert.equal(second.body.version, 2);
  assert.equal(second.body.meta.version, 2);
  assert.equal(second.body.meta.id, 'custom-example');
  const old = await s.api('GET', `${root}/custom-example?version=1`);
  assert.equal(old.status, 200);
  assert.equal(old.body.source, input.source);
  assert.equal((await s.api('GET', `${root}/custom-example`)).body.source, edited.source);
  assert.equal((await s.api('GET', `${root}/custom-example?version=3`)).status, 404);
  const forked = await s.api('POST', `${root}/custom-example/fork`, {});
  assert.equal(forked.status, 201);
  assert.equal(forked.body.id, 'custom-custom-example');
  assert.equal(forked.body.version, 1);
  assert.equal(forked.body.meta.version, 1);
  assert.equal(forked.body.source, edited.source);
  assert.equal((await s.api('POST', `${root}/custom-example/fork`, {})).body.id, 'custom-custom-example-2');
  const explicit = await s.api('POST', `${root}/custom-example/fork?version=1`, { id: 'custom-from-old' });
  assert.equal(explicit.status, 201);
  assert.equal(explicit.body.source, input.source);
  const setup = s.makeToken('setup');
  assert.equal((await s.api('PUT', '/api/v1/profile', profile, { token: setup })).status, 200);
  assert.equal((await s.api('PUT', '/api/v1/tracks/example', { ...track, resume_template: 'custom-example@1' })).status, 201);
  const refused = await s.api('DELETE', `${root}/custom-example`);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.details[0].id, 'example');
  assert.equal(getTemplate(s.db, 'custom-example').version, 2);
  await s.api('DELETE', '/api/v1/tracks/example');
  assert.equal((await s.api('DELETE', `${root}/custom-example`)).status, 200);
  assert.equal(getTemplate(s.db, 'custom-example'), null);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS count FROM template_versions WHERE template_id = ?').get('custom-example').count, 0);
  assert.equal((await s.api('DELETE', `${root}/custom-example`)).status, 404);
  assert.ok(listTemplates(s.db).some(({ id, builtin }) => id === 'custom-custom-example' && !builtin));
});

test('template writes reject invalid ids, metadata, source and syntax without creating versions', async (t) => {
  const s = await server(t);
  const input = customBody(s);
  for (const id of ['example', 'custom-', 'custom-Upper', `custom-${'a'.repeat(58)}`, 'custom-under_score']) {
    assert.equal((await s.api('PUT', `${root}/${id}`, input)).status, 400);
  }
  for (const body of [null, [], 'text']) assert.equal((await s.api('PUT', `${root}/custom-invalid`, body)).status, 400);
  const invalidBodies = [
    {}, { ...input, meta: null }, { ...input, meta: [] },
    { ...input, meta: { ...input.meta, kind: 'unknown' } },
    { ...input, meta: { ...input.meta, paper: 'legal' } },
    { ...input, meta: { ...input.meta, max_pages: 0 } },
    { ...input, meta: { ...input.meta, labels: null } },
    { ...input, meta: { ...input.meta, languages: ['en', 1] } },
    { ...input, meta: { ...input.meta, name: null } },
    { ...input, source: null }, { ...input, source: ' ' },
    { ...input, source: '<p>\n{{#if resume.summary}}unclosed' }
  ];
  for (const body of invalidBodies) {
    const result = await s.api('PUT', `${root}/custom-invalid`, body);
    assert.equal(result.status, 422);
    assert.equal(result.body.error.code, 'validation_failed');
    assert.ok(result.body.error.details.length);
  }
  const syntax = await s.api('PUT', `${root}/custom-invalid`, { ...input, source: '<p>\n{{#each resume.experience}}' });
  assert.equal(syntax.body.error.details[0].path, 'source');
  assert.match(syntax.body.error.message, /Template line 2: Unclosed each/);
  assert.equal(getTemplate(s.db, 'custom-invalid'), null);
  saveCustomTemplate(s.db, 'custom-valid', input);
  assert.equal((await s.api('PUT', `${root}/custom-valid`, { ...input, source: '{{> partial}}' })).status, 422);
  assert.equal(getTemplate(s.db, 'custom-valid').version, 1);
});

test('built-ins cannot be edited or deleted, forks handle collisions and writes require scope', async (t) => {
  const s = await server(t);
  const input = customBody(s);
  const edit = await s.api('PUT', `${root}/classic`, input);
  assert.equal(edit.status, 403);
  assert.equal(edit.body.error.code, 'forbidden');
  assert.match(edit.body.error.message, /fork/i);
  assert.equal((await s.api('DELETE', `${root}/classic`)).status, 403);
  const fork = await s.api('POST', `${root}/classic/fork`, {});
  assert.equal(fork.status, 201);
  assert.equal(fork.body.id, 'custom-classic');
  assert.equal(fork.body.source, input.source);
  assert.equal((await s.api('POST', `${root}/classic/fork`, {})).body.id, 'custom-classic-2');
  assert.equal((await s.api('POST', `${root}/classic/fork`, { id: 'custom-classic' })).status, 409);
  for (const id of ['bad', null, 42]) {
    assert.equal((await s.api('POST', `${root}/classic/fork`, { id })).status, 400);
  }
  assert.equal((await s.api('POST', `${root}/classic/fork`, null)).status, 400);
  assert.equal((await s.api('POST', `${root}/missing/fork`, {})).status, 404);
  const readOnly = (await s.api('POST', '/api/v1/tokens', { name: 'preview reader', scopes: ['read'] })).body.secret;
  for (const [method, path, body] of [
    ['PUT', `${root}/custom-reader`, input], ['POST', `${root}/classic/fork`, {}], ['DELETE', `${root}/custom-classic`, undefined]
  ]) {
    assert.equal((await s.api(method, path, body, { token: readOnly })).status, 403);
  }
});

test('template deletion checks bare and versioned application and cover track references', async (t) => {
  const s = await server(t);
  const resume = saveCustomTemplate(s.db, 'custom-resume', customBody(s));
  const cover = saveCustomTemplate(s.db, 'custom-cover', customBody(s, 'cover'));
  for (const [column, ref] of [['resume_template', 'custom-resume'], ['resume_template', 'custom-resume@1'], ['cover_template', 'custom-cover@1']]) {
    s.db.prepare(`INSERT INTO applications(id, ${column}) VALUES (1, ?)`).run(ref);
    const id = column === 'resume_template' ? resume.id : cover.id;
    const result = await s.api('DELETE', `${root}/${id}`);
    assert.equal(result.status, 409);
    assert.equal(result.body.error.details[0].path, 'applications');
    s.db.prepare('DELETE FROM applications WHERE id = 1').run();
  }
  await s.api('PUT', '/api/v1/profile', profile);
  await s.api('PUT', '/api/v1/tracks/example', { ...track, cover_template: 'custom-cover' });
  assert.equal((await s.api('DELETE', `${root}/custom-cover`)).status, 409);
  await s.api('DELETE', '/api/v1/tracks/example');
  assert.equal(deleteCustomTemplate(s.db, 'custom-cover'), true);
  assert.equal(deleteCustomTemplate(s.db, 'custom-cover'), false);
  assert.equal(deleteCustomTemplate(s.db, 'custom-resume'), true);
});

test('preview HTML uses sample or stored identity, localizes content and never invokes Chrome', async (t) => {
  let renders = 0;
  const s = await server(t, { deps: {
    chrome: { bin: '/missing/chrome', docker: false },
    renderPdf() { renders++; throw new Error('HTML preview must not call the PDF renderer.'); }
  } });
  const readOnly = (await s.api('POST', '/api/v1/tokens', { name: 'preview reader', scopes: ['read'] })).body.secret;
  const htmlPreview = async (id, body) => {
    const response = await fetch(`${s.url}${root}/${id}/preview?format=html`, {
      method: 'POST', headers: { Authorization: `Bearer ${readOnly}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    return { status: response.status, html: await response.text(), type: response.headers.get('content-type') };
  };
  const sample = await htmlPreview('classic', {});
  assert.equal(sample.status, 200);
  assert.match(sample.type, /^text\/html/);
  assert.match(sample.html, /Alex Example/);
  assert.match(sample.html, /alex@example.com/);
  await s.api('PUT', '/api/v1/profile', { ...profile, identity: { ...profile.identity, location: 'Stored profile location' } });
  const custom = saveCustomTemplate(s.db, 'custom-preview', {
    meta: customBody(s).meta,
    source: '<!doctype html><p>{{identity.name}}|{{identity.location}}|{{lang}}|{{resume.headline}}|{{identity.email}}</p>'
  });
  const preview = await htmlPreview(custom.id, {
    content: { ...track.base, headline: '<Example headline>' }, lang: 'ru',
    profile: { identity: { name: 'Ignored identity', location: 'Ignored location' } }
  });
  assert.equal(preview.status, 200);
  assert.match(preview.html, /Алекс Пример\|Stored profile location\|ru\|&lt;Example headline&gt;\|alex@example.com/);
  const cover = await htmlPreview('letter', { cover: { text: 'Example cover text.' }, lang: 'en' });
  assert.equal(cover.status, 200);
  assert.match(cover.html, /Example cover text\./);
  assert.equal(renders, 0);
});

test('preview PDF uses injected renderer and Chrome options with page and overflow headers', async (t) => {
  const calls = [];
  let pages = 2;
  const s = await server(t, { deps: {
    chrome: { bin: '/fake/chrome', docker: true },
    renderPdf(input) {
      calls.push(input);
      return { html: renderHtml(input), pdf: Buffer.from('%PDF-1.4 fake'), pages };
    }
  } });
  const response = await fetch(`${s.url}${root}/classic/preview`, {
    method: 'POST', headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' }, body: '{}'
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/pdf');
  assert.equal(response.headers.get('x-pages'), '2');
  assert.equal(response.headers.get('x-page-overflow'), 'true');
  assert.equal(await response.text(), '%PDF-1.4 fake');
  assert.deepEqual(calls[0].chrome, { chromeBin: '/fake/chrome', docker: true });
  assert.equal(calls[0].context.identity.name, 'Alex Example');
  pages = 1;
  const withinLimit = await fetch(`${s.url}${root}/letter/preview`, {
    method: 'POST', headers: { Authorization: `Bearer ${s.token}` }, body: JSON.stringify({ content: { text: 'Example cover.' } })
  });
  assert.equal(withinLimit.status, 200);
  assert.equal(withinLimit.headers.get('x-pages'), '1');
  assert.equal(withinLimit.headers.get('x-page-overflow'), null);
  await withinLimit.arrayBuffer();
  assert.equal(calls[1].context.cover.text, 'Example cover.');
});

test('preview errors explain invalid input, missing templates and unavailable PDF rendering', async (t) => {
  const s = await server(t, { deps: {
    chrome: { bin: '', docker: false }, renderPdf() { throw renderFailed('Install Chrome or set CHROME_BIN.'); }
  } });
  for (const body of [null, [], 1]) assert.equal((await s.api('POST', `${root}/classic/preview`, body)).status, 400);
  for (const body of [{ content: {} }, { content: null }, { lang: 1 }, { lang: '' }, { cover: null }]) {
    assert.equal((await s.api('POST', `${root}/classic/preview`, body)).status, 422);
  }
  assert.equal((await s.api('POST', `${root}/letter/preview`, { cover: { text: 1 } })).status, 422);
  assert.equal((await s.api('POST', `${root}/missing/preview`, {})).status, 404);
  assert.equal((await s.api('POST', `${root}/classic/preview`, {}, { token: null })).status, 401);
  const failure = await s.api('POST', `${root}/classic/preview`, {});
  assert.equal(failure.status, 422);
  assert.equal(failure.body.error.code, 'render_failed');
  assert.match(failure.body.error.message, /CHROME_BIN/);
});

test('template services retain historical kinds and roll back writes atomically', (t) => {
  const s = { db: new DatabaseSync(':memory:') };
  t.after(() => s.db.close());
  migrate(s.db);
  const input = customBody(s);
  saveCustomTemplate(s.db, 'custom-history', input);
  saveCustomTemplate(s.db, 'custom-history', customBody(s, 'cover'));
  assert.equal(getTemplate(s.db, 'custom-history').kind, 'cover');
  assert.equal(getTemplate(s.db, 'custom-history', 1).kind, 'resume');
  assert.equal(getTemplate(s.db, 'custom-history', 1).meta.kind, 'resume');
  assert.equal(getTemplate(s.db, 'missing'), null);
  s.db.exec("CREATE TRIGGER reject_version BEFORE INSERT ON template_versions BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
  assert.throws(() => saveCustomTemplate(s.db, 'custom-history', input), /test failure/);
  assert.equal(getTemplate(s.db, 'custom-history').version, 2);
  assert.equal(getTemplate(s.db, 'custom-history').kind, 'cover');
  assert.throws(() => saveCustomTemplate(s.db, 'custom-failed', input), /test failure/);
  assert.equal(getTemplate(s.db, 'custom-failed'), null);
});

test('direct template handlers manage lifecycle, references and previews without sockets', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  migrate(db);
  const routes = new Map();
  register({ add(method, path, handler, options) { routes.set(`${method} ${path}`, { handler, ...options }); } });
  let renders = 0;
  const call = (method, suffix = '/:id', id = 'classic', body = {}, query = {}) => routes.get(`${method} ${root}${suffix}`).handler({
    db, body, params: { id }, query,
    chrome: { bin: '/fake/chrome', docker: true },
    renderPdf(input) {
      renders++;
      assert.deepEqual(input.chrome, { chromeBin: '/fake/chrome', docker: true });
      return { html: renderHtml(input), pdf: Buffer.from('%PDF-1.4 fake'), pages: 2 };
    }
  });
  const original = call('GET');
  assert.equal(original.sample.profile_identity.name, 'Alex Example');
  assert.ok(original.content_schema.required.includes('headline'));
  assert.ok(call('GET', '', '', {}, { kind: 'resume' }).every(({ kind }) => kind === 'resume'));
  assert.throws(() => call('GET', '', '', {}, { kind: 'invalid' }), { status: 400 });
  assert.throws(() => call('GET', '/:id', 'missing'), { status: 404 });
  assert.throws(() => call('GET', '/:id', 'classic', {}, { version: '2' }), { status: 404 });
  assert.throws(() => call('PUT', '/:id', 'classic', original), { status: 403 });
  assert.throws(() => call('DELETE', '/:id', 'classic'), { status: 403 });
  assert.throws(() => call('PUT', '/:id', 'bad', original), { status: 400 });
  for (const [field, value] of [['kind', 'unknown'], ['paper', 'legal'], ['max_pages', 0], ['languages', ['en', 1]], ['labels', null], ['name', null]]) {
    assert.throws(() => call('PUT', '/:id', 'custom-invalid', { ...original, meta: { ...original.meta, [field]: value } }), { status: 422, code: 'validation_failed' });
  }
  assert.equal(getTemplate(db, 'custom-invalid'), null);
  assert.throws(() => call('PUT', '/:id', 'custom-invalid', { ...original, source: '{{#if resume}}' }), (error) => error.status === 422 && error.details[0].path === 'source' && /Template line 1/.test(error.message));
  assert.equal(call('PUT', '/:id', 'custom-example', original).status, 201);
  const edited = { ...original, source: '<p>{{identity.name}}|{{identity.location}}|{{lang}}|{{resume.headline}}</p>' };
  assert.equal(call('PUT', '/:id', 'custom-example', edited).body.version, 2);
  assert.equal(call('GET', '/:id', 'custom-example', {}, { version: '1' }).source, original.source);
  assert.equal(call('POST', '/:id/fork', 'classic').body.id, 'custom-classic');
  assert.equal(call('POST', '/:id/fork', 'classic').body.id, 'custom-classic-2');
  assert.equal(call('POST', '/:id/fork', 'custom-example').body.id, 'custom-custom-example');
  assert.throws(() => call('POST', '/:id/fork', 'classic', { id: 'custom-classic' }), { status: 409 });
  const longId = `custom-${'a'.repeat(57)}`;
  call('PUT', '/:id', longId, original);
  const longFork = call('POST', '/:id/fork', longId).body.id;
  assert.equal(longFork.length, 64);
  assert.match(longFork, /^custom-[a-z0-9][a-z0-9-]{0,56}$/);
  assert.notEqual(call('POST', '/:id/fork', longId).body.id, longFork);
  db.prepare('INSERT INTO tracks(id, doc) VALUES (?, ?)').run('example', JSON.stringify({ ...track, resume_template: 'custom-example@1' }));
  assert.throws(() => call('DELETE', '/:id', 'custom-example'), { status: 409 });
  db.prepare('DELETE FROM tracks').run();
  db.prepare('INSERT INTO applications(id, cover_template) VALUES (1, ?)').run('custom-example@2');
  assert.throws(() => call('DELETE', '/:id', 'custom-example'), { status: 409 });
  db.prepare('DELETE FROM applications').run();
  const sample = await call('POST', '/:id/preview', 'custom-example', {}, { format: 'html' });
  assert.equal(sample.headers['Content-Type'], 'text/html; charset=utf-8');
  assert.match(sample.raw, /Alex Example/);
  assert.equal(renders, 0);
  saveProfile(db, { ...profile, identity: { ...profile.identity, location: 'Stored location' } }, null);
  const localized = await call('POST', '/:id/preview', 'custom-example', { content: track.base, lang: 'ru' }, { format: 'html' });
  assert.match(localized.raw, /Алекс Пример\|Stored location\|ru/);
  const pdf = await call('POST', '/:id/preview');
  assert.equal(pdf.headers['X-Pages'], '2');
  assert.equal(pdf.headers['X-Page-Overflow'], 'true');
  assert.equal(pdf.raw.toString(), '%PDF-1.4 fake');
  assert.equal(renders, 1);
  for (const body of [{ content: null }, { lang: 1 }, { cover: null }]) {
    await assert.rejects(() => call('POST', '/:id/preview', 'classic', body), { status: 422 });
  }
  assert.deepEqual(call('DELETE', '/:id', 'custom-example'), { ok: true });
  assert.equal(getTemplate(db, 'custom-example', 1), null);
  for (const [key, route] of routes) {
    assert.equal(route.scope, key.startsWith('GET') || key.endsWith('/preview') ? 'read' : 'write:templates');
  }
});
