import { accessSync, constants, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createToken } from './auth.js';
import { APP_ROOT, loadConfig } from './config.js';

const USAGE = 'Usage: node server/cli.js token --name <name> (--preset agent|setup|owner | --scopes a,b)\n       node server/cli.js backup|doctor\n       node server/cli.js export [--out file]\n       node server/cli.js import --file file\n       node server/cli.js seed-demo [--force]';

function tokenOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!['--name', '--preset', '--scopes'].includes(flag) || value === undefined
      || value.startsWith('--') || Object.hasOwn(options, flag.slice(2))) {
      throw new Error(`Invalid token argument ${flag}. ${USAGE}`);
    }
    options[flag.slice(2)] = flag === '--scopes' ? value.split(',').map((scope) => scope.trim()) : value;
  }
  return options;
}

async function doctor(config) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const supported = major > 22 || (major === 22 && minor >= 13);
  console.log(`Node: ${process.version} (${supported ? 'satisfies >=22.13' : 'requires >=22.13; upgrade Node'})`);
  let writable = false;
  try {
    mkdirSync(config.dataDir, { recursive: true });
    accessSync(config.dataDir, constants.W_OK);
    writable = true;
  } catch {
    // Report the inaccessible directory without hiding the other diagnostics.
  }
  console.log(`Data directory: ${config.dataDir} (writable: ${writable})`);
  let db;
  try {
    const { openDb } = await import('./db.js');
    db = openDb(config.dataDir);
    const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
    const row = hasMeta && db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    console.log(`Schema version: ${Number(row?.value || 0)}`);
  } catch (error) {
    console.log(`Schema version: unavailable (${error.message})`);
  } finally {
    db?.close();
  }
  let chrome = { found: false, path: '', version: '' };
  try {
    const { findChrome, chromeVersion } = await import('./render/pdf.js');
    if (typeof findChrome === 'function' && typeof chromeVersion === 'function') {
      const path = await findChrome({ ...process.env, CHROME_BIN: config.chromeBin });
      if (path) chrome = { found: true, path, version: await chromeVersion(path) };
    }
  } catch {
    // Chrome is optional for commands that do not render PDFs.
  }
  console.log(`Chrome: ${chrome.found ? `${chrome.path} (${chrome.version})` : 'not found'}`);
  return supported ? 0 : 1;
}

export async function main(args, { deps = {} } = {}) {
  const [command, ...rest] = args;
  const validArgs = command === 'token'
    || (command === 'export' && (!rest.length || (rest.length === 2 && rest[0] === '--out' && rest[1] && !rest[1].startsWith('--'))))
    || (command === 'import' && rest.length === 2 && rest[0] === '--file' && rest[1] && !rest[1].startsWith('--'))
    || (command === 'seed-demo' && (!rest.length || (rest.length === 1 && rest[0] === '--force')))
    || (['backup', 'doctor'].includes(command) && !rest.length);
  if (!validArgs) {
    console.error(USAGE);
    return 1;
  }
  const config = loadConfig();
  if (command === 'doctor') return doctor(config);
  const options = command === 'token' ? tokenOptions(rest) : null;
  const { openDb, migrate } = await import('./db.js');
  const db = openDb(config.dataDir);
  try {
    const backupDir = join(config.dataDir, 'backups');
    migrate(db, { dir: join(APP_ROOT, 'server', 'migrations'), backupDir, log: command === 'export' ? { log: (message) => console.error(message) } : console });
    if (command === 'token') {
      const token = createToken(db, options);
      console.log(`Created token "${token.name}". Save this secret; it will only be shown once: ${token.secret}`);
    } else if (command === 'export') {
      const { exportBundle } = await import('./services/bundle.js');
      const json = `${JSON.stringify(exportBundle(db, { version: config.version }), null, 2)}\n`;
      if (rest.length) writeFileSync(rest[1], json);
      else process.stdout.write(json);
    } else if (command === 'import' || command === 'seed-demo') {
      const { findChrome } = await import('./render/pdf.js');
      const options = { dataDir: config.dataDir, chrome: { bin: config.chromeBin || findChrome(), docker: config.docker } };
      let result;
      if (command === 'import') {
        const { importBundle } = await import('./services/bundle.js');
        let bundle;
        try {
          bundle = JSON.parse(readFileSync(rest[1], 'utf8'));
        } catch (error) {
          throw new Error(`Cannot read import JSON from ${rest[1]}: ${error.message}. Use --file with a complete JobForge export.`);
        }
        result = await importBundle(db, bundle, options);
      } else {
        const { seedDemo } = await import('./services/seed.js');
        result = await seedDemo(db, { ...options, deps, force: rest.includes('--force') });
        const { owner_token: secret, ...summary } = result;
        if (secret) console.log(`Created the initial owner token. Save this secret now; it will only be shown once: ${secret}`);
        result = summary;
      }
      console.log(JSON.stringify(result));
    } else {
      mkdirSync(backupDir, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const path = join(backupDir, `jobforge-manual-${timestamp}.db`);
      db.prepare('VACUUM INTO ?').run(path);
      console.log(`Database backup saved: ${path}`);
    }
    return 0;
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
