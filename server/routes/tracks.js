import { ApiError, badRequest, notFound, validationFailed } from '../errors.js';
import { check } from '../guard.js';
import { getProfile } from '../services/profile.js';
import { getTemplate, listTemplates, parseRef } from '../services/templates.js';
import { deleteTrack, getTrack, listTracks, saveTrack } from '../services/tracks.js';
import { validateDocument } from '../upgrade.js';

function validateId(id) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) {
    throw badRequest('Track path.id must match ^[a-z0-9][a-z0-9-]{0,62}$. Use a lowercase slug of 1 to 63 characters.');
  }
}

function templateErrors(db, doc) {
  const errors = [];
  for (const [path, kind] of [['resume_template', 'resume'], ['cover_template', 'cover']]) {
    if (path === 'cover_template' && !doc[path]) continue;
    let template;
    try {
      const { id, version } = parseRef(doc[path]);
      template = getTemplate(db, id, version);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
    }
    if (!template || template.kind !== kind) {
      const ids = listTemplates(db, { kind }).map(({ id }) => id);
      errors.push({ path, code: 'unknown_template', message: `Template ${JSON.stringify(doc[path])} at ${path} must reference an existing ${kind} template. Valid ids: ${ids.join(', ')}. Choose one from GET /api/v1/templates?kind=${kind}.` });
    }
  }
  return errors;
}

function prefixBase(issues) {
  return issues.map((issue) => ({ ...issue, path: issue.path ? `base.${issue.path}` : 'base' }));
}

export function register(router) {
  router.add('GET', '/api/v1/tracks', ({ db }) => listTracks(db).map(({ id, doc, updatedAt }) => ({
    id, name: doc.name, when_to_use: doc.when_to_use, language: doc.language,
    resume_template: doc.resume_template, cover_template: doc.cover_template, updated_at: updatedAt
  })), { scope: 'read' });

  router.add('GET', '/api/v1/tracks/:id', ({ db, params }) => {
    validateId(params.id);
    const track = getTrack(db, params.id);
    if (!track) throw notFound(`Track ${params.id} does not exist. Use an id from GET /api/v1/tracks or create it with PUT.`);
    return { id: track.id, track: track.doc, updated_at: track.updatedAt };
  }, { scope: 'read' });

  router.add('PUT', '/api/v1/tracks/:id', ({ db, params, body }) => {
    validateId(params.id);
    const profile = getProfile(db);
    if (!profile) throw new ApiError(422, 'profile_missing', 'No profile exists. Fill the profile first via PUT /api/v1/profile, then retry saving the track.');
    // An empty cover reference represents the optional cover omitted by a caller.
    const incoming = body && typeof body === 'object' && !Array.isArray(body) && !Object.hasOwn(body, 'cover_template')
      ? { ...body, cover_template: '' } : body;
    const { doc, errors } = validateDocument('track', incoming);
    if (errors.length) throw validationFailed('Track validation failed. Fix the fields listed in details and retry.', errors);
    const invalidTemplates = templateErrors(db, doc);
    if (invalidTemplates.length) throw validationFailed('Track template references are invalid. Choose templates of the required kind.', invalidTemplates);
    const result = check({
      content: doc.base,
      cover: doc.base_cover === undefined ? null : { text: doc.base_cover, language: doc.language },
      profile: profile.doc
    });
    if (result.errors.length) throw validationFailed('Track base failed the fact check. Use facts from GET /api/v1/profile and correct the fields in details.', prefixBase(result.errors));
    const exists = Boolean(getTrack(db, params.id));
    const saved = saveTrack(db, params.id, doc);
    return { status: exists ? 200 : 201, body: {
      id: saved.id, track: saved.doc, warnings: prefixBase(result.warnings), updated_at: saved.updatedAt
    } };
  }, { scope: 'write:tracks' });

  router.add('DELETE', '/api/v1/tracks/:id', ({ db, params }) => {
    validateId(params.id);
    if (!deleteTrack(db, params.id)) throw notFound(`Track ${params.id} does not exist. Use an id from GET /api/v1/tracks.`);
    return { ok: true };
  }, { scope: 'write:tracks' });
}
