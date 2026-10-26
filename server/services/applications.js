import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hasScope } from '../auth.js';
import { ApiError, badRequest, conflict, forbidden, notFound, renderFailed, validationFailed } from '../errors.js';
import { check } from '../guard.js';
import { buildContext } from '../render/context.js';
import { renderHtml, renderPdf as defaultRenderPdf } from '../render/index.js';
import { upgradeDocument, validateDocument } from '../upgrade.js';
import { loadSchema, validate } from '../validate.js';
import { getProfile, getRevision } from './profile.js';
import { formatRef, getTemplate, listTemplates, parseRef } from './templates.js';

const statuses = ['draft', 'needs_review', 'approved', 'sent', 'interview', 'offer', 'rejected', 'skipped'];
const agentTransitions = { draft: ['needs_review', 'skipped'], needs_review: ['draft', 'skipped'], skipped: ['draft'] };
const documentKinds = ['resume', 'cover'];

export function normalizeUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return '';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./u, '');
    url.hash = '';
    // Keep source: some boards use it as part of the job identity, rather than attribution.
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_.*|gclid|fbclid|dclid|msclkid|ref|ref_src)$/iu.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    url.pathname = url.pathname.replace(/\/+$/u, '') || '/';
    return url.href.replace(/\/(?=\?|$)/u, '');
  } catch {
    return '';
  }
}

export function normalizeCompany(value) {
  if (typeof value !== 'string') return '';
  const words = value.normalize('NFKC').toLowerCase().replace(/ё/gu, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/u);
  const legal = new Set(['llc', 'inc', 'incorporated', 'ltd', 'limited', 'gmbh', 'corp', 'corporation', 'ооо', 'пао', 'ао', 'оао', 'зао']);
  while (legal.has(words[0])) words.shift();
  while (legal.has(words.at(-1))) words.pop();
  const result = words.join('');
  return ['nda', 'hidden', 'unknown', 'anonymous', 'скрыто', 'компанияскрыта', ''].includes(result) ? '' : result;
}

function prefixed(issues, kind) {
  return issues.map((issue) => {
    const path = kind === 'cover' ? issue.path.replace(/^cover\.?/u, '') : issue.path;
    return { ...issue, path: `${kind}.content${path ? `.${path}` : ''}` };
  });
}

function resolveTemplate(db, ref, kind) {
  let template;
  try {
    const { id, version } = parseRef(ref);
    template = getTemplate(db, id, version);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
  }
  if (!template || template.kind !== kind) {
    const ids = listTemplates(db, { kind }).map(({ id }) => id);
    throw validationFailed('Application template is invalid. Choose a template of the required kind.', [{
      path: `${kind}.template`, code: 'unknown_template',
      message: `Template ${JSON.stringify(ref)} must be an existing ${kind} template. Valid ids: ${ids.join(', ')}. Choose one from GET /api/v1/templates?kind=${kind}.`
    }]);
  }
  return template;
}

function sameCompany(db, normalized, exceptId) {
  if (!normalized) return [];
  return db.prepare('SELECT id, title, status, updated_at FROM applications WHERE company_norm = ? AND id != ? ORDER BY updated_at DESC, id DESC')
    .all(normalized, exceptId ?? -1).map((row) => ({ ...row }));
}

function duplicateFor(db, url, exceptId) {
  if (!url) return null;
  const row = db.prepare('SELECT id AS existing_id, status FROM applications WHERE vacancy_url_norm = ? AND id != ?').get(url, exceptId ?? -1);
  return row ? { ...row } : null;
}

function overflow(template, kind, pages, db) {
  const alternatives = listTemplates(db, { kind }).map(({ id }) => id).join(', ');
  return {
    path: `${kind}.content`, code: 'page_overflow',
    message: `${kind === 'resume' ? 'Resume' : 'Cover'} is ${pages} pages; template "${template.id}" allows ${template.meta.max_pages}. Shorten bullets, drop a project, or choose a roomier template (list: ${alternatives}).`
  };
}

function chromeOptions(chrome) {
  return typeof chrome === 'string' ? { chromeBin: chrome }
    : { chromeBin: chrome?.chromeBin ?? chrome?.bin, docker: chrome?.docker ?? false };
}

async function renderDocuments(db, normalized, profile, { renderPdf = defaultRenderPdf, chrome } = {}) {
  const files = {};
  const pages = {};
  const errors = [];
  for (const kind of documentKinds) {
    const document = normalized[kind];
    if (!document) continue;
    const issues = validate(loadSchema(kind === 'resume' ? 'content' : 'cover'), document.content, { rootPath: `${kind}.content` });
    if (issues.length) {
      errors.push(...issues);
      continue;
    }
    let template;
    try {
      template = resolveTemplate(db, document.template, kind);
      const result = await renderPdf({
        meta: template.meta, source: template.source,
        context: buildContext({ profile, meta: template.meta, [kind]: document.content, lang: normalized.language }),
        chrome: chromeOptions(chrome)
      });
      pages[kind] = result.pages;
      files[kind] = result.pdf;
      if (result.pages > template.meta.max_pages) errors.push(overflow(template, kind, result.pages, db));
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      errors.push(...(error.details.length ? error.details : [{ path: `${kind}.content`, code: error.code, message: error.message }]));
    }
  }
  return { files, pages, errors };
}

export async function prepare(db, input, { renderPdf = defaultRenderPdf, chrome, render = true } = {}) {
  const skip = input?.verdict === 'skip';
  const incoming = skip && input && typeof input === 'object' ? { ...input } : input;
  if (skip) {
    delete incoming.resume;
    delete incoming.cover;
  }
  // Documents have their own upgrade-aware schemas; keep envelope errors from the application schema.
  const errors = validate(loadSchema('application'), incoming)
    .filter(({ path }) => !/^\b(?:resume|cover)\.content(?:[.\[]|$)/u.test(path));
  if (!skip && incoming && typeof incoming === 'object' && !Object.hasOwn(incoming, 'resume')) {
    errors.push({ path: 'resume', code: 'required', message: 'Missing resume. Provide resume.template and resume.content, or set verdict to skip.' });
  }
  const profile = getProfile(db);
  if (!profile) throw new ApiError(422, 'profile_missing', 'No profile exists. Fill it with PUT /api/v1/profile before preparing an application.');
  const normalized = incoming && typeof incoming === 'object' && !Array.isArray(incoming) ? structuredClone(incoming) : {};
  const warnings = [];
  const language = incoming?.vacancy?.language ?? incoming?.resume?.content?.language ?? incoming?.cover?.content?.language ?? 'en';
  normalized.language = typeof language === 'string' ? language.trim().toLowerCase() : 'en';
  if (normalized.vacancy && typeof normalized.vacancy === 'object') normalized.vacancy.language = normalized.language;
  for (const kind of documentKinds) {
    const document = incoming?.[kind];
    if (!document || typeof document !== 'object' || Array.isArray(document)) continue;
    let doc;
    let validDocument = false;
    try {
      const result = validateDocument(kind === 'resume' ? 'content' : 'cover', document.content, { rootPath: `${kind}.content` });
      doc = result.doc;
      errors.push(...result.errors);
      validDocument = result.errors.length === 0;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      errors.push(...error.details);
    }
    let template;
    try {
      template = resolveTemplate(db, document.template, kind);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      errors.push(...error.details);
    }
    if (doc) {
      doc.language = normalized.language;
      const result = check({ [kind === 'resume' ? 'content' : 'cover']: doc, profile: profile.doc, template, language: normalized.language });
      errors.push(...prefixed(result.errors, kind));
      warnings.push(...prefixed(result.warnings, kind));
    }
    normalized[kind] = validDocument && template ? { template: formatRef(template.id, template.version), content: doc } : null;
  }
  const rendered = render ? await renderDocuments(db, normalized, profile.doc, { renderPdf, chrome }) : { pages: {}, files: {}, errors: [] };
  errors.push(...rendered.errors);
  const uniqueErrors = errors.filter((error, index) => errors.findIndex((candidate) => candidate.path === error.path && candidate.code === error.code) === index);
  if (uniqueErrors.length) {
    const onlyRender = uniqueErrors.every(({ code }) => code === 'page_overflow' || code === 'render_failed');
    throw (onlyRender ? renderFailed : validationFailed)('Application preparation failed. Correct every field in details and retry.', uniqueErrors);
  }
  normalized.verdict ??= 'apply';
  return {
    normalized, warnings, pages: rendered.pages, files: rendered.files, profileRevisionId: profile.revisionId,
    duplicate: duplicateFor(db, normalizeUrl(normalized.vacancy.url)),
    same_company: sameCompany(db, normalizeCompany(normalized.vacancy.company))
  };
}

function rowFor(db, id) {
  if (!/^[1-9][0-9]*$/u.test(String(id)) || !Number.isSafeInteger(Number(id))) {
    throw badRequest('Application path.id must be a positive integer. Use an id from GET /api/v1/applications.');
  }
  const row = db.prepare('SELECT * FROM applications WHERE id = ?').get(Number(id));
  if (!row) throw notFound(`Application #${id} does not exist. Use an id from GET /api/v1/applications.`);
  return row;
}

export function eventsFor(db, id) {
  return db.prepare('SELECT * FROM application_events WHERE application_id = ? ORDER BY id').all(id).map((row) => ({ ...row }));
}

function event(db, id, status, tokenId, note = null) {
  db.prepare('INSERT INTO application_events(application_id, status, note, token_id, at) VALUES (?, ?, ?, ?, ?)')
    .run(id, status, note, tokenId ?? null, new Date().toISOString());
}

function pdfPath(dataDir, id, kind) {
  return dataDir ? join(applicationDirectory(dataDir, id), `${kind}.pdf`) : null;
}

function applicationDirectory(dataDir, id) {
  const directory = join(dataDir, 'files', String(id));
  if (!existsSync(directory) && existsSync(`${directory}.old`)) renameSync(`${directory}.old`, directory);
  return directory;
}

function hasPdf(dataDir, id, kind) {
  const path = pdfPath(dataDir, id, kind);
  try {
    return Boolean(path && statSync(path).isFile());
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    return false;
  }
}

function stageFiles(dataDir, id, files) {
  if (!dataDir) throw new Error('Application dataDir is required. Pass config.dataDir to the application service.');
  const directory = applicationDirectory(dataDir, id);
  rmSync(`${directory}.new`, { recursive: true, force: true });
  mkdirSync(`${directory}.new`, { recursive: true });
  for (const kind of documentKinds) {
    if (files[kind]) writeFileSync(join(`${directory}.new`, `${kind}.pdf`), files[kind]);
  }
}

function publishFiles(dataDir, id) {
  const directory = applicationDirectory(dataDir, id);
  rmSync(`${directory}.old`, { recursive: true, force: true });
  const hadFiles = existsSync(directory);
  if (hadFiles) renameSync(directory, `${directory}.old`);
  try {
    renameSync(`${directory}.new`, directory);
  } catch (error) {
    if (hadFiles) renameSync(`${directory}.old`, directory);
    throw error;
  }
  try {
    rmSync(`${directory}.old`, { recursive: true, force: true });
  } catch {
    // An obsolete directory is harmless; the next publication removes it.
  }
}

function persistFiles(db, id, files, { dataDir }, save) {
  let committed = false;
  let transactionOpen = false;
  let previous;
  let lastEventId;
  try {
    if (id) stageFiles(dataDir, id, files);
    db.exec('SAVEPOINT application_files');
    transactionOpen = true;
    previous = id ? rowFor(db, id) : null;
    lastEventId = id ? db.prepare('SELECT MAX(id) AS id FROM application_events WHERE application_id = ?').get(Number(id)).id ?? 0 : 0;
    id = save();
    if (!previous) stageFiles(dataDir, id, files);
    db.exec('RELEASE application_files');
    transactionOpen = false;
    committed = true;
    publishFiles(dataDir, id);
  } catch (error) {
    if (transactionOpen) {
      db.exec('ROLLBACK TO application_files; RELEASE application_files');
    } else if (committed) {
      // A failed directory swap restored the old files; restore their database state too.
      db.exec('SAVEPOINT restore_application');
      try {
        db.prepare('DELETE FROM application_events WHERE application_id = ? AND id > ?').run(Number(id), lastEventId);
        if (previous) {
          const columns = Object.keys(previous).filter((key) => key !== 'id');
          db.prepare(`UPDATE applications SET ${columns.map((key) => `${key} = ?`).join(', ')} WHERE id = ?`)
            .run(...columns.map((key) => previous[key]), Number(id));
        } else {
          db.prepare('DELETE FROM applications WHERE id = ?').run(Number(id));
        }
        db.exec('RELEASE restore_application');
      } catch (restoreError) {
        db.exec('ROLLBACK TO restore_application; RELEASE restore_application');
        throw restoreError;
      }
    }
    throw error;
  } finally {
    if (dataDir && id) rmSync(join(dataDir, 'files', `${id}.new`), { recursive: true, force: true });
  }
  return id;
}

export function getApplication(db, id, { dataDir } = {}) {
  const row = rowFor(db, id);
  const base = `/api/v1/applications/${row.id}/files`;
  const resume = row.resume_content ? { template: row.resume_template, content: upgradeDocument('content', JSON.parse(row.resume_content)) } : null;
  const cover = row.cover_content ? { template: row.cover_template, content: upgradeDocument('cover', JSON.parse(row.cover_content)) } : null;
  return {
    ...row, resume_content: resume?.content ?? null, cover_content: cover?.content ?? null,
    vacancy: { url: row.vacancy_url, source: row.vacancy_source, title: row.title, company: row.company, location: row.location, language: row.language, text: row.vacancy_text },
    resume, cover, warnings: JSON.parse(row.warnings || '[]'), pages: { resume: row.pages_resume, cover: row.pages_cover },
    track: row.track_id, events: eventsFor(db, row.id), same_company: sameCompany(db, row.company_norm, row.id),
    files: {
      resume_pdf: resume && hasPdf(dataDir, row.id, 'resume') ? `${base}/resume.pdf` : null,
      cover_pdf: cover && hasPdf(dataDir, row.id, 'cover') ? `${base}/cover.pdf` : null,
      cover_txt: cover ? `${base}/cover.txt` : null, vacancy_md: `${base}/vacancy.md`, resume_html: resume ? `${base}/resume.html` : null
    }
  };
}

function duplicateError(duplicate) {
  const { existing_id: id, status } = duplicate;
  return conflict('This vacancy URL already belongs to another application. Update that draft or use a different vacancy URL.', [{
    path: 'vacancy.url', code: 'duplicate_vacancy', existing_id: id, status,
    message: `This vacancy is already filed as application #${id} (${status}). Use PUT /applications/${id} to update it while it is a draft.`
  }]);
}

function valuesFor(prepared) {
  const { normalized: input, warnings, pages } = prepared;
  const vacancy = input.vacancy;
  return {
    verdict: input.verdict, score: input.score ?? null,
    vacancy_url: vacancy.url ?? '', vacancy_url_norm: normalizeUrl(vacancy.url), vacancy_source: vacancy.source ?? '',
    company: vacancy.company ?? '', company_norm: normalizeCompany(vacancy.company), title: vacancy.title ?? '',
    location: vacancy.location ?? '', language: input.language, vacancy_text: vacancy.text,
    track_id: input.track_id ?? null, resume_template: input.resume?.template ?? null, cover_template: input.cover?.template ?? null,
    resume_content: input.resume ? JSON.stringify(input.resume.content) : null, cover_content: input.cover ? JSON.stringify(input.cover.content) : null,
    notes: input.notes ?? '', warnings: JSON.stringify(warnings), pages_resume: pages.resume ?? null, pages_cover: pages.cover ?? null,
    profile_revision_id: prepared.profileRevisionId
  };
}

export async function createApplication(db, input, options = {}) {
  const prepared = await prepare(db, input, options);
  const duplicate = duplicateFor(db, normalizeUrl(prepared.normalized.vacancy.url));
  if (duplicate) throw duplicateError(duplicate);
  const now = new Date().toISOString();
  const values = { ...valuesFor(prepared), status: prepared.normalized.verdict === 'skip' ? 'skipped' : 'draft', created_at: now, updated_at: now, created_by_token_id: options.token?.id ?? null };
  const columns = Object.keys(values);
  let id;
  try {
    id = persistFiles(db, null, prepared.files, options, () => {
      const createdId = Number(db.prepare(`INSERT INTO applications(${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...Object.values(values)).lastInsertRowid);
      event(db, createdId, values.status, options.token?.id);
      return createdId;
    });
  } catch (error) {
    const collision = duplicateFor(db, values.vacancy_url_norm);
    if (collision) throw duplicateError(collision);
    throw error;
  }
  return getApplication(db, id, options);
}

export async function updateApplication(db, id, input, options = {}) {
  const current = rowFor(db, id);
  if (!['draft', 'needs_review'].includes(current.status)) throw conflict(`Application #${id} is ${current.status}. Content can only be replaced in draft or needs_review; ask an owner to move it to draft first.`);
  const prepared = await prepare(db, input, options);
  const duplicate = duplicateFor(db, normalizeUrl(prepared.normalized.vacancy.url), Number(id));
  if (duplicate) throw duplicateError(duplicate);
  persistFiles(db, id, prepared.files, options, () => {
    const latest = rowFor(db, id);
    if (!['draft', 'needs_review'].includes(latest.status)) throw conflict(`Application #${id} changed status during rendering. Return it to draft before editing.`);
    const values = { ...valuesFor(prepared), status: prepared.normalized.verdict === 'skip' ? 'skipped' : latest.status, updated_at: new Date().toISOString() };
    db.prepare(`UPDATE applications SET ${Object.keys(values).map((column) => `${column} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(values), Number(id));
    event(db, Number(id), 'updated', options.token?.id);
    return Number(id);
  });
  return getApplication(db, id, options);
}

export function listApplications(db, query = {}) {
  const integer = (value, fallback, name) => {
    if (value === undefined) return fallback;
    if (!/^\d+$/u.test(String(value)) || !Number.isSafeInteger(Number(value))) throw badRequest(`Application query.${name} must be a non-negative integer. Use ${fallback} or omit it.`);
    return Number(value);
  };
  const limit = Math.min(integer(query.limit, 50, 'limit'), 200);
  const offset = integer(query.offset, 0, 'offset');
  const statusFilter = query.status === undefined ? null : String(query.status).split(',');
  if (statusFilter?.some((status) => !statuses.includes(status))) throw badRequest(`Application query.status contains an unknown status. Use: ${statuses.join(', ')}.`);
  if (query.verdict !== undefined && !['apply', 'maybe', 'skip'].includes(query.verdict)) throw badRequest('Application query.verdict must be apply, maybe, or skip.');
  const company = query.company === undefined ? null : normalizeCompany(query.company);
  const search = String(query.q ?? '').toLowerCase();
  const rows = db.prepare('SELECT * FROM applications ORDER BY updated_at DESC, id DESC').all().filter((row) => (
    (query.track === undefined || row.track_id === query.track)
    && (company === null || (company !== '' && row.company_norm === company))
    && (query.verdict === undefined || row.verdict === query.verdict)
    && (!search || [row.title, row.company, row.vacancy_source, row.notes].some((value) => (value || '').toLowerCase().includes(search)))
  ));
  const counts = Object.fromEntries(statuses.map((status) => [status, 0]));
  for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
  const filtered = rows.filter((row) => !statusFilter || statusFilter.includes(row.status));
  const items = filtered.slice(offset, offset + limit).map((row) => ({
    ...Object.fromEntries(['id', 'status', 'verdict', 'score', 'title', 'company', 'location', 'language', 'vacancy_url', 'vacancy_source', 'track_id', 'resume_template', 'cover_template', 'created_at', 'updated_at'].map((key) => [key, row[key]])),
    pages: { resume: row.pages_resume, cover: row.pages_cover }, warnings_count: JSON.parse(row.warnings || '[]').length,
    has_resume: Boolean(row.resume_content), has_cover: Boolean(row.cover_content),
    same_company_count: sameCompany(db, row.company_norm, row.id).length
  }));
  return { items, total: filtered.length, counts };
}

export function applicationDocumentErrors(row, { status = row.status, dataDir, checkFiles = false, path = '' } = {}) {
  const errors = [];
  const at = (key) => path ? `${path}.${key}` : key;
  const reviewed = ['approved', 'sent', 'interview', 'offer', 'rejected'].includes(status);
  if (reviewed && row.verdict === 'skip') {
    errors.push({ path: at('verdict'), code: 'documents_required', message: `Application #${row.id} has verdict skip. Move it to draft and replace its verdict and resume before setting ${status}.` });
  }
  if ((reviewed || (['apply', 'maybe'].includes(row.verdict) && status !== 'skipped')) && !row.resume_content) {
    errors.push({ path: at('resume_content'), code: 'required', message: `Application #${row.id} requires resume content for ${status} with verdict ${row.verdict}. Add a resume in draft, or use status skipped.` });
  }
  if (checkFiles && reviewed) {
    for (const kind of documentKinds) {
      if ((kind === 'resume' || row.cover_content) && !hasPdf(dataDir, row.id, kind)) {
        errors.push({ path: at(`files.${kind}_pdf`), code: 'pdf_required', message: `Application #${row.id} requires ${kind}.pdf before ${status}. Move it to draft, add the document and rerender before changing status.` });
      }
    }
  }
  return errors;
}

export function setStatus(db, id, input, { token, dataDir } = {}) {
  const errors = validate({ type: 'object', required: ['status'], properties: { status: { enum: statuses }, note: { type: 'string' } }, additionalProperties: false }, input);
  if (errors.length) throw validationFailed('Invalid status body. Provide a known status and an optional string note.', errors);
  const scope = ['draft', 'needs_review', 'skipped'].includes(input.status) ? 'write:applications' : 'approve';
  if (!hasScope(token, scope)) throw forbidden(`Token lacks scope ${scope} to set status ${input.status}. Use a token with ${scope}.`);
  const row = rowFor(db, id);
  if (!hasScope(token, 'approve') && !agentTransitions[row.status]?.includes(input.status)) {
    throw conflict(`Application #${id} cannot move from ${row.status} to ${input.status} with this token. Allowed next statuses: ${(agentTransitions[row.status] ?? []).join(', ') || '(none)'}. An owner with approve may choose another status.`);
  }
  if (['approved', 'sent'].includes(input.status)) {
    const documentErrors = applicationDocumentErrors(row, { status: input.status, dataDir, checkFiles: true });
    if (documentErrors.length) throw conflict(`Application #${id} cannot be ${input.status}. Correct the document problems in details while it is a draft.`, documentErrors);
  }
  db.exec('SAVEPOINT set_status');
  try {
    db.prepare('UPDATE applications SET status = ?, updated_at = ? WHERE id = ?').run(input.status, new Date().toISOString(), Number(id));
    event(db, Number(id), input.status, token.id, input.note ?? null);
    db.exec('RELEASE set_status');
  } catch (error) {
    db.exec('ROLLBACK TO set_status; RELEASE set_status');
    throw error;
  }
  return getApplication(db, id, { dataDir });
}

// Import restores derived files even for historical, already-sent applications.
export async function restoreApplicationFiles(db, id, options = {}) {
  const row = rowFor(db, id);
  let profile;
  if (options.preserveProfileRevision) {
    const doc = row.profile_revision_id == null ? null : getRevision(db, row.profile_revision_id);
    if (!doc) throw renderFailed(`Application #${id} references unavailable profile revision ${row.profile_revision_id}. Restore that profile_revisions entry from the original export before rendering.`, [{
      path: 'profile_revision_id', code: 'profile_revision_missing', message: `Restore profile revision ${row.profile_revision_id} for application #${id}; another profile cannot reproduce its contacts.`
    }]);
    profile = { doc, revisionId: row.profile_revision_id };
  } else {
    profile = getProfile(db);
  }
  if (!profile) throw new ApiError(422, 'profile_missing', 'No profile exists. Import or save a profile before rendering applications.');
  const normalized = { language: row.language };
  for (const kind of documentKinds) {
    if (!row[`${kind}_content`]) continue;
    const ref = parseRef(row[`${kind}_template`]);
    const requestedVersion = options.version ?? (options.preserveTemplateVersion ? ref.version : undefined);
    const template = resolveTemplate(db, requestedVersion === undefined ? ref.id : `${ref.id}@${requestedVersion}`, kind);
    normalized[kind] = { template: formatRef(template.id, template.version), content: upgradeDocument(kind === 'resume' ? 'content' : 'cover', JSON.parse(row[`${kind}_content`])) };
  }
  const result = await renderDocuments(db, normalized, profile.doc, options);
  if (result.errors.length) throw renderFailed('Application could not be rerendered. Correct the rendering problems in details and retry.', result.errors);
  persistFiles(db, id, result.files, options, () => {
    const latest = rowFor(db, id);
    if (options.checkEditable) assertEditable(latest);
    if (['resume_content', 'cover_content', 'resume_template', 'cover_template', 'language', 'profile_revision_id'].some((key) => latest[key] !== row[key])) {
      throw conflict(`Application #${id} changed content or templates during rendering. Retry rerender with the latest stored content.`);
    }
    db.prepare('UPDATE applications SET resume_template = ?, cover_template = ?, pages_resume = ?, pages_cover = ?, profile_revision_id = ?, updated_at = ? WHERE id = ?')
      .run(normalized.resume?.template ?? null, normalized.cover?.template ?? null, result.pages.resume ?? null, result.pages.cover ?? null, profile.revisionId, options.preserveUpdatedAt ? row.updated_at : new Date().toISOString(), Number(id));
    return Number(id);
  });
  return getApplication(db, id, options);
}

function assertEditable(row) {
  if (!['draft', 'needs_review'].includes(row.status)) throw conflict(`Application #${row.id} is ${row.status}. Rerender requires draft or needs_review; ask an owner to move it to draft first.`);
}

export async function rerenderApplication(db, id, options = {}) {
  assertEditable(rowFor(db, id));
  return restoreApplicationFiles(db, id, { ...options, checkEditable: true });
}

export function applicationFile(db, id, name, { dataDir, download = false } = {}) {
  const row = rowFor(db, id);
  const headers = {};
  let raw;
  if (['resume.pdf', 'cover.pdf'].includes(name)) {
    const kind = name.split('.')[0];
    if (!row[`${kind}_content`] || !hasPdf(dataDir, id, kind)) throw notFound(`Application #${id} has no ${name}. Add the document and POST /api/v1/applications/${id}/rerender with Chrome available.`);
    raw = readFileSync(pdfPath(dataDir, id, kind));
    headers['Content-Type'] = 'application/pdf';
    if (download) {
      const safe = (value) => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/gu, '').replace(/[^a-zA-Z0-9]+/gu, '_').replace(/^_+|_+$/gu, '') || 'Application';
      const filename = `${safe(getProfile(db)?.doc.identity.name)}_${kind === 'resume' ? 'Resume' : 'Cover'}_${safe(row.company)}.pdf`;
      headers['Content-Disposition'] = `attachment; filename="${filename}"`;
    }
  } else if (name === 'cover.txt') {
    if (!row.cover_content) throw notFound(`Application #${id} has no cover letter. Add cover.content with PUT while the application is editable.`);
    raw = upgradeDocument('cover', JSON.parse(row.cover_content)).text;
    headers['Content-Type'] = 'text/plain; charset=utf-8';
  } else if (name === 'vacancy.md') {
    raw = `# ${row.title || 'Vacancy'}\n\nCompany: ${row.company || ''}\nSource: ${row.vacancy_source || ''}\nURL: ${row.vacancy_url || ''}\n\n${row.vacancy_text || ''}\n`;
    headers['Content-Type'] = 'text/markdown; charset=utf-8';
  } else if (name === 'resume.html') {
    if (!row.resume_content) throw notFound(`Application #${id} has no resume. Add resume.content with PUT while the application is editable.`);
    const template = resolveTemplate(db, row.resume_template, 'resume');
    raw = renderHtml({ meta: template.meta, source: template.source, context: buildContext({ profile: getProfile(db)?.doc, meta: template.meta, resume: upgradeDocument('content', JSON.parse(row.resume_content)), lang: row.language }) });
    headers['Content-Type'] = 'text/html; charset=utf-8';
  } else {
    throw notFound(`Application file ${JSON.stringify(name)} is unknown. Use resume.pdf, cover.pdf, cover.txt, vacancy.md, or resume.html.`);
  }
  return { status: 200, headers, raw };
}

export function deleteApplication(db, id, { dataDir } = {}) {
  rowFor(db, id);
  if (!dataDir) throw new Error('Application dataDir is required to delete derived files. Pass config.dataDir.');
  db.exec('SAVEPOINT delete_application');
  try {
    db.prepare('DELETE FROM application_events WHERE application_id = ?').run(Number(id));
    db.prepare('DELETE FROM applications WHERE id = ?').run(Number(id));
    db.exec('RELEASE delete_application');
  } catch (error) {
    db.exec('ROLLBACK TO delete_application; RELEASE delete_application');
    throw error;
  }
  rmSync(join(dataDir, 'files', String(id)), { recursive: true, force: true });
  return { ok: true };
}
