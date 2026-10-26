import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBuiltinTemplates } from '../server/render/builtin.js';
import { buildContext } from '../server/render/context.js';
import { DEFAULT_LABELS, labelsFor } from '../server/render/labels.js';
import { renderHtml } from '../server/render/index.js';

const builtinDir = fileURLToPath(new URL('../templates/builtin/', import.meta.url));
const templates = await loadBuiltinTemplates(builtinDir);

test('all four built-in templates load with their declared metadata and full samples', () => {
  assert.deepEqual([...templates.keys()], ['classic', 'compact', 'letter', 'modern']);
  for (const [id, template] of templates) {
    assert.equal(template.id, id);
    assert.equal(template.builtin, true);
    assert.equal(template.meta.version, 1);
    assert.equal(template.meta.kind, id === 'letter' ? 'cover' : 'resume');
    assert.equal(template.meta.paper, id === 'modern' ? 'a4' : 'letter');
    assert.equal(template.meta.max_pages, id === 'modern' ? 2 : 1);
    assert.deepEqual(template.meta.languages, ['en', 'ru']);
    assert.equal(template.sample.resume.experience.length, 3);
    assert.ok(template.sample.resume.experience.every((entry) => entry.bullets.length === 3));
    assert.equal(template.sample.resume.projects.length, 3);
    assert.equal(template.sample.resume.skills.length, 4);
    assert.ok(template.sample.resume.education.length > 0);
  }
});

for (const [id, template] of templates) {
  for (const lang of ['en', 'ru']) {
    test(`${id} renders a complete, localized ${lang} document from its sample`, async () => {
      const sample = lang === 'en' ? template.sample : JSON.parse(await readFile(join(builtinDir, id, 'sample.ru.json'), 'utf8'));
      const context = buildContext({
        profile: { identity: sample.profile_identity }, meta: template.meta, resume: sample.resume, cover: sample.cover
      });
      const html = renderHtml({ ...template, context });
      assert.doesNotMatch(html, /{{/);
      assert.match(html, /^<!doctype html>/i);
      assert.match(html, new RegExp(`<html lang="${lang}">`));
      assert.match(html, /<meta charset="utf-8">/);
      assert.ok(html.includes(lang === 'ru' ? 'Алекс Пример' : 'Alex Example'));
      assert.match(html, /<a href="https:\/\/example\.com\/">/);
      assert.match(html, /<a href="mailto:alex@example\.com">/);
      assert.match(html, /@page\s*{\s*size: (Letter|A4);/);
      assert.match(html, /print-color-adjust: exact/);
      assert.match(html, /break-inside: avoid/);
      assert.doesNotMatch(html, /<script|<img|<table|<link\b|@import|url\(/i);
      if (id === 'letter') {
        assert.ok(html.includes(DEFAULT_LABELS[lang].greeting));
        assert.ok(html.includes(DEFAULT_LABELS[lang].closing));
        assert.match(html, /<main>\s*<p>/);
        assert.doesNotMatch(html, /<time\b/);
      } else {
        for (const section of ['summary', 'experience', 'projects', 'skills', 'education']) {
          assert.ok(html.includes(`<h2 id="${section}">${DEFAULT_LABELS[lang][section]}</h2>`));
        }
        assert.match(html, /<ul>/);
        assert.match(html, /<li>/);
      }
    });
  }

  test(`${id} hides empty content and contact fields`, () => {
    const context = buildContext({
      meta: template.meta,
      profile: { identity: { name: 'Alex Example' } },
      resume: { summary: '', experience: [], projects: [], skills: [], education: [] },
      cover: { text: '' }
    });
    const html = renderHtml({ ...template, context });
    assert.doesNotMatch(html, /<section|<h2|<article|<a href|<p class="availability"|<p class="headline"/);
    if (id === 'letter') assert.doesNotMatch(html, /<main>|Hello,|Sincerely,/);
  });
}

test('labels merge localized overrides, defaults, English overrides, and English defaults in order', () => {
  const meta = { labels: {
    en: { summary: 'English custom', onlyEnglish: 'Extra', greeting: 'Dear team,' },
    ru: { experience: 'Мой опыт', onlyRussian: 'Дополнительно' },
    de: { summary: 'Zusammenfassung' }
  } };
  const ru = labelsFor(meta, 'ru');
  assert.equal(ru.experience, 'Мой опыт');
  assert.equal(ru.summary, DEFAULT_LABELS.ru.summary);
  assert.equal(ru.greeting, DEFAULT_LABELS.ru.greeting);
  assert.equal(ru.onlyEnglish, 'Extra');
  assert.equal(ru.onlyRussian, 'Дополнительно');
  assert.equal(labelsFor(meta, 'en').summary, 'English custom');
  assert.equal(labelsFor(meta, 'de').summary, 'Zusammenfassung');
  assert.equal(labelsFor(meta, 'de').greeting, 'Dear team,');
  assert.equal(labelsFor(meta, 'de').experience, DEFAULT_LABELS.en.experience);
  assert.equal(labelsFor(meta, 'unknown').closing, 'Sincerely,');
  assert.deepEqual(labelsFor(undefined, 'ru'), DEFAULT_LABELS.ru);
  assert.deepEqual(labelsFor({}, 'unknown'), DEFAULT_LABELS.en);
  const copy = labelsFor({}, 'en');
  copy.summary = 'changed';
  assert.equal(DEFAULT_LABELS.en.summary, 'Summary');
  for (const lang of ['en', 'ru']) {
    for (const key of ['summary', 'experience', 'projects', 'skills', 'education', 'languages', 'links', 'availability', 'contact', 'greeting', 'closing']) {
      assert.equal(typeof DEFAULT_LABELS[lang][key], 'string');
    }
  }
});

test('context exposes only resolved identity, content, and render helpers', () => {
  const profile = {
    identity: {
      name: 'Alex Example', name_localized: { ru: 'Алекс Пример' }, email: 'alex@example.com',
      phone: '', location: 'Remote', availability: { en: 'Remote', ru: 'Удалённо' },
      links: [{ label: 'Site', url: 'https://example.com/path/', private: 'hidden' }], private: 'hidden'
    },
    about: 'Private profile notes', do_not_claim: ['Private rules'], experience: ['Private facts']
  };
  const resume = { language: 'ru', extra: { custom: 'retained' } };
  const cover = { language: 'en', text: 'One\n\nTwo' };
  const before = structuredClone(profile);
  const context = buildContext({ profile, meta: { kind: 'resume', paper: 'a4' }, resume, cover, lang: 'en' });
  assert.deepEqual(Object.keys(context).sort(), ['identity', 'lang', 'labels', 'paper', 'resume', 'cover', 'paragraphs'].sort());
  assert.deepEqual(context.identity, {
    name: 'Алекс Пример', email: 'alex@example.com', phone: '', location: 'Remote', availability: 'Удалённо',
    links: [{ label: 'Site', url: 'https://example.com/path/', display: 'example.com/path' }]
  });
  assert.equal(context.lang, 'ru');
  assert.equal(context.paper, 'a4');
  assert.equal(context.resume, resume);
  assert.equal(context.cover, cover);
  assert.deepEqual(context.paragraphs, ['One', 'Two']);
  assert.deepEqual(profile, before);
  assert.equal(buildContext({ profile, meta: { kind: 'cover' }, resume, cover, lang: 'ru' }).lang, 'en');
});

test('context falls back through language, identity, availability, and optional content defaults', () => {
  const profile = { identity: { name: 'Alex Example', availability: { ru: 'Удалённо', en: 'Remote' }, links: [
    { label: 'Site', url: 'http://example.com/' }, { label: 'Site', url: 'https://example.com///' }
  ] } };
  const context = buildContext({ profile, meta: { kind: 'resume' }, lang: 'de' });
  assert.equal(context.lang, 'de');
  assert.equal(context.identity.name, 'Alex Example');
  assert.equal(context.identity.availability, 'Remote');
  assert.deepEqual(context.identity.links.map((link) => link.display), ['example.com', 'example.com']);
  assert.deepEqual(context.paragraphs, []);
  assert.equal(buildContext({ profile: { identity: { availability: { ru: 'Удалённо' } } }, lang: 'de' }).identity.availability, 'Удалённо');
  assert.equal(buildContext({ cover: { language: 'ru' } }).lang, 'ru');
  assert.equal(buildContext({ resume: { language: 'ru' }, cover: { language: 'en' }, lang: 'de' }).lang, 'ru');
  assert.equal(buildContext({}).lang, 'en');
  assert.deepEqual(buildContext({}).identity, { name: '', email: '', phone: '', location: '', availability: '', links: [] });
});

test('HTML rendering wraps syntax failures in the shared render_failed API error', () => {
  assert.throws(() => renderHtml({ meta: { id: 'classic' }, source: '\n{{#if value}}', context: {} }), (error) => {
    assert.equal(error.code, 'render_failed');
    assert.equal(error.status, 422);
    assert.match(error.message, /classic.*line 2.*Fix template\.html/);
    return true;
  });
});

test('built-in metadata validation names the file, invalid field, and repair', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'jobforge-template-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const folder = join(directory, 'classic');
  await mkdir(folder);
  const valid = templates.get('classic').meta;
  await writeFile(join(folder, 'template.html'), '<!doctype html>');
  await writeFile(join(folder, 'sample.json'), '{}');
  const cases = [
    [null, 'metadata object'],
    [{ ...valid, id: 'other' }, 'id'],
    [{ ...valid, kind: 'other' }, 'kind'],
    [{ ...valid, version: 1.2 }, 'version'],
    [{ ...valid, paper: 'legal' }, 'paper'],
    [{ ...valid, max_pages: 0 }, 'max_pages'],
    [{ ...valid, max_pages: 1.5 }, 'max_pages'],
    [{ ...valid, languages: 'en' }, 'languages'],
    [{ ...valid, languages: [42] }, 'languages'],
    [{ ...valid, labels: [] }, 'labels'],
    [{ ...valid, labels: { en: null } }, 'labels.en'],
    [{ ...valid, labels: { en: { summary: 42 } } }, 'labels.en']
  ];
  for (const [meta, field] of cases) {
    await writeFile(join(folder, 'meta.json'), JSON.stringify(meta));
    await assert.rejects(loadBuiltinTemplates(directory), (error) => {
      assert.ok(error.message.includes(join(folder, 'meta.json')));
      assert.ok(error.message.includes(field));
      return true;
    });
  }
  await writeFile(join(folder, 'meta.json'), '{invalid');
  await assert.rejects(loadBuiltinTemplates(directory), /meta\.json: Could not read valid JSON/);
  await writeFile(join(folder, 'meta.json'), JSON.stringify(valid));
  await writeFile(join(folder, 'sample.json'), '{invalid');
  await assert.rejects(loadBuiltinTemplates(directory), /sample\.json: Could not read valid JSON/);
  await writeFile(join(folder, 'sample.json'), '{}');
  assert.equal((await loadBuiltinTemplates(directory)).get('classic').builtin, true);
});
