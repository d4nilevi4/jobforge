import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../server/errors.js';
import { CURRENT, registerUpgrade, resetUpgrades, upgradeDocument, validateDocument } from '../server/upgrade.js';

afterEach(() => resetUpgrades());

function freezeDeep(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function assertValidationError(action, path = 'schema_version') {
  let caught;
  assert.throws(action, (error) => {
    caught = error;
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 422);
    assert.equal(error.code, 'validation_failed');
    assert.equal(error.details[0].path, path);
    return true;
  });
  return caught;
}

test('all shipped document kinds are at version one', () => {
  assert.deepEqual(CURRENT, { profile: 1, track: 1, content: 1, cover: 1 });
});

test('missing versions become one and every kind returns a deep clone', () => {
  for (const kind of Object.keys(CURRENT)) {
    const input = freezeDeep({ nested: { values: ['original'] } });
    const upgraded = upgradeDocument(kind, input);
    assert.deepEqual(upgraded, { nested: { values: ['original'] }, schema_version: 1 });
    assert.notStrictEqual(upgraded, input);
    assert.notStrictEqual(upgraded.nested, input.nested);
    upgraded.nested.values.push('new');
    assert.deepEqual(input, { nested: { values: ['original'] } });
  }
});

test('already current documents retain every field without sharing nested objects', () => {
  const input = freezeDeep({ schema_version: 1, custom: { text: 'keep me' }, list: [1, 2] });
  const result = upgradeDocument('profile', input);
  assert.deepEqual(result, input);
  assert.notStrictEqual(result, input);
  assert.notStrictEqual(result.custom, input.custom);
  assert.notStrictEqual(result.list, input.list);
});

test('invalid schema versions return actionable API validation errors', () => {
  for (const schema_version of [0, -1, 1.5, '1', null, undefined, false, NaN, Infinity]) {
    const error = assertValidationError(() => upgradeDocument('profile', { schema_version }));
    assert.match(error.message, /integer of at least 1/);
  }
});

test('newer documents instruct the caller to update the server without downgrading', () => {
  for (const kind of Object.keys(CURRENT)) {
    const input = freezeDeep({ schema_version: 2, future: ['preserve'] });
    const error = assertValidationError(() => upgradeDocument(kind, input));
    assert.match(error.message, /Update the JobForge server/);
    assert.match(error.details[0].message, /Do not downgrade/);
    assert.deepEqual(input, { schema_version: 2, future: ['preserve'] });
  }
});

test('non-object documents fail as API validation errors', () => {
  for (const input of [null, [], 'text', 1, false, undefined]) {
    assertValidationError(() => upgradeDocument('content', input), '');
  }
});

test('registered multi-step chains run in order and stamp each intermediate version', () => {
  const seen = [];
  registerUpgrade('profile', 1, (doc) => {
    seen.push(doc.schema_version);
    return { ...doc, first: 'one to two' };
  });
  registerUpgrade('profile', 2, (doc) => {
    seen.push(doc.schema_version);
    return { ...doc, second: 'two to three' };
  });
  const original = freezeDeep({ keep: { values: [1, 2] } });
  const result = upgradeDocument('profile', original);
  assert.equal(CURRENT.profile, 3);
  assert.equal(CURRENT.track, 1);
  assert.deepEqual(seen, [1, 2]);
  assert.deepEqual(result, { keep: { values: [1, 2] }, schema_version: 3, first: 'one to two', second: 'two to three' });
  assert.deepEqual(original, { keep: { values: [1, 2] } });
});

test('chains start at the supplied document version and skip completed steps', () => {
  registerUpgrade('content', 1, () => { throw new Error('Completed upgrades must not run again.'); });
  registerUpgrade('content', 2, (doc) => ({ ...doc, added: true }));
  assert.deepEqual(upgradeDocument('content', { schema_version: 2 }), { schema_version: 3, added: true });
  assert.deepEqual(upgradeDocument('content', { schema_version: 3 }), { schema_version: 3 });
});

test('even a mutating upgrade cannot mutate the caller document', () => {
  registerUpgrade('cover', 1, (doc) => {
    doc.nested.values.push('upgrade');
    return doc;
  });
  const input = freezeDeep({ schema_version: 1, nested: { values: ['original'] } });
  const result = upgradeDocument('cover', input);
  result.nested.values.push('caller');
  assert.deepEqual(input.nested.values, ['original']);
  assert.deepEqual(result.nested.values, ['original', 'upgrade', 'caller']);
});

test('a failing upgrade leaves the caller document intact', () => {
  registerUpgrade('track', 1, (doc) => {
    doc.values.push('temporary');
    throw new Error('Fixture upgrade failed.');
  });
  const input = freezeDeep({ values: ['original'] });
  assert.throws(() => upgradeDocument('track', input), /Fixture upgrade failed/);
  assert.deepEqual(input, { values: ['original'] });
});

test('registration rejects missing, out-of-order, duplicate, and non-function steps', () => {
  assert.throws(() => registerUpgrade('profile', 2, (doc) => doc), /do not skip/);
  for (const version of [0, -1, 1.5, '1']) {
    assert.throws(() => registerUpgrade('profile', version, (doc) => doc), /positive integer/);
  }
  assert.throws(() => registerUpgrade('profile', 1, null), /function returning/);
  registerUpgrade('profile', 1, (doc) => doc);
  assert.throws(() => registerUpgrade('profile', 1, (doc) => doc), /do not skip or replace/);
});

test('invalid upgrade outputs are reported as internal API errors', () => {
  registerUpgrade('profile', 1, () => null);
  assert.throws(() => upgradeDocument('profile', {}), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 500);
    assert.equal(error.code, 'internal');
    assert.match(error.message, /must return a document object/);
    return true;
  });
});

test('reset removes fake chains and restores all current versions', () => {
  registerUpgrade('profile', 1, (doc) => ({ ...doc, extra: true }));
  registerUpgrade('cover', 1, (doc) => doc);
  resetUpgrades();
  assert.deepEqual(CURRENT, { profile: 1, track: 1, content: 1, cover: 1 });
  assert.deepEqual(upgradeDocument('profile', {}), { schema_version: 1 });
  assertValidationError(() => upgradeDocument('cover', { schema_version: 2 }));
});

test('unknown document kinds fail with an explicit developer repair message', () => {
  for (const kind of ['application', 'constructor', '__proto__', undefined]) {
    assert.throws(() => upgradeDocument(kind, {}), /Use profile, track, content, or cover/);
  }
  assert.throws(() => registerUpgrade('unknown', 1, (doc) => doc), /Unknown document kind/);
});

test('validateDocument upgrades missing versions before enforcing profile requirements', () => {
  const input = freezeDeep({ identity: { name: 'Alex Example' }, experience: [], skills: [] });
  const result = validateDocument('profile', input);
  assert.deepEqual(result.errors, []);
  assert.equal(result.doc.schema_version, 1);
  assert.equal(Object.hasOwn(input, 'schema_version'), false);
});

test('validateDocument returns schema errors with the requested root path', () => {
  const input = { headline: 2, experience: [], skills: [{ label: 'Languages', items: ['Go'] }] };
  const result = validateDocument('content', input, { rootPath: 'resume.content' });
  assert.equal(result.doc.schema_version, 1);
  assert.deepEqual(result.errors.map(({ path, code }) => ({ path, code })), [
    { path: 'resume.content.headline', code: 'type' },
    { path: 'resume.content.skills[0].items', code: 'type' }
  ]);
});

test('validateDocument resolves each supported kind to its matching schema', () => {
  assert.deepEqual(validateDocument('cover', { text: 'Hello.' }).errors, []);
  assert.equal(validateDocument('cover', { text: '' }).errors[0].code, 'min_length');
  const result = validateDocument('track', { name: 'Unity developer' });
  assert.ok(result.errors.some((error) => error.path === 'base' && error.code === 'required'));
  assert.ok(result.errors.some((error) => error.path === 'resume_template' && error.code === 'required'));
});

test('validateDocument prefixes invalid version and document errors too', () => {
  assertValidationError(() => validateDocument('cover', { schema_version: 2, text: 'Hello.' }, { rootPath: 'cover.content' }), 'cover.content.schema_version');
  assertValidationError(() => validateDocument('content', null, { rootPath: 'resume.content' }), 'resume.content');
});
