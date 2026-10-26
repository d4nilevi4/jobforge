import { api } from '../api.js';
import { h, clear, button, field, busy, toast, detailsList, confirmDialog } from '../dom.js';
import { buildBaseFromProfile, slugValid, relativeTime } from '../lib.js';

export async function resumesView(root) {
  const tracks = await api.get('/tracks');
  root.append(h('div', { className: 'page-heading' }, h('div', {}, h('h1', {}, 'Resumes'), h('p', { className: 'muted' }, 'Keep a starting point for each kind of role. Agents tailor it for each vacancy.')), h('a', { href: '#/resumes/new', className: 'button primary' }, 'New resume variant')));
  if (!tracks.length) root.append(h('div', { className: 'empty' }, h('p', {}, 'No resume variants yet. Fill in ', h('a', { href: '#/profile' }, 'About me'), ', then create a variant for the roles you want.'), h('a', { href: '#/resumes/new' }, 'Create a resume variant')));
  else root.append(h('div', { className: 'stack' }, tracks.map(track => h('article', { className: 'card' }, h('h2', {}, h('a', { href: `#/resumes/${encodeURIComponent(track.id)}` }, track.name)), h('p', {}, track.when_to_use), h('div', { className: 'meta small' }, h('span', {}, `Language: ${track.language}`), h('span', {}, `Resume: ${track.resume_template}`), h('span', {}, `Cover: ${track.cover_template}`), h('time', { datetime: track.updated_at, title: track.updated_at }, `Updated ${relativeTime(track.updated_at).toLowerCase()}`))))));
}

function parseBase(text) {
  let content;
  try { content = JSON.parse(text); } catch (error) { throw new Error(`Base resume JSON is invalid: ${error.message}. Correct it before previewing or saving.`); }
  if (!content || typeof content !== 'object' || Array.isArray(content)) throw new Error('Base resume content must be a JSON object. Use “Fill from my profile” to create a starting point.');
  return content;
}

export async function resumeView(root, ctx, id) {
  const creating = id === 'new';
  const [profileResponse, resumeTemplates, coverTemplates, existing] = await Promise.all([api.get('/profile'), api.get('/templates?kind=resume'), api.get('/templates?kind=cover'), creating ? null : api.get(`/tracks/${encodeURIComponent(id)}`)]);
  root.append(h('a', { href: '#/resumes' }, 'All resume variants'), h('h1', {}, creating ? 'New resume variant' : existing.track.name));
  if (!profileResponse.profile || profileResponse.empty) {
    root.append(h('div', { className: 'empty' }, h('p', {}, 'Add your facts in ', h('a', { href: '#/profile' }, 'About me'), ' before creating or editing a resume variant.')));
    return;
  }
  const doc = existing?.track || { schema_version: 1, name: '', when_to_use: '', language: 'en', resume_template: resumeTemplates[0]?.id || '', cover_template: coverTemplates[0]?.id || '', base: buildBaseFromProfile(profileResponse.profile) };
  const slug = h('input', { value: creating ? '' : id, readOnly: !creating, required: true, pattern: '[a-z0-9][a-z0-9-]{0,62}', maxlength: 63, spellcheck: 'false' });
  const name = h('input', { value: doc.name, required: true });
  const when = h('textarea', { value: doc.when_to_use, rows: 3, required: true });
  const notes = h('textarea', { value: doc.notes || '', rows: 4 });
  const language = h('input', { value: doc.language, required: true, pattern: '[a-z]{2}(-[A-Za-z]+)?', spellcheck: 'false' });
  function templateSelect(items, selected) {
    const choices = [...items];
    if (selected && !choices.some(item => item.id === selected)) choices.push({ id: selected, name: `${selected} (current)` });
    return h('select', { required: true }, choices.map(item => h('option', { value: item.id, selected: item.id === selected }, item.name)));
  }
  const resume = templateSelect(resumeTemplates, doc.resume_template);
  const cover = templateSelect(coverTemplates, doc.cover_template);
  const coverText = h('textarea', { value: doc.base_cover || '', rows: 5 });
  const base = h('textarea', { className: 'mono editor', value: JSON.stringify(doc.base, null, 2), spellcheck: 'false', required: true });
  const errors = h('div');
  const warnings = h('div');
  const previewHost = h('div');
  const previewErrors = h('div');
  const preview = button('Preview', () => busy(preview, previewErrors, async () => {
    if (!resume.value) throw new Error('Choose a resume template before previewing.');
    const html = await api.post(`/templates/${encodeURIComponent(resume.value)}/preview?format=html`, { content: parseBase(base.value), lang: language.value }, { format: 'text' });
    if (ctx.active) clear(previewHost, h('iframe', { className: 'preview-frame', title: 'Resume preview', sandbox: '', srcdoc: html }));
  }));
  const fill = button('Fill from my profile', () => {
    base.value = JSON.stringify(buildBaseFromProfile(profileResponse.profile, language.value || 'en'), null, 2);
    toast('Starting content filled from your profile. Review it before saving.');
  });
  const submit = h('button', { type: 'submit', className: 'primary' }, 'Save');
  const form = h('form', { className: 'card' }, h('div', { className: 'form-grid' }, field('Id', slug, 'Lowercase letters, numbers, and hyphens; at most 63 characters. Fixed after creation.'), field('Name', name)), field('When to use', when), field('Notes for agents', notes), h('div', { className: 'form-grid' }, field('Language', language), field('Resume template', resume), field('Cover template', cover)), field('Starting cover text (optional)', coverText), field('Base resume content', base), h('div', { className: 'actions' }, fill, preview), previewErrors, previewHost, h('hr'), errors, warnings, h('div', { className: 'actions' }, submit));
  form.addEventListener('submit', event => {
    event.preventDefault();
    busy(submit, errors, async () => {
      if (!slugValid(slug.value)) throw new Error('Resume variant id is invalid. Use 1–63 lowercase letters, numbers, or hyphens, starting with a letter or number.');
      const track = { schema_version: 1, name: name.value, when_to_use: when.value, notes: notes.value, language: language.value, resume_template: resume.value, cover_template: cover.value, base: parseBase(base.value) };
      if (coverText.value.trim()) track.base_cover = coverText.value;
      const result = await api.put(`/tracks/${encodeURIComponent(slug.value)}`, track);
      if (!ctx.active) return;
      clear(warnings, result.warnings?.length ? h('div', { className: 'callout' }, h('h3', {}, 'Warnings'), detailsList(result.warnings)) : null);
      toast('Resume variant saved.');
      if (creating) {
        slug.readOnly = true;
        history.replaceState(null, '', `#/resumes/${encodeURIComponent(slug.value)}`);
        root.querySelector('h1').textContent = name.value;
        if (!form.querySelector('.danger')) form.lastElementChild.append(deleteButton(slug.value));
      }
    });
  });
  function deleteButton(trackId) {
    const remove = button('Delete', async () => {
      if (!await confirmDialog('Delete resume variant?', 'This removes the variant. Existing applications keep their saved content.')) return;
      await busy(remove, errors, async () => { await api.remove(`/tracks/${encodeURIComponent(trackId)}`); location.hash = '#/resumes'; toast('Resume variant deleted.'); });
    }, 'danger');
    return remove;
  }
  if (!creating) form.lastElementChild.append(deleteButton(id));
  root.append(form);
}
