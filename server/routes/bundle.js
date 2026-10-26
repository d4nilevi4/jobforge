import { exportBundle, importBundle } from '../services/bundle.js';

export function register(router) {
  router.add('GET', '/api/v1/export', (c) => exportBundle(c.db, { version: c.config.version }), { scope: 'admin' });
  router.add('POST', '/api/v1/import', (c) => importBundle(c.db, c.body, { dataDir: c.config.dataDir, renderPdf: c.renderPdf, chrome: c.chrome }), { scope: 'admin' });
}
