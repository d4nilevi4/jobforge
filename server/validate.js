import { readFileSync } from 'node:fs';

const schemaCache = new Map();
const errorLimit = 50;

function fieldPath(path, key) {
  return path ? `${path}.${key}` : key;
}

function valueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(type, value) {
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return valueType(value) === type;
}

function equalValues(left, right) {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && (!Array.isArray(left) || left.length === right.length)
    && keys.every((key) => Object.hasOwn(right, key) && equalValues(left[key], right[key]));
}

function displayValue(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function resolveReference(root, reference) {
  const match = /^#\/\$defs\/([^/]+)$/.exec(reference);
  const name = match?.[1].replace(/~1/g, '/').replace(/~0/g, '~');
  if (!match || !root.$defs || !Object.hasOwn(root.$defs, name)) {
    throw new TypeError(`Cannot resolve schema reference "${reference}". Use an existing local #/$defs/<name> reference.`);
  }
  return root.$defs[name];
}

export function validate(schema, value, { rootPath = '' } = {}) {
  const errors = [];

  function add(target, path, code, message) {
    if (target.length < errorLimit) target.push({ path, code, message });
  }

  function visit(node, current, path, target, ancestors = []) {
    if (target.length >= errorLimit) return;
    if (ancestors.some((entry) => entry.node === node && entry.value === current)) return;
    const nextAncestors = [...ancestors, { node, value: current }];

    if (node.$ref) {
      visit(resolveReference(schema, node.$ref), current, path, target, nextAncestors);
    }
    if (node.type !== undefined) {
      const types = Array.isArray(node.type) ? node.type : [node.type];
      if (!types.some((type) => matchesType(type, current))) {
        add(target, path, 'type', `Expected ${types.join(' or ')}, got ${valueType(current)}.`);
      }
    }
    if (node.enum && !node.enum.some((option) => equalValues(option, current))) {
      add(target, path, 'enum', `Must be one of: ${node.enum.map(displayValue).join(', ')}.`);
    }
    if (Object.hasOwn(node, 'const') && !equalValues(node.const, current)) {
      add(target, path, 'const', `Must equal ${JSON.stringify(node.const)}.`);
    }
    if (node.anyOf) {
      const branches = node.anyOf.map((branch) => {
        const branchErrors = [];
        visit(branch, current, path, branchErrors, nextAncestors);
        return branchErrors;
      });
      if (!branches.some((branch) => branch.length === 0)) {
        const hints = branches.slice(0, 3).map((branch) => {
          const first = branch[0];
          return `${first.path || 'value'}: ${first.message}`;
        });
        add(target, path, 'any_of', `Must match at least one allowed schema. ${hints.join(' ')}`);
      }
    }

    if (typeof current === 'string') {
      const length = [...current].length;
      if (node.minLength !== undefined && length < node.minLength) {
        add(target, path, 'min_length', `Must contain at least ${node.minLength} characters; got ${length}.`);
      }
      if (node.maxLength !== undefined && length > node.maxLength) {
        add(target, path, 'max_length', `Must contain at most ${node.maxLength} characters; got ${length}.`);
      }
      if (node.pattern !== undefined && !new RegExp(node.pattern, 'u').test(current)) {
        add(target, path, 'pattern', `Must match pattern ${JSON.stringify(node.pattern)}.`);
      }
    }
    if (typeof current === 'number' && Number.isFinite(current)) {
      if (node.minimum !== undefined && current < node.minimum) {
        add(target, path, 'minimum', `Must be at least ${node.minimum}; got ${current}.`);
      }
      if (node.maximum !== undefined && current > node.maximum) {
        add(target, path, 'maximum', `Must be at most ${node.maximum}; got ${current}.`);
      }
    }
    if (Array.isArray(current)) {
      if (node.minItems !== undefined && current.length < node.minItems) {
        add(target, path, 'min_items', `Must contain at least ${node.minItems} items; got ${current.length}.`);
      }
      if (node.maxItems !== undefined && current.length > node.maxItems) {
        add(target, path, 'max_items', `Must contain at most ${node.maxItems} items; got ${current.length}.`);
      }
      if (node.items) {
        for (let index = 0; index < current.length && target.length < errorLimit; index++) {
          visit(node.items, current[index], `${path}[${index}]`, target, nextAncestors);
        }
      }
    } else if (current !== null && typeof current === 'object') {
      const properties = node.properties ?? {};
      for (const key of node.required ?? []) {
        if (!Object.hasOwn(current, key)) {
          add(target, fieldPath(path, key), 'required', `Missing required field "${key}". Add it to this object.`);
        }
      }
      for (const key of Object.keys(current)) {
        if (target.length >= errorLimit) break;
        if (Object.hasOwn(properties, key)) {
          visit(properties[key], current[key], fieldPath(path, key), target, nextAncestors);
        } else if (node.additionalProperties === false) {
          const allowed = Object.keys(properties).join(', ') || '(none)';
          add(target, fieldPath(path, key), 'additional_property', `Unknown field "${key}". Allowed: ${allowed}. Remove or rename this field.`);
        } else if (node.additionalProperties && typeof node.additionalProperties === 'object') {
          visit(node.additionalProperties, current[key], fieldPath(path, key), target, nextAncestors);
        }
      }
    }
  }

  visit(schema, value, rootPath, errors);
  return errors;
}

export function loadSchema(name) {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(name)) {
    throw new TypeError('Schema name must be a lowercase identifier, such as "profile"; do not include a path or extension.');
  }
  if (!schemaCache.has(name)) {
    const file = new URL(`../schema/${name}.schema.json`, import.meta.url);
    schemaCache.set(name, JSON.parse(readFileSync(file, 'utf8')));
  }
  return schemaCache.get(name);
}
