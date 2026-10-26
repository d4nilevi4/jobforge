import { api } from '../api.js';
import { h, clear, button, field, tabs, errorBox } from '../dom.js';
import { statuses, statusLabel, relativeTime, plural } from '../lib.js';

export async function applicationsView(root, ctx) {
  const tracks = await api.get('/tracks');
  const trackNames = new Map(tracks.map(track => [track.id, track.name]));
  let status = '';
  let offset = 0;
  let timer;
  let requestId = 0;
  const search = h('input', { type: 'search', placeholder: 'Search position, company, or vacancy', 'aria-label': 'Search applications' });
  const track = h('select', {}, h('option', { value: '' }, 'All resume variants'), tracks.map(item => h('option', { value: item.id }, item.name)));
  const tabHost = h('div');
  const results = h('div', { 'aria-live': 'polite' });
  root.append(h('div', { className: 'page-heading' }, h('div', {}, h('h1', {}, 'Applications'), h('p', { className: 'muted' }, 'Review the applications your agents prepare.'))), tabHost, h('div', { className: 'toolbar' }, field('Search', search), field('Resume variant', track)), results);
  function clearFilters() {
    clearTimeout(timer);
    status = '';
    search.value = '';
    track.value = '';
    offset = 0;
    return load();
  }
  async function load() {
    const sequence = ++requestId;
    const params = new URLSearchParams({ limit: '50', offset: String(offset) });
    if (status) params.set('status', status);
    if (track.value) params.set('track', track.value);
    if (search.value.trim()) params.set('q', search.value.trim());
    results.setAttribute('aria-busy', 'true');
    try {
      const data = await api.get(`/applications?${params}`);
      if (!ctx.active || sequence !== requestId) return;
      if (offset && !data.items.length && data.total <= offset) { offset = Math.max(0, Math.floor((data.total - 1) / 50) * 50); return load(); }
      const tabItems = [{ id: '', label: `All (${Object.values(data.counts).reduce((sum, value) => sum + value, 0)})` }, ...statuses.filter(item => data.counts[item] > 0 || item === status).map(item => ({ id: item, label: `${statusLabel(item)} (${data.counts[item] || 0})` }))];
      clear(tabHost, tabs(tabItems, status, next => { status = next; offset = 0; return load(); }, 'Application status'));
      clear(results);
      if (!data.items.length) {
        results.append(status || search.value.trim() || track.value ? h('div', { className: 'empty' }, h('p', {}, 'Nothing matches these filters.'), button('Clear filters', clearFilters)) : h('div', { className: 'empty' }, h('p', {}, 'No applications yet. ', h('a', { href: '#/settings' }, 'Connect an agent in Settings'), ', then ask it to apply to a vacancy.')));
      } else {
        const rows = data.items.map(item => {
          const href = `#/applications/${encodeURIComponent(item.id)}`;
          const row = h('tr', { 'data-link': href },
            h('td', { className: 'application-position' }, h('a', { className: 'position-link', href }, item.title || 'Untitled position'), h('div', { className: 'company-line' }, item.company || 'Company not provided'), h('div', { className: 'badges' }, item.same_company_count > 0 ? h('span', { className: 'badge' }, `${item.same_company_count} earlier ${plural(item.same_company_count, 'application', 'applications')} at this company`) : null, item.warnings_count > 0 ? h('span', { className: 'badge warning' }, `${item.warnings_count} ${plural(item.warnings_count, 'warning', 'warnings')}`) : null)),
            h('td', { 'data-label': 'Track' }, trackNames.get(item.track_id) || item.track_id || '—'),
            h('td', { 'data-label': 'Verdict' }, item.verdict ? h('span', { className: `badge ${item.verdict}` }, { apply: 'Apply', maybe: 'Maybe', skip: 'Skip' }[item.verdict] || item.verdict) : '—'),
            h('td', { 'data-label': 'Status' }, h('span', { className: `badge ${item.status}` }, statusLabel(item.status))),
            h('td', { className: 'application-updated', 'data-label': 'Updated' }, h('time', { datetime: item.updated_at, title: item.updated_at }, relativeTime(item.updated_at)))
          );
          row.addEventListener('click', event => {
            if (event.target.closest('a, button') || event.ctrlKey || event.metaKey || event.shiftKey || window.getSelection()?.toString()) return;
            location.hash = href;
          });
          return row;
        });
        results.append(h('div', { className: 'table-wrap' }, h('table', { className: 'applications-table' }, h('thead', {}, h('tr', {}, ['Position', 'Track', 'Verdict', 'Status', 'Updated'].map(label => h('th', { scope: 'col' }, label)))), h('tbody', {}, rows))));
      }
      results.append(h('div', { className: 'pagination' }, h('span', { className: 'muted small' }, `${data.total ? `${offset + 1}–${Math.min(offset + 50, data.total)} of ` : ''}${data.total} ${plural(data.total, 'application', 'applications')}`), h('div', { className: 'actions' }, button('Previous', () => { offset = Math.max(0, offset - 50); load(); }, '', { disabled: offset === 0 }), button('Next', () => { offset += 50; load(); }, '', { disabled: offset + 50 >= data.total }))));
    } catch (error) {
      if (ctx.active && sequence === requestId) clear(results, errorBox(error, load));
    } finally {
      if (sequence === requestId) results.removeAttribute('aria-busy');
    }
  }
  search.addEventListener('input', () => { clearTimeout(timer); requestId++; timer = setTimeout(() => { offset = 0; load(); }, 250); });
  track.addEventListener('change', () => { clearTimeout(timer); offset = 0; load(); });
  ctx.onCleanup(() => clearTimeout(timer));
  await load();
}
