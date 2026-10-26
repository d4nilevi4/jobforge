import { api } from '../api.js';
import { h, clear, button, field, busy, toast, confirmDialog } from '../dom.js';
import { plural } from '../lib.js';

export async function templatesView(root) {
  const templates = await api.get('/templates');
  root.append(h('h1', {}, 'Templates'), h('p', { className: 'muted' }, 'Choose a layout or fork a built-in template to make your own.'), templates.length ? h('div', { className: 'stack' }, templates.map(template => h('article', { className: 'card' }, h('h2', {}, h('a', { href: `#/templates/${encodeURIComponent(template.id)}` }, template.name)), h('p', {}, template.description || ''), h('div', { className: 'meta small' }, h('span', { className: 'badge' }, template.kind === 'resume' ? 'Resume' : 'Cover letter'), template.builtin ? h('span', { className: 'badge' }, 'Built-in') : null, h('span', {}, `Paper: ${template.paper}`), h('span', {}, `Maximum: ${template.max_pages} ${plural(template.max_pages, 'page', 'pages')}`), h('span', {}, `Version: ${template.version}`))))) : h('div', { className: 'empty' }, 'No templates are available. Check the server template directory, then reload this page.'));
}

function syntaxHelp() {
  return h('details', {}, h('summary', {}, 'Template syntax'), h('ul', {}, h('li', {}, h('code', {}, '{{path.to.value}}'), ' escapes HTML. ', h('code', {}, '{{{path}}}'), ' inserts raw HTML. ', h('code', {}, '{{.}}'), ' is the current item.'), h('li', {}, h('code', {}, '{{#each list}} ... {{/each}}'), ' supports ', h('code', {}, '{{@index}}, {{@first}}, {{@last}}'), '.'), h('li', {}, h('code', {}, '{{#if path}} ... {{else}} ... {{/if}}'), '. Missing values, empty strings, empty arrays, false, and 0 are falsy.'), h('li', {}, h('code', {}, '{{labels.experience}}'), ' uses the render language with English as the fallback.'), h('li', {}, 'Partials (', h('code', {}, '{{> name}}'), ') are not supported. Unknown paths render empty.')), h('p', {}, 'Context: ', h('code', {}, 'identity, lang, labels, paper, resume, cover, summary_html'), '. Identity has localized name and availability already resolved; links are a flat list.'));
}

function parseMeta(text) {
  let meta;
  try { meta = JSON.parse(text); } catch (error) { throw new Error(`Template meta JSON is invalid: ${error.message}. Correct it before saving.`); }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('Template meta must be a JSON object. Keep the template id, kind, paper, max_pages, and languages fields.');
  return meta;
}

export async function templateView(root, ctx, id) {
  const path = `/templates/${encodeURIComponent(id)}`;
  const template = await api.get(path);
  const errors = h('div');
  const previewErrors = h('div');
  const previewHost = h('div');
  const languages = template.meta.languages || ['en'];
  const language = h('select', {}, languages.map(lang => h('option', { value: lang }, lang)));
  const meta = template.builtin ? null : h('textarea', { className: 'mono editor', value: JSON.stringify(template.meta, null, 2), spellcheck: 'false' });
  const source = template.builtin ? null : h('textarea', { className: 'mono source-editor', value: template.source, spellcheck: 'false' });
  let savedMeta = meta?.value;
  let savedSource = source?.value;
  let previewSequence = 0;
  const preview = button('Preview', () => busy(preview, previewErrors, renderPreview));
  async function renderPreview() {
    if (meta && (meta.value !== savedMeta || source.value !== savedSource)) throw new Error('The preview endpoint renders the saved template. Save your meta and source changes, then choose Preview.');
    const sequence = ++previewSequence;
    const html = await api.post(`${path}/preview?format=html`, { lang: language.value }, { format: 'text' });
    if (ctx.active && sequence === previewSequence) clear(previewHost, h('iframe', { className: 'preview-frame', title: `${template.meta.name} preview`, sandbox: '', srcdoc: html }));
  }
  language.addEventListener('change', () => busy(preview, previewErrors, renderPreview));
  const fork = button('Fork as custom', () => busy(fork, errors, async () => {
    const result = await api.post(`${path}/fork`, {});
    toast('Custom template created.');
    location.hash = `#/templates/${encodeURIComponent(result.id)}`;
  }));
  root.append(h('a', { href: '#/templates' }, 'All templates'), h('div', { className: 'page-heading' }, h('div', {}, h('h1', {}, template.meta.name), h('p', {}, template.meta.description || '')), template.builtin ? h('span', { className: 'badge' }, 'Built-in') : null), h('p', { className: 'muted small' }, `${template.kind === 'resume' ? 'Resume' : 'Cover letter'} · ${template.meta.paper} · Maximum: ${template.meta.max_pages} ${plural(template.meta.max_pages, 'page', 'pages')} · Version ${template.version}`), errors, fork);
  if (!template.builtin) {
    const save = button('Save', () => busy(save, errors, async () => {
      const result = await api.put(path, { meta: parseMeta(meta.value), source: source.value });
      if (!ctx.active) return;
      if (result?.meta) meta.value = JSON.stringify(result.meta, null, 2);
      if (result?.source !== undefined) source.value = result.source;
      const updatedMeta = result?.meta || parseMeta(meta.value);
      const selectedLanguage = language.value;
      clear(language, (updatedMeta.languages || ['en']).map(lang => h('option', { value: lang, selected: lang === selectedLanguage }, lang)));
      savedMeta = meta.value;
      savedSource = source.value;
      toast('Template saved.');
      await busy(preview, previewErrors, renderPreview);
    }), 'primary');
    const remove = button('Delete', async () => {
      if (!await confirmDialog('Delete template?', 'The server will refuse deletion while an application uses this template.')) return;
      await busy(remove, errors, async () => { await api.remove(path); location.hash = '#/templates'; toast('Template deleted.'); });
    }, 'danger');
    root.append(h('hr'), field('Meta JSON', meta), field('Template source', source), h('div', { className: 'actions' }, save, remove), h('p', { className: 'muted small' }, 'Save source changes before previewing. Preview uses the saved template.'));
  }
  root.append(syntaxHelp(), h('div', { className: 'toolbar' }, field('Preview language', language), preview), previewErrors, previewHost);
  await busy(preview, previewErrors, renderPreview);
}
