import { badRequest, unauthorized } from '../errors.js';
import { applicationFile, createApplication, deleteApplication, getApplication, listApplications, prepare, rerenderApplication, setStatus, updateApplication } from '../services/applications.js';

function options(c) {
  return { dataDir: c.config.dataDir, token: c.token, renderPdf: c.renderPdf, chrome: c.chrome };
}

export function register(router) {
  router.add('POST', '/api/v1/check', async (c) => {
    const result = await prepare(c.db, c.body, { ...options(c), render: c.query.render !== '0' });
    return { ok: true, warnings: result.warnings, ...(c.query.render === '0' ? {} : { pages: result.pages }), duplicate: result.duplicate, same_company: result.same_company };
  }, { scope: 'write:applications' });
  router.add('POST', '/api/v1/applications', async (c) => ({ status: 201, body: await createApplication(c.db, c.body, options(c)) }), { scope: 'write:applications' });
  router.add('GET', '/api/v1/applications', (c) => listApplications(c.db, c.query, options(c)), { scope: 'read' });
  router.add('GET', '/api/v1/applications/:id', (c) => getApplication(c.db, c.params.id, options(c)), { scope: 'read' });
  router.add('PUT', '/api/v1/applications/:id', (c) => updateApplication(c.db, c.params.id, c.body, options(c)), { scope: 'write:applications' });
  // Scope depends on the requested status. Authentication and that scope are enforced here and in setStatus.
  router.add('POST', '/api/v1/applications/:id/status', (c) => {
    if (!c.token) throw unauthorized('Missing or invalid token. Send Authorization: Bearer <active token> to change application status.');
    return setStatus(c.db, c.params.id, c.body, options(c));
  });
  router.add('POST', '/api/v1/applications/:id/rerender', (c) => {
    const version = c.query.version;
    if (version !== undefined && (!/^[1-9][0-9]*$/u.test(version) || !Number.isSafeInteger(Number(version)))) {
      throw badRequest('Rerender query.version must be a positive integer. Use a stored template version or omit version for the current template.');
    }
    return rerenderApplication(c.db, c.params.id, { ...options(c), version: version === undefined ? undefined : Number(version) });
  }, { scope: 'write:applications' });
  router.add('GET', '/api/v1/applications/:id/files/:name', (c) => applicationFile(c.db, c.params.id, c.params.name, { ...options(c), download: c.query.dl === '1' }), { scope: 'read' });
  router.add('DELETE', '/api/v1/applications/:id', (c) => deleteApplication(c.db, c.params.id, options(c)), { scope: 'approve' });
}
