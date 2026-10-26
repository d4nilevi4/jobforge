import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export function loadConfig(env = process.env) {
  const port = Number(env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('PORT must be an integer from 0 to 65535. Set PORT to a valid TCP port.');
  }
  const { version } = JSON.parse(readFileSync(resolve(APP_ROOT, 'package.json'), 'utf8'));
  return {
    port,
    host: env.HOST || '127.0.0.1',
    dataDir: resolve(env.DATA_DIR || './data'),
    chromeBin: env.CHROME_BIN || '',
    docker: env.JOBFORGE_DOCKER === '1',
    version,
  };
}
