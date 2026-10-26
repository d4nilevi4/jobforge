import { readFileSync } from 'node:fs';
import { conflict, validationFailed } from '../errors.js';
import { validateTemplateMeta } from '../render/builtin.js';
import { renderHtml } from '../render/index.js';
import { findChrome } from '../render/pdf.js';
import { upgradeDocument } from '../upgrade.js';
import { loadSchema, validate } from '../validate.js';
import { applicationDocumentErrors, normalizeCompany, normalizeUrl, restoreApplicationFiles } from './applications.js';

const appVersion = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const applicationColumns = ['id', 'status', 'verdict', 'score', 'vacancy_url', 'vacancy_url_norm', 'vacancy_source', 'company', 'company_norm', 'title', 'location', 'language', 'vacancy_text', 'track_id', 'resume_template', 'cover_template', 'resume_content', 'cover_content', 'notes', 'warnings', 'pages_resume', 'pages_cover', 'profile_revision_id', 'created_at', 'updated_at', 'created_by_token_id'];
const eventColumns = ['id', 'application_id', 'status', 'note', 'token_id', 'at'];
const statusValues = ['draft', 'needs_review', 'approved', 'sent', 'interview', 'offer', 'rejected', 'skipped'];

function validateRow(row, columns, path, overrides = {}) {
  const nullableString = { type: ['string', 'null'] };
  const properties = Object.fromEntries(columns.map((column) => [column, nullableString]));
  Object.assign(properties, overrides);
  const errors = validate({ type: 'object', properties }, row, { rootPath: path });
  if (errors.length) throw validationFailed(`Invalid exported row at ${path}. Correct the fields in details or use an unmodified export.`, errors);
}

function document(kind, value, path) {
  let incoming = value;
  if (typeof value === 'string') {
    try {
      incoming = JSON.parse(value);
    } catch {
      throw validationFailed(`Invalid JSON at ${path}. Export a complete JobForge bundle and retry.`, [{ path, code: 'json', message: 'Provide a JSON document object.' }]);
    }
  }
  let upgraded;
  try {
    upgraded = upgradeDocument(kind, incoming);
    if (kind === 'track' && upgraded.base) upgraded.base = upgradeDocument('content', upgraded.base);
  } catch (error) {
    if (error.status !== 422) throw error;
    throw validationFailed(`Invalid document at ${path}. ${error.message}`, error.details.map((detail) => ({ ...detail, path: `${path}${detail.path ? `.${detail.path}` : ''}` })));
  }
  const errors = validate(loadSchema(kind), upgraded, { rootPath: path });
  if (errors.length) throw validationFailed(`Invalid document at ${path}. Correct the fields in details and retry.`, errors);
  return upgraded;
}

export function exportBundle(db, { version = appVersion } = {}) {
  db.exec('BEGIN');
  try {
    const profile = db.prepare('SELECT doc FROM profile WHERE id = 1').get();
    const templates = db.prepare('SELECT * FROM templates ORDER BY id').all().map((row) => ({
      ...row,
      versions: db.prepare('SELECT version, meta, source, created_at FROM template_versions WHERE template_id = ? ORDER BY version').all(row.id)
        .map((entry) => ({ ...entry, meta: JSON.parse(entry.meta) }))
    }));
    const bundle = {
      bundle_version: 1, exported_at: new Date().toISOString(), app_version: version,
      schema_version: Number(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value ?? 0),
      profile: profile ? upgradeDocument('profile', JSON.parse(profile.doc)) : null,
      profile_revisions: db.prepare('SELECT * FROM profile_revisions ORDER BY id').all().map((row) => ({ ...row, doc: upgradeDocument('profile', JSON.parse(row.doc)) })),
      tracks: Object.fromEntries(db.prepare('SELECT id, doc FROM tracks ORDER BY id').all().map((row) => [row.id, upgradeDocument('track', JSON.parse(row.doc))])),
      templates,
      applications: db.prepare('SELECT * FROM applications ORDER BY id').all().map((row) => ({
        ...row, resume_content: row.resume_content ? upgradeDocument('content', JSON.parse(row.resume_content)) : null,
        cover_content: row.cover_content ? upgradeDocument('cover', JSON.parse(row.cover_content)) : null,
        warnings: JSON.parse(row.warnings || '[]')
      })),
      events: db.prepare('SELECT * FROM application_events ORDER BY id').all().map((row) => ({ ...row }))
    };
    db.exec('COMMIT');
    return bundle;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function assertEmpty(db) {
  for (const table of ['profile', 'profile_revisions', 'tracks', 'templates', 'template_versions', 'applications', 'application_events']) {
    if (db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) {
      throw conflict(`Import requires an empty instance, but ${table} contains data. Use a fresh DATA_DIR; importing never overwrites existing data.`);
    }
  }
}

function invalid(path, message) {
  throw validationFailed(`Invalid bundle at ${path}. ${message}`, [{ path, code: 'bundle', message }]);
}

function positiveId(value, path) {
  if (!Number.isSafeInteger(value) || value < 1) invalid(path, 'Use a positive integer id from an exported JobForge bundle.');
}

function insertRow(db, table, columns, row) {
  db.prepare(`INSERT INTO ${table}(${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    .run(...columns.map((column) => row[column] ?? null));
}

function restoreRows(db, bundle) {
  const now = new Date().toISOString();
  if (bundle.profile !== null) {
    insertRow(db, 'profile', ['id', 'doc', 'updated_at'], { id: 1, doc: JSON.stringify(document('profile', bundle.profile, 'profile')), updated_at: now });
  }
  for (const [index, revision] of bundle.profile_revisions.entries()) {
    positiveId(revision?.id, `profile_revisions[${index}].id`);
    validateRow(revision, ['id', 'created_at', 'token_id'], `profile_revisions[${index}]`, { id: { type: 'integer' }, token_id: { type: ['integer', 'null'] } });
    insertRow(db, 'profile_revisions', ['id', 'doc', 'created_at', 'token_id'], { ...revision, doc: JSON.stringify(document('profile', revision.doc, `profile_revisions[${index}].doc`)) });
  }
  for (const [id, doc] of Object.entries(bundle.tracks)) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(id)) invalid(`tracks.${id}`, 'Use a lowercase track slug of at most 63 characters.');
    insertRow(db, 'tracks', ['id', 'doc', 'created_at', 'updated_at'], { id, doc: JSON.stringify(document('track', doc, `tracks.${id}`)), created_at: now, updated_at: now });
  }
  for (const [index, template] of bundle.templates.entries()) {
    const path = `templates[${index}]`;
    if (!/^custom-[a-z0-9][a-z0-9-]{0,56}$/u.test(template?.id) || !['resume', 'cover'].includes(template.kind) || !Array.isArray(template.versions) || !template.versions.length) {
      invalid(path, 'Provide a custom template id, resume or cover kind, and a non-empty versions array. Built-in templates ship with the server.');
    }
    if (template.versions.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))) invalid(`${path}.versions`, 'Every template version must be an object with version, meta and source.');
    const current = template.current_version ?? Math.max(...template.versions.map(({ version }) => version));
    positiveId(current, `${path}.current_version`);
    validateRow(template, ['created_at', 'updated_at'], path);
    if (!template.versions.some(({ version }) => version === current)) invalid(path, 'current_version must exist in the versions array.');
    insertRow(db, 'templates', ['id', 'kind', 'current_version', 'created_at', 'updated_at'], { ...template, current_version: current, created_at: template.created_at ?? now, updated_at: template.updated_at ?? now });
    for (const entry of template.versions) {
      positiveId(entry.version, `${path}.versions.version`);
      validateRow(entry, ['created_at'], `${path}.versions`);
      try {
        validateTemplateMeta(entry.meta, `${path}.versions.meta`);
        if (entry.meta.id !== template.id || entry.meta.kind !== template.kind || entry.meta.version !== entry.version) throw new Error('Template metadata id, kind and version must match its enclosing template version.');
        if (typeof entry.source !== 'string' || !entry.source.trim()) throw new Error('Provide non-empty HTML source.');
        renderHtml({ meta: entry.meta, source: entry.source, context: {} });
      } catch (error) {
        invalid(path, `Repair the template metadata or HTML source: ${error.message}`);
      }
      insertRow(db, 'template_versions', ['template_id', 'version', 'meta', 'source', 'created_at'], { ...entry, template_id: template.id, meta: JSON.stringify(entry.meta), created_at: entry.created_at ?? now });
    }
  }
  for (const [index, row] of bundle.applications.entries()) {
    const path = `applications[${index}]`;
    positiveId(row?.id, `${path}.id`);
    const normalized = { ...row, vacancy_url_norm: normalizeUrl(row.vacancy_url), company_norm: normalizeCompany(row.company) };
    validateRow(normalized, applicationColumns, path, {
      id: { type: 'integer' }, status: { enum: statusValues }, verdict: { enum: ['apply', 'maybe', 'skip'] },
      score: { type: ['number', 'null'], minimum: 0, maximum: 1 }, warnings: { type: 'array' },
      resume_content: { type: ['object', 'string', 'null'] }, cover_content: { type: ['object', 'string', 'null'] },
      pages_resume: { type: ['integer', 'null'], minimum: 1 }, pages_cover: { type: ['integer', 'null'], minimum: 1 },
      profile_revision_id: { type: ['integer', 'null'] }, created_by_token_id: { type: ['integer', 'null'] }
    });
    if (!statusValues.includes(row.status)) invalid(`${path}.status`, 'Use a known JobForge application status.');
    if (!Array.isArray(row.warnings)) invalid(`${path}.warnings`, 'Provide the warnings array from GET /export.');
    const documentErrors = applicationDocumentErrors(row, { path });
    if (documentErrors.length) throw validationFailed(`Application #${row.id} has inconsistent documents. Correct the fields in details before importing.`, documentErrors);
    const stored = { ...normalized, warnings: JSON.stringify(row.warnings) };
    for (const [key, kind] of [['resume_content', 'content'], ['cover_content', 'cover']]) {
      stored[key] = row[key] == null ? null : JSON.stringify(document(kind, row[key], `${path}.${key}`));
    }
    try {
      insertRow(db, 'applications', applicationColumns, stored);
    } catch (error) {
      const existing = String(error.code).startsWith('ERR_SQLITE') && stored.vacancy_url_norm
        ? db.prepare('SELECT id FROM applications WHERE vacancy_url_norm = ?').get(stored.vacancy_url_norm) : null;
      if (existing) throw validationFailed(`Applications #${existing.id} and #${row.id} have the same normalized vacancy URL. Keep one application per vacancy before importing.`, [{
        path: `${path}.vacancy_url`, code: 'duplicate_vacancy', application_id: row.id, existing_id: existing.id,
        message: `Application #${row.id} duplicates application #${existing.id}. Remove the duplicate or correct its vacancy_url in the bundle.`
      }]);
      throw error;
    }
  }
  for (const [index, row] of bundle.events.entries()) {
    positiveId(row?.id, `events[${index}].id`);
    validateRow(row, eventColumns, `events[${index}]`, { id: { type: 'integer' }, application_id: { type: 'integer' }, token_id: { type: ['integer', 'null'] } });
    if (!db.prepare('SELECT 1 FROM applications WHERE id = ?').get(row.application_id ?? null)) invalid(`events[${index}].application_id`, 'Reference an application id present in this bundle.');
    insertRow(db, 'application_events', eventColumns, row);
  }
}

export async function importBundle(db, bundle, options = {}) {
  if (!bundle || bundle.bundle_version !== 1) {
    throw validationFailed('Unsupported bundle_version. Update the JobForge server to a version that supports this bundle; do not edit or downgrade the bundle.', [{ path: 'bundle_version', code: 'bundle_version', message: 'This server imports bundle_version 1. Update the server before importing another version.' }]);
  }
  const errors = validate({
    type: 'object', required: ['profile', 'profile_revisions', 'tracks', 'templates', 'applications', 'events'],
    properties: { profile: { type: ['object', 'null'] }, profile_revisions: { type: 'array' }, tracks: { type: 'object' }, templates: { type: 'array' }, applications: { type: 'array' }, events: { type: 'array' } }
  }, bundle);
  if (errors.length) throw validationFailed('Invalid bundle shape. Import the complete JSON produced by GET /export.', errors);
  assertEmpty(db);
  db.exec('SAVEPOINT import_bundle');
  try {
    restoreRows(db, bundle);
    db.exec('RELEASE import_bundle');
  } catch (error) {
    db.exec('ROLLBACK TO import_bundle; RELEASE import_bundle');
    if (error instanceof Error && String(error.code).startsWith('ERR_SQLITE')) invalid('bundle', `Rows conflict or contain invalid values: ${error.message}. Import a complete, unmodified export.`);
    throw error;
  }
  const rendered = [];
  const render_errors = [];
  const chrome = options.chrome ?? { bin: findChrome() };
  const chromeAvailable = Boolean(typeof chrome === 'string' ? chrome : chrome?.bin || chrome?.chromeBin);
  for (const row of bundle.applications) {
    if (!row.resume_content && !row.cover_content) continue;
    if (!chromeAvailable) {
      render_errors.push({ id: row.id, message: 'Chrome is unavailable. Install Chrome or set CHROME_BIN, then rerender this application to restore its PDFs.' });
      continue;
    }
    try {
      await restoreApplicationFiles(db, row.id, { ...options, chrome, preserveUpdatedAt: true, preserveTemplateVersion: true, preserveProfileRevision: true });
      rendered.push(row.id);
    } catch (error) {
      render_errors.push({ id: row.id, message: error.message, details: error.details ?? [] });
    }
  }
  return { ok: true, imported: bundle.applications.length, rendered, render_errors };
}
