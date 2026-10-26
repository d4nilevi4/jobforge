import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { check, checkContent, checkCover, normalizeToken, safeTest, skillAllowed } from '../server/guard.js';
import { profile, cleanContent } from './guard-fixtures.js';

const clone = (value) => structuredClone(value);
const cleanCover = { schema_version: 1, language: 'en', text: 'I build reliable tools and would welcome the opportunity to discuss this role.' };

function request() {
  return { content: clone(cleanContent), cover: clone(cleanCover), profile: clone(profile) };
}

const cases = [
  {
    code: 'unknown_employer', path: 'experience[0].company',
    change: ({ content }) => { content.experience[0].company = 'Unknown Works'; },
    message: /Known: Example Works\./u,
  },
  {
    code: 'date_mismatch', path: 'experience[0].dates',
    change: ({ content }) => { content.experience[0].dates = '2020 - 2024'; },
    message: /2020 - 2024.*2021 - 2024/u,
  },
  {
    code: 'unknown_project', path: 'projects[0].title',
    change: ({ content }) => { content.projects[0].title = 'Unknown Project'; },
    message: /Known: Example Tool \(desktop\)\./u,
  },
  {
    code: 'unknown_skill', path: 'skills[0].items',
    change: ({ content }) => { content.skills[0].items = 'Go, UnknownOne; UnknownTwo'; },
    message: /UnknownOne.*UnknownTwo/u,
  },
  {
    code: 'unknown_skill_group', path: 'skills[0].label',
    change: ({ content }) => { content.skills[0].label = 'Unknown Group'; },
  },
  {
    code: 'unknown_education', path: 'education[0].institution',
    change: ({ content }) => { content.education[0].institution = 'Unknown Institute'; },
  },
  {
    code: 'familiar_unqualified', path: 'summary',
    change: ({ content }) => { content.summary = 'Uses Kubernetes for reliable tools.'; },
    message: /Kubernetes.*summary.*coursework/u,
  },
  {
    code: 'do_not_claim', path: 'headline',
    change: ({ content }) => { content.headline = 'Team Lead'; },
    message: /headline.*Never claim team lead experience/u,
  },
  {
    code: 'forbidden_pattern', path: 'summary',
    change: ({ content }) => { content.summary = 'Builds tools — reliably.'; },
    message: /summary.*Use a short dash instead of a long dash/u,
  },
  {
    code: 'cover_too_long', path: 'cover.text',
    change: ({ cover, profile: facts }) => { cover.text = 'One two three four'; facts.rules.cover_max_words = 3; },
    message: /4 words.*allows 3/u,
  },
  {
    code: 'wrong_language', path: 'summary', warning: true,
    change: ({ content }) => { content.summary = 'Создаю надёжные полезные инструменты.'; },
  },
  {
    code: 'number_not_in_profile', path: 'experience[0].bullets[0]', warning: true,
    change: ({ content }) => { content.experience[0].bullets[0] = 'Reduced build time by 75%.'; },
  },
  {
    code: 'code_line_counts', path: 'experience[0].bullets[0]', warning: true,
    change: ({ content }) => { content.experience[0].bullets[0] = 'Maintained lines of code.'; },
  },
  {
    code: 'bullet_too_long', path: 'experience[0].bullets[0]', warning: true,
    change: ({ content }) => { content.experience[0].bullets[0] = 'a'.repeat(301); },
  },
  {
    code: 'profile_rule_invalid', path: '', warning: true,
    change: ({ profile: facts }) => { facts.do_not_claim[0].patterns = ['[']; },
    message: /profile\.do_not_claim\[0\]\.patterns\[0\].*Fix/u,
  },
];

test('clean content and cover pass without findings', () => {
  assert.deepEqual(check(request()), { errors: [], warnings: [] });
  assert.deepEqual(checkContent(cleanContent, profile), { errors: [], warnings: [] });
  assert.deepEqual(checkCover(cleanCover, profile), { errors: [], warnings: [] });
});

for (const example of cases) {
  test(`reports ${example.code} at its document path`, () => {
    const input = request();
    example.change(input);
    const result = check(input);
    const findings = example.warning ? result.warnings : result.errors;
    assert.equal(findings.length, 1);
    assert.equal((example.warning ? result.errors : result.warnings).length, 0);
    assert.deepEqual(Object.keys(findings[0]), ['path', 'code', 'message']);
    assert.equal(findings[0].code, example.code);
    assert.equal(findings[0].path, example.path);
    if (example.message) assert.match(findings[0].message, example.message);
  });
}

test('reports multiple errors in document order in a single call', () => {
  const input = request();
  input.content.headline = 'Kubernetes Team Lead';
  input.content.summary = 'Tools — reliably.';
  input.content.experience[0].company = 'Unknown Works';
  input.content.projects[0].title = 'Unknown Project';
  input.content.skills[0] = { label: 'Unknown Group', items: 'UnknownOne, UnknownTwo' };
  input.content.education[0].institution = 'Unknown Institute';
  input.cover.text = 'Kubernetes Team Lead';
  const result = check(input);
  assert.deepEqual(result.errors.map(({ path, code }) => [path, code]), [
    ['headline', 'familiar_unqualified'],
    ['headline', 'do_not_claim'],
    ['summary', 'forbidden_pattern'],
    ['experience[0].company', 'unknown_employer'],
    ['projects[0].title', 'unknown_project'],
    ['skills[0].label', 'unknown_skill_group'],
    ['skills[0].items', 'unknown_skill'],
    ['education[0].institution', 'unknown_education'],
    ['cover.text', 'familiar_unqualified'],
    ['cover.text', 'do_not_claim'],
  ]);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(check(input), result);
});

test('normalizes skill tokens without losing meaningful punctuation', () => {
  for (const [input, expected] of [
    ['  NODE.js.  ', 'node.js'], ['• Version   control;', 'version control'],
    ['C++', 'c++'], ['C#', 'c#'], ['.NET', '.net'], ['', ''], [null, ''], [42, ''],
  ]) assert.equal(normalizeToken(input), expected);
});

test('allows exact and loose skills while protecting short tokens and parenthetical details', () => {
  for (const [token, expected] of [
    ['go', true], ['C++', true], ['C#', true], ['.net', true], ['Node.js', true],
    ['JavaScript development', true], ['Java', true], ['going', false], ['Django', false], ['C', false],
    ['Version control (Git)', true], ['Version control (Git, Go; SQLite)', true],
    ['Version control (UnknownTool)', false], ['Unknown phrase (Git)', false],
    ['SQLite (UnknownTool)', false], ['Kubernetes', false], ['Kubernetes (coursework)', true],
    ['Kubernetes (coursework, UnknownTool)', false], ['UnknownTool', false], ['', false], [null, false],
  ]) assert.equal(skillAllowed(token, profile), expected, String(token));
  assert.equal(skillAllowed('Go', {}), false);
});

test('parses comma and semicolon skill lists without splitting parenthetical items', () => {
  const input = request();
  input.content.skills[1].items = 'Version control (Git, Go; SQLite), UnknownOne; UnknownTwo';
  const { errors } = check(input);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'unknown_skill');
  assert.match(errors[0].message, /UnknownOne.*UnknownTwo/u);
  assert.doesNotMatch(errors[0].message, /Version control/u);
});

test('accepts profile labels, localized labels, and group keys with spaces', () => {
  for (const label of ['languages', '  LANGUAGES ', 'Языки', 'Programming Languages']) {
    const input = request();
    input.content.skills[0].label = label;
    assert.deepEqual(check(input), { errors: [], warnings: [] }, label);
  }
});

test('matches employers with case and whitespace normalization and dates with normalized dashes', () => {
  for (const dates of ['2021-2024', '2021 - 2024', '2021 – 2024', ' 2021 — 2024 ', '2021 − 2024']) {
    const input = request();
    input.profile.rules.forbid_patterns = [];
    input.content.experience[0].company = '  EXAMPLE   works ';
    input.content.experience[0].dates = dates;
    assert.deepEqual(check(input), { errors: [], warnings: [] }, dates);
  }
});

test('matches dates against each profile entry for the same employer', () => {
  const input = request();
  input.profile.experience.push({ company: 'EXAMPLE WORKS', dates: '2018 - 2020' });
  input.content.experience[0].dates = '2018-2020';
  assert.deepEqual(check(input), { errors: [], warnings: [] });
});

test('matches equal project titles after normalizing whitespace, case and one trailing parenthetical', () => {
  for (const title of ['EXAMPLE TOOL (desktop)', '  Example   Tool  ', 'Example Tool (other context)']) {
    const input = request();
    input.content.projects[0].title = title;
    assert.deepEqual(check(input), { errors: [], warnings: [] }, title);
  }
  for (const title of ['E', 'Tool', 'Example Tool Extended (demo)', 'Example Tool (desktop) (demo)']) {
    const input = request();
    input.content.projects[0].title = title;
    assert.equal(check(input).errors[0]?.code, 'unknown_project', title);
  }
});

test('matches education only when normalized institution, degree and years all match', () => {
  for (const institution of ['EXAMPLE UNIVERSITY', '  Example   University ']) {
    const input = request();
    input.content.education[0].institution = institution;
    input.content.education[0].degree = ' bsc ';
    input.content.education[0].years = ' 2010 – 2014 ';
    assert.deepEqual(check(input), { errors: [], warnings: [] }, institution);
  }
  for (const [field, value] of [
    ['institution', 'University'], ['institution', 'Example University of Computing'],
    ['degree', 'PhD'], ['years', '2020 - 2024'],
  ]) {
    const input = request();
    input.content.education[0][field] = value;
    const error = check(input).errors[0];
    assert.equal(error.code, 'unknown_education');
    assert.equal(error.path, `education[0].${field}`);
    assert.ok(error.message.includes(JSON.stringify(profile.education[0])));
    assert.ok(error.message.includes(`Fields that differ: ${field}.`));
  }
  const input = request();
  input.profile.education.unshift({ institution: 'Other University', degree: 'MA', years: '2000 - 2002' });
  input.content.education[0].degree = 'PhD';
  input.content.education[0].years = '2026';
  assert.match(check(input).errors[0].message, /Closest profile entry:.*Example University.*Fields that differ: degree, years/u);
});

test('checks familiar items in every required prose field and in skill tokens', () => {
  const locations = [
    ['headline', (content) => { content.headline = 'Kubernetes engineer'; }],
    ['summary', (content) => { content.summary = 'Uses Kubernetes.'; }],
    ['experience[0].bullets[0]', (content) => { content.experience[0].bullets[0] = 'Uses Kubernetes.'; }],
    ['projects[0].bullets[0]', (content) => { content.projects[0].bullets[0] = 'Uses Kubernetes.'; }],
    ['projects[0].tech', (content) => { content.projects[0].tech = 'Kubernetes'; }],
    ['skills[0].items', (content) => { content.skills[0].items = 'Go, Kubernetes'; }],
  ];
  for (const [path, change] of locations) {
    const input = request();
    change(input.content);
    const { errors } = check(input);
    assert.equal(errors.length, 1, path);
    assert.equal(errors[0].code, 'familiar_unqualified');
    assert.equal(errors[0].path, path);
  }
  assert.equal(checkCover({ text: 'Uses Kubernetes.' }, profile).errors[0].path, 'cover.text');
});

test('uses whole word boundaries including punctuation in technology names', () => {
  const examples = [
    ['React', 'A chain-reaction improves tools.', false], ['React', 'Uses React.', true],
    ['Go', 'Keeps going with Django.', false], ['Go', 'Uses Go.', true], ['Go', 'Go2 is a different token.', false],
    ['Go', 'Uses ЯGo and Goя identifiers.', false],
    ['C++', 'Uses C and C#.', false], ['C++', 'Uses C++.', true], ['C++', 'Uses C++17.', false],
    ['C#', 'Uses C++.', false], ['C#', 'Uses C#.', true], ['C#', 'Uses C#Tools.', false],
    ['.NET', 'Uses internet tools.', false], ['.NET', 'Uses ASP.NET.', false], ['.NET', 'Uses .NET.', true],
    ['Node.js', 'Uses NodeXjs and Node.json.', false], ['Node.js', 'Uses Node.js.', true],
  ];
  for (const [item, summary, expected] of examples) {
    const input = request();
    input.profile.familiar = [{ item, qualifier: 'coursework' }];
    input.content.skills = [];
    input.content.projects[0].tech = '';
    input.content.summary = summary;
    const errors = check(input).errors.filter((entry) => entry.code === 'familiar_unqualified');
    assert.equal(errors.length, expected ? 1 : 0, `${item}: ${summary}`);
  }
});

test('accepts familiar qualifications in English and Russian across prose and skills', () => {
  for (const [qualifier, phrases] of [
    ['coursework', ['coursework', 'курсовой проект', 'по курсу', 'учебный проект', 'учёба']],
    ['university', ['university', 'университетский проект', 'вуз', 'учебный проект', 'учёба']],
    ['tutorial', ['tutorial']],
  ]) {
    for (const phrase of phrases) {
      const input = request();
      input.profile.familiar[0].qualifier = qualifier;
      input.content.summary = `Kubernetes (${phrase}).`;
      input.content.skills[0].items = `Go, Kubernetes (${phrase})`;
      input.cover.text = `Kubernetes (${phrase}).`;
      assert.deepEqual(check(input).errors, [], `${qualifier}: ${phrase}`);
      assert.equal(skillAllowed(`Kubernetes (${phrase})`, input.profile), true);
    }
  }
  const input = request();
  input.content.summary = 'Uses Kubernetes in precoursework experiments.';
  assert.equal(check(input).errors[0].code, 'familiar_unqualified');
});

test('does not use a qualifier from a different text field', () => {
  const input = request();
  input.content.headline = 'Coursework engineer';
  input.content.summary = 'Uses Kubernetes.';
  assert.equal(check(input).errors[0].path, 'summary');
});

test('accepts inline qualifiers for short familiar tokens and treats custom qualifiers literally', () => {
  for (const qualifier of ['coursework', 'constructor', '__proto__', 'a+b']) {
    const facts = clone(profile);
    facts.familiar = [{ item: 'Go', qualifier }];
    assert.equal(skillAllowed(`Go ${qualifier}`, facts), true, qualifier);
    assert.equal(skillAllowed('Go', facts), false, qualifier);
    assert.equal(checkCover({ text: 'Uses Go.' }, facts).errors[0].code, 'familiar_unqualified');
    assert.deepEqual(checkCover({ text: `Uses Go in ${qualifier}.` }, facts), { errors: [], warnings: [] });
  }
  const facts = clone(profile);
  facts.familiar = [{ item: 'Go', qualifier: 'coursework' }];
  assert.equal(skillAllowed('Go по учебному курсу', facts), true);
});

test('a familiar skill requires qualification even when also present in profile skills', () => {
  const input = request();
  input.profile.skills[1].items.push('Kubernetes');
  input.content.skills[1].items = 'Kubernetes';
  assert.equal(skillAllowed('Kubernetes', input.profile), false);
  assert.deepEqual(check(input).errors.map(({ code }) => code), ['familiar_unqualified']);
});

test('profile regex rules scan every standard text field and cover with Unicode case folding', () => {
  const input = request();
  input.profile.do_not_claim = [{ text: 'Avoid the marker', patterns: ['маркер'] }];
  input.profile.rules.forbid_patterns = [{ pattern: 'маркер', message: 'Remove the marker' }];
  input.content = {
    schema_version: 1,
    language: 'маркер', headline: 'МАРКЕР', summary: 'МАРКЕР',
    experience: [{ company: 'МАРКЕР', title: 'МАРКЕР', dates: 'МАРКЕР', location: 'МАРКЕР', bullets: ['МАРКЕР'] }],
    projects: [{ title: 'МАРКЕР', tech: 'МАРКЕР', link: 'МАРКЕР', link_label: 'МАРКЕР', bullets: ['МАРКЕР'] }],
    skills: [{ label: 'МАРКЕР', items: 'МАРКЕР' }],
    education: [{ institution: 'МАРКЕР', degree: 'МАРКЕР', years: 'МАРКЕР' }],
    extra: { text: 'МАРКЕР' },
  };
  input.cover = { language: 'МАРКЕР', text: 'МАРКЕР' };
  const expectedPaths = [
    'language', 'headline', 'summary',
    'experience[0].company', 'experience[0].title', 'experience[0].dates', 'experience[0].location', 'experience[0].bullets[0]',
    'projects[0].title', 'projects[0].tech', 'projects[0].link', 'projects[0].link_label', 'projects[0].bullets[0]',
    'skills[0].label', 'skills[0].items', 'education[0].institution', 'education[0].degree', 'education[0].years',
    'cover.language', 'cover.text',
  ];
  const { errors } = check(input);
  for (const code of ['do_not_claim', 'forbidden_pattern']) {
    assert.deepEqual(errors.filter((entry) => entry.code === code).map(({ path }) => path), expectedPaths);
  }
});

test('invalid profile regex patterns warn once each while valid patterns still run', () => {
  const input = request();
  input.profile.do_not_claim[0].patterns = ['[', '\\bteam lead\\b', '(?'];
  input.profile.rules.forbid_patterns.push({ pattern: '[', message: 'Invalid rule' });
  input.content.headline = 'Team Lead';
  input.cover.text = 'Team Lead';
  const { errors, warnings } = check(input);
  assert.deepEqual(errors.map(({ path, code }) => [path, code]), [['headline', 'do_not_claim'], ['cover.text', 'do_not_claim']]);
  assert.equal(warnings.length, 3);
  assert.ok(warnings.every((entry) => entry.code === 'profile_rule_invalid'));
  assert.match(warnings[2].message, /profile\.rules\.forbid_patterns\[1\]\.pattern/u);
});

test('safeTest supports a custom timeout and normal Unicode regex matches', () => {
  assert.equal(safeTest(/инструменты/iu, 'ИНСТРУМЕНТЫ'), true);
  assert.equal(safeTest(/tools/iu, 'other text'), false);
  assert.throws(() => safeTest(/^(a+)+$/iu, `${'a'.repeat(28)}!`, { timeoutMs: 20 }), {
    code: 'ERR_SCRIPT_EXECUTION_TIMEOUT'
  });
});

test('profile patterns compile once per check even when shared across rule sources', (t) => {
  const NativeRegExp = RegExp;
  const calls = [];
  t.mock.method(globalThis, 'RegExp', function(pattern, flags) {
    calls.push([pattern, flags]);
    return new NativeRegExp(pattern, flags);
  });
  const facts = {
    do_not_claim: [{ text: 'Avoid marker', patterns: ['marker', '[', 'marker'] }],
    rules: { forbid_patterns: [{ pattern: 'marker', message: 'Avoid marker' }, { pattern: '[', message: 'Broken' }] }
  };
  const content = { headline: 'Marker', summary: 'Marker' };
  assert.equal(check({ content, profile: facts }).errors.length, 6);
  assert.deepEqual(calls, [['marker', 'iu'], ['[', 'iu']]);
  check({ content, profile: facts });
  assert.equal(calls.length, 4);
});

test('catastrophic profile patterns warn once and are skipped across remaining fields and rule sources', () => {
  const script = `
    import assert from 'node:assert/strict';
    import { check } from './server/guard.js';
    const text = 'a'.repeat(28) + '!';
    const profile = {
      do_not_claim: [{ text: 'Avoid pattern', patterns: ['^(a+)+$'] }],
      rules: { forbid_patterns: [{ pattern: '^(a+)+$', message: 'Avoid pattern' }] }
    };
    const content = { headline: text, summary: text, experience: [{ bullets: Array(12).fill(text) }] };
    for (let index = 0; index < 2; index++) {
      const result = check({ content, cover: { text }, profile });
      assert.deepEqual(result.errors, []);
      assert.equal(result.warnings.length, 1);
      assert.equal(result.warnings[0].code, 'profile_rule_timeout');
      assert.equal(result.warnings[0].path, 'headline');
      assert.match(result.warnings[0].message, /took too long.*skipped.*simplify/u);
    }
    const result = check({ cover: { text }, profile: { rules: profile.rules } });
    assert.equal(result.warnings[0].code, 'profile_rule_timeout');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url), timeout: 1500, encoding: 'utf8'
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
});

test('built-in normalization and line-count detection handle long adversarial input promptly', () => {
  const script = `
    import assert from 'node:assert/strict';
    import { check, normalizeToken, skillAllowed } from './server/guard.js';
    assert.equal(normalizeToken('.'.repeat(100000) + 'X'), '.'.repeat(100000) + 'x');
    assert.equal(skillAllowed('('.repeat(100000) + 'X', {}), false);
    const result = check({
      content: {
        projects: [{ title: ' '.repeat(100000) + 'X' }],
        experience: [{ bullets: ['1' + ' '.repeat(100000) + 'X', '1.'.repeat(50000) + 'X'] }],
        summary: '1'.repeat(100000) + 'a'
      },
      profile: { projects: [{ title: 'X (demo)' }] }
    });
    assert.deepEqual(result.errors, []);
    assert.equal(result.warnings.some(({code}) => code === 'code_line_counts'), false);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url), timeout: 1500, encoding: 'utf8'
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
});

test('never guards custom template extra content', () => {
  const input = request();
  input.content.extra = { summary: 'Kubernetes team lead — 99%', bullets: ['lines of code'.repeat(30)] };
  assert.deepEqual(check(input), { errors: [], warnings: [] });
});

test('counts cover words using Unicode whitespace and permits the exact limit', () => {
  const facts = clone(profile);
  facts.rules.cover_max_words = 3;
  for (const text of ['', '  ', 'One\n\ntwo\tthree', 'Раз\u00a0два\u2003три']) {
    assert.deepEqual(checkCover({ text }, facts), { errors: [], warnings: [] }, text);
  }
  const result = checkCover({ text: ' One\n two\tthree\u2003four ' }, facts);
  assert.equal(result.errors[0].code, 'cover_too_long');
  assert.match(result.errors[0].message, /4 words/u);
});

test('uses each document language and reports the path of every mismatched prose part', () => {
  const input = request();
  input.content.language = 'en-US';
  input.content.experience[0].bullets = ['Создаю надёжные полезные инструменты.'];
  input.content.projects[0].bullets = ['Создаю надёжные полезные инструменты.'];
  input.cover = { language: 'en', text: 'Создаю надёжные полезные инструменты.' };
  assert.deepEqual(check(input).warnings.map(({ code, path }) => [code, path]), [
    ['wrong_language', 'experience[0].bullets[0]'],
    ['wrong_language', 'projects[0].bullets[0]'],
    ['wrong_language', 'cover.text'],
  ]);
  input.cover.language = 'ru';
  assert.equal(checkCover(input.cover, input.profile).warnings.length, 0);
  input.cover.text = cleanCover.text;
  assert.equal(checkCover(input.cover, input.profile).warnings[0].path, 'cover.text');
  assert.equal(check({ ...input, language: 'ru' }).warnings[0].path, 'experience[0].bullets[0]');
});

test('language warnings require three wrong-script words and more than thirty percent of letters', () => {
  for (const [language, text, warns] of [
    ['en', 'Я Я Я abcdefg', false], ['en', 'Я Я Я abcdef', true],
    ['en', 'Создаю инструменты', false], ['en', 'Tools using C# and Unity', false],
    ['ru', 'Разрабатываю приложения на C# и Unity.', false], ['ru', 'Build reliable tools', true],
  ]) {
    const warnings = checkCover({ language, text }, profile).warnings;
    assert.equal(warnings.length, warns ? 1 : 0, text);
    if (warns) assert.equal(warnings[0].code, 'wrong_language');
  }
});

test('checks summary and bullet numbers with suffixes once per resume and ignores years', () => {
  const input = request();
  input.content.summary = 'Maintained 75% uptime, 20k records, 30M events and a 25x speedup in (1990) and (2100).';
  input.content.experience[0].bullets = ['Reached 75% and 20k again; maintained 12 tools with a 40% improvement.'];
  input.content.projects[0].bullets = ['Reached 75% again and added 88 features in 2024.'];
  input.cover.text = 'Reached 99%.';
  const { warnings } = check(input);
  assert.deepEqual(warnings.map(({ path, code }) => [path, code]), [
    ['summary', 'number_not_in_profile'], ['summary', 'number_not_in_profile'],
    ['summary', 'number_not_in_profile'], ['summary', 'number_not_in_profile'],
    ['projects[0].bullets[0]', 'number_not_in_profile'],
  ]);
  for (const [index, number] of ['75%', '20k', '30m', '25x', '88'].entries()) assert.ok(warnings[index].message.includes(number));
});

test('does not treat substrings of profile numbers as supported quantities', () => {
  const input = request();
  input.content.summary = 'Maintained 21 tools.';
  assert.equal(check(input).warnings[0].code, 'number_not_in_profile');
});

test('year exemptions apply to dates but not quantities before lowercase words', () => {
  for (const text of ['since 2021', '2019 - 2022', '(2024)', 'in 2023.', 'since 2026']) {
    const input = request();
    input.content.experience[0].bullets = [text];
    assert.deepEqual(check(input).warnings, [], text);
  }
  for (const text of ['Completed 2026 migrations.', 'Since 2026; completed 2026 migrations.', 'Built 2026 инструментов.']) {
    const input = request();
    input.content.experience[0].bullets = [text];
    const warnings = check(input).warnings;
    assert.equal(warnings.length, 1, text);
    assert.equal(warnings[0].code, 'number_not_in_profile');
    assert.match(warnings[0].message, /2026/u);
  }
});

test('ignores single digit quantities and years only within the inclusive year range', () => {
  const input = request();
  input.content.summary = 'Built 9 tools and 5k records in 1989, 1990, (2100) and 2101 with a 2024x speedup.';
  const { warnings } = check(input);
  assert.equal(warnings.length, 3);
  for (const [index, number] of ['1989', '2101', '2024x'].entries()) assert.ok(warnings[index].message.includes(number));
});

test('ignores numbers in unscanned fields while checking bullet and cover language', () => {
  const input = request();
  input.content.experience[0].title = 'Engineer for 99 tools';
  input.content.projects[0].tech = 'Go with 88 tools';
  input.content.projects[0].bullets = ['Создаю надёжные полезные инструменты.'];
  input.content.skills[0].label = 'Languages';
  input.cover.text = 'Создаю надёжные полезные инструменты с 77 функциями.';
  const result = check(input);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings.map(({ code, path }) => [code, path]), [
    ['wrong_language', 'projects[0].bullets[0]'], ['wrong_language', 'cover.text']
  ]);
});

test('accepts numbers anywhere in the profile including multiline text and numeric values', () => {
  const input = request();
  input.profile.about = 'Measured outcomes:\n75% uptime, 20k records, 30M events, 25x speedup, 1,200 requests and 3.14 units.';
  input.profile.extra = { count: 88 };
  input.content.summary = 'Measured 75%, 20k, 30M, 25x, 1,200, 3.14 and 88.';
  assert.deepEqual(check(input), { errors: [], warnings: [] });
});

test('code line count warnings cover English abbreviations and Russian wording', () => {
  for (const bullet of ['Maintained lines of code.', 'Maintained 12 LOC.', 'Maintained 12k+ loc.', 'Написал 12 строк кода.']) {
    const input = request();
    input.profile.about = bullet;
    input.content.projects[0].bullets = [bullet];
    assert.deepEqual(check(input).warnings.filter(({ code }) => code === 'code_line_counts').map(({ code, path }) => [code, path]), [['code_line_counts', 'projects[0].bullets[0]']], bullet);
  }
});

test('warns about bullet length only above 300 characters and in both bullet sections', () => {
  const input = request();
  input.content.summary = 'a'.repeat(301);
  input.content.experience[0].bullets = ['a'.repeat(300), 'a'.repeat(301)];
  input.content.projects[0].bullets = ['a'.repeat(301)];
  assert.deepEqual(check(input).warnings.map(({ code, path }) => [code, path]), [
    ['bullet_too_long', 'experience[0].bullets[1]'], ['bullet_too_long', 'projects[0].bullets[0]'],
  ]);
});

test('missing fields, malformed arrays, and nonstring values do not throw', () => {
  for (const input of [
    {}, { content: null, cover: null, profile: null },
    { content: {}, cover: {}, profile: {} },
    {
      content: { language: 42, headline: false, summary: {}, experience: 'invalid', projects: {}, skills: null, education: 42 },
      cover: { text: 42, language: [] }, profile: { experience: {}, projects: false, skills: 'invalid', familiar: {}, education: {} },
    },
    {
      content: { experience: [null, 42, { company: 42, dates: [] }], projects: [null, {}], skills: [null, { label: 42, items: [] }], education: [null, {}] },
      profile: { skills: [null, { label_localized: null, items: [42] }], familiar: [null, { item: 42 }], do_not_claim: [null, { patterns: [42] }], rules: { forbid_patterns: [null], cover_max_words: '3' } },
    },
  ]) assert.deepEqual(check(input), { errors: [], warnings: [] });
  assert.deepEqual(check(), { errors: [], warnings: [] });
  assert.deepEqual(checkContent(), { errors: [], warnings: [] });
  assert.deepEqual(checkCover(), { errors: [], warnings: [] });
});

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

test('does not mutate deeply frozen clean or invalid input documents', () => {
  for (const invalid of [false, true]) {
    const input = request();
    if (invalid) {
      input.content.headline = 'Team Lead using Kubernetes';
      input.content.skills[0].items += ', UnknownTool';
      input.content.experience[0].company = 'Unknown Works';
      input.cover.text = 'Kubernetes';
    }
    const before = clone(input);
    deepFreeze(input);
    check(input);
    checkContent(input.content, input.profile);
    checkCover(input.cover, input.profile);
    skillAllowed('Kubernetes (coursework)', input.profile);
    assert.deepEqual(input, before);
  }
});
