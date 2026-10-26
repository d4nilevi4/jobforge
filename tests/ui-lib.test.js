import test from 'node:test';
import assert from 'node:assert/strict';
import { plural, relativeTime, statusLabel, statuses, legalActions, parseHashRoute, routeChanged, stripToken, resolveResumeRoute, splitTemplateRef, templateOptions, selectedTemplateRef, templatePreviewPath, createDocumentCache, buildBaseFromProfile, cleanProfile, linesToArray, arrayToLines, slugValid, diffKeys, formatBytes } from '../ui/js/lib.js';

test('plural selects the singular only for one and supports irregular forms', () => {
  assert.equal(plural(1, 'warning', 'warnings'), 'warning');
  for (const count of [0, 2, 50, -1, 1.5]) assert.equal(plural(count, 'warning', 'warnings'), 'warnings');
  assert.equal(plural(1, 'person', 'people'), 'person');
  assert.equal(plural(2, 'person', 'people'), 'people');
  assert.equal(plural(1, 'application', 'applications'), 'application');
  assert.equal(plural(1, 'revision', 'revisions'), 'revision');
  assert.equal(plural(2, 'page', 'pages'), 'pages');
});

test('relativeTime handles boundaries, future dates, and invalid input', () => {
  const now = Date.parse('2026-01-02T12:00:00Z');
  const at = seconds => new Date(now - seconds * 1000).toISOString();
  for (const [seconds, expected] of [[0, 'Just now'], [59, 'Just now'], [60, '1 minute ago'], [3599, '59 minutes ago'], [3600, '1 hour ago'], [7200, '2 hours ago'], [86400, '1 day ago'], [2592000, '1 month ago'], [31536000, '1 year ago'], [-120, 'In 2 minutes']]) assert.equal(relativeTime(at(seconds), now), expected);
  assert.equal(relativeTime(at(60), new Date(now)), '1 minute ago');
  assert.equal(relativeTime(at(60), new Date(now).toISOString()), '1 minute ago');
  for (const value of ['', null, 'invalid']) assert.equal(relativeTime(value, now), 'Unknown');
  assert.equal(relativeTime(at(0), NaN), 'Unknown');
});

test('statusLabel names all supported statuses and preserves an unknown status', () => {
  assert.deepEqual(statuses.map(statusLabel), ['Draft', 'Needs review', 'Approved', 'Sent', 'Interview', 'Offer', 'Rejected', 'Skipped']);
  assert.equal(statusLabel('queued'), 'queued');
  assert.equal(statusLabel(null), 'Unknown');
  assert.equal(statusLabel('constructor'), 'constructor');
});

test('legalActions follows the specified order for every status', () => {
  const expected = {
    draft: ['approved', 'needs_review', 'skipped'], needs_review: ['approved', 'draft', 'skipped'],
    approved: ['sent', 'draft'], sent: ['interview', 'rejected'], interview: ['offer', 'rejected'],
    offer: ['rejected'], rejected: ['draft'], skipped: ['draft']
  };
  for (const [status, actions] of Object.entries(expected)) assert.deepEqual(legalActions(status, { hasResume: true }).map(action => action.status), actions);
  assert.deepEqual(legalActions('draft')[0], { status: 'approved', label: 'Approve', primary: true });
  assert.deepEqual(legalActions('draft')[1], { status: 'needs_review', label: 'Needs review', needsNote: true });
  assert.deepEqual(legalActions('sent')[1], { status: 'rejected', label: 'Rejected', needsNote: true });
  assert.equal(legalActions('approved')[0].label, 'Mark as sent');
  assert.equal(legalActions('needs_review')[1].label, 'Back to draft');
  assert.equal(legalActions('skipped', { hasResume: true })[0].label, 'Reopen as draft');
  assert.deepEqual(legalActions('rejected', { hasResume: true }), [{ status: 'draft', label: 'Reopen as draft', primary: true }]);
  assert.equal(legalActions('skipped', { hasResume: true })[0].note, undefined);
  const [reopen] = legalActions('skipped');
  assert.equal(reopen.status, 'draft');
  assert.equal(reopen.label, 'Reopen as draft');
  assert.match(reopen.note, /only changes the status/);
  assert.match(reopen.note, /file documents with PUT.*before.*approved/);
  assert.deepEqual(legalActions('skipped', { hasResume: false }), [reopen]);
  for (const status of ['rejected', 'unknown', 'constructor', '__proto__']) assert.deepEqual(legalActions(status), []);
  const actions = legalActions('draft');
  actions[0].label = 'Changed';
  assert.equal(legalActions('draft')[0].label, 'Approve');
});

test('hash routing supports every screen, encoded ids, and default applications', () => {
  for (const hash of ['', '#', '#/']) assert.deepEqual(parseHashRoute(hash), { path: ['applications'] });
  for (const path of ['applications', 'applications/42', 'profile', 'resumes', 'resumes/+new', 'resumes/new', 'resumes/create', 'resumes/backend', 'templates', 'templates/classic', 'settings']) assert.deepEqual(parseHashRoute(`#/${path}`), { path: path.split('/') });
  assert.deepEqual(parseHashRoute('#/resumes/%2Bnew?unused=1'), { path: ['resumes', '+new'] });
  assert.equal(slugValid(parseHashRoute('#/resumes/+new').path[1]), false);
  assert.deepEqual(parseHashRoute('#/templates/custom%2Dexample'), { path: ['templates', 'custom-example'] });
  assert.deepEqual(parseHashRoute('#/resumes/%invalid'), { path: ['resumes', '%invalid'] });
});

test('routeChanged resets navigation for a new path while ignoring query-only changes', () => {
  for (const previous of [null, undefined]) assert.equal(routeChanged(previous, '#/applications'), true);
  const unchanged = [
    ['', '#/applications'], ['#/', '#/applications'],
    ['#/profile', '#/profile'], ['#/applications?q=first', '#/applications?q=second&status=draft'],
    ['#/settings?tab=tokens', '#/settings'], ['#/profile&token=old', '#/profile?token=new'],
    ['#/resumes/+new', '#/resumes/%2Bnew'],
    ['#/resumes/example', '#/resumes/%65xample'], ['#/resumes/%invalid', '#/resumes/%invalid']
  ];
  for (const [previous, next] of unchanged) assert.equal(routeChanged(previous, next), false, `${previous} -> ${next}`);
  const changed = [
    ['#/applications', '#/profile'], ['#/applications', '#/applications/1'],
    ['#/applications/1?q=keep', '#/applications/2?q=keep'],
    ['#/resumes/a%2Fb', '#/resumes/a/b'], ['#/templates/classic', '#/templates/compact'],
    ['#/resumes/new', '#/resumes/+new'], ['#/resumes/create', '#/resumes/+new'],
    ['#/settings', '#/applications?source=settings']
  ];
  for (const [previous, next] of changed) assert.equal(routeChanged(previous, next), true, `${previous} -> ${next}`);
});

test('fragment tokens are decoded, stripped, and never left in the route', () => {
  const cases = [
    ['#token=secret', '#/applications', ['applications'], 'secret'],
    ['#/applications&token=abc%2B123%3D', '#/applications', ['applications'], 'abc+123='],
    ['#/settings?token=secret&view=tokens', '#/settings?view=tokens', ['settings'], 'secret'],
    ['#/resumes/new&foo=1&token=secret&bar=2', '#/resumes/new&foo=1&bar=2', ['resumes', 'new'], 'secret'],
    ['#token=old&token=new', '#/applications', ['applications'], 'new'],
    ['#/applications&token=', '#/applications', ['applications'], ''],
    ['#token=x&/settings', '#/settings', ['settings'], 'x'],
    ['#/applications&token=%bad', '#/applications', ['applications'], '%bad']
  ];
  for (const [hash, clean, path, token] of cases) {
    assert.equal(stripToken(hash), clean);
    assert.deepEqual(parseHashRoute(hash), { path, token });
    assert.equal(parseHashRoute(stripToken(hash)).token, undefined);
  }
  assert.equal(stripToken('#/settings&other_token=keep'), '#/settings&other_token=keep');
});

test('resume creation cannot collide with track ids and the legacy new route prefers the stored track', async () => {
  const calls = [];
  const getTrack = async id => {
    calls.push(id);
    return { track: { name: `Track ${id}` } };
  };
  assert.deepEqual(await resolveResumeRoute(parseHashRoute('#/resumes/+new').path[1], getTrack), { creating: true, existing: null });
  assert.deepEqual(calls, []);
  for (const id of ['new', 'create', 'backend']) {
    assert.deepEqual(await resolveResumeRoute(parseHashRoute(`#/resumes/${id}`).path[1], getTrack), { creating: false, existing: { track: { name: `Track ${id}` } } });
  }
  assert.deepEqual(calls, ['new', 'create', 'backend']);
  const missing = Object.assign(new Error('Track does not exist.'), { status: 404 });
  const fail = async () => { throw missing; };
  assert.deepEqual(await resolveResumeRoute('new', fail), { creating: true, existing: null });
  await assert.rejects(resolveResumeRoute('create', fail), error => error === missing);
  for (const status of [401, 403, 500]) {
    const error = Object.assign(new Error('Request failed.'), { status });
    await assert.rejects(resolveResumeRoute('new', async () => { throw error; }), actual => actual === error);
  }
});

test('splitTemplateRef accepts ids and safe positive versions and rejects malformed references', () => {
  assert.deepEqual(splitTemplateRef('classic'), { id: 'classic', version: undefined });
  assert.deepEqual(splitTemplateRef('classic@1'), { id: 'classic', version: 1 });
  assert.deepEqual(splitTemplateRef('custom-x@12'), { id: 'custom-x', version: 12 });
  assert.deepEqual(splitTemplateRef(`custom-x@${Number.MAX_SAFE_INTEGER}`), { id: 'custom-x', version: Number.MAX_SAFE_INTEGER });
  for (const ref of ['', null, undefined, 12, {}, 'Classic', '-classic', 'classic@', '@1', 'classic@0', 'classic@01', 'classic@-1', 'classic@1.5', 'classic@1@2', 'classic@9007199254740992', 'classic/path', 'classic_x', ' classic', 'classic@1\n']) {
    assert.throws(() => splitTemplateRef(ref), /Template reference.*id@version.*positive integer/);
  }
});

test('template choices select the id while saving and previewing preserves a pinned reference', () => {
  const items = [{ id: 'classic', name: 'Classic' }, { id: 'compact', name: 'Compact' }];
  const options = templateOptions(items, 'classic@1');
  assert.deepEqual(options, [{ value: 'classic', label: 'Classic', selected: true }, { value: 'compact', label: 'Compact', selected: false }]);
  assert.equal(selectedTemplateRef('classic@1', options.find(option => option.selected).value), 'classic@1');
  assert.equal(selectedTemplateRef('classic@1', 'compact'), 'compact');
  assert.equal(selectedTemplateRef('classic', 'classic'), 'classic');
  assert.deepEqual(templateOptions(items, 'custom-x@12').at(-1), { value: 'custom-x', label: 'custom-x@12 (current)', selected: true });
  assert.equal(items.length, 2);
  assert.equal(templatePreviewPath('classic'), '/templates/classic/preview?format=html');
  assert.equal(templatePreviewPath('classic@1'), '/templates/classic/preview?format=html&version=1');
  assert.equal(templatePreviewPath('custom-x@12'), '/templates/custom-x/preview?format=html&version=12');
});

test('cover choices keep an empty default optional and preserve pinned covers', () => {
  const items = [{ id: 'letter', name: 'Letter' }];
  const options = templateOptions(items, '', { allowEmpty: true });
  assert.deepEqual(options, [{ value: '', label: 'No default cover letter', selected: true }, { value: 'letter', label: 'Letter', selected: false }]);
  assert.equal(selectedTemplateRef('', options.find(option => option.selected).value), '');
  assert.equal(selectedTemplateRef('letter@1', ''), '');
  assert.equal(selectedTemplateRef('', 'letter'), 'letter');
  assert.deepEqual(templateOptions([], '', { allowEmpty: true }), [options[0]]);
  const pinned = templateOptions(items, 'letter@1', { allowEmpty: true });
  assert.equal(pinned[0].selected, false);
  assert.equal(selectedTemplateRef('letter@1', pinned.find(option => option.selected).value), 'letter@1');
});

function documentCache(loadBlob) {
  const created = [];
  const revoked = [];
  const cache = createDocumentCache(loadBlob, {
    createObjectURL(blob) { created.push(blob); return `blob:test-${created.length}`; },
    revokeObjectURL(url) { revoked.push(url); }
  });
  return { cache, created, revoked };
}

test('document cache shares pending fetches and reuses one URL per document until leaving the view', async () => {
  const requests = [];
  const { cache, created, revoked } = documentCache(async file => { requests.push(file); return new Blob([file]); });
  const first = cache.get('resume.pdf', '/resume.pdf');
  assert.equal(cache.get('resume.pdf', '/resume.pdf'), first);
  const resume = await first;
  const cover = await cache.get('cover.pdf', '/cover.pdf');
  assert.equal(await cache.get('resume.pdf', '/resume.pdf'), resume);
  assert.equal(await cache.get('cover.pdf', '/cover.pdf'), cover);
  assert.deepEqual(requests, ['/resume.pdf', '/cover.pdf']);
  assert.equal(created.length, 2);
  assert.deepEqual(revoked, []);
  cache.dispose();
  assert.deepEqual(revoked, [resume, cover]);
  cache.dispose();
  assert.deepEqual(revoked, [resume, cover]);
  assert.equal(await cache.get('resume.pdf', '/resume.pdf'), null);
  assert.equal(requests.length, 2);
});

test('re-fetching a document revokes its previous URL and leaves other documents cached', async () => {
  const { cache, created, revoked } = documentCache(async file => new Blob([file]));
  const resume = await cache.get('resume.pdf', '/resume.pdf');
  const cover = await cache.get('cover.pdf', '/cover.pdf');
  const reloading = cache.get('resume.pdf', '/resume.pdf', { reload: true });
  assert.deepEqual(revoked, [resume]);
  const refreshed = await reloading;
  assert.notEqual(refreshed, resume);
  assert.equal(await cache.get('cover.pdf', '/cover.pdf'), cover);
  const changed = await cache.get('resume.pdf', '/resume.pdf?revision=2');
  assert.deepEqual(revoked, [resume, refreshed]);
  assert.equal(created.length, 4);
  cache.dispose();
  assert.deepEqual(revoked, [resume, refreshed, changed, cover]);
});

test('document cache retries failed fetches without retaining a stale URL', async () => {
  let fail = false;
  const error = new Error('PDF request failed.');
  const { cache, created, revoked } = documentCache(async () => { if (fail) throw error; return new Blob(['PDF']); });
  const original = await cache.get('resume.pdf', '/resume.pdf');
  fail = true;
  await assert.rejects(cache.get('resume.pdf', '/resume.pdf', { reload: true }), actual => actual === error);
  assert.deepEqual(revoked, [original]);
  fail = false;
  const retried = await cache.get('resume.pdf', '/resume.pdf');
  assert.notEqual(retried, original);
  assert.equal(created.length, 2);
  cache.dispose();
  assert.deepEqual(revoked, [original, retried]);
});

test('pending document fetches cannot create URLs after leaving or replacing the document', async () => {
  const finish = [];
  const { cache, created, revoked } = documentCache(() => new Promise(resolve => finish.push(resolve)));
  const old = cache.get('resume.pdf', '/resume.pdf');
  const current = cache.get('resume.pdf', '/resume.pdf', { reload: true });
  await Promise.resolve();
  finish[1](new Blob(['new PDF']));
  const url = await current;
  finish[0](new Blob(['old PDF']));
  assert.equal(await old, null);
  assert.equal(created.length, 1);
  const pending = cache.get('cover.pdf', '/cover.pdf');
  await Promise.resolve();
  cache.dispose();
  assert.deepEqual(revoked, [url]);
  finish[2](new Blob(['cover PDF']));
  assert.equal(await pending, null);
  assert.equal(created.length, 1);
});

const profile = {
  schema_version: 1,
  identity: { name: 'Alex Example', email: 'alex@example.com' },
  experience: [{ id: 'example', company: 'Example Studio', title: 'Engineer', dates: '2021 - 2024', location: '', bullets: ['Built a tool.'] }],
  projects: [{ id: 'tool', title: 'Tool', tech: 'Node.js', link: 'https://example.com', link_label: 'Website', bullets: ['Released the tool.'] }],
  skills: [{ key: 'tools', label: 'Tools', label_localized: { ru: 'Инструменты' }, items: ['Node.js', 'SQLite'] }],
  education: [{ institution: 'Example University', degree: 'BSc', years: '2016 - 2020' }]
};

test('buildBaseFromProfile copies exact facts without profile-only fields or shared references', () => {
  const before = structuredClone(profile);
  const base = buildBaseFromProfile(profile);
  assert.deepEqual(base, {
    schema_version: 1, language: 'en', headline: 'Engineer', summary: '',
    experience: [{ company: 'Example Studio', title: 'Engineer', dates: '2021 - 2024', location: '', bullets: ['Built a tool.'] }],
    projects: [{ title: 'Tool', tech: 'Node.js', link: 'https://example.com', link_label: 'Website', bullets: ['Released the tool.'] }],
    skills: [{ label: 'Tools', items: 'Node.js, SQLite' }],
    education: [{ institution: 'Example University', degree: 'BSc', years: '2016 - 2020' }]
  });
  base.experience[0].bullets.push('Changed');
  base.projects[0].title = 'Changed';
  base.education[0].degree = 'Changed';
  assert.deepEqual(profile, before);
  assert.equal(buildBaseFromProfile(profile, 'ru').skills[0].label, 'Инструменты');
  assert.equal(buildBaseFromProfile(profile, 'es').skills[0].label, 'Tools');
  assert.equal(buildBaseFromProfile({ ...profile, identity: { role_default: 'Developer' } }).headline, 'Developer');
});

test('buildBaseFromProfile handles an empty profile and missing optional arrays', () => {
  assert.deepEqual(buildBaseFromProfile(null), { schema_version: 1, language: 'en', headline: '', summary: '', experience: [], projects: [], skills: [], education: [] });
  const base = buildBaseFromProfile({ experience: [{ company: 'Example', title: 'Engineer', dates: '' }], projects: [{ title: 'Tool' }] });
  assert.deepEqual(base.experience[0].bullets, []);
  assert.deepEqual(base.projects[0].bullets, []);
});

test('cleanProfile removes empty optional values recursively and keeps required keys', () => {
  const input = { schema_version: 1, identity: { name: '', email: ' ', links: [], availability: { en: '', ru: 'Remote' } }, experience: [], skills: [], projects: [], rules: { notes: '', forbid_patterns: [], cover_max_words: 160 }, about: '', familiar: [{}] };
  const before = structuredClone(input);
  assert.deepEqual(cleanProfile(input), { schema_version: 1, identity: { name: '', availability: { ru: 'Remote' } }, experience: [], skills: [], rules: { cover_max_words: 160 } });
  assert.deepEqual(input, before);
  assert.deepEqual(cleanProfile({}), { schema_version: 1, identity: { name: '' }, experience: [], skills: [] });
  assert.deepEqual(cleanProfile(null), cleanProfile({}));
});

test('cleanProfile preserves required nested arrays and strings while dropping empty rows', () => {
  const result = cleanProfile({ identity: { name: 'Alex Example', links: [{ label: 'Website', url: 'https://example.com' }] }, experience: [{ company: 'Example', title: '', dates: '', bullets: [] }, {}], skills: [{ key: 'tools', label: 'Tools', items: [] }], projects: [{ title: 'Tool', bullets: [] }], education: [{ institution: 'Example University', degree: '', years: '' }] });
  assert.deepEqual(result.experience, [{ company: 'Example', title: '', dates: '', bullets: [] }]);
  assert.deepEqual(result.skills, [{ key: 'tools', label: 'Tools', items: [] }]);
  assert.deepEqual(result.projects, [{ title: 'Tool', bullets: [] }]);
  assert.deepEqual(result.education, [{ institution: 'Example University', degree: '', years: '' }]);
  assert.equal(cleanProfile({ ...profile, rules: { cover_max_words: 0 }, about: '  Keep exact spacing  ' }).rules.cover_max_words, 0);
  assert.equal(cleanProfile({ ...profile, about: '  Keep exact spacing  ' }).about, '  Keep exact spacing  ');
});

test('line helpers trim bullet boundaries and retain text and regex contents', () => {
  assert.deepEqual(linesToArray(' First\r\n\r\n Second \n\\bteam lead\\b\n'), ['First', 'Second', '\\bteam lead\\b']);
  assert.deepEqual(linesToArray(''), []);
  assert.deepEqual(linesToArray(null), []);
  assert.equal(arrayToLines(['One', 'Two']), 'One\nTwo');
  assert.equal(arrayToLines(), '');
  assert.deepEqual(linesToArray(arrayToLines(['One', 'Two'])), ['One', 'Two']);
});

test('slugValid enforces the exact track id pattern and length', () => {
  for (const id of ['a', '0', 'unity-developer', 'a-', 'a'.repeat(63)]) assert.equal(slugValid(id), true, id);
  for (const id of ['', '-a', 'A', 'two words', 'a_b', 'a/b', 'a'.repeat(64), null, 12, 'é']) assert.equal(slugValid(id), false, String(id));
});

test('diffKeys compares top-level values deeply without depending on object key order', () => {
  assert.deepEqual(diffKeys({ a: 1, b: { x: 2, y: 3 }, c: [] }, { a: 2, b: { y: 3, x: 2 }, d: false }), ['a', 'c', 'd']);
  assert.deepEqual(diffKeys({ a: [1, 2] }, { a: [2, 1] }), ['a']);
  assert.deepEqual(diffKeys({ a: null }, { a: [] }), ['a']);
  assert.deepEqual(diffKeys(), []);
  assert.deepEqual(diffKeys(null, { identity: {} }), ['identity']);
});

test('formatBytes reports readable binary units including boundary values', () => {
  for (const [value, expected] of [[0, '0 B'], [-1, '0 B'], [NaN, '0 B'], [Infinity, '0 B'], [0.5, '1 B'], [1, '1 B'], [1023, '1023 B'], [1024, '1 KB'], [1536, '1.5 KB'], [1048576, '1 MB'], [1024 ** 3, '1 GB'], [1024 ** 4, '1 TB']]) assert.equal(formatBytes(value), expected);
});

test('previewDocument pads the preview and keeps the original document', async () => {
  const { previewDocument } = await import('../ui/js/lib.js');
  const withHead = previewDocument('<!doctype html><html><head><title>x</title></head><body>Hi</body></html>');
  assert.match(withHead, /<head><style>/);
  assert.ok(withHead.includes('<body>Hi</body>'));
  assert.match(previewDocument('<p>bare</p>'), /^<style>.*<\/style><p>bare<\/p>$/s);
});
