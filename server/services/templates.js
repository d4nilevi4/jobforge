import { join } from 'node:path';
import { APP_ROOT } from '../config.js';
import { badRequest, conflict, forbidden, validationFailed } from '../errors.js';
import { loadBuiltinTemplates, validateTemplateMeta } from '../render/builtin.js';
import { buildContext } from '../render/context.js';
import { renderTemplate } from '../render/engine.js';
import { listTracks } from './tracks.js';

const builtins = await loadBuiltinTemplates(join(APP_ROOT, 'templates', 'builtin'));
const customIdPattern = /^custom-[a-z0-9][a-z0-9-]{0,56}$/;

export function parseRef(ref) {
  const match = typeof ref === 'string' && /^([a-z0-9][a-z0-9-]*)(?:@([1-9][0-9]*))?$/.exec(ref);
  const version = match?.[2] === undefined ? undefined : Number(match[2]);
  if (!match || (version !== undefined && !Number.isSafeInteger(version))) {
    throw badRequest('Template reference must be an id or id@version, such as classic@1. Use a positive integer version from GET /api/v1/templates/:id.');
  }
  return { id: match[1], version };
}

export function formatRef(id, version) {
  const ref = `${id}@${version}`;
  parseRef(ref);
  return ref;
}

function sampleFor(kind) {
  return builtins.get(kind === 'cover' ? 'letter' : 'classic').sample;
}

export function getTemplate(db, id, version) {
  const builtin = builtins.get(id);
  if (builtin) {
    if (version !== undefined && Number(version) !== builtin.meta.version) return null;
    return structuredClone({ ...builtin, kind: builtin.meta.kind, version: builtin.meta.version });
  }
  const row = db.prepare(`SELECT v.version, v.meta, v.source FROM templates t
    JOIN template_versions v ON v.template_id = t.id AND v.version = COALESCE(?, t.current_version)
    WHERE t.id = ?`).get(version ?? null, id);
  if (!row) return null;
  const meta = JSON.parse(row.meta);
  return {
    id, builtin: false, kind: meta.kind, version: row.version,
    meta, source: row.source, sample: structuredClone(sampleFor(meta.kind))
  };
}

export function listTemplates(db, { kind } = {}) {
  const ids = [...builtins.keys(), ...db.prepare('SELECT id FROM templates ORDER BY id').all().map((row) => row.id)];
  return ids.map((id) => getTemplate(db, id)).filter((template) => !kind || template.kind === kind)
    .map(({ id, builtin, kind: templateKind, version, meta }) => ({
      id, name: meta.name, kind: templateKind, builtin, version,
      description: meta.description, paper: meta.paper, max_pages: meta.max_pages, languages: meta.languages
    }));
}

export function saveCustomTemplate(db, id, { meta, source } = {}) {
  if (builtins.has(id)) throw forbidden(`Template ${id} is built-in and read-only. Fork it with POST /api/v1/templates/${id}/fork, then edit the custom copy.`);
  if (!customIdPattern.test(id)) {
    throw badRequest('Template path.id must match ^custom-[a-z0-9][a-z0-9-]{0,56}$. Choose a custom- prefixed lowercase slug of at most 64 characters.');
  }
  const current = db.prepare('SELECT current_version FROM templates WHERE id = ?').get(id);
  const version = (current?.current_version ?? 0) + 1;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    throw validationFailed('Template meta must be an object. Copy metadata from GET /api/v1/templates/classic and update it.', [
      { path: 'meta', code: 'type', message: 'Provide a template metadata object.' }
    ]);
  }
  const storedMeta = { ...structuredClone(meta), id, version };
  try {
    validateTemplateMeta(storedMeta, 'meta');
    for (const key of ['name', 'description']) {
      if (typeof storedMeta[key] !== 'string') throw new Error(`meta.${key}: Expected a string; provide ${key}.`);
    }
  } catch (error) {
    throw validationFailed(`Template metadata is invalid. ${error.message}`, [
      { path: 'meta', code: 'template_meta', message: error.message }
    ]);
  }
  if (typeof source !== 'string' || !source.trim()) {
    throw validationFailed('Template source must be a non-empty HTML string. Provide source with a complete HTML document.', [
      { path: 'source', code: 'type', message: 'Provide non-empty HTML template source.' }
    ]);
  }
  const sample = sampleFor(storedMeta.kind);
  try {
    renderTemplate(source, buildContext({
      profile: { identity: sample.profile_identity }, meta: storedMeta, resume: sample.resume, cover: sample.cover
    }));
  } catch (error) {
    throw validationFailed(`Template source is invalid. ${error.message}`, [
      { path: 'source', code: 'template_syntax', message: error.message }
    ]);
  }
  const now = new Date().toISOString();
  db.exec('SAVEPOINT save_template');
  try {
    db.prepare(`INSERT INTO templates(id, kind, current_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, current_version = excluded.current_version, updated_at = excluded.updated_at`)
      .run(id, storedMeta.kind, version, now, now);
    db.prepare('INSERT INTO template_versions(template_id, version, meta, source, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, version, JSON.stringify(storedMeta), source, now);
    db.exec('RELEASE save_template');
  } catch (error) {
    db.exec('ROLLBACK TO save_template; RELEASE save_template');
    throw error;
  }
  return getTemplate(db, id);
}

export function deleteCustomTemplate(db, id) {
  if (builtins.has(id)) throw forbidden(`Template ${id} is built-in and read-only. Delete a custom template instead.`);
  const references = (ref) => ref === id || (typeof ref === 'string' && ref.startsWith(`${id}@`));
  const tracks = listTracks(db).filter(({ doc }) => references(doc.resume_template) || references(doc.cover_template));
  const applications = db.prepare('SELECT id, resume_template, cover_template FROM applications').all()
    .filter((row) => references(row.resume_template) || references(row.cover_template));
  if (tracks.length || applications.length) {
    throw conflict(`Template ${id} is referenced by tracks or applications. Change or remove those references before deleting it.`, [
      ...tracks.map((track) => ({ path: 'tracks', code: 'template_in_use', id: track.id, message: `Update or delete track ${track.id} first.` })),
      ...applications.map((application) => ({ path: 'applications', code: 'template_in_use', id: application.id, message: `Update or delete application ${application.id} first.` }))
    ]);
  }
  db.exec('SAVEPOINT delete_template');
  try {
    const result = db.prepare('DELETE FROM templates WHERE id = ?').run(id);
    db.prepare('DELETE FROM template_versions WHERE template_id = ?').run(id);
    db.exec('RELEASE delete_template');
    return result.changes > 0;
  } catch (error) {
    db.exec('ROLLBACK TO delete_template; RELEASE delete_template');
    throw error;
  }
}
