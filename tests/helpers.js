import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToken } from '../server/auth.js';
import { startServer } from '../server/index.js';

export async function startTestServer({ withToken = 'owner' } = {}) {
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
