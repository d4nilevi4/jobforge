import { ApiError, validationFailed } from './errors.js';
import { loadSchema, validate } from './validate.js';

export const CURRENT = { profile: 1, track: 1, content: 1, cover: 1 };

const chains = { profile: [], track: [], content: [], cover: [] };

function assertKind(kind) {
  if (!Object.hasOwn(chains, kind)) {
    throw new TypeError(`Unknown document kind "${kind}". Use profile, track, content, or cover.`);
  }
}

function isDocument(doc) {
  return doc !== null && typeof doc === 'object' && !Array.isArray(doc);
}

function upgrade(kind, doc, rootPath = '') {
  assertKind(kind);
  if (!isDocument(doc)) {
    throw validationFailed(`The ${kind} document must be an object. Send a JSON object.`, [
      { path: rootPath, code: 'type', message: 'Expected a document object. Send a JSON object, not an array or scalar.' }
    ]);
  }

  const versionPath = rootPath ? `${rootPath}.schema_version` : 'schema_version';
  const version = Object.hasOwn(doc, 'schema_version') ? doc.schema_version : 1;
  if (!Number.isInteger(version) || version < 1) {
    throw validationFailed(`Invalid ${kind} schema_version. Set it to an integer of at least 1.`, [
      { path: versionPath, code: 'type', message: 'schema_version must be an integer of at least 1. Use 1 for an unversioned document.' }
    ]);
  }
  if (version > CURRENT[kind]) {
    throw validationFailed(`The ${kind} document uses schema_version ${version}, but this server supports ${CURRENT[kind]}. Update the JobForge server before sending this document.`, [
      { path: versionPath, code: 'maximum', message: `Update the JobForge server to support ${kind} schema_version ${version}. Do not downgrade the document.` }
    ]);
  }

  let result = structuredClone(doc);
  result.schema_version = version;
  for (let fromVersion = version; fromVersion < CURRENT[kind]; fromVersion++) {
    const transform = chains[kind][fromVersion - 1];
    if (!transform) {
      throw new ApiError(500, 'internal', `Missing ${kind} upgrade from version ${fromVersion} to ${fromVersion + 1}. Register this upgrade in server/upgrade.js.`);
    }
    const next = transform(result);
    if (!isDocument(next)) {
      throw new ApiError(500, 'internal', `The ${kind} upgrade from version ${fromVersion} must return a document object. Fix the registered upgrade function.`);
    }
    result = structuredClone(next);
    result.schema_version = fromVersion + 1;
  }
  return result;
}

export function upgradeDocument(kind, doc) {
  return upgrade(kind, doc);
}

export function validateDocument(kind, doc, { rootPath = '' } = {}) {
  const upgraded = upgrade(kind, doc, rootPath);
  return { doc: upgraded, errors: validate(loadSchema(kind), upgraded, { rootPath }) };
}

// Register in ascending order; the chain owns version stamping and raises the target version.
export function registerUpgrade(kind, fromVersion, fn) {
  assertKind(kind);
  if (!Number.isInteger(fromVersion) || fromVersion < 1 || typeof fn !== 'function') {
    throw new TypeError('Register an upgrade with a positive integer fromVersion and a function returning the next document.');
  }
  if (fromVersion !== CURRENT[kind]) {
    throw new TypeError(`Register the next ${kind} upgrade from version ${CURRENT[kind]}; do not skip or replace a chain step.`);
  }
  chains[kind][fromVersion - 1] = fn;
  CURRENT[kind] = fromVersion + 1;
}

// Test-only hook: restore the shipped version-one chains after registering fixtures.
export function resetUpgrades() {
  for (const kind of Object.keys(chains)) {
    chains[kind].length = 0;
    CURRENT[kind] = 1;
  }
}
