import test from 'node:test';
import assert from 'node:assert/strict';
import { plural, relativeTime, statusLabel, statuses, legalActions, parseHashRoute, routeChanged, stripToken, buildBaseFromProfile, cleanProfile, linesToArray, arrayToLines, slugValid, diffKeys, formatBytes } from '../ui/js/lib.js';

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
  for (const status of ['rejected', 'skipped', 'unknown', 'constructor', '__proto__']) assert.deepEqual(legalActions(status), []);
  const actions = legalActions('draft');
  actions[0].label = 'Changed';
  assert.equal(legalActions('draft')[0].label, 'Approve');
});

test('hash routing supports every screen, encoded ids, and default applications', () => {
  for (const hash of ['', '#', '#/']) assert.deepEqual(parseHashRoute(hash), { path: ['applications'] });
  for (const path of ['applications', 'applications/42', 'profile', 'resumes', 'resumes/new', 'resumes/backend', 'templates', 'templates/classic', 'settings']) assert.deepEqual(parseHashRoute(`#/${path}`), { path: path.split('/') });
  assert.deepEqual(parseHashRoute('#/templates/custom%2Dexample'), { path: ['templates', 'custom-example'] });
  assert.deepEqual(parseHashRoute('#/resumes/%invalid'), { path: ['resumes', '%invalid'] });
});

test('routeChanged resets navigation for a new path while ignoring query-only changes', () => {
  for (const previous of [null, undefined]) assert.equal(routeChanged(previous, '#/applications'), true);
  const unchanged = [
    ['', '#/applications'], ['#/', '#/applications'],
    ['#/profile', '#/profile'], ['#/applications?q=first', '#/applications?q=second&status=draft'],
    ['#/settings?tab=tokens', '#/settings'], ['#/profile&token=old', '#/profile?token=new'],
    ['#/resumes/example', '#/resumes/%65xample'], ['#/resumes/%invalid', '#/resumes/%invalid']
  ];
  for (const [previous, next] of unchanged) assert.equal(routeChanged(previous, next), false, `${previous} -> ${next}`);
  const changed = [
    ['#/applications', '#/profile'], ['#/applications', '#/applications/1'],
    ['#/applications/1?q=keep', '#/applications/2?q=keep'],
    ['#/resumes/a%2Fb', '#/resumes/a/b'], ['#/templates/classic', '#/templates/compact'],
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
