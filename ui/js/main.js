import { api, getToken, setToken } from './api.js';
import { h, clear, button, errorBox } from './dom.js';
import { parseHashRoute, stripToken } from './lib.js';
import { applicationsView } from './views/applications.js';
import { applicationView } from './views/application.js';
import { profileView } from './views/profile.js';
import { resumesView, resumeView } from './views/resumes.js';
import { templatesView, templateView } from './views/templates.js';
import { settingsView } from './views/settings.js';
import { signinView } from './views/signin.js';

const main = document.getElementById('main');
let version = null;
let authError = null;
let current = null;
let chromeDismissed = false;

function renderBanners() {
  const host = clear(document.getElementById('banners'));
  if (version && version.api !== 'v1') host.append(h('div', { className: 'banner' }, 'The UI and server versions do not match. Update JobForge and reload this page.'));
  if (version?.chrome?.found === false && !chromeDismissed) {
    host.append(h('div', { className: 'banner' }, h('p', {}, 'PDFs need Chrome, Chromium, or Edge. ', h('a', { href: '#/settings' }, 'See Settings for installation instructions.')), button('Dismiss', () => { chromeDismissed = true; renderBanners(); })));
  }
}

function createContext() {
  const cleanups = [];
  let active = true;
  return {
    get version() { return version; },
    get active() { return active; },
    refresh() { if (active) render(); },
    onCleanup(callback) { if (active) cleanups.push(callback); else callback(); },
    objectURL(blob) {
      const url = URL.createObjectURL(blob);
      this.onCleanup(() => URL.revokeObjectURL(url));
      return url;
    },
    dispose() { active = false; cleanups.splice(0).forEach(callback => callback()); }
  };
}

async function render() {
  current?.dispose();
  const ctx = createContext();
  current = ctx;
  const route = parseHashRoute(location.hash);
  if (route.token !== undefined) {
    setToken(route.token);
    history.replaceState(null, '', `${location.pathname}${location.search}${stripToken(location.hash)}`);
  } else if (!location.hash || location.hash === '#') {
    history.replaceState(null, '', `${location.pathname}${location.search}#/applications`);
  }
  const signedIn = Boolean(getToken());
  document.getElementById('nav').hidden = !signedIn;
  for (const link of document.querySelectorAll('#nav a')) {
    if (link.hash.slice(2) === route.path[0]) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  const root = h('section', {});
  clear(main, h('p', { className: 'muted', role: 'status' }, 'Loading…'));
  try {
    if (!signedIn) await signinView(root, { onSignin: () => { authError = null; render(); }, error: authError });
    else {
      const [screen, id, ...extra] = route.path;
      if (extra.length) throw new Error('This page does not exist. Choose a page from the navigation.');
      if (screen === 'applications') await (id ? applicationView(root, ctx, id) : applicationsView(root, ctx));
      else if (screen === 'profile' && !id) await profileView(root, ctx);
      else if (screen === 'resumes') await (id ? resumeView(root, ctx, id) : resumesView(root, ctx));
      else if (screen === 'templates') await (id ? templateView(root, ctx, id) : templatesView(root, ctx));
      else if (screen === 'settings' && !id) await settingsView(root, ctx);
      else throw new Error('This page does not exist. Choose a page from the navigation.');
    }
  } catch (error) {
    if (ctx.active) clear(root, h('h1', {}, 'Unable to load page'), errorBox(error), button('Try again', () => ctx.refresh()));
  }
  if (ctx.active) {
    clear(main, root);
    document.title = `${root.querySelector('h1')?.textContent || 'Workspace'} · JobForge`;
    main.focus({ preventScroll: true });
  }
}

window.addEventListener('hashchange', render);
document.querySelector('.skip-link').addEventListener('click', event => { event.preventDefault(); main.focus(); });
window.addEventListener('jobforge:unauthorized', event => { authError = event.detail; render(); });
window.addEventListener('jobforge:signout', () => { authError = null; render(); });
api.get('/version', { public: true }).then(data => {
  version = data;
  document.getElementById('version').textContent = `v${data.version}`;
  renderBanners();
}).catch(error => {
  clear(document.getElementById('banners'), errorBox(error));
});
render();
