import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { migrate } from '../server/db.js';
import { ApiError } from '../server/errors.js';
import { loadBuiltinTemplates } from '../server/render/builtin.js';
import { buildContext, safeUrl } from '../server/render/context.js';
import { renderTemplate } from '../server/render/engine.js';
import { renderHtml, renderPdf } from '../server/render/index.js';
import { htmlToPdf } from '../server/render/pdf.js';
import { register } from '../server/routes/templates.js';
import { getTemplate, saveCustomTemplate } from '../server/services/templates.js';

const megabyte = 1024 * 1024;
const pdfCsp = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";
const previewCsp = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:";
const nested = (block, count, body = 'x') => `{{#${block}}}`.repeat(count) + body
  + `{{/${block.split(' ')[0]}}}`.repeat(count);

async function shellChrome(t, { capture = false, blocked = false } = {}) {
  if (process.platform === 'win32') {
    t.skip('The fake Chrome shell executable requires POSIX.');
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'jobforge-hardening-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, 'chrome');
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(executable, `#!/bin/sh
for argument do
  case "$argument" in
    --print-to-pdf=*) output=\${argument#--print-to-pdf=} ;;
    file://*) input=\${argument#file://} ;;
  esac
done
${capture ? `cp "$input" ${quote(join(directory, 'capture.html'))}` : ''}
printf 'start\\n' >> ${quote(join(directory, 'events'))}
${blocked ? `while [ ! -f ${quote(join(directory, 'release'))} ]; do sleep 0.01; done` : ''}
sleep 0.01
printf '%%PDF-1.4\\n<</Type /Pages /Count 1>>\\n' > "$output"
printf 'end\\n' >> ${quote(join(directory, 'events'))}
`);
  await chmod(executable, 0o755);
  return {
    directory,
    options: { chromeBin: executable },
    release: () => writeFile(join(directory, 'release'), '')
  };
}

function assertBusy(error, message = /busy.*retry/i) {
  assert.ok(error instanceof ApiError);
  assert.equal(error.status, 422);
  assert.equal(error.code, 'render_failed');
  assert.match(error.message, message);
}

async function waitForStarts(chrome, count) {
  const deadline = performance.now() + 1000;
  while (performance.now() < deadline) {
    let events = '';
    try {
      events = await readFile(join(chrome.directory, 'events'), 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (events.split('\n').filter((event) => event === 'start').length >= count) return;
    await delay(5);
  }
  assert.fail(`Fake Chrome did not start ${count} renders within 1000 ms.`);
}

test('Chrome input starts with the restrictive CSP and strips base and refresh tags', async (t) => {
  const chrome = await shellChrome(t, { capture: true });
  if (!chrome) return;
  const body = '<body><p>Alex Example</p><img src="http://127.0.0.1:9000/x">'
    + '<iframe src="file:///etc/passwd"></iframe></body>';
  for (const prefix of [
    '<!doctype html><html><head>',
    '<!DOCTYPE html><HTML lang="en"><HEAD data-title="a > b">',
    '<!doctype html><html>',
    '',
    '<!-- a misleading <head> -->',
    '<!-->',
    '<!--->',
    '<!-- a comment ending with --!>',
    '<!invalid "quoted >',
    '<script>const text = "<head>";</script>'
  ]) {
    const html = prefix + '<base href="file:///etc/"><BASE target="_top">'
      + '<meta content="0;url=http://127.0.0.1:9000/" HTTP-EQUIV = "ReFrEsH">'
      + "<meta http-equiv='refresh' content='0;url=file:///etc/passwd'>"
      + '<meta http-equiv=refresh content="0"><meta http-equiv="&#114;efresh" content="0">'
      + '<meta name="description" content="keep > this">'
      + '<link rel="stylesheet" href="http://127.0.0.1:9000/style">'
      + '</head>' + body + '</html>';
    await htmlToPdf(html, chrome.options);
    const captured = await readFile(join(chrome.directory, 'capture.html'), 'utf8');
    assert.match(captured, /<head\b[^>]*(?:"[^"]*"[^>]*)?>/i);
    const policy = `<meta http-equiv="Content-Security-Policy" content="${pdfCsp}">`;
    assert.ok(captured.includes(policy));
    assert.match(captured.slice(0, captured.indexOf(policy)), /<head(?=[\t\n\f\r />])(?:[^"'<>]|"[^"]*"|'[^']*')*>$/i);
    assert.ok(captured.indexOf(policy) < captured.indexOf('<script>') || !captured.includes('<script>'));
    assert.ok(captured.indexOf(policy) < captured.indexOf('<link'));
    assert.doesNotMatch(captured, /<base\b/i);
    assert.doesNotMatch(captured, /http-equiv\s*=\s*["']?(?:refresh|&#114;efresh)/i);
    assert.ok(captured.includes(body));
    assert.ok(captured.includes('<meta name="description" content="keep > this">'));
  }
});

test('CSP injection preserves every built-in document body and inline stylesheet', async (t) => {
  const chrome = await shellChrome(t, { capture: true });
  if (!chrome) return;
  const templates = await loadBuiltinTemplates(fileURLToPath(new URL('../templates/builtin/', import.meta.url)));
  for (const template of templates.values()) {
    const { sample, meta } = template;
    const context = buildContext({ profile: { identity: sample.profile_identity }, meta,
      resume: sample.resume, cover: sample.cover });
    const html = renderHtml({ ...template, context });
    await htmlToPdf(html, chrome.options);
    const captured = await readFile(join(chrome.directory, 'capture.html'), 'utf8');
    assert.ok(captured.includes(html.match(/<body\b[\s\S]*<\/body>/i)[0]), meta.id);
    assert.ok(captured.includes(html.match(/<style>[\s\S]*<\/style>/i)[0]), meta.id);
    assert.ok(captured.includes(`<head><meta http-equiv="Content-Security-Policy" content="${pdfCsp}">`));
  }
});

test('context removes hostile link schemes and whitespace tricks without changing inputs', () => {
  const hostile = [
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\nscript:alert(1)', 'java\tscript:alert(1)',
    'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)', 'file:///etc/passwd',
    '//example.com', '/relative', ' javascript:alert(1)', '\u0000https://example.com',
    'https:\n//example.com', 'https://example.com\u007f', 'https://example.com\u0085'
  ];
  const allowed = ['http://example.com', 'https://example.com/path/', 'mailto:alex@example.com',
    'tel:+123456789', 'HTTPS://example.com'];
  const urls = [...hostile, ...allowed];
  const profile = { identity: { links: urls.map((url) => ({ label: 'Example', url })) } };
  const resume = { projects: urls.map((link) => ({ title: 'Example', link, bullets: ['Keep this'] })) };
  const before = structuredClone({ profile, resume });
  const context = buildContext({ profile, resume });
  assert.deepEqual(context.identity.links.map(({ url }) => url), [...hostile.map(() => ''), ...allowed]);
  assert.deepEqual(context.resume.projects.map(({ link }) => link), [...hostile.map(() => ''), ...allowed]);
  assert.ok(context.identity.links.slice(0, hostile.length).every(({ display }) => display === ''));
  assert.deepEqual(context.resume.projects[0].bullets, ['Keep this']);
  assert.deepEqual({ profile, resume }, before);
});

test('safeUrl accepts only absolute URLs with allowed schemes and handles missing values', () => {
  for (const value of [undefined, null, false, 0, {}, '', 'http:', 'https://', 'example.com']) {
    assert.equal(safeUrl(value), '');
  }
  const value = 'https://example.com/?name=Alex%20Example';
  assert.equal(safeUrl(value), value);
});

test('engine checks depth at parse time and bounds exponential evaluation below 500 ms', () => {
  assert.equal(renderTemplate(nested('if yes', 12), { yes: true }), 'x');
  assert.equal(renderTemplate(nested('if no', 12)), '');
  for (const source of [nested('if no', 13), nested('each resume.skills', 16)]) {
    assert.ok(Buffer.byteLength(source) < 1024);
    const start = performance.now();
    assert.throws(() => renderTemplate(source), /nesting depth.*12.*Reduce/i);
    assert.ok(performance.now() - start < 500);
  }
  const source = nested('each resume.skills', 9, '');
  assert.ok(Buffer.byteLength(source) < 1024);
  const start = performance.now();
  assert.throws(() => renderTemplate(source, { resume: { skills: [1, 2, 3, 4] } }), /evaluation step.*200000.*Reduce/i);
  assert.ok(performance.now() - start < 500);
});

test('engine counts empty loop iterations and enforces the exact evaluation budget', () => {
  const source = '{{#each list}}{{/each}}';
  assert.equal(renderTemplate(source, { list: Array(199999).fill(null) }), '');
  assert.throws(() => renderTemplate(source, { list: Array(200000).fill(null) }), /evaluation step.*200000.*Reduce/i);
});

test('engine limits total UTF-8 output to 2 MB including literals, raw values, and escaped values', () => {
  const limit = 2 * megabyte;
  assert.equal(renderTemplate('x'.repeat(limit)).length, limit);
  assert.equal(Buffer.byteLength(renderTemplate('é'.repeat(megabyte))), limit);
  for (const [source, context] of [
    ['x'.repeat(limit + 1), {}],
    ['{{{value}}}x', { value: 'x'.repeat(limit) }],
    ['{{{value}}}x', { value: 'é'.repeat(megabyte) }],
    ['{{value}}', { value: '&'.repeat(Math.floor(limit / 5) + 1) }],
    [nested('each resume.skills', 8, 'x'.repeat(64)), { resume: { skills: [1, 2, 3, 4] } }]
  ]) {
    assert.throws(() => renderTemplate(source, context), /output size.*2 MB.*Reduce/i);
  }
});

test('template saves and both preview formats return 422 for all engine limits without sockets', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  migrate(db);
  const routes = new Map();
  register({ add(method, path, handler) { routes.set(`${method} ${path}`, handler); } });
  const original = getTemplate(db, 'classic');
  const save = routes.get('PUT /api/v1/templates/:id');
  const preview = routes.get('POST /api/v1/templates/:id/preview');
  for (const [index, source, pattern] of [
    [0, nested('each resume.skills', 16), /nesting depth/i],
    [1, nested('each resume.skills', 9, ''), /evaluation step/i],
    [2, nested('each resume.skills', 8, 'x'.repeat(64)), /output size/i]
  ]) {
    assert.ok(Buffer.byteLength(source) < 1024);
    const id = `custom-limit-${index}`;
    const start = performance.now();
    assert.throws(() => save({ db, params: { id }, body: { ...original, source } }), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 422);
      assert.equal(error.code, 'validation_failed');
      assert.equal(error.details[0].path, 'source');
      assert.match(error.message, pattern);
      return true;
    });
    assert.ok(performance.now() - start < 500);
    assert.equal(getTemplate(db, id), null);
    saveCustomTemplate(db, id, original);
    db.prepare('UPDATE template_versions SET source = ? WHERE template_id = ?').run(source, id);
    for (const query of [{ format: 'html' }, {}]) {
      const previewStart = performance.now();
      await assert.rejects(preview({ db, params: { id }, query, body: {}, renderPdf, chrome: { bin: '' } }), (error) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 422);
        assert.equal(error.code, 'render_failed');
        assert.match(error.message, pattern);
        return true;
      });
      assert.ok(performance.now() - previewStart < 500);
    }
  }
});

test('HTML preview carries sandbox and nosniff headers without sockets', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  migrate(db);
  let handler;
  register({ add(method, path, callback) {
    if (path.endsWith('/preview')) handler = callback;
  } });
  const result = await handler({ db, params: { id: 'classic' }, query: { format: 'html' }, body: {} });
  assert.equal(result.status, 200);
  assert.equal(result.headers['Content-Security-Policy'], previewCsp);
  assert.equal(result.headers['X-Content-Type-Options'], 'nosniff');
  assert.match(result.raw, /Alex Example/);
});

test('PDF queue rejects the twenty-first waiting job immediately and keeps only two processes', async (t) => {
  const chrome = await shellChrome(t, { blocked: true });
  if (!chrome) return;
  const jobs = Array.from({ length: 22 }, () => htmlToPdf('<p>Alex Example</p>', chrome.options));
  let overflowError;
  const overflow = htmlToPdf('overflow', chrome.options).catch((error) => { overflowError = error; });
  const results = Promise.allSettled([...jobs, overflow]);
  try {
    await new Promise(setImmediate);
    assertBusy(overflowError);
    await waitForStarts(chrome, 2);
  } finally {
    await chrome.release();
    await results;
  }
  assert.ok((await Promise.allSettled(jobs)).every(({ status }) => status === 'fulfilled'));
  const events = (await readFile(join(chrome.directory, 'events'), 'utf8')).trim().split('\n');
  let active = 0;
  let maximum = 0;
  for (const event of events) {
    active += event === 'start' ? 1 : -1;
    maximum = Math.max(maximum, active);
    assert.ok(active >= 0 && active <= 2);
  }
  assert.equal(maximum, 2);
  assert.equal(active, 0);
  assert.equal(events.filter((event) => event === 'start').length, 22);
});

test('PDF queue caps total waiting UTF-8 HTML bytes at 20 MB and frees bytes on dispatch', async (t) => {
  const chrome = await shellChrome(t, { blocked: true });
  if (!chrome) return;
  const jobs = [htmlToPdf('first', chrome.options), htmlToPdf('second', chrome.options)];
  jobs.push(htmlToPdf('é'.repeat(5 * megabyte), chrome.options));
  jobs.push(htmlToPdf('é'.repeat(5 * megabyte), chrome.options));
  let overflowError;
  const overflow = htmlToPdf('x', chrome.options).catch((error) => { overflowError = error; });
  const results = Promise.allSettled([...jobs, overflow]);
  try {
    await new Promise(setImmediate);
    assertBusy(overflowError);
  } finally {
    await chrome.release();
    await results;
  }
  assert.ok((await Promise.allSettled(jobs)).every(({ status }) => status === 'fulfilled'));
  const recovered = await Promise.all(Array.from({ length: 3 }, () => htmlToPdf('x', chrome.options)));
  assert.equal(recovered.length, 3);
});

test('waiting PDFs expire after 60 seconds, never launch, and release queue capacity', async (t) => {
  const chrome = await shellChrome(t, { blocked: true });
  if (!chrome) return;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const active = [htmlToPdf('first', chrome.options), htmlToPdf('second', chrome.options)];
  let expiredError;
  const waiting = htmlToPdf('é'.repeat(10 * megabyte), chrome.options).catch((error) => { expiredError = error; });
  const results = Promise.allSettled([...active, waiting]);
  try {
    t.mock.timers.tick(59999);
    await Promise.resolve();
    assert.equal(expiredError, undefined);
    t.mock.timers.tick(1);
    await new Promise(setImmediate);
    assertBusy(expiredError);
    assert.match(expiredError.message, /60000 ms/);
    const replacements = Array.from({ length: 20 }, () => htmlToPdf('x', chrome.options));
    const replacementResults = Promise.allSettled(replacements);
    t.mock.timers.reset();
    await chrome.release();
    assert.ok((await replacementResults).every(({ status }) => status === 'fulfilled'));
  } finally {
    t.mock.timers.reset();
    await chrome.release();
    await results;
  }
  const events = (await readFile(join(chrome.directory, 'events'), 'utf8')).trim().split('\n');
  assert.equal(events.filter((event) => event === 'start').length, 22);
});
