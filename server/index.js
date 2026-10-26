import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureOwnerToken } from './auth.js';
import { APP_ROOT, loadConfig } from './config.js';
import { migrate, openDb } from './db.js';
import { createRouter } from './http.js';
import { registerAll } from './routes/index.js';
import { renderPdf } from './render/index.js';
import { findChrome } from './render/pdf.js';

function isLoopback(host) {
  return host === 'localhost' || host === '::1'
    || (isIP(host) === 4 && host.startsWith('127.'));
}

export async function startServer({ env = process.env, overrides = {}, log = console, deps = {} } = {}) {
  const config = { ...loadConfig(env), ...overrides };
  const db = openDb(config.dataDir);
  let server;
  try {
    migrate(db, { dir: join(APP_ROOT, 'server', 'migrations'), backupDir: join(config.dataDir, 'backups'), log });
    ensureOwnerToken(db, log);
    const router = createRouter();
    const injected = {
      renderPdf: deps.renderPdf ?? renderPdf,
      chrome: deps.chrome ?? { bin: config.chromeBin || findChrome(env), docker: config.docker }
    };
    registerAll({
      add(method, path, handler, options) {
        router.add(method, path, (c) => handler({ ...c, ...injected }), options);
      }
    });
    server = createServer((req, res) => router.handle(req, res, { db, config, log }));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    const host = address.address.includes(':') ? `[${address.address}]` : address.address;
    const url = `http://${host}:${address.port}`;
    if (!isLoopback(config.host)) {
      const message = `Warning: JobForge is reachable from the network on ${config.host} and protected only by tokens.`;
      if (typeof log === 'function') log(message);
      else (log.warn || log.log).call(log, message);
    }
    let closing;
    const close = () => {
      closing ??= new Promise((resolve, reject) => {
        server.close((error) => {
          try {
            db.close();
            if (error) reject(error);
            else resolve();
          } catch (closeError) {
            reject(closeError);
          }
        });
        server.closeIdleConnections();
      });
      return closing;
    };
    return { server, url, db, config, close };
  } catch (error) {
    server?.close();
    db.close();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const instance = await startServer();
    console.log(`JobForge ${instance.config.version} listening on ${instance.url}`);
    const stop = async () => {
      try {
        await instance.close();
      } catch (error) {
        console.error(error.stack || error.message);
        process.exitCode = 1;
      }
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
