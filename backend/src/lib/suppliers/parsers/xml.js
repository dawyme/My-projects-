/**
 * Minimal, dependency-free XML reader for supplier catalogue feeds.
 *
 * Deliberately *not* a full XML implementation — it covers what product feeds
 * actually use (elements, attributes, text, CDATA, comments, self-closing tags)
 * and refuses the constructs that make XML dangerous:
 *
 *   • DOCTYPE / internal entity subsets are rejected outright, which removes
 *     XXE and "billion laughs" entity expansion entirely
 *   • only the five predefined entities plus numeric character refs are decoded
 *   • hard caps on document size, depth and node count
 *
 * Output shape (one object per element):
 *   { '@attr': 'v', '_text': 'body', child: {...} | [...] }
 */

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_DEPTH = 32;
const MAX_NODES = 200000;

class XmlError extends Error {
  constructor(message, code = 'XML_ERROR') { super(message); this.name = 'XmlError'; this.code = code; }
}

const PREDEFINED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, ref) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X'
        ? parseInt(ref.slice(2), 16)
        : parseInt(ref.slice(1), 10);
      if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) {
        try { return String.fromCodePoint(code); } catch { return match; }
      }
      return match;
    }
    return PREDEFINED[ref] !== undefined ? PREDEFINED[ref] : match;
  });
}

function parseAttributes(source) {
  const attrs = {};
  const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(source))) {
    attrs[`@${m[1]}`] = decodeEntities(m[3] ?? m[4] ?? '');
  }
  return attrs;
}

/**
 * Parses XML text into a JS tree.
 * @returns {{root:object, name:string}}
 */
function parseXml(input) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input ?? '');
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) {
    throw new XmlError(`XML feed exceeds the ${MAX_BYTES / 1024 / 1024} MB limit`, 'TOO_LARGE');
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) {
    throw new XmlError('DOCTYPE / entity declarations are not accepted in supplier feeds', 'FORBIDDEN_DTD');
  }

  const src = text
    .replace(/^\uFEFF/, '')
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  const TAG = /<(\/?)([\w:.-]+)((?:\s+[^>]*?)?)(\/?)>|<!\[CDATA\[([\s\S]*?)\]\]>/g;

  const root = {};
  const stack = [{ node: root, name: '#document' }];
  let cursor = 0;
  let nodes = 0;
  let match;
  let rootName = null;

  const addChild = (parent, name, child) => {
    if (parent[name] === undefined) parent[name] = child;
    else if (Array.isArray(parent[name])) parent[name].push(child);
    else parent[name] = [parent[name], child];
  };

  while ((match = TAG.exec(src))) {
    const textBefore = src.slice(cursor, match.index);
    cursor = match.index + match[0].length;

    if (match[5] !== undefined) {
      // CDATA section — raw text, no entity decoding.
      const top = stack[stack.length - 1];
      if (top.node._text) top.node._text += match[5];
      else top.node._text = match[5];
      continue;
    }

    if (textBefore.trim()) {
      const top = stack[stack.length - 1];
      const decoded = decodeEntities(textBefore).trim();
      if (decoded) top.node._text = (top.node._text || '') + decoded;
    }

    const [, closing, name, attrSource, selfClosing] = match;

    if (closing) {
      if (stack.length === 1) throw new XmlError(`Unexpected closing tag </${name}>`, 'MALFORMED');
      const top = stack.pop();
      if (top.name !== name) throw new XmlError(`Mismatched tag: expected </${top.name}>, got </${name}>`, 'MALFORMED');
      continue;
    }

    if (++nodes > MAX_NODES) throw new XmlError('XML feed has too many nodes', 'TOO_COMPLEX');
    if (stack.length > MAX_DEPTH) throw new XmlError(`XML nesting exceeds ${MAX_DEPTH} levels`, 'TOO_DEEP');

    const node = { ...parseAttributes(attrSource) };
    const parent = stack[stack.length - 1].node;
    if (name === rootName || rootName === null) {
      if (rootName === null) rootName = name;
      addChild(parent, name, node);
    } else {
      addChild(parent, name, node);
    }

    if (!selfClosing) stack.push({ node, name });
  }

  if (stack.length !== 1) {
    throw new XmlError(`Unclosed element <${stack[stack.length - 1].name}>`, 'MALFORMED');
  }
  if (!rootName) throw new XmlError('No XML elements found', 'EMPTY');
  return { root: collapse(root), name: rootName };
}

/**
 * Turns `<sku>ABC</sku>` into the string "ABC" instead of `{ _text: 'ABC' }`,
 * which is what feed column mapping expects. Elements that carry attributes or
 * children keep their object form.
 */
function collapse(node) {
  if (Array.isArray(node)) return node.map(collapse);
  if (!node || typeof node !== 'object') return node;
  const keys = Object.keys(node);
  if (keys.length === 1 && keys[0] === '_text') return node._text;
  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = collapse(v);
  return out;
}

/** Returns the array of repeated child elements under a path, e.g. "catalog.product". */
function selectNodes(root, path) {
  const node = path ? String(path).split('.').reduce((acc, k) => (acc === undefined ? undefined : acc[k]), root) : root;
  if (node === undefined || node === null) return [];
  return Array.isArray(node) ? node : [node];
}

/** Flattens one node into dot-notation keys so `getPath` mapping keeps working. */
function flattenNode(node, prefix = '', out = {}, depth = 0) {
  if (depth > 8) return out;
  for (const [key, value] of Object.entries(node || {})) {
    if (key === '@text') continue;
    const path = prefix ? `${prefix}.${key.replace(/^@/, '')}` : key.replace(/^@/, '');
    if (value && typeof value === 'object' && !Array.isArray(value)) flattenNode(value, path, out, depth + 1);
    else if (Array.isArray(value)) out[path] = value.map((v) => (v && typeof v === 'object' ? v._text ?? JSON.stringify(v) : v));
    else out[path] = value;
  }
  return out;
}

module.exports = { parseXml, selectNodes, flattenNode, collapse, decodeEntities, XmlError, MAX_BYTES };
