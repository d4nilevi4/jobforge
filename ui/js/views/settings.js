import { api, setToken } from '../api.js';
import { h, clear, button, busy, toast, errorBox, confirmDialog, downloadBlob } from '../dom.js';
import { relativeTime } from '../lib.js';
import { tokenCreator } from '../agent.js';

export async function settingsView(root, ctx) {
  const [tokens, version] = await Promise.all([api.get('/tokens'), ctx.version || api.get('/version', { public: true })]);
  const tokenHost = h('div');
  const errors = h('div');
  function renderTokens(items) {
    clear(tokenHost, items.length ? h('div', { className: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Tokens' }, h('table', { className: 'tokens-table' }, h('thead', {}, h('tr', {}, ['Name', 'Scopes', 'Created', 'Last used', 'Actions'].map(label => h('th', { scope: 'col' }, label)))), h('tbody', {}, items.map(token => {
      const revoke = button('Revoke', async () => {
        if (!await confirmDialog('Revoke token?', `Agents using “${token.name}” will lose access. Revoking your current token also signs you out.`, 'Revoke')) return;
        await busy(revoke, errors, async () => { await api.remove(`/tokens/${encodeURIComponent(token.id)}`); await loadTokens(); toast('Token revoked.'); });
      }, 'danger');
      return h('tr', {}, h('td', { 'data-label': 'Name' }, token.name), h('td', { 'data-label': 'Scopes' }, h('code', {}, (token.scopes || []).join(', '))), h('td', { className: 'token-date', 'data-label': 'Created' }, h('time', { datetime: token.created_at, title: token.created_at }, relativeTime(token.created_at))), h('td', { className: 'token-date', 'data-label': 'Last used' }, token.last_used_at ? h('time', { datetime: token.last_used_at, title: token.last_used_at }, relativeTime(token.last_used_at)) : 'Never'), h('td', { 'data-label': 'Actions' }, revoke));
    })))) : h('p', { className: 'muted' }, 'No active tokens. Create a token to connect an agent.'));
  }
  async function loadTokens() {
    try { const items = await api.get('/tokens'); if (ctx.active) { renderTokens(items); clear(errors); } } catch (error) { if (ctx.active) clear(errors, errorBox(error, loadTokens)); }
  }
  renderTokens(tokens);
  const exportButton = button('Export all data', () => busy(exportButton, errors, async () => {
    const blob = await api.getBlob('/export');
    downloadBlob(blob, `jobforge-export-${new Date().toISOString().slice(0, 10)}.json`);
    toast('Export downloaded.');
  }));
  const chrome = version.chrome || {};
  root.append(h('h1', {}, 'Settings'), h('section', { className: 'card' }, h('h2', {}, 'Connect an agent'), h('ol', {}, h('li', {}, 'Create a token with the access the agent needs.'), h('li', {}, 'Give the agent the base URL and token.'), h('li', {}, 'Tell it to read ', h('code', {}, `${location.origin}/api/v1/guide`), ' first.')), tokenCreator(loadTokens)), h('section', { className: 'card' }, h('h2', {}, 'Tokens'), h('p', { className: 'muted' }, 'Revoke a token when its agent no longer needs access.'), tokenHost), h('section', { className: 'card' }, h('h2', {}, 'Instance'), h('dl', {}, h('dt', {}, 'Version'), h('dd', {}, `v${version.version}`), h('dt', {}, 'API version'), h('dd', {}, version.api), h('dt', {}, 'Schema version'), h('dd', {}, version.schema_version), h('dt', {}, 'Chrome'), h('dd', {}, chrome.found ? `${chrome.version || 'Found'} · ${chrome.path || ''}` : 'Not found. Install Chrome, Chromium, or Edge, or set CHROME_BIN to its executable path. Restart JobForge after changing CHROME_BIN. PDFs need a browser; the rest of the workspace remains available.'))), h('section', { className: 'card' }, h('h2', {}, 'Data'), h('p', {}, 'For backups, copy the ', h('code', {}, 'data/'), ' directory or run ', h('code', {}, 'npm run backup'), '. Keep backups somewhere separate from this instance.'), exportButton), errors, button('Sign out', () => { setToken(''); window.dispatchEvent(new Event('jobforge:signout')); }));
}
