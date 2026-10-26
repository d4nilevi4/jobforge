import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToken } from '../server/auth.js';
import { startServer } from '../server/index.js';

export async function startTestServer({ withToken = 'owner', deps } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'jobforge-test-'));
  let instance;
  let initialSecret;
  const log = {
    log(message) {
      const match = /jf_[A-Za-z0-9_-]{43}/.exec(message);
      if (match) initialSecret = match[0];
    },
    warn() {},
    error() {},
  };
  try {
    instance = await startServer({
      env: { ...process.env, DATA_DIR: dataDir, PORT: '0', HOST: '127.0.0.1' },
      log,
      deps,
    });
  } catch (error) {
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  }
  const { url, db } = instance;
  const makeToken = (preset) => createToken(db, { name: `${preset} test token`, preset }).secret;
  const token = withToken === 'owner' ? initialSecret : withToken ? makeToken(withToken) : null;
  let closing;
  return {
    url,
    db,
    dataDir,
    token,
    makeToken,
    async api(method, path, body, { token: requestToken = token, raw = false } = {}) {
      const headers = {};
      if (requestToken) headers.Authorization = `Bearer ${requestToken}`;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(`${url}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
      });
      const text = await response.text();
      return {
        status: response.status,
        body: raw ? text : text ? JSON.parse(text) : null,
        headers: response.headers,
      };
    },
    close() {
      closing ??= (async () => {
        try {
          await instance.close();
        } finally {
          await rm(dataDir, { recursive: true, force: true });
        }
      })();
      return closing;
    },
  };
}

export function demoExample(name) {
  return JSON.parse(readFileSync(new URL(`../examples/${name}.example.json`, import.meta.url), 'utf8'));
}

export async function fakeApplicationPdf({ meta, context }) {
  return { pdf: Buffer.from(`%PDF-1.7\n/Type /Pages /Count 1\n${meta.id}\n${JSON.stringify(context)}`), pages: 1 };
}

export function applicationInput(number = 1, overrides = {}) {
  const track = demoExample('tracks')['unity-developer'];
  const content = structuredClone(track.base);
  content.experience = content.experience.slice(0, 1);
  content.projects = content.projects.slice(0, 1);
  return {
    vacancy: { url: `https://example.com/jobs/${number}`, title: 'Unity Engineer', company: 'Orbit Games', source: 'manual', language: 'en', text: 'Build Unity gameplay systems and editor tools for a remote team.' },
    verdict: 'apply', score: 0.9, track_id: 'unity-developer', notes: 'Focus on profiling.',
    resume: { template: 'classic', content },
    cover: { template: 'letter', content: { text: 'I built Unity and C# gameplay systems at Northwind Games. I would bring that experience to your team.' } },
    ...overrides
  };
}

export async function applicationTestServer(t, { deps = {}, ...options } = {}) {
  const app = await startApplicationServer({ ...options, deps: { renderPdf: fakeApplicationPdf, chrome: { bin: 'fake-chrome' }, ...deps } });
  t.after(() => app.close());
  const response = await app.api('PUT', '/api/v1/profile', demoExample('profile'));
  if (response.status !== 200) throw new Error(`Application test profile failed: ${JSON.stringify(response.body)}`);
  return app;
}

export async function startApplicationServer(options = {}) {
  try {
    return { ...await startTestServer(options), transport: 'http' };
  } catch (error) {
    if (error.code !== 'EPERM' || error.syscall !== 'listen') throw error;
  }
  // Restricted sandboxes may forbid listening, while the real router can still be exercised in process.
  const { PassThrough } = await import('node:stream');
  const { openDb, migrate } = await import('../server/db.js');
  const { createRouter } = await import('../server/http.js');
  const { registerAll } = await import('../server/routes/index.js');
  const dataDir = await mkdtemp(join(tmpdir(), 'jobforge-router-test-'));
  const db = openDb(dataDir);
  migrate(db, { backupDir: join(dataDir, 'backups') });
  const makeToken = (preset) => createToken(db, { name: `${preset} test token`, preset }).secret;
  const token = makeToken(options.withToken ?? 'owner');
  const config = { dataDir, version: '0.1.0' };
  const router = createRouter();
  registerAll({ add(method, path, handler, routeOptions) {
    router.add(method, path, (c) => handler({ ...c, ...options.deps }), routeOptions);
  } });
  return {
    db, dataDir, token, makeToken, transport: 'in-process (listen EPERM)',
    async api(method, path, body, { token: requestToken = token, raw = false } = {}) {
      const req = new PassThrough();
      req.method = method;
      req.url = path;
      req.headers = requestToken ? { authorization: `Bearer ${requestToken}` } : {};
      const headers = new Headers();
      let output;
      let status;
      const res = {
        headersSent: false, writableEnded: false,
        setHeader(key, value) { headers.set(key, value); },
        getHeader(key) { return headers.get(key); },
        writeHead(code, values = {}) {
          status = code;
          for (const [key, value] of Object.entries(values)) headers.set(key, value);
          this.headersSent = true;
        },
        end(value, done) { output = value?.toString() ?? ''; this.writableEnded = true; done?.(); },
        destroy() { this.writableEnded = true; }
      };
      const handling = router.handle(req, res, { db, config, log: { error() {} } });
      req.end(body === undefined ? '' : raw ? body : JSON.stringify(body));
      await handling;
      return { status, body: raw ? output : output ? JSON.parse(output) : null, headers };
    },
    async close() {
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  };
}
