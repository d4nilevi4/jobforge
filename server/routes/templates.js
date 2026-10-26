import { badRequest, conflict, forbidden, notFound, validationFailed } from '../errors.js';
import { buildContext } from '../render/context.js';
import { renderHtml } from '../render/index.js';
import { getProfile } from '../services/profile.js';
import { deleteCustomTemplate, getTemplate, listTemplates, saveCustomTemplate } from '../services/templates.js';
import { validateDocument } from '../upgrade.js';
import { loadSchema } from '../validate.js';

function requireTemplate(db, id, version) {
  if (version !== undefined && (!/^[1-9][0-9]*$/.test(version) || !Number.isSafeInteger(Number(version)))) {
    throw badRequest('Template query.version must be a positive integer. Use a stored template version, such as ?version=1.');
  }
  const template = getTemplate(db, id, version === undefined ? undefined : Number(version));
  if (!template) throw notFound(`Template ${id}${version === undefined ? '' : `@${version}`} does not exist. Use an id and version from GET /api/v1/templates.`);
  return template;
}

function requireBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Template request body must be a JSON object. Send the fields documented for this endpoint.');
  }
}

function detail(template) {
  return { ...template, content_schema: loadSchema(template.kind === 'resume' ? 'content' : 'cover') };
}

function previewDocument(kind, value, language, path) {
  const incoming = language && value && typeof value === 'object' && !Array.isArray(value)
    ? { ...value, language } : value;
  const { doc, errors } = validateDocument(kind, incoming, { rootPath: path });
  if (errors.length) throw validationFailed(`Preview ${path} is invalid. Correct the fields in details before previewing.`, errors);
  return doc;
}

function previewContext(db, template, body) {
  if (body.lang !== undefined && (typeof body.lang !== 'string' || !body.lang.trim())) {
    throw validationFailed('Preview lang must be a non-empty language code. Set lang to en, ru, or another template language.', [
      { path: 'lang', code: 'type', message: 'Provide a non-empty language code string.' }
    ]);
  }
  const sample = template.sample;
  const profile = getProfile(db)?.doc ?? { identity: sample.profile_identity };
  const resume = template.kind === 'resume'
    ? previewDocument('content', body.content === undefined ? sample.resume : body.content, body.lang, 'content')
    : sample.resume;
  let coverInput = body.cover;
  if (coverInput === undefined) {
    coverInput = template.kind === 'cover' && body.content !== undefined ? body.content : sample.cover;
  }
  const cover = template.kind === 'cover' || body.cover !== undefined
    ? previewDocument('cover', coverInput, body.lang, 'cover') : sample.cover;
  return buildContext({ profile, meta: template.meta, resume, cover, lang: body.lang });
}

export function register(router) {
  router.add('GET', '/api/v1/templates', ({ db, query }) => {
    if (query.kind !== undefined && !['resume', 'cover'].includes(query.kind)) {
      throw badRequest('Template query.kind must be resume or cover. Omit kind to list all templates.');
    }
    return listTemplates(db, { kind: query.kind });
  }, { scope: 'read' });

  router.add('GET', '/api/v1/templates/:id', ({ db, params, query }) => detail(requireTemplate(db, params.id, query.version)), { scope: 'read' });

  router.add('PUT', '/api/v1/templates/:id', ({ db, params, body }) => {
    const existing = getTemplate(db, params.id);
    if (existing?.builtin) throw forbidden(`Template ${params.id} is built-in and read-only. Fork it with POST /api/v1/templates/${params.id}/fork, then edit the custom copy.`);
    requireBody(body);
    const saved = saveCustomTemplate(db, params.id, body);
    return { status: existing ? 200 : 201, body: detail(saved) };
  }, { scope: 'write:templates' });

  router.add('POST', '/api/v1/templates/:id/fork', ({ db, params, body, query }) => {
    const original = requireTemplate(db, params.id, query.version);
    requireBody(body);
    let id = body.id;
    if (id === undefined) {
      const base = `custom-${original.id}`.slice(0, 64);
      id = base;
      for (let suffix = 2; getTemplate(db, id); suffix++) {
        const ending = `-${suffix}`;
        id = `${base.slice(0, 64 - ending.length)}${ending}`;
      }
    } else if (typeof id !== 'string' || !/^custom-[a-z0-9][a-z0-9-]{0,56}$/.test(id)) {
      throw badRequest('Fork body.id must match ^custom-[a-z0-9][a-z0-9-]{0,56}$. Choose a custom- prefixed lowercase slug.');
    } else if (getTemplate(db, id)) {
      throw conflict(`Template ${id} already exists. Choose another body.id or omit it to generate a free id.`);
    }
    return { status: 201, body: detail(saveCustomTemplate(db, id, original)) };
  }, { scope: 'write:templates' });

  router.add('DELETE', '/api/v1/templates/:id', ({ db, params }) => {
    requireTemplate(db, params.id);
    deleteCustomTemplate(db, params.id);
    return { ok: true };
  }, { scope: 'write:templates' });

  router.add('POST', '/api/v1/templates/:id/preview', async (c) => {
    const { db, params, query, body } = c;
    const template = requireTemplate(db, params.id, query.version);
    requireBody(body);
    const context = previewContext(db, template, body);
    const input = { meta: template.meta, source: template.source, context };
    if (query.format === 'html') {
      return { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, raw: renderHtml(input) };
    }
    const chrome = { chromeBin: c.chrome.bin, docker: c.chrome.docker };
    const result = await c.renderPdf({ ...input, chrome });
    return {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf', 'X-Pages': String(result.pages),
        ...(result.pages > template.meta.max_pages ? { 'X-Page-Overflow': 'true' } : {})
      },
      raw: result.pdf
    };
  }, { scope: 'read' });
}
