import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSchema, validate } from '../server/validate.js';

function example(name) {
  return JSON.parse(readFileSync(new URL(`../examples/${name}.example.json`, import.meta.url), 'utf8'));
}

const profile = example('profile');
const tracks = example('tracks');
const base = tracks['unity-developer'].base;

function application() {
  return {
    vacancy: {
      url: 'https://example.com/jobs/unity-developer',
      source: 'manual',
      title: 'Unity Developer',
      company: 'Example Game Workshop',
      location: 'Remote',
      language: 'en',
      text: 'Build Unity gameplay systems and editor tools using C#.'
    },
    verdict: 'apply',
    score: 0.85,
    track_id: 'unity-developer',
    resume: { template: 'classic', content: structuredClone(base) },
    cover: { template: 'letter', content: { text: 'I build Unity gameplay systems and editor tools. I would welcome a discussion about your team.' } },
    notes: 'Discuss the balance between gameplay and tooling work.'
  };
}

function expectError(kind, document, path, code) {
  const errors = validate(loadSchema(kind), document);
  assert.ok(errors.some((error) => error.path === path && error.code === code), JSON.stringify(errors));
}

test('the fictional example profile validates', () => {
  assert.deepEqual(validate(loadSchema('profile'), profile), []);
  assert.equal(profile.identity.name, 'Alex Example');
  assert.equal(profile.identity.email, 'alex@example.com');
  assert.equal(profile.experience.length, 3);
  assert.equal(profile.projects.length, 4);
  assert.equal(profile.rules.cover_max_words, 170);
  assert.equal(profile.familiar[0].qualifier, 'coursework');
  assert.ok(profile.identity.name_localized.ru);
  assert.ok(profile.identity.availability.en);
  assert.ok(profile.identity.availability.ru);
  for (const rule of profile.rules.forbid_patterns) assert.doesNotThrow(() => new RegExp(rule.pattern, 'iu'));
  for (const claim of profile.do_not_claim) {
    for (const pattern of claim.patterns ?? []) assert.doesNotThrow(() => new RegExp(pattern, 'iu'));
  }
});

for (const [id, track] of Object.entries(tracks)) {
  test(`example track ${id} validates including its embedded resume`, () => {
    assert.deepEqual(validate(loadSchema('track'), track), []);
    assert.deepEqual(validate(loadSchema('content'), track.base), []);
    assert.equal(track.language, 'en');
    assert.equal(track.resume_template, 'classic');
    assert.equal(track.cover_template, 'letter');
    assert.ok(track.when_to_use.length > 30);
    assert.ok(track.notes.length > 30);
  });

  test(`example track ${id} copies facts exclusively from the profile`, () => {
    for (const entry of track.base.experience) {
      const source = profile.experience.find((item) => item.company === entry.company);
      assert.ok(source, entry.company);
      for (const field of ['company', 'title', 'dates', 'location']) assert.equal(entry[field], source[field]);
      for (const bullet of entry.bullets) assert.ok(source.bullets.includes(bullet), bullet);
    }
    for (const entry of track.base.projects) {
      const source = profile.projects.find((item) => item.title === entry.title);
      assert.ok(source, entry.title);
      for (const field of ['title', 'tech', 'link', 'link_label']) assert.equal(entry[field], source[field]);
      for (const bullet of entry.bullets) assert.ok(source.bullets.includes(bullet), bullet);
    }
    for (const group of track.base.skills) {
      const source = profile.skills.find((item) => item.label === group.label);
      assert.ok(source, group.label);
      for (const item of group.items.split(', ')) assert.ok(source.items.includes(item), item);
    }
    for (const entry of track.base.education) assert.ok(profile.education.some((item) => JSON.stringify(item) === JSON.stringify(entry)));
  });
}

test('minimal profile and content documents accept omitted optional fields', () => {
  assert.deepEqual(validate(loadSchema('profile'), {
    schema_version: 1, identity: { name: 'Alex Example' }, experience: [], skills: []
  }), []);
  assert.deepEqual(validate(loadSchema('content'), { headline: 'Developer', experience: [], skills: [] }), []);
  assert.deepEqual(validate(loadSchema('cover'), { text: 'Hello.' }), []);
});

test('profile required fields include identity.name and schema_version', () => {
  const missingName = structuredClone(profile);
  delete missingName.identity.name;
  expectError('profile', missingName, 'identity.name', 'required');
  for (const field of ['schema_version', 'identity', 'experience', 'skills']) {
    const broken = structuredClone(profile);
    delete broken[field];
    expectError('profile', broken, field, 'required');
  }
});

test('document top levels and identity reject misspelled fields', () => {
  expectError('profile', { ...profile, experiance: [] }, 'experiance', 'additional_property');
  expectError('profile', { ...profile, identity: { ...profile.identity, emali: 'alex@example.com' } }, 'identity.emali', 'additional_property');
  expectError('content', { ...base, experiance: [] }, 'experiance', 'additional_property');
  expectError('track', { ...tracks['unity-developer'], nmae: 'Unity developer' }, 'nmae', 'additional_property');
  expectError('cover', { text: 'Hello.', tetx: 'Hello.' }, 'tetx', 'additional_property');
  expectError('application', { ...application(), notse: 'Hello.' }, 'notse', 'additional_property');
});

test('nested extension fields and custom resume extra content remain free', () => {
  const extended = structuredClone(base);
  extended.experience[0].custom_field = { anything: true };
  extended.extra = { custom_section: [{ any: [1, false, null] }], arbitrary: 'text' };
  assert.deepEqual(validate(loadSchema('content'), extended), []);
  expectError('content', { ...base, extra: 'not an object' }, 'extra', 'type');
});

test('profile bullets and skill items are arrays of strings', () => {
  const broken = structuredClone(profile);
  broken.experience[0].bullets[1] = 3;
  broken.projects[0].bullets[0] = false;
  broken.skills[0].items[0] = 4;
  expectError('profile', broken, 'experience[0].bullets[1]', 'type');
  expectError('profile', broken, 'projects[0].bullets[0]', 'type');
  expectError('profile', broken, 'skills[0].items[0]', 'type');
  broken.skills[0].items = 'Go, C#';
  expectError('profile', broken, 'skills[0].items', 'type');
});

test('content skill items are strings rather than profile-style arrays', () => {
  const broken = structuredClone(base);
  broken.skills[0].items = ['Go', 'C#'];
  expectError('content', broken, 'skills[0].items', 'type');
});

test('profile skill keys use lowercase slugs and dates are free strings', () => {
  const broken = structuredClone(profile);
  broken.skills[0].key = 'Unity Skills';
  expectError('profile', broken, 'skills[0].key', 'pattern');
  broken.skills[0].key = 'unity-tools_2';
  broken.experience[0].dates = 'Spring to autumn, exact dates unknown';
  assert.deepEqual(validate(loadSchema('profile'), broken), []);
  broken.experience[0].dates = 2023;
  expectError('profile', broken, 'experience[0].dates', 'type');
});

test('do_not_claim text and familiar qualifiers are required', () => {
  const broken = structuredClone(profile);
  delete broken.do_not_claim[0].text;
  delete broken.familiar[0].qualifier;
  expectError('profile', broken, 'do_not_claim[0].text', 'required');
  expectError('profile', broken, 'familiar[0].qualifier', 'required');
  assert.deepEqual(validate(loadSchema('profile'), { ...profile, do_not_claim: [{ text: 'Do not invent certifications.' }] }), []);
});

test('profile rules have typed patterns, messages, notes, and a positive integer word limit', () => {
  const broken = structuredClone(profile);
  broken.rules.forbid_patterns[0].pattern = 3;
  broken.rules.forbid_patterns[0].message = false;
  broken.rules.cover_max_words = 0;
  broken.rules.notes = [];
  expectError('profile', broken, 'rules.forbid_patterns[0].pattern', 'type');
  expectError('profile', broken, 'rules.forbid_patterns[0].message', 'type');
  expectError('profile', broken, 'rules.cover_max_words', 'minimum');
  expectError('profile', broken, 'rules.notes', 'type');
  broken.rules.cover_max_words = 1.5;
  expectError('profile', broken, 'rules.cover_max_words', 'type');
});

test('localized maps declare string values and document the unsupported key constraint', () => {
  const localized = loadSchema('profile').$defs.localized;
  assert.deepEqual(localized.additionalProperties, { type: 'string' });
  assert.match(localized.description, /\^\[a-z\]/);
  assert.equal(Object.hasOwn(localized, 'propertyNames'), false);
  expectError('profile', { ...profile, identity: { ...profile.identity, availability: [] } }, 'identity.availability', 'type');
});

test('cover text is required, nonempty, and typed', () => {
  expectError('cover', {}, 'text', 'required');
  expectError('cover', { text: '' }, 'text', 'min_length');
  expectError('cover', { text: 3 }, 'text', 'type');
  assert.deepEqual(validate(loadSchema('cover'), { schema_version: 1, language: 'en', text: 'First paragraph.\n\nSecond paragraph.' }), []);
});

test('track base uses content restrictions and reports paths within base', () => {
  const broken = structuredClone(tracks['unity-developer']);
  broken.base.experiance = [];
  broken.base.skills[0].items = [];
  expectError('track', broken, 'base.experiance', 'additional_property');
  expectError('track', broken, 'base.skills[0].items', 'type');
});

test('application requests validate with resume content and optional cover versions', () => {
  assert.deepEqual(validate(loadSchema('application'), application()), []);
  const withoutVerdict = application();
  delete withoutVerdict.verdict;
  assert.deepEqual(validate(loadSchema('application'), withoutVerdict), []);
  assert.deepEqual(validate(loadSchema('application'), { vacancy: { text: 'A vacancy.' }, verdict: 'skip' }), []);
});

test('resume is required unless the verdict explicitly equals skip', () => {
  for (const verdict of ['apply', 'maybe', undefined]) {
    const request = { vacancy: { text: 'A vacancy.' } };
    if (verdict !== undefined) request.verdict = verdict;
    expectError('application', request, '', 'any_of');
  }
});

test('application vacancy text, verdict, score, templates, and nested content are checked', () => {
  const broken = application();
  delete broken.vacancy.text;
  broken.verdict = 'send';
  broken.score = 1.1;
  broken.resume.template = 1;
  broken.resume.content.experience[0].dates = 2023;
  broken.cover.content.text = '';
  expectError('application', broken, 'vacancy.text', 'required');
  expectError('application', broken, 'verdict', 'enum');
  expectError('application', broken, 'score', 'maximum');
  expectError('application', broken, 'resume.template', 'type');
  expectError('application', broken, 'resume.content.experience[0].dates', 'type');
  expectError('application', broken, 'cover.content.text', 'min_length');
  expectError('application', { ...application(), score: -0.1 }, 'score', 'minimum');
  expectError('application', { ...application(), score: '0.5' }, 'score', 'type');
  expectError('application', { ...application(), vacancy: { url: 'https://example.com/jobs/1' } }, 'vacancy.text', 'required');
  expectError('application', { verdict: 'skip' }, 'vacancy', 'required');
  for (const score of [0, 1]) assert.deepEqual(validate(loadSchema('application'), { ...application(), score }), []);
});

test('embedded content and cover definitions stay identical to standalone schemas', () => {
  const { $schema: contentDialect, $defs: contentDefs, ...contentShape } = loadSchema('content');
  const { $schema: coverDialect, ...coverShape } = loadSchema('cover');
  assert.equal(contentDialect, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(coverDialect, contentDialect);
  for (const kind of ['track', 'application']) {
    const schema = loadSchema(kind);
    assert.deepEqual(schema.$defs.content, contentShape);
    for (const [name, definition] of Object.entries(contentDefs)) assert.deepEqual(schema.$defs[name], definition);
  }
  assert.deepEqual(loadSchema('application').$defs.cover, coverShape);
});

test('schemas use draft 2020-12, omit ids, and contain only local definition references', () => {
  function inspect(node) {
    if (node === null || typeof node !== 'object') return;
    assert.equal(Object.hasOwn(node, '$id'), false);
    if (node.$ref) assert.match(node.$ref, /^#\/\$defs\/[^/]+$/);
    for (const child of Object.values(node)) inspect(child);
  }
  for (const kind of ['profile', 'track', 'content', 'cover', 'application']) {
    const schema = loadSchema(kind);
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    inspect(schema);
  }
});
