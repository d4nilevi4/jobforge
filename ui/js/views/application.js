import { api } from '../api.js';
import { h, clear, button, tabs, busy, toast, errorBox, detailsList, confirmDialog, noteDialog, externalLink, copyText, downloadBlob } from '../dom.js';
import { legalActions, statusLabel, relativeTime, plural, createDocumentCache } from '../lib.js';

export async function applicationView(root, ctx, id) {
  const path = `/applications/${encodeURIComponent(id)}`;
  const data = await api.get(path);
  const documents = createDocumentCache(api.getBlob);
  ctx.onCleanup(() => documents.dispose());
  const vacancy = data.vacancy;
  const errors = h('div');
  const actions = h('div', { className: 'actions application-actions' });
  for (const action of legalActions(data.status, { hasResume: data.has_resume ?? Boolean(data.resume) })) {
    const control = button(action.label, async () => {
      const note = action.needsNote ? await noteDialog(action.label) : '';
      if (note === null || !ctx.active) return;
      await busy(control, errors, async () => {
        await api.post(`${path}/status`, { status: action.status, ...(note ? { note } : {}) });
        toast(`Status changed to ${statusLabel(action.status)}.`);
        ctx.refresh();
      });
    }, action.primary ? 'primary' : '');
    actions.append(control);
    if (action.note) {
      control.setAttribute('aria-describedby', 'reopen-note');
      actions.append(h('small', { id: 'reopen-note', className: 'muted' }, action.note));
    }
  }
  const remove = button('Delete', async () => {
    if (!await confirmDialog('Delete application?', 'The application, documents, and history will be deleted.')) return;
    await busy(remove, errors, async () => { await api.remove(path); location.hash = '#/applications'; toast('Application deleted.'); });
  }, 'danger');
  actions.append(remove);
  root.append(h('a', { href: '#/applications' }, 'All applications'), h('div', { className: 'page-heading' }, h('div', {}, h('h1', {}, vacancy.title || 'Untitled position'), h('p', {}, [vacancy.company, vacancy.location].filter(Boolean).join(' · ')), h('div', { className: 'meta' }, externalLink('Open vacancy', vacancy.url), vacancy.source ? h('span', {}, `Source: ${vacancy.source}`) : null, data.track_id ? h('a', { href: `#/resumes/${encodeURIComponent(data.track_id)}` }, `Track: ${data.track_id}`) : null, h('span', {}, `Language: ${vacancy.language || '—'}`), data.verdict ? h('span', {}, `Verdict: ${{ apply: 'Apply', maybe: 'Maybe', skip: 'Skip' }[data.verdict] || data.verdict}`) : null, data.score !== null && data.score !== undefined ? h('span', {}, `Score: ${Math.round(data.score * 100)}%`) : null)), h('span', { className: `badge ${data.status}` }, statusLabel(data.status))), actions, errors, h('hr'));
  let selected = 'resume';
  let sideBySide = false;
  try { sideBySide = localStorage.getItem('jobforge.sideBySide') === 'true'; } catch { /* Tabs remain the default when storage is unavailable. */ }
  const wideScreen = window.matchMedia('(min-width: 1200px)');
  const tabHost = h('div');
  const panel = h('section', { role: 'tabpanel', 'aria-label': 'Application document' });
  const toggle = button('Side by side', () => {
    sideBySide = !sideBySide;
    try { localStorage.setItem('jobforge.sideBySide', String(sideBySide)); } catch { /* The choice still applies to the current view. */ }
    select(selected);
  }, 'layout-toggle');
  function updateLayout() { select(selected); }
  wideScreen.addEventListener('change', updateLayout);
  ctx.onCleanup(() => wideScreen.removeEventListener('change', updateLayout));
  root.append(h('div', { className: 'document-controls' }, tabHost, toggle), panel);
  const downloadName = type => `${vacancy.company || 'Application'} - ${vacancy.title || id} - ${type}.pdf`.replace(/[\\/:*?"<>|]/g, '-');
  async function pdf(target, name, file, label) {
    if (!file) { target.append(h('p', { className: 'muted' }, `${label} PDF is not available.`)); return; }
    const errors = h('div');
    const download = button('Download PDF', () => busy(download, errors, async () => downloadBlob(await api.getBlob(`${file}${file.includes('?') ? '&' : '?'}dl=1`), downloadName(label))));
    const frameHost = h('div', {}, h('p', { className: 'muted' }, `Loading ${label}…`));
    target.append(download, errors, frameHost);
    function failed(error) {
      if (ctx.active && panel.contains(target)) clear(frameHost, h('p', {}, `${label} PDF could not be loaded.`), errorBox(error, () => load(true)));
    }
    async function load(reload = false) {
      clear(frameHost, h('p', { className: 'muted', role: 'status' }, `Loading ${label} PDF…`));
      try {
        const url = await documents.get(name, file, { reload });
        if (!url || !ctx.active || !panel.contains(target)) return;
        clear(frameHost, h('iframe', { className: 'pdf-frame', title: `${label} PDF`, src: url, onerror: () => failed(new Error(`The ${label} PDF viewer could not open ${file}. Retry or use Download PDF to open it separately.`)) }));
      } catch (error) { failed(error); }
    }
    await load();
  }
  function resume(target) {
    if (!data.resume) {
      target.append(h('div', { className: 'empty' }, 'No resume was filed for this application. Skipped applications can contain only a vacancy and notes.'));
      return;
    }
    const pages = data.pages?.resume;
    target.append(h('p', { className: 'muted small' }, `Template: ${data.resume.template || '—'} · ${pages ?? 'Unknown'} ${plural(pages, 'page', 'pages')}`));
    if (data.warnings?.length) target.append(h('div', { className: 'callout' }, h('h3', {}, `${data.warnings.length} ${plural(data.warnings.length, 'warning', 'warnings')}`), detailsList(data.warnings)));
    const fileHost = h('div');
    target.append(fileHost);
    pdf(fileHost, 'resume.pdf', data.files?.resume_pdf, 'Resume');
  }
  function cover(target) {
    if (!data.cover) {
      target.append(h('div', { className: 'empty' }, 'No cover letter was filed for this application.'));
      return;
    }
    const pages = data.pages?.cover;
    target.append(h('div', { className: 'card' }, h('pre', { className: 'readable' }, data.cover.content?.text || ''), h('hr'), button('Copy text', () => copyText(data.cover.content?.text || ''))), h('p', { className: 'muted small' }, `Template: ${data.cover.template || '—'} · ${pages ?? 'Unknown'} ${plural(pages, 'page', 'pages')}`));
    const fileHost = h('div');
    target.append(fileHost);
    pdf(fileHost, 'cover.pdf', data.files?.cover_pdf, 'Cover letter');
  }
  function select(next) {
    const columns = wideScreen.matches && sideBySide;
    selected = columns && next === 'cover' ? 'resume' : next;
    toggle.setAttribute('aria-pressed', String(sideBySide));
    toggle.hidden = !wideScreen.matches;
    const documents = columns ? [{ id: 'resume', label: 'Documents' }] : [{ id: 'resume', label: 'Resume' }, { id: 'cover', label: 'Cover letter' }];
    clear(tabHost, tabs([...documents, { id: 'vacancy', label: 'Vacancy' }, { id: 'notes', label: 'Notes' }, { id: 'history', label: 'History' }], selected, select, 'Application details'));
    clear(panel);
    panel.setAttribute('aria-label', columns && selected === 'resume' ? 'Resume and cover letter' : { resume: 'Resume', cover: 'Cover letter', vacancy: 'Vacancy', notes: 'Notes', history: 'History' }[selected]);
    if (columns && selected === 'resume') {
      const resumePane = h('section', {}, h('h2', {}, 'Resume'));
      const coverPane = h('section', {}, h('h2', {}, 'Cover letter'));
      panel.append(h('div', { className: 'document-columns' }, resumePane, coverPane));
      resume(resumePane);
      cover(coverPane);
    } else if (selected === 'resume') {
      resume(panel);
    } else if (selected === 'cover') {
      cover(panel);
    } else if (selected === 'vacancy') {
      panel.append(h('div', { className: 'card' }, h('p', {}, externalLink('Open vacancy', vacancy.url), vacancy.source ? ` · ${vacancy.source}` : ''), h('pre', { className: 'readable' }, vacancy.text || 'No vacancy text was provided.')));
    } else if (selected === 'notes') {
      panel.append(h('div', { className: 'card' }, h('pre', { className: 'readable' }, data.notes || 'No notes were provided.')));
    } else {
      panel.append(data.events?.length ? h('ol', { className: 'history' }, data.events.map(event => h('li', {}, h('strong', {}, statusLabel(event.status)), h('div', { className: 'muted small' }, h('time', { datetime: event.at, title: event.at }, relativeTime(event.at)), event.token_name ? ` · ${event.token_name}` : ''), event.note ? h('pre', { className: 'readable' }, event.note) : null))) : h('p', { className: 'muted' }, 'No status changes yet.'));
    }
  }
  select('resume');
  if (data.same_company?.length) root.append(h('aside', { className: 'card' }, h('h2', {}, 'Same company'), h('ul', {}, data.same_company.map(item => h('li', {}, h('a', { href: `#/applications/${encodeURIComponent(item.id)}` }, item.title || 'Untitled position'), ` · ${statusLabel(item.status)} · `, h('time', { datetime: item.updated_at, title: item.updated_at }, relativeTime(item.updated_at)))))));
}
