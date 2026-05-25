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
    // Best-effort: clear children; real HTML parsing is not implemented.
    this.childNodes = [];
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
    document:      doc,
    XMLSerializer: ShimXMLSerializer,
  };
}
