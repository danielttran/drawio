// Minimal SVG-serialization shim for headless Node.js execution.
//
// Implements only the subset of the SVG DOM required to let draw.io's
// shape/text renderer create elements and serialize them to XML.  HTML
// layout, the CSS cascade, getBoundingClientRect, event handling, and pixel
// production are NOT implemented — those are forbidden by docs/CLAUDE.md §0.
//
// The shim provides:
//   createSvgDocument()  → a document-like factory
//   shimElement          → the Element class (used by the document)
//   shimTextNode         → the TextNode class
//   XMLSerializer        → serializeToString(node) → XML string
//
// Usage (inject into the exporter's `root`):
//   const shim = createSvgDocument();
//   // then set globalThis.document = shim  (or pass as `root`)

const SVG_NS = 'http://www.w3.org/2000/svg';

// ── HTML fragment parser ────────────────────────────────────────────────────
// Parses the draw.io HTML label vocabulary into a ShimElement tree.
// Handles: <b>, <i>, <u>, <s>, <strike>, <strong>, <em>, <font>, <span>,
//          <p>, <div>, <br>, <br/>, text nodes, and HTML entities.
// Used by ShimElement.innerHTML setter so that richContent() and plainLabel()
// work correctly headlessly.

const NAMED_ENTITIES = {
  iexcl: '¡', cent: '¢', pound: '£', curren: '¤', yen: '¥',
  brvbar: '¦', sect: '§', uml: '¨', copy: '©', ordf: 'ª',
  laquo: '«', not: '¬', shy: '­', reg: '®', macr: '¯',
  deg: '°', plusmn: '±', sup2: '²', sup3: '³', acute: '´',
  micro: 'µ', para: '¶', middot: '·', cedil: '¸', sup1: '¹',
  ordm: 'º', raquo: '»', frac14: '¼', frac12: '½', frac34: '¾',
  iquest: '¿', times: '×', divide: '÷',
  Agrave:'À',Aacute:'Á',Acirc:'Â',Atilde:'Ã',Auml:'Ä',Aring:'Å',AElig:'Æ',
  Ccedil:'Ç',Egrave:'È',Eacute:'É',Ecirc:'Ê',Euml:'Ë',Igrave:'Ì',Iacute:'Í',
  Icirc:'Î',Iuml:'Ï',ETH:'Ð',Ntilde:'Ñ',Ograve:'Ò',Oacute:'Ó',Ocirc:'Ô',
  Otilde:'Õ',Ouml:'Ö',Oslash:'Ø',Ugrave:'Ù',Uacute:'Ú',Ucirc:'Û',Uuml:'Ü',
  Yacute:'Ý',THORN:'Þ',szlig:'ß',agrave:'à',aacute:'á',acirc:'â',atilde:'ã',
  auml:'ä',aring:'å',aelig:'æ',ccedil:'ç',egrave:'è',eacute:'é',ecirc:'ê',
  euml:'ë',igrave:'ì',iacute:'í',icirc:'î',iuml:'ï',eth:'ð',ntilde:'ñ',
  ograve:'ò',oacute:'ó',ocirc:'ô',otilde:'õ',ouml:'ö',oslash:'ø',ugrave:'ù',
  uacute:'ú',ucirc:'û',uuml:'ü',yacute:'ý',thorn:'þ',yuml:'ÿ',
  ndash:'–',mdash:'—',lsquo:'‘',rsquo:'’',sbquo:'‚',ldquo:'“',rdquo:'”',
  bdquo:'„',dagger:'†',Dagger:'‡',bull:'•',hellip:'…',permil:'‰',
  prime:'′',Prime:'″',lsaquo:'‹',rsaquo:'›',oline:'‾',frasl:'⁄',euro:'€',
  trade:'™',larr:'←',uarr:'↑',rarr:'→',darr:'↓',harr:'↔',minus:'−',
  infin:'∞',ne:'≠',le:'≤',ge:'≥',radic:'√',sum:'∑',part:'∂',
  alpha:'α',beta:'β',gamma:'γ',delta:'δ',mu:'μ',pi:'π',sigma:'σ',
  omega:'ω',Delta:'Δ',Sigma:'Σ',Omega:'Ω'
};

function decodeHtmlEntities(s) {
  // &amp; must decode LAST (decoding it first double-decoded "&amp;lt;" to
  // "<" instead of the literal "&lt;"); numeric references need fromCodePoint
  // (fromCharCode corrupts astral code points like emoji to surrogate
  // garbage). &nbsp; stays U+00A0 (browser innerHTML semantics).
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, name) =>
      Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : m)
    .replace(/&amp;/g, '&');
}

function parseHtmlAttrs(str) {
  const attrs = {};
  const re = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([\S]*))/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    attrs[m[1].toLowerCase()] = decodeHtmlEntities(m[2] != null ? m[2] : m[3] != null ? m[3] : m[4] || '');
  }
  return attrs;
}

function parseHtmlFrag(html, doc) {
  if (!html) return [];
  const nodes = [];
  const stack = [{ children: nodes }]; // stack of {children, el}

  const re = /(<\/?([\w]+)(\s[^>]*)?\s*\/?>|<!--[\s\S]*?-->)/g;
  let lastIdx = 0;
  let m;

  while ((m = re.exec(html)) !== null) {
    // Text before this tag
    if (m.index > lastIdx) {
      const text = decodeHtmlEntities(html.slice(lastIdx, m.index));
      if (text) {
        const tn = doc ? doc.createTextNode(text) : new ShimTextNode(text);
        stack[stack.length - 1].children.push(tn);
      }
    }
    lastIdx = m.index + m[0].length;

    const full = m[1];
    if (full.startsWith('<!--')) { continue; } // skip comments

    const closing = full[1] === '/';
    const tagName = (m[2] || '').toLowerCase();
    const attrsStr = m[3] || '';
    // HTML void elements never have children and never need a closing tag.
    // Without this, a void tag (e.g. <hr>, <img>) would be pushed onto the
    // open-tag stack and swallow all following siblings as its "children"
    // (e.g. <p>A</p><hr><p>B</p> would lose <p>B</p>).
    const VOID = { area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1,
      input: 1, link: 1, meta: 1, param: 1, source: 1, track: 1, wbr: 1 };
    const selfClose = full.endsWith('/>') || VOID[tagName] === 1;

    if (closing) {
      // Pop stack back to matching open tag
      for (let k = stack.length - 1; k >= 1; k--) {
        if (stack[k].tag === tagName) {
          stack.length = k;
          break;
        }
      }
      continue;
    }

    // Create element
    const el = doc
      ? doc.createElement(tagName)
      : new ShimElement(SVG_NS, tagName, null);
    const attrs = parseHtmlAttrs(attrsStr);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'style') {
        el.setAttribute('style', v);
        if (el._style) el._style.cssText = v;
      } else {
        el.setAttribute(k, v);
      }
    }

    stack[stack.length - 1].children.push(el);
    if (!selfClose) {
      stack.push({ tag: tagName, children: el.childNodes, el });
    }
  }

  // Trailing text
  if (lastIdx < html.length) {
    const text = decodeHtmlEntities(html.slice(lastIdx));
    if (text) {
      const tn = doc ? doc.createTextNode(text) : new ShimTextNode(text);
      stack[stack.length - 1].children.push(tn);
    }
  }

  return nodes;
}

// ── getComputedStyle shim ───────────────────────────────────────────────────
// Returns inline style + semantic-tag overrides. Covers the draw.io label
// vocabulary used by richContent() (bold, italic, underline, strikethrough,
// font-size, color, background-color, font-family).
function shimGetComputedStyle(el) {
  if (!el || el.nodeType !== 1) return { getPropertyValue: () => '' };
  const props = {};
  const styleVal = (el.getAttribute && el.getAttribute('style')) || '';
  for (const part of styleVal.split(';')) {
    const col = part.indexOf(':');
    if (col < 0) continue;
    props[part.slice(0, col).trim().toLowerCase()] = part.slice(col + 1).trim();
  }
  const tag = (el.tagName || '').toLowerCase();
  if ((tag === 'b' || tag === 'strong') && !props['font-weight']) props['font-weight'] = 'bold';
  if ((tag === 'i' || tag === 'em') && !props['font-style']) props['font-style'] = 'italic';
  if (tag === 'u' && !props['text-decoration']) props['text-decoration'] = 'underline';
  if ((tag === 's' || tag === 'strike') && !props['text-decoration']) props['text-decoration'] = 'line-through';
  // <font color="..."> / <font face="...">
  const color = el.getAttribute && el.getAttribute('color');
  if (color && !props['color']) props['color'] = color;
  const face = el.getAttribute && el.getAttribute('face');
  if (face && !props['font-family']) props['font-family'] = face;
  return { getPropertyValue: (k) => props[k] || '', ...props };
}

// Identity 2×3 matrix (same shape as SVGMatrix).
function identityMatrix() {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

class ShimStyle {
  constructor() { this._map = {}; }
  setProperty(name, value)  { this._map[name] = value || ''; }
  getPropertyValue(name)    { return this._map[name] || ''; }
  removeProperty(name)      { delete this._map[name]; }
  get cssText() {
    return Object.entries(this._map).map(([k, v]) => `${k}:${v}`).join(';');
  }
  set cssText(s) {
    this._map = {};
    for (const part of String(s).split(';')) {
      const eq = part.indexOf(':');
      if (eq < 0) continue;
      const k = part.slice(0, eq).trim();
      const v = part.slice(eq + 1).trim();
      if (k) this._map[k] = v;
    }
  }
}

// Proxy so that `el.style.fill = 'red'` works as `setProperty('fill','red')`.
function makeStyleProxy(shimStyle) {
  return new Proxy(shimStyle, {
    get(t, p) {
      if (p in t || typeof p === 'symbol') return typeof t[p] === 'function' ? t[p].bind(t) : t[p];
      return t.getPropertyValue(String(p));
    },
    set(t, p, v) {
      if (p === 'cssText') { t.cssText = v; return true; }
      t.setProperty(String(p), v == null ? '' : String(v));
      return true;
    }
  });
}

export class ShimElement {
  constructor(ns, tag, ownerDoc) {
    this.nodeType       = 1;
    this.namespaceURI   = ns || SVG_NS;
    this.tagName        = tag;
    this.localName      = tag.includes(':') ? tag.split(':')[1] : tag;
    this.childNodes     = [];
    this.parentNode     = null;
    this.ownerDocument  = ownerDoc || null;
    this.ownerSVGElement = null;
    this._attrs         = {};
    this._style         = new ShimStyle();
    this.style          = makeStyleProxy(this._style);
  }

  get firstChild()  { return this.childNodes[0] || null; }
  get lastChild()   { return this.childNodes[this.childNodes.length - 1] || null; }
  get children()    { return this.childNodes.filter((n) => n.nodeType === 1); }

  getAttribute(name)            { return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null; }
  setAttribute(name, value)     { this._attrs[name] = String(value == null ? '' : value); }
  hasAttribute(name)            { return Object.prototype.hasOwnProperty.call(this._attrs, name); }
  removeAttribute(name)         { delete this._attrs[name]; }
  setAttributeNS(_ns, name, v)  { this.setAttribute(name, v); }
  getAttributeNS(_ns, name)     { return this.getAttribute(name); }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) { this.childNodes.splice(i, 1); child.parentNode = null; }
    return child;
  }
  insertBefore(newChild, ref) {
    if (!ref) return this.appendChild(newChild);
    const i = this.childNodes.indexOf(ref);
    if (i < 0) return this.appendChild(newChild);
    if (newChild.parentNode) newChild.parentNode.removeChild(newChild);
    newChild.parentNode = this;
    this.childNodes.splice(i, 0, newChild);
    return newChild;
  }
  replaceChild(newChild, old) {
    const i = this.childNodes.indexOf(old);
    if (i < 0) throw new Error('not a child');
    if (newChild.parentNode) newChild.parentNode.removeChild(newChild);
    old.parentNode = null;
    newChild.parentNode = this;
    this.childNodes[i] = newChild;
    return old;
  }
  cloneNode(deep) {
    const copy = new ShimElement(this.namespaceURI, this.tagName, this.ownerDocument);
    copy._attrs = Object.assign({}, this._attrs);
    copy._style.cssText = this._style.cssText;
    copy.style = makeStyleProxy(copy._style);
    if (deep) {
      for (const c of this.childNodes) {
        copy.appendChild(c.cloneNode(true));
      }
    }
    return copy;
  }

  // SVG DOM stubs — return safe no-ops so the exporter gracefully falls back.
  getCTM()       { return identityMatrix(); }
  getScreenCTM() { return identityMatrix(); }
  getBBox()      { return { x: 0, y: 0, width: 0, height: 0 }; }
  // getElementById needs to walk the tree from ownerDocument
  getElementById(id) {
    return this.ownerDocument ? this.ownerDocument.getElementById(id) : null;
  }

  get id()      { return this.getAttribute('id') || ''; }
  set id(v)     { this.setAttribute('id', v); }
  get className() { return this.getAttribute('class') || ''; }
  set className(v){ this.setAttribute('class', v); }

  get textContent() {
    return this.childNodes.map((n) =>
      n.nodeType === 3 ? n.nodeValue : (n.textContent || '')
    ).join('');
  }
  set textContent(v) {
    this.childNodes = [];
    if (v != null && v !== '') {
      const t = new ShimTextNode(String(v));
      t.parentNode = this;
      this.childNodes.push(t);
    }
  }

  get innerHTML() { return serializeChildren(this); }
  set innerHTML(html) {
    this.childNodes = [];
    const doc = this.ownerDocument || globalThis.document;
    for (const child of parseHtmlFrag(html, doc)) {
      child.parentNode = this;
      this.childNodes.push(child);
    }
  }

  get outerHTML() { return serializeElement(this); }
}

export class ShimTextNode {
  constructor(data) {
    this.nodeType   = 3;
    this.nodeValue  = String(data == null ? '' : data);
    this.data       = this.nodeValue;
    this.parentNode = null;
    this.childNodes = [];
  }
  cloneNode() {
    const t = new ShimTextNode(this.nodeValue);
    return t;
  }
}

// --- serialization ---

function escapeAttr(v) {
  return String(v)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeText(v) {
  return String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function serializeElement(el) {
  const tag = el.tagName;
  let s = `<${tag}`;
  // Inline style first (matches browser serialization order for our usage)
  const css = el._style.cssText;
  if (css) s += ` style="${escapeAttr(css)}"`;
  for (const [k, v] of Object.entries(el._attrs)) {
    s += ` ${k}="${escapeAttr(v)}"`;
  }
  if (el.childNodes.length === 0) {
    s += '/>';
  } else {
    s += '>' + serializeChildren(el) + `</${tag}>`;
  }
  return s;
}

function serializeChildren(el) {
  return el.childNodes.map((n) => {
    if (n.nodeType === 1) return serializeElement(n);
    if (n.nodeType === 3) return escapeText(n.nodeValue);
    return '';
  }).join('');
}

export class ShimXMLSerializer {
  serializeToString(node) {
    if (!node) return '';
    if (node.nodeType === 1) return serializeElement(node);
    if (node.nodeType === 3) return escapeText(node.nodeValue);
    return '';
  }
}

// --- document factory ---

export class ShimDocument {
  constructor() {
    this._byId = {};
  }

  createElement(tag) {
    return this.createElementNS(null, tag);
  }
  createElementNS(ns, tag) {
    const el = new ShimElement(ns || SVG_NS, tag, this);
    return el;
  }
  createTextNode(data) {
    const t = new ShimTextNode(data);
    return t;
  }
  createComment()   { return new ShimTextNode(''); }

  getElementById(id) {
    return this._index(this._root, id);
  }
  _index(node, id) {
    if (!node || node.nodeType !== 1) return null;
    if (node.getAttribute && node.getAttribute('id') === id) return node;
    for (const c of node.childNodes) {
      const r = this._index(c, id);
      if (r) return r;
    }
    return null;
  }

  set _root(v) { this.__root = v; }
  get _root()   { return this.__root || null; }
}

// Returns a partial `globalThis`-compatible env that the exporter's
// `root.document.*` and `root.XMLSerializer` calls can use.
export function createSvgEnv() {
  const doc = new ShimDocument();
  return {
    document:         doc,
    XMLSerializer:    ShimXMLSerializer,
    getComputedStyle: shimGetComputedStyle,
  };
}
