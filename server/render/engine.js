export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

export function paragraphs(text) {
  return String(text ?? '').split(/\r?\n[\t ]*\r?\n(?:[\t ]*\r?\n)*/)
    .map((paragraph) => paragraph.trim()).filter(Boolean);
}

function syntaxError(line, message) {
  return new Error(`Template line ${line}: ${message}`);
}

function tokenize(source) {
  const tokens = [];
  let offset = 0;
  let line = 1;
  while (offset < source.length) {
    const start = source.indexOf('{{', offset);
    const end = start === -1 ? source.length : start;
    const text = source.slice(offset, end);
    if (text) tokens.push({ type: 'text', value: text });
    line += text.split('\n').length - 1;
    if (start === -1) break;
    const raw = source.startsWith('{{{', start);
    const closing = raw ? '}}}' : '}}';
    const tagEnd = source.indexOf(closing, start + (raw ? 3 : 2));
    if (tagEnd === -1) throw syntaxError(line, 'Unclosed tag; add its closing braces.');
    const value = source.slice(start + (raw ? 3 : 2), tagEnd).trim();
    tokens.push({ type: 'tag', value, raw, line });
    offset = tagEnd + closing.length;
    line += source.slice(start, offset).split('\n').length - 1;
  }
  return tokens;
}

function parse(tokens) {
  let offset = 0;
  function sequence(block, openingLine, depth = 0) {
    const nodes = [];
    while (offset < tokens.length) {
      const token = tokens[offset++];
      if (token.type === 'text') {
        nodes.push(token);
        continue;
      }
      const { value, line, raw } = token;
      if (!raw && (value === 'else' || value.startsWith('/'))) {
        if (block && value === `/${block}`) return { nodes, end: 'close' };
        if (value === 'else' && block === 'if') return { nodes, end: 'else' };
        throw syntaxError(line, `Unexpected {{${value}}}; match it to an open block.`);
      }
      const opening = !raw && value.match(/^#(each|if)\s+(\S+)$/);
      if (opening) {
        if (depth >= 12) {
          throw syntaxError(line, 'Template block nesting depth limit of 12 exceeded. Reduce nested #if and #each blocks to at most 12.');
        }
        const [, type, path] = opening;
        const body = sequence(type, line, depth + 1);
        let alternate = [];
        if (body.end === 'else') {
          const remainder = sequence(type, line, depth + 1);
          if (remainder.end === 'else') {
            throw syntaxError(tokens[offset - 1].line, 'Duplicate {{else}}; keep one per if block.');
          }
          alternate = remainder.nodes;
        }
        nodes.push({ type, path, nodes: body.nodes, alternate });
      } else {
        if (!value || /^[#/>]/.test(value)) {
          throw syntaxError(line, `Unsupported tag {{${value}}}; use a path, #if, or #each.`);
        }
        nodes.push({ type: 'value', path: value, raw });
      }
    }
    if (block) throw syntaxError(openingLine, `Unclosed ${block} block; add {{/${block}}}.`);
    return { nodes };
  }
  return sequence().nodes;
}

function ownValue(value, key) {
  if (value == null) return undefined;
  return Object.hasOwn(Object(value), key) ? value[key] : undefined;
}

function resolve(path, scopes) {
  if (path === '.') return scopes[0].value;
  const parts = path.split('.');
  for (const scope of scopes) {
    const source = path.startsWith('@') ? scope.variables : scope.value;
    if (source == null || !Object.hasOwn(Object(source), parts[0])) continue;
    let value = source;
    for (const part of parts) value = ownValue(value, part);
    return value;
  }
  return undefined;
}

function isTruthy(value) {
  return Boolean(value) && (!Array.isArray(value) || value.length > 0);
}

function evaluationStep(state) {
  if (++state.steps > 200000) {
    throw new Error('Template evaluation step limit of 200000 exceeded. Reduce nested loops or the number of items they render.');
  }
}

function appendOutput(state, text) {
  state.bytes += Buffer.byteLength(text, 'utf8');
  if (state.bytes > 2 * 1024 * 1024) {
    throw new Error('Template output size limit of 2 MB exceeded. Reduce rendered content or repeated template blocks.');
  }
  if (text) state.chunks.push(text);
}

function evaluate(nodes, scopes, state) {
  for (const node of nodes) {
    evaluationStep(state);
    if (node.type === 'text') {
      appendOutput(state, node.value);
      continue;
    }
    const value = resolve(node.path, scopes);
    if (node.type === 'value') {
      appendOutput(state, node.raw ? String(value ?? '') : escapeHtml(value));
    } else if (node.type === 'if') {
      evaluate(isTruthy(value) ? node.nodes : node.alternate, scopes, state);
    } else if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        evaluationStep(state);
        evaluate(node.nodes, [{
          value: value[index],
          variables: { '@index': index, '@first': index === 0, '@last': index === value.length - 1 }
        }, ...scopes], state);
      }
    }
  }
}

export function renderTemplate(source, context = {}) {
  const nodes = parse(tokenize(source));
  const state = { steps: 0, bytes: 0, chunks: [] };
  evaluate(nodes, [{ value: context, variables: {} }], state);
  return state.chunks.join('');
}
