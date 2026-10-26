import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, paragraphs, renderTemplate } from '../server/render/engine.js';

test('values support dotted paths, raw HTML, primitives, and missing paths', () => {
  assert.equal(renderTemplate('{{person.name}}|{{person.absent.value}}|{{absent}}|{{zero}}|{{no}}|{{nil}}', {
    person: { name: 'Alex Example' }, zero: 0, no: false, nil: null
  }), 'Alex Example|||0|false|');
  assert.equal(renderTemplate('{{{html}}}|{{{missing}}}', { html: '<strong>Alex</strong>' }), '<strong>Alex</strong>|');
  assert.equal(renderTemplate('{{.}}', 'Alex Example'), 'Alex Example');
  assert.equal(renderTemplate('{{missing.path}}', null), '');
  assert.equal(renderTemplate(''), '');
});

test('escaped values neutralize HTML metacharacters and script injection', () => {
  const attack = '<script title="x & y">alert(\'x\')</script>';
  const expected = '&lt;script title=&quot;x &amp; y&quot;&gt;alert(&#39;x&#39;)&lt;/script&gt;';
  assert.equal(escapeHtml(attack), expected);
  assert.equal(renderTemplate('{{attack}}', { attack }), expected);
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(0), '0');
  assert.equal(renderTemplate('{{{attack}}}', { attack }), attack);
});

test('each handles objects, primitives, current items, and loop metadata', () => {
  const source = '{{#each list}}[{{@index}}:{{@first}}:{{@last}}:{{.}}]{{/each}}';
  assert.equal(renderTemplate(source, { list: ['a', 'b', 'c'] }),
    '[0:true:false:a][1:false:false:b][2:false:true:c]');
  assert.equal(renderTemplate(source, { list: ['only'] }), '[0:true:true:only]');
  assert.equal(renderTemplate('{{#each list}}{{name}}={{nested.value}};{{/each}}', {
    list: [{ name: 'Alex', nested: { value: 'one' } }, { name: 'Example', nested: { value: 'two' } }]
  }), 'Alex=one;Example=two;');
  assert.equal(renderTemplate('{{#each list}}{{.}};{{/each}}', { list: [null, false, 0, '<b>'] }), ';false;0;&lt;b&gt;;');
  for (const list of [[], null, false, 'text', {}, 0, undefined]) {
    assert.equal(renderTemplate('a{{#each list}}unexpected{{/each}}z', { list }), 'az');
  }
});

test('if and else apply the specified falsy rules', () => {
  for (const value of [undefined, null, '', [], false, 0]) {
    assert.equal(renderTemplate('{{#if value}}yes{{else}}no{{/if}}', { value }), 'no');
    assert.equal(renderTemplate('{{#if value}}yes{{/if}}', { value }), '');
  }
  for (const value of [' ', '0', [false], {}, true, 1, -1]) {
    assert.equal(renderTemplate('{{#if value}}yes{{else}}no{{/if}}', { value }), 'yes');
  }
  assert.equal(renderTemplate('{{#if absent.path}}yes{{else}}no{{/if}}'), 'no');
});

test('nested each and if preserve scopes and innermost loop metadata', () => {
  const source = '{{#each groups}}{{#if enabled}}{{title}}:{{#each items}}{{#if @first}}[{{/if}}'
    + '{{@index}}={{name}}/{{title}}/{{labels.summary}}{{#if @last}}]{{else}},{{/if}}{{/each}}'
    + '{{else}}off{{/if}};{{/each}}';
  assert.equal(renderTemplate(source, {
    labels: { summary: 'Summary' },
    groups: [
      { title: 'A', enabled: true, items: [{ name: 'one' }, { name: 'two', title: 'local' }] },
      { enabled: false }
    ]
  }), 'A:[0=one/A/Summary,1=two/local/Summary];off;');
  assert.equal(renderTemplate('{{#if yes}}{{#if no}}a{{else}}b{{/if}}{{else}}c{{/if}}', { yes: true }), 'b');
});

test('item properties shadow parent names and missing names fall back through parents', () => {
  assert.equal(renderTemplate('{{#each items}}{{name}}|{{parent.value}}|{{#if active}}{{name}}{{/if}};{{/each}}', {
    name: 'parent', active: true, parent: { value: 'root' },
    items: [{ name: 'local' }, {}, { name: '', parent: {} }]
  }), 'local|root|local;parent|root|parent;||;');
});

test('prototype properties are inaccessible', () => {
  assert.equal(renderTemplate('{{toString}}|{{constructor}}|{{value.__proto__}}|{{value.constructor}}', { value: {} }), '|||');
  assert.equal(renderTemplate('{{constructor}}', { constructor: 'explicit value' }), 'explicit value');
});

test('all literal whitespace is preserved including around blocks and tags', () => {
  const source = '  \nA\t{{ value }}\r\n{{#if yes}} \n {{#each list}} {{.}}\t{{/each}} \n{{else}}x{{/if}}\n ';
  assert.equal(renderTemplate(source, { value: 'V', yes: true, list: [1, 2] }), '  \nA\tV\r\n \n  1\t 2\t \n\n ');
});

test('malformed templates report the offending or opening line and a repair', () => {
  const cases = [
    ['text\n{{#each items}}\n{{.}}', 2],
    ['text\n{{#if value}}\nyes{{else}}no', 2],
    ['text\n{{/each}}', 2],
    ['text\n{{/if}}', 2],
    ['text\n{{/undefined}}', 2],
    ['{{#if value}}\n{{/each}}', 2],
    ['text\n{{else}}', 2],
    ['{{#each items}}\n{{else}}{{/each}}', 2],
    ['{{#if value}}{{else}}\n{{else}}{{/if}}', 2],
    ['text\n{{value', 2],
    ['text\n{{{value}}', 2],
    ['text\n{{#if}}', 2],
    ['text\n{{#unless value}}', 2],
    ['text\n{{> partial}}', 2],
    ['text\n{{}}', 2]
  ];
  for (const [source, line] of cases) {
    assert.throws(() => renderTemplate(source, {}), new RegExp(`line ${line}:`, 'i'), source);
  }
});

test('paragraphs split blank lines, trim edges, preserve single newlines, and remove empty paragraphs', () => {
  assert.deepEqual(paragraphs(' \n\n First line\nsecond line\n \t\n\n Third \r\n\t\r\nFourth\n\n '),
    ['First line\nsecond line', 'Third', 'Fourth']);
  for (const text of ['', ' \n\n\t', null, undefined]) assert.deepEqual(paragraphs(text), []);
  assert.deepEqual(paragraphs('one\r\ntwo'), ['one\r\ntwo']);
});
