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
  function sequence(block, openingLine) {
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
        const [, type, path] = opening;
        const body = sequence(type, line);
        let alternate = [];
        if (body.end === 'else') {
          const remainder = sequence(type, line);
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

function evaluate(nodes, scopes) {
  return nodes.map((node) => {
    if (node.type === 'text') return node.value;
    const value = resolve(node.path, scopes);
    if (node.type === 'value') return node.raw ? String(value ?? '') : escapeHtml(value);
    if (node.type === 'if') return evaluate(isTruthy(value) ? node.nodes : node.alternate, scopes);
    if (!Array.isArray(value)) return '';
    return value.map((item, index) => evaluate(node.nodes, [{
      value: item,
      variables: { '@index': index, '@first': index === 0, '@last': index === value.length - 1 }
    }, ...scopes])).join('');
  }).join('');
}

export function renderTemplate(source, context = {}) {
  return evaluate(parse(tokenize(source)), [{ value: context, variables: {} }]);
}
