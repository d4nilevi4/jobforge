let fieldId = 0;

export function h(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (name.startsWith('on') && typeof value === 'function') element.addEventListener(name.slice(2).toLowerCase(), value);
    else if (name === 'className') element.className = value;
    else if (['value', 'checked', 'disabled', 'selected', 'hidden', 'readOnly'].includes(name)) element[name] = value;
    else element.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

export function clear(element, ...children) {
  element.replaceChildren(...children.flat(Infinity).filter(child => child !== null && child !== undefined));
  return element;
}

export function toast(message) {
  const host = document.getElementById('toasts');
  const item = h('div', { className: 'toast' }, message);
  host.append(item);
  setTimeout(() => item.remove(), 6000);
}

export function detailsList(details = []) {
  return h('ul', {}, details.map(item => h('li', {}, item.path ? h('code', {}, `${item.path}: `) : null, item.message || item.code)));
}

export function errorBox(error) {
  return h('div', { className: 'error-box', role: 'alert' }, h('p', {}, error.message || String(error)), error.details?.length ? detailsList(error.details) : null);
}

export function button(label, action, className = '', attrs = {}) {
  return h('button', { type: 'button', className, onclick: action, ...attrs }, label);
}

export function field(label, control, hint) {
  if (!control.id) control.id = `field-${++fieldId}`;
  const help = hint ? h('small', { id: `${control.id}-hint`, className: 'muted' }, hint) : null;
  if (help) control.setAttribute('aria-describedby', help.id);
  return h('div', { className: 'field' }, h('label', { for: control.id }, label), control, help);
}

export function tabs(items, selected, onSelect, label = 'Sections') {
  async function activate(index) {
    const host = list.parentElement;
    await onSelect(items[index].id);
    host?.querySelector('[role="tab"][aria-selected="true"]')?.focus();
  }
  const buttons = items.map((item, index) => button(item.label, () => activate(index), '', { role: 'tab', 'aria-selected': String(item.id === selected), tabindex: item.id === selected ? 0 : -1 }));
  const list = h('div', { className: 'tabs', role: 'tablist', 'aria-label': label }, buttons);
  list.addEventListener('keydown', event => {
    const index = buttons.indexOf(document.activeElement);
    if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    activate(next);
  });
  return list;
}

export async function busy(control, errors, action) {
  control.disabled = true;
  if (errors) clear(errors);
  try { return await action(); } catch (error) {
    if (error.name !== 'AbortError') {
      if (errors) clear(errors, errorBox(error));
      else toast(error.message);
    }
  } finally { control.disabled = false; }
}

export function dialog(title, content, actions = []) {
  const element = h('dialog', { 'aria-labelledby': `dialog-${++fieldId}` });
  const heading = h('h2', { id: `dialog-${fieldId}` }, title);
  element.append(heading, content, h('div', { className: 'actions' }, ...actions, button('Close', () => element.close())));
  document.body.append(element);
  element.addEventListener('close', () => element.remove(), { once: true });
  element.showModal();
  return element;
}

export function confirmDialog(title, message, label = 'Delete') {
  return new Promise(resolve => {
    let confirmed = false;
    const element = dialog(title, h('p', {}, message), [button(label, () => { confirmed = true; element.close(); }, 'danger')]);
    element.addEventListener('close', () => resolve(confirmed), { once: true });
  });
}

export function noteDialog(title) {
  return new Promise(resolve => {
    const input = h('textarea', { rows: 4 });
    let result = null;
    const element = dialog(title, field('Note (optional)', input), [button('Continue', () => { result = input.value; element.close(); }, 'primary')]);
    element.addEventListener('close', () => resolve(result), { once: true });
    input.focus();
  });
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); } catch {
    const previous = document.activeElement;
    const input = h('textarea', { className: 'clipboard-fallback', value: text, 'aria-label': 'Text to copy' });
    document.body.append(input);
    input.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch { /* Offer manual copying below. */ }
    input.remove();
    previous?.focus();
    if (!copied) {
      dialog('Copy text', field('Select and copy this text', h('textarea', { value: text, readOnly: true, rows: 10 })));
      return;
    }
  }
  toast('Copied to clipboard.');
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

export function externalLink(label, url) {
  const href = safeUrl(url);
  return href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, label) : null;
}
