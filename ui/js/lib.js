export const statuses = ['draft', 'needs_review', 'approved', 'sent', 'interview', 'offer', 'rejected', 'skipped'];

export function plural(n, one, other) {
  return n === 1 ? one : other;
}

export function statusLabel(status) {
  const labels = { draft: 'Draft', needs_review: 'Needs review', approved: 'Approved', sent: 'Sent', interview: 'Interview', offer: 'Offer', rejected: 'Rejected', skipped: 'Skipped' };
  return Object.hasOwn(labels, status) ? labels[status] : status || 'Unknown';
}

export function relativeTime(iso, now = Date.now()) {
  if (!iso) return 'Unknown';
  const time = Date.parse(iso);
  const current = now instanceof Date ? now.getTime() : typeof now === 'string' ? Date.parse(now) : now;
  if (!Number.isFinite(time) || !Number.isFinite(current)) return 'Unknown';
  const seconds = (current - time) / 1000;
  if (Math.abs(seconds) < 60) return 'Just now';
  const units = [[31536000, 'year'], [2592000, 'month'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
  const [size, unit] = units.find(([size]) => Math.abs(seconds) >= size);
  const count = Math.floor(Math.abs(seconds) / size);
  const label = `${count} ${plural(count, unit, `${unit}s`)}`;
  return seconds < 0 ? `In ${label}` : `${label} ago`;
}

export function legalActions(status, { hasResume = false } = {}) {
  const approve = { status: 'approved', label: 'Approve', primary: true };
  const draft = { status: 'draft', label: 'Back to draft' };
  const skip = { status: 'skipped', label: 'Skip' };
  const reject = { status: 'rejected', label: 'Rejected', needsNote: true };
  const reopen = { status: 'draft', label: 'Reopen as draft', primary: true };
  const actions = {
    draft: [approve, { status: 'needs_review', label: 'Needs review', needsNote: true }, skip],
    needs_review: [approve, draft, skip],
    approved: [{ status: 'sent', label: 'Mark as sent', primary: true }, draft],
    sent: [{ status: 'interview', label: 'Interview', primary: true }, reject],
    interview: [{ status: 'offer', label: 'Offer', primary: true }, reject],
    offer: [reject],
    rejected: hasResume ? [reopen] : [],
    skipped: [{ ...reopen, ...(!hasResume ? { note: 'Reopening only changes the status. An agent must file documents with PUT before this application can be approved.' } : {}) }]
  };
  return (Object.hasOwn(actions, status) ? actions[status] : []).map(action => ({ ...action }));
}

function decode(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

export function parseHashRoute(hash = '') {
  const fragment = String(hash).replace(/^#/, '');
  const tokens = [...fragment.matchAll(/(?:^|[&?])token=([^&?]*)/g)];
  const clean = stripToken(hash).replace(/^#/, '');
  const route = clean.split(/[?&]/)[0];
  const result = { path: route.split('/').filter(Boolean).map(decode) };
  if (!result.path.length) result.path = ['applications'];
  if (tokens.length) result.token = decode(tokens[tokens.length - 1][1]);
  return result;
}

export function routeChanged(previousHash, nextHash) {
  if (previousHash === null || previousHash === undefined) return true;
  const previous = parseHashRoute(previousHash).path;
  const next = parseHashRoute(nextHash).path;
  return previous.length !== next.length || previous.some((part, index) => part !== next[index]);
}

export function stripToken(hash = '') {
  const fragment = String(hash).replace(/^#/, '');
  const clean = fragment.replace(/(^|[&?])token=[^&?]*/g, '$1').replace(/([?&])[?&]+/g, '$1').replace(/^[?&]+|[?&]+$/g, '');
  return `#${clean || '/applications'}`;
}

export async function resolveResumeRoute(id, getTrack) {
  if (id === '+new') return { creating: true, existing: null };
  try {
    return { creating: false, existing: await getTrack(id) };
  } catch (error) {
    if (id === 'new' && error.status === 404) return { creating: true, existing: null };
    throw error;
  }
}

export function splitTemplateRef(ref) {
  const match = typeof ref === 'string' && /^([a-z0-9][a-z0-9-]*)(?:@([1-9][0-9]*))?$/.exec(ref);
  const version = match?.[2] === undefined ? undefined : Number(match[2]);
  if (!match || (version !== undefined && !Number.isSafeInteger(version))) {
    throw new Error('Template reference is invalid. Use an id or id@version, such as classic@1, with a positive integer version.');
  }
  return { id: match[1], version };
}

export function templateOptions(items, ref, { allowEmpty = false } = {}) {
  const selected = ref ? splitTemplateRef(ref).id : '';
  const choices = items.map(item => ({ value: item.id, label: item.name, selected: item.id === selected }));
  if (allowEmpty) choices.unshift({ value: '', label: 'No default cover letter', selected: !selected });
  if (selected && !items.some(item => item.id === selected)) choices.push({ value: selected, label: `${ref} (current)`, selected: true });
  return choices;
}

export function selectedTemplateRef(original, selected) {
  return original && splitTemplateRef(original).id === selected ? original : selected;
}

export function templatePreviewPath(ref) {
  const { id, version } = splitTemplateRef(ref);
  return `/templates/${encodeURIComponent(id)}/preview?format=html${version === undefined ? '' : `&version=${version}`}`;
}

export function createDocumentCache(loadBlob, urls = URL) {
  const entries = new Map();
  let active = true;
  function revoke(entry) {
    if (entry?.url) urls.revokeObjectURL(entry.url);
  }
  return {
    get(name, file, { reload = false } = {}) {
      if (!active) return Promise.resolve(null);
      const current = entries.get(name);
      if (current && current.file === file && !reload) return current.promise;
      revoke(current);
      const entry = { file, url: null };
      entries.set(name, entry);
      entry.promise = Promise.resolve().then(() => loadBlob(file)).then(blob => {
        if (!active || entries.get(name) !== entry) return null;
        entry.url = urls.createObjectURL(blob);
        return entry.url;
      }).catch(error => {
        if (entries.get(name) === entry) entries.delete(name);
        throw error;
      });
      return entry.promise;
    },
    dispose() {
      active = false;
      entries.forEach(revoke);
      entries.clear();
    }
  };
}

export function buildBaseFromProfile(profile, language = 'en') {
  const pick = (item, keys) => Object.fromEntries(keys.filter(key => item[key] !== undefined).map(key => [key, structuredClone(item[key])]));
  return {
    schema_version: 1,
    language,
    headline: profile?.identity?.role_default || profile?.experience?.[0]?.title || '',
    summary: '',
    experience: (profile?.experience || []).map(item => ({ ...pick(item, ['company', 'title', 'dates', 'location']), bullets: [...(item.bullets || [])] })),
    projects: (profile?.projects || []).map(item => ({ ...pick(item, ['title', 'tech', 'link', 'link_label']), bullets: [...(item.bullets || [])] })),
    skills: (profile?.skills || []).map(item => ({ label: item.label_localized?.[language] || item.label, items: (item.items || []).join(', ') })),
    education: (profile?.education || []).map(item => pick(item, ['institution', 'degree', 'years']))
  };
}

const requiredProfileKeys = {
  '': ['schema_version', 'identity', 'experience', 'skills'],
  identity: ['name'],
  'identity.links[]': ['label', 'url'],
  'experience[]': ['company', 'title', 'dates', 'bullets'],
  'projects[]': ['title', 'bullets'],
  'education[]': ['institution', 'degree', 'years'],
  'skills[]': ['key', 'label', 'items'],
  'familiar[]': ['item', 'qualifier'],
  'languages[]': ['name', 'level'],
  'do_not_claim[]': ['text'],
  'rules.forbid_patterns[]': ['pattern', 'message']
};

export function cleanProfile(doc) {
  function clean(value, path) {
    if (typeof value === 'string') return value.trim() ? value : undefined;
    if (Array.isArray(value)) {
      const items = value.map(item => clean(item, `${path}[]`)).filter(item => item !== undefined);
      return items.length ? items : undefined;
    }
    if (value && typeof value === 'object') {
      const entries = Object.entries(value).map(([key, item]) => [key, clean(item, path ? `${path}.${key}` : key)]).filter(([, item]) => item !== undefined);
      const output = Object.fromEntries(entries);
      const required = Object.hasOwn(requiredProfileKeys, path) ? requiredProfileKeys[path] : [];
      if (!entries.length && path && path !== 'identity') return undefined;
      for (const key of required) {
        if (output[key] === undefined) {
          if (key === 'schema_version') output[key] = 1;
          else if (key === 'identity') output[key] = { name: '' };
          else if (['experience', 'skills', 'bullets', 'items'].includes(key)) output[key] = [];
          else output[key] = '';
        }
      }
      return output;
    }
    return value === null || value === undefined ? undefined : value;
  }
  return clean(doc || {}, '');
}

export function linesToArray(text) {
  return String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

export function arrayToLines(list) {
  return (list || []).join('\n');
}

export function slugValid(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(id);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

export function diffKeys(a = {}, b = {}) {
  return [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])].filter(key => JSON.stringify(canonical(a?.[key])) !== JSON.stringify(canonical(b?.[key])));
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.max(0, Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1));
  return `${Number((bytes / 1024 ** index).toFixed(index ? 1 : 0))} ${units[index]}`;
}

/** Screen-only padding so a print-sized template preview does not touch the frame edge. */
export function previewDocument(html) {
  const style = '<style>html{background:#fff}body{box-sizing:border-box;max-width:860px;margin:0 auto;padding:24px}</style>';
  const text = String(html);
  return /<head[^>]*>/i.test(text) ? text.replace(/<head[^>]*>/i, (match) => `${match}${style}`) : `${style}${text}`;
}
