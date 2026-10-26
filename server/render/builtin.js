import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateMeta(meta, id, file) {
  const require = (valid, message) => {
    if (!valid) throw new Error(`${file}: ${message}`);
  };
  require(isObject(meta), 'Expected a metadata object; replace the JSON with template metadata.');
  require(meta.id === id, `id must equal folder name "${id}"; update meta.id.`);
  require(['resume', 'cover'].includes(meta.kind), 'kind must be "resume" or "cover"; update meta.kind.');
  require(Number.isInteger(meta.version), 'version must be an integer; update meta.version.');
  require(['letter', 'a4'].includes(meta.paper), 'paper must be "letter" or "a4"; update meta.paper.');
  require(Number.isInteger(meta.max_pages) && meta.max_pages >= 1, 'max_pages must be an integer >= 1; update meta.max_pages.');
  require(Array.isArray(meta.languages) && meta.languages.every((lang) => typeof lang === 'string' && lang.length > 0),
    'languages must be an array of language codes; update meta.languages.');
  require(isObject(meta.labels), 'labels must be an object of language maps; update meta.labels.');
  for (const [language, labels] of Object.entries(meta.labels)) {
    require(isObject(labels) && Object.values(labels).every((label) => typeof label === 'string'),
      `labels.${language} must be an object of string labels; update that language map.`);
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file}: Could not read valid JSON; fix the file. ${error.message}`);
  }
}

export async function loadBuiltinTemplates(dir) {
  const templates = new Map();
  const entries = (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const { name: id } of entries) {
    const folder = join(dir, id);
    const meta = await readJson(join(folder, 'meta.json'));
    validateMeta(meta, id, join(folder, 'meta.json'));
    const [source, sample] = await Promise.all([
      readFile(join(folder, 'template.html'), 'utf8'), readJson(join(folder, 'sample.json'))
    ]);
    templates.set(id, { id, builtin: true, meta, source, sample });
  }
  return templates;
}
