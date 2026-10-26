import { readFile } from 'node:fs/promises';
import { createToken, hasScope, listTokens, revokeToken } from '../auth.js';
import { badRequest, conflict, notFound } from '../errors.js';

export function register(router) {
  router.add('GET', '/api/v1/guide', async ({ req }) => {
    let origin;
    try {
      origin = new URL(`${req.socket?.encrypted ? 'https' : 'http'}://${req.headers.host || 'localhost'}`).origin;
    } catch {
      throw badRequest('Request Host header is invalid. Send the hostname and optional port of this JobForge instance.');
    }
    const guide = await readFile(new URL('../../docs/agent-guide.md', import.meta.url), 'utf8');
    return { status: 200, headers: { 'Content-Type': 'text/markdown; charset=utf-8' }, raw: guide.replaceAll('{{BASE_URL}}', origin) };
  }, { scope: 'read' });

  router.add('GET', '/api/v1/openapi.json', async () => JSON.parse(
    await readFile(new URL('../../schema/openapi.json', import.meta.url), 'utf8')
  ), { scope: 'read' });

  router.add('GET', '/api/v1/version', async ({ db, config }) => {
    let chrome = { found: false, path: '', version: '' };
    try {
      const { findChrome, chromeVersion } = await import('../render/pdf.js');
      if (typeof findChrome === 'function' && typeof chromeVersion === 'function') {
        const path = await findChrome({ ...process.env, CHROME_BIN: config.chromeBin });
        if (path) chrome = { found: true, path, version: await chromeVersion(path) };
      }
    } catch {
      // Chrome is optional; the rest of the API remains usable without it.
    }
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    return { name: 'jobforge', version: config.version, api: 'v1', schema_version: Number(row?.value || 0), chrome };
  }, { scope: null });

  router.add('GET', '/api/v1/tokens', ({ db }) => listTokens(db), { scope: 'admin' });

  router.add('POST', '/api/v1/tokens', ({ db, body }) => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw badRequest('Token request body must be an object. Provide name and exactly one of preset or scopes.');
    }
    return { status: 201, body: createToken(db, body) };
  }, { scope: 'admin' });

  router.add('DELETE', '/api/v1/tokens/:id', ({ db, params, token }) => {
    const id = Number(params.id);
    if (!/^\d+$/.test(params.id) || !Number.isSafeInteger(id) || id < 1) {
      throw badRequest('Token path.id must be a positive integer. Use an id returned by GET /api/v1/tokens.');
    }
    const tokens = listTokens(db);
    if (!tokens.some((entry) => entry.id === id)) {
      throw notFound(`Token ${id} does not exist. Use an id returned by GET /api/v1/tokens.`);
    }
    if (token.id === id && tokens.filter((entry) => !entry.revoked_at && hasScope(entry, 'admin')).length === 1) {
      throw conflict('Cannot revoke the last active admin token making this request. Create another admin or owner token first.');
    }
    revokeToken(db, id);
    return { status: 200, body: { ok: true } };
  }, { scope: 'admin' });
}
