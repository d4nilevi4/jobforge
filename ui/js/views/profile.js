import { api, ApiError } from '../api.js';
import { h, clear, button, field, tabs, busy, toast, errorBox, dialog } from '../dom.js';
import { cleanProfile, diffKeys, linesToArray, arrayToLines, relativeTime, plural } from '../lib.js';
import { setupAgentBox } from '../agent.js';

function parseDocument(text) {
  let document;
  try { document = JSON.parse(text); } catch (error) { throw new Error(`Profile JSON is invalid: ${error.message}. Correct the JSON, then try again.`); }
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('Profile JSON must be an object. Start with {"schema_version":1,"identity":{"name":""},"experience":[],"skills":[]}.');
  const allowed = ['schema_version', 'identity', 'about', 'experience', 'projects', 'education', 'skills', 'familiar', 'languages', 'do_not_claim', 'rules'];
  const identityKeys = ['name', 'name_localized', 'email', 'phone', 'location', 'links', 'availability'];
  const details = Object.keys(document).filter(key => !allowed.includes(key)).map(key => ({ path: key, code: 'unknown_field', message: 'Remove this unknown profile field.' }));
  if (document.identity && typeof document.identity === 'object') details.push(...Object.keys(document.identity).filter(key => !identityKeys.includes(key)).map(key => ({ path: `identity.${key}`, code: 'unknown_field', message: 'Remove this unknown identity field.' })));
  if (details.length) throw new ApiError(422, 'validation_failed', 'Profile JSON contains unknown fields. Remove the fields listed below.', details);
  checkEditorShape(document);
  return document;
}

function checkEditorShape(doc) {
  const fail = (path, type) => { throw new ApiError(422, 'validation_failed', 'Profile JSON has an invalid field type. Correct it before opening the forms or saving.', [{ path, code: 'type', message: `Use ${type} for this field.` }]); };
  const object = (value, path) => { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'an object'); };
  const strings = (value, keys, path) => {
    for (const key of keys) if (value[key] !== undefined && typeof value[key] !== 'string') fail(`${path}${key}`, 'a string');
  };
  const localized = (value, path) => { if (value === undefined) return; object(value, path); strings(value, Object.keys(value), `${path}.`); };
  const list = (value, path, visit) => {
    if (value === undefined) return;
    if (!Array.isArray(value)) fail(path, 'an array');
    value.forEach((item, index) => visit(item, `${path}[${index}]`));
  };
  const lines = (value, path) => list(value, path, (item, itemPath) => { if (typeof item !== 'string') fail(itemPath, 'a string'); });
  if (doc.identity !== undefined) {
    object(doc.identity, 'identity');
    strings(doc.identity, ['name', 'email', 'phone', 'location'], 'identity.');
    localized(doc.identity.name_localized, 'identity.name_localized');
    localized(doc.identity.availability, 'identity.availability');
    list(doc.identity.links, 'identity.links', (item, path) => { object(item, path); strings(item, ['label', 'url'], `${path}.`); });
  }
  strings(doc, ['about'], '');
  const fields = { experience: ['id', 'company', 'title', 'dates', 'location'], projects: ['id', 'title', 'tech', 'link', 'link_label'], education: ['institution', 'degree', 'years'], skills: ['key', 'label'], familiar: ['item', 'qualifier'], languages: ['name', 'level'], do_not_claim: ['text'] };
  for (const [key, keys] of Object.entries(fields)) list(doc[key], key, (item, path) => {
    object(item, path);
    strings(item, keys, `${path}.`);
    if (['experience', 'projects'].includes(key)) lines(item.bullets, `${path}.bullets`);
    if (key === 'skills') { lines(item.items, `${path}.items`); localized(item.label_localized, `${path}.label_localized`); }
    if (key === 'do_not_claim') lines(item.patterns, `${path}.patterns`);
  });
  if (doc.rules !== undefined) {
    object(doc.rules, 'rules');
    strings(doc.rules, ['notes'], 'rules.');
    if (doc.rules.cover_max_words !== undefined && (!Number.isInteger(doc.rules.cover_max_words) || doc.rules.cover_max_words < 1)) fail('rules.cover_max_words', 'a positive integer');
    list(doc.rules.forbid_patterns, 'rules.forbid_patterns', (item, path) => { object(item, path); strings(item, ['pattern', 'message'], `${path}.`); });
  }
}

export async function profileView(root, ctx) {
  const response = await api.get('/profile');
  let doc = structuredClone(response.profile || { schema_version: 1, identity: { name: '' }, experience: [], skills: [] });
  let baseline = cleanProfile(doc);
  let selected = 'forms';
  let jsonInput;
  let dirty = false;
  const errors = h('div');
  const warnings = h('div');
  const tabHost = h('div');
  const panel = h('section', { role: 'tabpanel', 'aria-label': 'Profile editor' });
  const status = h('span', { className: 'muted small', role: 'status' });
  const save = button('Save', () => saveProfile(save), 'primary');
  const bar = h('div', { className: 'sticky-bar' }, status, save);
  const sectionNav = h('nav', { className: 'profile-nav', 'aria-label': 'On this page' });
  const editor = h('div', { className: 'profile-editor' }, panel, bar);
  const layout = h('div', { className: 'profile-layout' }, sectionNav, editor);
  const onboarding = response.empty || !response.profile ? setupAgentBox() : null;
  root.append(...[h('div', { className: 'page-heading' }, h('div', {}, h('h1', {}, 'About me'), h('p', { className: 'muted' }, 'Keep your facts here. Agents use this profile to prepare honest applications.'))), onboarding, errors, warnings, tabHost, layout].filter(Boolean)); // append(null) would print "null"

  function updateDirty() {
    let changes;
    try { changes = diffKeys(baseline, cleanProfile(selected === 'json' && jsonInput ? parseDocument(jsonInput.value) : doc)); } catch { changes = ['JSON']; }
    dirty = changes.length > 0;
    status.textContent = dirty ? `Unsaved changes · ${changes.join(', ')}` : 'All changes saved';
    save.disabled = !dirty;
  }
  function beforeUnload(event) { if (dirty) { event.preventDefault(); event.returnValue = ''; } }
  window.addEventListener('beforeunload', beforeUnload);
  ctx.onCleanup(() => window.removeEventListener('beforeunload', beforeUnload));

  async function saveProfile(control) {
    await busy(control, errors, async () => {
      if (selected === 'json') doc = parseDocument(jsonInput.value);
      const cleaned = cleanProfile(doc);
      const result = await api.put('/profile', cleaned);
      if (!ctx.active) return;
      doc = structuredClone(result.profile || cleaned);
      baseline = cleanProfile(doc);
      if (jsonInput && selected === 'json') jsonInput.value = JSON.stringify(doc, null, 2);
      clear(warnings);
      if (result.tracks_failing?.length) warnings.append(h('div', { className: 'callout' }, h('p', {}, 'These resume variants no longer pass the profile checks. Review and save them before using them:'), h('ul', {}, result.tracks_failing.map(id => h('li', {}, h('a', { href: `#/resumes/${encodeURIComponent(id)}` }, id))))));
      onboarding?.remove();
      toast('Profile saved.');
      if (selected === 'forms') renderForms();
    });
    updateDirty();
  }

  function textField(object, key, label, options = {}) {
    const { textarea = false, lines = false, comma = false, number = false, ...attrs } = options;
    const value = lines ? arrayToLines(object[key]) : comma ? (object[key] || []).join(', ') : object[key] ?? '';
    const input = h(textarea || lines ? 'textarea' : 'input', { value, ...(number ? { type: 'number', min: 1, step: 1 } : {}), ...attrs });
    input.addEventListener('input', () => {
      object[key] = lines ? linesToArray(input.value) : comma ? input.value.split(',').map(value => value.trim()).filter(Boolean) : number ? input.value === '' ? '' : Number(input.value) : input.value;
      updateDirty();
    });
    return field(label, input);
  }

  function localized(object, key, label) {
    let entries = Object.entries(object[key] || {}).map(([language, value]) => ({ language, value }));
    const host = h('div');
    function sync() { object[key] = Object.fromEntries(entries.filter(row => row.language.trim()).map(row => [row.language.trim(), row.value])); updateDirty(); }
    function render() {
      clear(host, h('h3', {}, label), entries.map((row, index) => {
        const language = h('input', { value: row.language, placeholder: 'en', pattern: '[a-z]{2}(-[A-Za-z]+)?', spellcheck: 'false' });
        const value = h('input', { value: row.value });
        language.addEventListener('input', () => { row.language = language.value; sync(); });
        value.addEventListener('input', () => { row.value = value.value; sync(); });
        return h('div', { className: 'localized-row' }, field('Language code', language), field('Value', value), button('Remove', () => { entries.splice(index, 1); sync(); render(); }, '', { 'aria-label': `Remove ${label.toLowerCase()} row ${index + 1}` }));
      }), button(`Add ${label.toLowerCase()}`, () => { entries.push({ language: '', value: '' }); render(); }));
    }
    render();
    return host;
  }

  function repeat(object, key, title, singular, fields, { move = false, extra } = {}) {
    const section = h('section', { className: 'card' });
    if (!Array.isArray(object[key])) object[key] = [];
    function render() {
      clear(section, h('h2', {}, title), object[key].map((item, index) => {
        const controls = h('div', { className: 'actions' });
        if (move) {
          for (const [label, direction] of [['Move up', -1], ['Move down', 1]]) controls.append(button(label, () => {
            [object[key][index], object[key][index + direction]] = [object[key][index + direction], object[key][index]];
            updateDirty(); render();
          }, '', { disabled: index + direction < 0 || index + direction >= object[key].length, 'aria-label': `${label} ${singular} ${index + 1}` }));
        }
        controls.append(button('Remove', () => { object[key].splice(index, 1); updateDirty(); render(); }, '', { 'aria-label': `Remove ${singular} ${index + 1}` }));
        return h('div', { className: 'repeat-item' }, h('h3', {}, `${singular[0].toUpperCase()}${singular.slice(1)} ${index + 1}`), controls, fields.map(([name, label, options]) => textField(item, name, label, options)), extra ? extra(item) : null);
      }), button(`Add ${singular}`, () => { object[key].push({}); updateDirty(); render(); }));
    }
    render();
    return section;
  }

  function renderForms() {
    if (!doc.identity || typeof doc.identity !== 'object' || Array.isArray(doc.identity)) doc.identity = { name: '' };
    if (!doc.rules || typeof doc.rules !== 'object' || Array.isArray(doc.rules)) doc.rules = {};
    const identity = doc.identity;
    const sections = [
      h('section', { className: 'card' }, h('h2', {}, 'Identity'), h('div', { className: 'form-grid' }, textField(identity, 'name', 'Name'), textField(identity, 'email', 'Email', { type: 'email' }), textField(identity, 'phone', 'Phone', { type: 'tel' }), textField(identity, 'location', 'Location')), localized(identity, 'name_localized', 'Name per language'), h('hr'), localized(identity, 'availability', 'Availability per language'), h('hr'), repeat(identity, 'links', 'Links', 'link', [['label', 'Label'], ['url', 'URL', { type: 'url' }]])),
      h('section', { className: 'card' }, h('h2', {}, 'About'), textField(doc, 'about', 'Notes for agents: goals, tone, what to avoid', { textarea: true, rows: 5 })),
      repeat(doc, 'experience', 'Experience', 'experience', [['company', 'Company'], ['title', 'Title'], ['dates', 'Dates'], ['location', 'Location'], ['bullets', 'Bullets (one per line)', { lines: true, rows: 5 }]], { move: true }),
      repeat(doc, 'projects', 'Projects', 'project', [['title', 'Title'], ['tech', 'Tech'], ['link', 'Link', { type: 'url' }], ['link_label', 'Link label'], ['bullets', 'Bullets (one per line)', { lines: true }]], { move: true }),
      repeat(doc, 'education', 'Education', 'education', [['institution', 'Institution'], ['degree', 'Degree'], ['years', 'Years']]),
      repeat(doc, 'skills', 'Skills', 'skill group', [['key', 'Key', { pattern: '[a-z0-9_-]+' }], ['label', 'Label'], ['items', 'Items (comma separated)', { comma: true }]], { extra: item => localized(item, 'label_localized', 'Label per language') }),
      repeat(doc, 'familiar', 'Familiar', 'familiar item', [['item', 'Known only with a qualifier'], ['qualifier', 'Qualifier']]),
      repeat(doc, 'languages', 'Languages', 'language', [['name', 'Name'], ['level', 'Level']]),
      repeat(doc, 'do_not_claim', 'Do not claim', 'rule', [['text', 'Rule text', { textarea: true }], ['patterns', 'Regex patterns (one per line)', { lines: true, className: 'mono', spellcheck: 'false' }]]),
      h('section', { className: 'card' }, h('h2', {}, 'Rules'), textField(doc.rules, 'cover_max_words', 'Cover max words', { number: true }), repeat(doc.rules, 'forbid_patterns', 'Forbidden patterns', 'forbidden pattern', [['pattern', 'Pattern', { className: 'mono', spellcheck: 'false' }], ['message', 'Message']]), textField(doc.rules, 'notes', 'Notes', { textarea: true }))
    ];
    const keys = ['identity', 'about', 'experience', 'projects', 'education', 'skills', 'familiar', 'languages', 'do-not-claim', 'rules'];
    clear(sectionNav, h('h2', {}, 'On this page'), h('ul', {}, sections.map((section, index) => {
      section.id = `profile-${keys[index]}`;
      section.classList.add('profile-section');
      const heading = section.querySelector('h2');
      heading.setAttribute('tabindex', '-1');
      return h('li', {}, h('a', { href: '#/profile', 'aria-controls': section.id, onclick: event => {
        event.preventDefault();
        section.scrollIntoView({ block: 'start' });
        const currentHeading = section.querySelector('h2');
        currentHeading.setAttribute('tabindex', '-1');
        currentHeading.focus({ preventScroll: true });
      } }, heading.textContent));
    })));
    clear(panel, sections);
  }

  async function renderHistory() {
    clear(panel, h('p', { className: 'muted' }, 'Loading revisions…'));
    try {
      const revisions = await api.get('/profile/revisions');
      if (!ctx.active || selected !== 'history') return;
      clear(panel, h('p', { className: 'muted small' }, `${revisions.length} ${plural(revisions.length, 'revision', 'revisions')}`), revisions.length ? h('div', { className: 'stack' }, revisions.map(revision => {
        const localErrors = h('div');
        const view = button('View JSON', () => busy(view, localErrors, async () => {
          const document = await api.get(`/profile/revisions/${encodeURIComponent(revision.id)}`);
          if (ctx.active) dialog('Profile revision', h('pre', {}, JSON.stringify(document, null, 2)));
        }));
        const load = button('Load into editor', () => busy(load, localErrors, async () => {
          const document = await api.get(`/profile/revisions/${encodeURIComponent(revision.id)}`);
          if (!ctx.active) return;
          doc = structuredClone(document);
          select('forms');
          updateDirty();
          toast('Revision loaded. Save to restore it.');
        }));
        return h('article', { className: 'card' }, h('p', {}, h('time', { datetime: revision.created_at, title: revision.created_at }, relativeTime(revision.created_at)), revision.token_name ? ` · ${revision.token_name}` : '', ` · Revision ${revision.id}`), h('div', { className: 'actions' }, view, load), localErrors);
      })) : h('div', { className: 'empty' }, 'No revisions yet. Save your profile to create the first revision.'));
    } catch (error) { if (ctx.active && selected === 'history') clear(panel, errorBox(error, renderHistory)); }
  }

  function select(next) {
    if (selected === 'json' && next !== 'json') {
      try { doc = parseDocument(jsonInput.value); clear(errors); } catch (error) { clear(errors, errorBox(error)); return; }
    }
    selected = next;
    layout.classList.toggle('with-section-nav', next === 'forms');
    sectionNav.hidden = next !== 'forms';
    clear(tabHost, tabs([{ id: 'forms', label: 'Forms' }, { id: 'json', label: 'JSON' }, { id: 'history', label: 'History' }], selected, select, 'Profile sections'));
    panel.setAttribute('aria-label', `${selected === 'json' ? 'JSON' : selected === 'forms' ? 'Forms' : 'History'} profile tab`);
    bar.hidden = next === 'history';
    if (next === 'forms') renderForms();
    else if (next === 'json') {
      jsonInput = h('textarea', { className: 'mono json-editor', value: JSON.stringify(doc, null, 2), spellcheck: 'false' });
      jsonInput.addEventListener('input', updateDirty);
      const format = button('Format', () => {
        try { doc = parseDocument(jsonInput.value); jsonInput.value = JSON.stringify(doc, null, 2); clear(errors); updateDirty(); } catch (error) { clear(errors, errorBox(error)); }
      });
      const jsonSave = button('Save', () => saveProfile(jsonSave), 'primary');
      clear(panel, field('Profile document', jsonInput), h('div', { className: 'actions' }, format, jsonSave));
    } else renderHistory();
    updateDirty();
  }
  select('forms');
}
