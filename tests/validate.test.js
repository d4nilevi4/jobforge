import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSchema, validate } from '../server/validate.js';

const keywordCases = [
  { keyword: 'type', schema: { type: 'string' }, valid: 'hello', invalid: 3, code: 'type' },
  { keyword: 'enum', schema: { enum: ['apply', 'skip'] }, valid: 'apply', invalid: 'send', code: 'enum' },
  { keyword: 'const', schema: { const: 1 }, valid: 1, invalid: 2, code: 'const' },
  { keyword: 'required', schema: { required: ['name'] }, valid: { name: '' }, invalid: {}, code: 'required', path: 'name' },
  { keyword: 'properties', schema: { properties: { name: { type: 'string' } } }, valid: { name: 'Alex Example' }, invalid: { name: 2 }, code: 'type', path: 'name' },
  { keyword: 'additionalProperties', schema: { properties: { a: {} }, additionalProperties: false }, valid: { a: 1 }, invalid: { extra: 1 }, code: 'additional_property', path: 'extra' },
  { keyword: 'items', schema: { items: { type: 'integer' } }, valid: [1, 2], invalid: [1, '2'], code: 'type', path: '[1]' },
  { keyword: 'minItems', schema: { minItems: 2 }, valid: [1, 2], invalid: [1], code: 'min_items' },
  { keyword: 'maxItems', schema: { maxItems: 2 }, valid: [1, 2], invalid: [1, 2, 3], code: 'max_items' },
  { keyword: 'minLength', schema: { minLength: 2 }, valid: 'ab', invalid: 'a', code: 'min_length' },
  { keyword: 'maxLength', schema: { maxLength: 2 }, valid: 'ab', invalid: 'abc', code: 'max_length' },
  { keyword: 'pattern', schema: { pattern: '^[a-z0-9_-]+$' }, valid: 'go-backend_1', invalid: 'Go Backend', code: 'pattern' },
  { keyword: 'minimum', schema: { minimum: 0 }, valid: 0, invalid: -1, code: 'minimum' },
  { keyword: 'maximum', schema: { maximum: 1 }, valid: 1, invalid: 1.01, code: 'maximum' },
  { keyword: 'anyOf', schema: { anyOf: [{ type: 'string' }, { type: 'null' }] }, valid: null, invalid: 3, code: 'any_of' }
];

for (const entry of keywordCases) {
  test(`${entry.keyword} accepts valid values and reports ${entry.code}`, () => {
    assert.deepEqual(validate(entry.schema, entry.valid), []);
    const errors = validate(entry.schema, entry.invalid);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].path, entry.path ?? '');
    assert.equal(errors[0].code, entry.code);
    assert.equal(typeof errors[0].message, 'string');
    assert.ok(errors[0].message.length > 10);
  });
}

test('all JSON types distinguish objects, arrays, null, integers, and finite numbers', () => {
  const cases = [
    ['string', '', 1],
    ['number', 1.5, '1.5'],
    ['integer', 2, 2.5],
    ['boolean', false, 0],
    ['object', {}, []],
    ['array', [], {}],
    ['null', null, {}]
  ];
  for (const [type, valid, invalid] of cases) {
    assert.deepEqual(validate({ type }, valid), [], type);
    assert.equal(validate({ type }, invalid)[0].code, 'type', type);
  }
  for (const invalid of [NaN, Infinity, -Infinity]) {
    assert.equal(validate({ type: 'number' }, invalid)[0].code, 'type');
    assert.equal(validate({ type: 'integer' }, invalid)[0].code, 'type');
  }
  assert.equal(validate({ type: 'object' }, null)[0].code, 'type');
  assert.equal(validate({ type: 'string' }, undefined)[0].code, 'type');
});

test('type arrays accept any listed type with a useful mismatch message', () => {
  const schema = { type: ['string', 'null'] };
  assert.deepEqual(validate(schema, 'hello'), []);
  assert.deepEqual(validate(schema, null), []);
  assert.deepEqual(validate(schema, 1), [
    { path: '', code: 'type', message: 'Expected string or null, got number.' }
  ]);
});

test('enum and const compare structured JSON values regardless of key order', () => {
  const value = { a: [1, null, false], b: 'text' };
  const reordered = { b: 'text', a: [1, null, false] };
  assert.deepEqual(validate({ enum: [value] }, reordered), []);
  assert.deepEqual(validate({ const: value }, reordered), []);
  assert.equal(validate({ const: value }, { a: [1], b: 'text' })[0].code, 'const');
  assert.deepEqual(validate({ const: false }, false), []);
  assert.deepEqual(validate({ const: null }, null), []);
  assert.equal(validate({ const: null }, false)[0].code, 'const');
  assert.deepEqual(validate({ const: { zero: 0 } }, { zero: -0 }), []);
  assert.equal(validate({ enum: [[]] }, {})[0].code, 'enum');
});

test('required fields and unknown fields identify the field and explain repairs', () => {
  const schema = { required: ['company'], properties: { company: {}, title: {} }, additionalProperties: false };
  const errors = validate(schema, { foo: true });
  assert.deepEqual(errors.map(({ path, code }) => ({ path, code })), [
    { path: 'company', code: 'required' },
    { path: 'foo', code: 'additional_property' }
  ]);
  assert.match(errors[0].message, /Missing required field "company"/);
  assert.match(errors[1].message, /Unknown field "foo"\. Allowed: company, title/);
  assert.match(validate({ enum: ['a', 'b'] }, 'c')[0].message, /Must be one of: a, b\./);
});

test('required uses own properties and accepts fields with falsy values', () => {
  const schema = { required: ['a'] };
  for (const value of [false, 0, '', null]) {
    assert.deepEqual(validate(schema, { a: value }), []);
  }
  assert.equal(validate(schema, Object.create({ a: true }))[0].code, 'required');
});

test('additional properties default to allowed and can be explicitly allowed', () => {
  assert.deepEqual(validate({ type: 'object' }, { extra: true }), []);
  assert.deepEqual(validate({ additionalProperties: true }, { extra: true }), []);
  assert.deepEqual(validate({ additionalProperties: false }, {}), []);
  assert.equal(validate({ additionalProperties: false }, { extra: true })[0].path, 'extra');
});

test('special property names are checked as own properties', () => {
  const value = JSON.parse('{"__proto__": 1, "constructor": 2}');
  assert.equal(validate({ additionalProperties: false }, value).length, 2);
  const schema = JSON.parse('{"properties":{"__proto__":{"type":"string"}}}');
  assert.deepEqual(validate(schema, value).map((error) => error.path), ['__proto__']);
});

test('paths include nested arrays and the optional root prefix', () => {
  const schema = { properties: { a: { items: { properties: { b: { type: 'string' } } } } } };
  const value = { a: [{ b: 'valid' }, { b: 2 }] };
  assert.equal(validate(schema, value)[0].path, 'a[1].b');
  assert.equal(validate(schema, value, { rootPath: 'resume.content' })[0].path, 'resume.content.a[1].b');
  assert.equal(validate({ type: 'object' }, false, { rootPath: 'resume.content' })[0].path, 'resume.content');
});

test('lengths count Unicode code points and accept zero boundaries', () => {
  assert.deepEqual(validate({ minLength: 1, maxLength: 1 }, '😀'), []);
  assert.equal(validate({ minLength: 2 }, '😀')[0].code, 'min_length');
  assert.equal(validate({ maxLength: 0 }, 'a')[0].code, 'max_length');
  assert.deepEqual(validate({ minLength: 0, maxLength: 0 }, ''), []);
  assert.deepEqual(validate({ minItems: 0, maxItems: 0 }, []), []);
  assert.equal(validate({ maxItems: 0 }, [1])[0].code, 'max_items');
  assert.deepEqual(validate({ minimum: 0, maximum: 0 }, 0), []);
});

test('patterns are unanchored unless the schema anchors them', () => {
  assert.deepEqual(validate({ pattern: 'cat' }, 'a cat sleeps'), []);
  assert.equal(validate({ pattern: '^cat$' }, 'a cat sleeps')[0].code, 'pattern');
});

test('keywords only constrain the applicable JSON type', () => {
  assert.deepEqual(validate({ minLength: 5, maxLength: 0, pattern: '^x$' }, 1), []);
  assert.deepEqual(validate({ minItems: 5, maxItems: 0, items: { type: 'string' } }, 'text'), []);
  assert.deepEqual(validate({ minimum: 5, maximum: 0 }, 'text'), []);
  assert.deepEqual(validate({ required: ['a'], properties: { a: { type: 'number' } }, additionalProperties: false }, null), []);
});

test('local references resolve chained definitions against the original root schema', () => {
  const schema = {
    $defs: {
      text: { type: 'string' },
      alias: { $ref: '#/$defs/text' },
      item: { properties: { b: { $ref: '#/$defs/alias' } } }
    },
    properties: { a: { items: { $ref: '#/$defs/item' } } }
  };
  assert.deepEqual(validate(schema, { a: [{ b: 'hello' }] }), []);
  assert.equal(validate(schema, { a: [{ b: 1 }] })[0].path, 'a[0].b');
});

test('reference siblings also apply and JSON Pointer escapes resolve', () => {
  const schema = {
    $defs: { 'text/value~': { type: 'string' } },
    $ref: '#/$defs/text~1value~0',
    minLength: 2
  };
  assert.deepEqual(validate(schema, 'ab'), []);
  assert.equal(validate(schema, 'a')[0].code, 'min_length');
  assert.equal(validate(schema, 1)[0].code, 'type');
});

test('recursive local references validate finite recursive data', () => {
  const schema = {
    $defs: {
      node: { properties: { name: { type: 'string' }, children: { items: { $ref: '#/$defs/node' } } } }
    },
    $ref: '#/$defs/node'
  };
  assert.equal(validate(schema, { name: 'root', children: [{ name: 2 }] })[0].path, 'children[0].name');
  assert.deepEqual(validate({ $defs: { loop: { $ref: '#/$defs/loop' } }, $ref: '#/$defs/loop' }, {}), []);
});

test('missing and nonlocal references fail with a schema author repair message', () => {
  for (const reference of ['#/$defs/missing', 'other.schema.json', '#/properties/name']) {
    assert.throws(() => validate({ $ref: reference }, {}), /Use an existing local/);
  }
});

test('anyOf hides failed branch errors when another branch matches', () => {
  const schema = {
    $defs: { text: { type: 'string', minLength: 2 } },
    anyOf: [{ $ref: '#/$defs/text' }, { type: 'number', minimum: 0 }]
  };
  assert.deepEqual(validate(schema, 0), []);
  assert.deepEqual(validate(schema, 'ab'), []);
  const errors = validate(schema, false, { rootPath: 'choice' });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'any_of');
  assert.equal(errors[0].path, 'choice');
  assert.match(errors[0].message, /Expected string/);
});

test('validation collects independent errors including siblings of a failing anyOf', () => {
  const schema = { type: 'string', enum: ['a'], const: 'b', anyOf: [{ const: 'c' }, { const: 'd' }] };
  assert.deepEqual(validate(schema, 2).map((error) => error.code), ['type', 'enum', 'const', 'any_of']);
  assert.equal(validate({ items: { type: 'string' } }, [1, 2, 3]).length, 3);
});

test('validation caps errors at 50 across a document', () => {
  const errors = validate({ items: { properties: { a: { type: 'string' } } } }, Array.from({ length: 100 }, () => ({ a: 1 })));
  assert.equal(errors.length, 50);
  assert.equal(errors[49].path, '[49].a');
  const missing = Array.from({ length: 100 }, (_, index) => `field${index}`);
  assert.equal(validate({ required: missing }, {}).length, 50);
  assert.equal(validate({ anyOf: [{ required: missing }, { type: 'string' }] }, {}).length, 1);
});

test('description and unsupported annotation keywords do not reject values', () => {
  assert.deepEqual(validate({ description: 'For agents', propertyNames: { pattern: '^en$' }, additionalProperties: { type: 'string' } }, { arbitrary: 1 }), []);
});

test('validation does not change the schema or input document', () => {
  const schema = { properties: { a: { items: { type: 'string' } } } };
  const value = { a: [1, 'ok'] };
  const before = structuredClone({ schema, value });
  validate(schema, value);
  assert.deepEqual({ schema, value }, before);
});

test('loadSchema reads repository schemas and caches each parsed object', () => {
  const profile = loadSchema('profile');
  assert.equal(profile.type, 'object');
  assert.strictEqual(loadSchema('profile'), profile);
  assert.notStrictEqual(loadSchema('content'), profile);
  assert.throws(() => loadSchema('../profile'), /do not include a path/);
  assert.throws(() => loadSchema('profile.schema.json'), /do not include a path/);
  assert.throws(() => loadSchema(null), /lowercase identifier/);
});
