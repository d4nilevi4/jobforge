import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countPages, findChrome, chromeVersion, htmlToPdf } from '../server/render/pdf.js';
import { loadBuiltinTemplates } from '../server/render/builtin.js';
import { buildContext } from '../server/render/context.js';
import { renderPdf } from '../server/render/index.js';

test('countPages reads the Skia page tree with arbitrary whitespace and key order', () => {
  for (const text of [
    '%PDF-1.4\n1 0 obj\n<</Type /Pages\n/Count 2\n/Kids [2 0 R 10 0 R]>>\nendobj',
    '<</Kids [2 0 R 10 0 R] /Count 2 /Type /Pages>>',
    '<<\r\n/Count\t2\r/Type\n/Pages >>',
    '<</Type/Pages/Count 2/Kids []>>'
  ]) assert.equal(countPages(Buffer.from(text, 'latin1')), 2);
});

test('countPages chooses the root Pages dictionary without Parent', () => {
  const children = '<< /Type /Pages /Parent 1 0 R /Count 2 >>\n<< /Count 3 /Type /Pages /Parent 1 0 R >>';
  const root = '<< /Type /Pages /Kids [2 0 R 3 0 R] /Count 5 >>';
  assert.equal(countPages(Buffer.from(`${children}\n${root}`)), 5);
  assert.equal(countPages(Buffer.from(`${root}\n${children}`)), 5);
});

test('countPages tolerates nested dictionaries and ignores their Parent and Count keys', () => {
  const text = '<</Type /Pages /Resources <</Parent 9 0 R /Count 99>> /Count 4 /Kids []>>';
  assert.equal(countPages(Buffer.from(text)), 4);
});

test('countPages falls back to Page dictionaries without counting Pages or other names', () => {
  assert.equal(countPages(Buffer.from('<</Type /Pages>><</Type /Page /Parent 1 0 R>><</Type\n/Page>><</Type /PageLayout>>')), 2);
  assert.equal(countPages(Buffer.from('<</Type /Pages /Count invalid>><</Type /Page>>')), 1);
  assert.equal(countPages(Buffer.from('<</Type /Pages /Parent 1 0 R /Count 99>><</Type /Page>>')), 1);
  assert.equal(countPages(Buffer.from('<</Type /Pages /Count 0>>')), 0);
  assert.equal(countPages(Buffer.from('%PDF-1.4\nno pages')), 0);
  assert.equal(countPages(Buffer.alloc(0)), 0);
});

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'jobforge-pdf-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function fakeChrome(t, code) {
  if (process.platform === 'win32') {
    t.skip('Executable script fixtures require POSIX; real Chrome tests still run on Windows.');
    return null;
  }
  const directory = await temporaryDirectory(t);
  const executable = join(directory, 'fake chrome');
  await writeFile(executable, `#!${process.execPath}\n${code}\n`);
  await chmod(executable, 0o755);
  return { directory, executable };
}

const fakePrint = `
import { writeFileSync } from 'node:fs';
const output = process.argv.find((arg) => arg.startsWith('--print-to-pdf=')).slice('--print-to-pdf='.length);
writeFileSync(output, '%PDF-1.4\\n1 0 obj\\n<</Type /Pages /Count 1>>\\nendobj\\n%%EOF');
`;

test('findChrome honors an existing CHROME_BIN and falls back without throwing', async (t) => {
  const directory = await temporaryDirectory(t);
  const executable = join(directory, 'chrome');
  await writeFile(executable, 'fixture');
  assert.equal(findChrome({ CHROME_BIN: executable, PATH: '' }), executable);
  assert.doesNotThrow(() => findChrome({ CHROME_BIN: join(directory, 'missing'), PATH: directory }));
  assert.equal(typeof findChrome({ PATH: '' }), 'string');
  assert.equal(typeof findChrome({ CHROME_BIN: directory, PATH: '' }), 'string');
});

test('chromeVersion returns trimmed output or an empty string on failure', async (t) => {
  assert.equal(chromeVersion(''), '');
  assert.equal(chromeVersion(join(tmpdir(), 'jobforge-no-such-chrome')), '');
  const fixture = await fakeChrome(t, "process.stdout.write('Google Chrome 130.0.0\\n');");
  if (!fixture) return;
  assert.equal(chromeVersion(fixture.executable), 'Google Chrome 130.0.0');
});

test('missing Chrome produces the shared render_failed error with installation instructions', async () => {
  await assert.rejects(htmlToPdf('<p>Alex Example</p>', { chromeBin: '' }), (error) => {
    assert.equal(error.code, 'render_failed');
    assert.equal(error.status, 422);
    assert.match(error.message, /Install Google Chrome or Chromium.*CHROME_BIN/);
    return true;
  });
});

test('PDF printing passes isolated paths and required flags, ignores stderr on success, and cleans up', async (t) => {
  const fixture = await fakeChrome(t, `${fakePrint}
import { fileURLToPath } from 'node:url';
const input = fileURLToPath(process.argv.at(-1));
const { readFileSync } = await import('node:fs');
writeFileSync(new URL('./capture.json', import.meta.url), JSON.stringify({ args: process.argv.slice(2), input, html: readFileSync(input, 'utf8') }));
process.stderr.write('task_policy_set: harmless macOS noise');
process.exitCode = 7;
`);
  if (!fixture) return;
  const html = '<!doctype html><p>Alex Example</p>';
  const result = await htmlToPdf(html, { chromeBin: fixture.executable, docker: true });
  assert.equal(result.pages, 1);
  assert.ok(Buffer.isBuffer(result.pdf));
  assert.equal(result.pdf.subarray(0, 5).toString(), '%PDF-');
  const capture = JSON.parse(await readFile(join(fixture.directory, 'capture.json'), 'utf8'));
  assert.equal(capture.html, html);
  for (const flag of ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', '--hide-scrollbars',
    '--run-all-compositor-stages-before-draw', '--virtual-time-budget=2000', '--no-sandbox', '--disable-dev-shm-usage']) {
    assert.ok(capture.args.includes(flag), flag);
  }
  assert.ok(capture.args.some((arg) => arg.startsWith('--user-data-dir=')));
  assert.match(capture.args.at(-1), /^file:\/\//);
  assert.equal(existsSync(capture.input), false);
  assert.equal(existsSync(capture.args.find((arg) => arg.startsWith('--print-to-pdf=')).slice('--print-to-pdf='.length)), false);
});

test('no-output failures include Chrome stderr and remove temporary files', async (t) => {
  const fixture = await fakeChrome(t, `
import { writeFileSync } from 'node:fs';
writeFileSync(new URL('./args.json', import.meta.url), JSON.stringify(process.argv));
process.stderr.write('Chrome could not open the document');
process.exitCode = 1;
`);
  if (!fixture) return;
  await assert.rejects(htmlToPdf('<p>Alex Example</p>', { chromeBin: fixture.executable }), (error) => {
    assert.equal(error.code, 'render_failed');
    assert.match(error.message, /Chrome could not open the document/);
    return true;
  });
  const args = JSON.parse(await readFile(join(fixture.directory, 'args.json'), 'utf8'));
  const profile = args.find((arg) => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
  assert.equal(existsSync(dirname(profile)), false);
  if (process.getuid?.() !== 0) {
    assert.ok(!args.includes('--no-sandbox'));
    assert.ok(!args.includes('--disable-dev-shm-usage'));
  } else {
    assert.ok(args.includes('--no-sandbox'));
    assert.ok(args.includes('--disable-dev-shm-usage'));
  }
});

test('timeouts, malformed output, and invalid timeout options produce render_failed', async (t) => {
  const fixture = await fakeChrome(t, 'setTimeout(() => {}, 10000);');
  if (!fixture) return;
  await assert.rejects(htmlToPdf('<p>Alex Example</p>', { chromeBin: fixture.executable, timeoutMs: 100 }), (error) => {
    assert.equal(error.code, 'render_failed');
    assert.match(error.message, /timed out after 100 ms/);
    return true;
  });
  await writeFile(fixture.executable, `#!${process.execPath}\n${fakePrint.replace('%PDF-1.4', 'invalid')}`);
  await assert.rejects(htmlToPdf('text', { chromeBin: fixture.executable }), /valid PDF/);
  await writeFile(fixture.executable, `#!${process.execPath}\n${fakePrint.replace('/Count 1', '/Count invalid')}`);
  await assert.rejects(htmlToPdf('text', { chromeBin: fixture.executable }), /no readable page tree/);
  for (const timeoutMs of [0, -1, Infinity, NaN]) {
    await assert.rejects(htmlToPdf('text', { chromeBin: fixture.executable, timeoutMs }), /timeoutMs must be a positive number/);
  }
});

test('the render queue permits at most two Chrome processes and releases slots after failures', async (t) => {
  const fixture = await fakeChrome(t, `
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const log = new URL('./events.txt', import.meta.url);
appendFileSync(log, 'start ' + process.pid + '\\n');
await new Promise((resolve) => setTimeout(resolve, 80));
if (readFileSync(fileURLToPath(process.argv.at(-1)), 'utf8').includes('fail')) {
  appendFileSync(log, 'end ' + process.pid + '\\n');
  process.stderr.write('Intentional fixture failure');
  process.exit(1);
}
${fakePrint}
appendFileSync(log, 'end ' + process.pid + '\\n');
`);
  if (!fixture) return;
  const results = await Promise.allSettled(Array.from({ length: 5 }, (_, index) => htmlToPdf(index < 2 ? 'fail' : `<p>${index}</p>`, {
    chromeBin: fixture.executable, docker: index % 2 === 0
  })));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 3);
  for (const result of results) {
    if (result.status === 'fulfilled') assert.equal(result.value.pages, 1);
    else assert.equal(result.reason.code, 'render_failed');
  }
  let active = 0;
  let maximum = 0;
  for (const event of (await readFile(join(fixture.directory, 'events.txt'), 'utf8')).trim().split('\n')) {
    active += event.startsWith('start') ? 1 : -1;
    maximum = Math.max(maximum, active);
    assert.ok(active >= 0 && active <= 2, event);
  }
  assert.equal(maximum, 2);
  assert.equal(active, 0);
});

const builtinDir = fileURLToPath(new URL('../templates/builtin/', import.meta.url));
const chromeBin = findChrome();

test('built-in samples print within their declared page limits without text extraction tools', { concurrency: 2 }, async (t) => {
  const templates = await loadBuiltinTemplates(builtinDir);
  const jobs = [];
  for (const [id, template] of templates) {
    for (const language of ['en', 'ru']) {
      jobs.push(t.test(`${id} ${language} PDF`, async (t) => {
        if (!chromeBin) {
          t.skip('Chrome/Chromium was not found; install it or set CHROME_BIN to run PDF integration checks.');
          return;
        }
        const sample = language === 'en' ? template.sample
          : JSON.parse(await readFile(join(builtinDir, id, 'sample.ru.json'), 'utf8'));
        const context = buildContext({ profile: { identity: sample.profile_identity }, meta: template.meta,
          resume: sample.resume, cover: sample.cover });
        const { html, pdf, pages } = await renderPdf({ ...template, context, chrome: chromeBin });
        assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
        assert.ok(pdf.length > 5 * 1024, `${id} ${language}: expected a PDF larger than 5 KB, received ${pdf.length} bytes`);
        assert.ok(pages >= 1 && pages <= template.meta.max_pages, `${id} ${language}: ${pages} pages exceeds max_pages=${template.meta.max_pages}`);
        assert.equal(countPages(pdf), pages);
        assert.doesNotMatch(html, /{{/);
      }));
    }
  }
  await Promise.all(jobs);
});
