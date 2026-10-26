import { badRequest, notFound, validationFailed } from '../errors.js';
import { check } from '../guard.js';
import { getProfile, getRevision, listRevisions, mergePatch, saveProfile } from '../services/profile.js';
import { listTracks } from '../services/tracks.js';
import { validateDocument } from '../upgrade.js';
import { loadSchema } from '../validate.js';

function writeProfile({ db, body, token }, patch = false) {
  let incoming = body;
  if (patch) {
    const current = getProfile(db);
    if (!current) throw validationFailed('No profile exists to patch. Fill the profile first with PUT /api/v1/profile.');
    incoming = mergePatch(current.doc, body);
  }
  const { doc, errors } = validateDocument('profile', incoming, { rootPath: 'profile' });
  if (errors.length) throw validationFailed('Profile validation failed. Fix the fields listed in details and retry PUT /api/v1/profile.', errors);
  const failing = listTracks(db).filter(({ doc: track }) => check({
    content: track.base,
    cover: track.base_cover === undefined ? null : { text: track.base_cover, language: track.language },
    profile: doc
  }).errors.length).map(({ id }) => id);
  const saved = saveProfile(db, doc, token.id);
  return { profile: saved.doc, revision_id: saved.revisionId, updated_at: saved.updatedAt, tracks_failing: failing };
}

export function register(router) {
  router.add('GET', '/api/v1/profile', ({ db }) => {
    const profile = getProfile(db);
    return {
      profile: profile?.doc ?? null, empty: !profile,
      revision_id: profile?.revisionId ?? null, updated_at: profile?.updatedAt ?? null
    };
  }, { scope: 'read' });
  router.add('PUT', '/api/v1/profile', (c) => writeProfile(c), { scope: 'write:profile' });
  router.add('PATCH', '/api/v1/profile', (c) => writeProfile(c, true), { scope: 'write:profile' });
  router.add('GET', '/api/v1/profile/schema', () => loadSchema('profile'), { scope: 'read' });
  router.add('GET', '/api/v1/profile/revisions', ({ db, query, res }) => {
    const { items, total } = listRevisions(db, query);
    res.setHeader('X-Total-Count', String(total));
    return items;
  }, { scope: 'read' });
  router.add('GET', '/api/v1/profile/revisions/:id', ({ db, params }) => {
    const id = Number(params.id);
    if (!/^[1-9][0-9]*$/.test(params.id) || !Number.isSafeInteger(id)) {
      throw badRequest('Profile revision path.id must be a positive integer. Use an id from GET /api/v1/profile/revisions.');
    }
    const doc = getRevision(db, id);
    if (!doc) throw notFound(`Profile revision ${id} does not exist. Use an id from GET /api/v1/profile/revisions.`);
    return doc;
  }, { scope: 'read' });
}
