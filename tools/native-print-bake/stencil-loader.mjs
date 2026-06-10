// Loads all draw.io stencil XML files and builds a registry Map<key, shapeNodeTree>
// Key format: shapes_element_name_attr.toLowerCase() + "." + shape_name.replace(/ /g,"_").toLowerCase()
// This matches mxStencilRegistry's parseStencilSet key derivation exactly.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Parse a minimal XML structure — returns a node: { name, attrs:{}, children:[] }
 * No external dependencies; pure regex/stack-based parser.
 */
function parseXml(xmlStr) {
  const tagRe = /<(\/)?([A-Za-z][\w:-]*)([^>]*?)(\/)?>/g;
  const attrRe = /([\w:-]+)=["']([^"']*)["']/g;
  function parseAttrs(s) {
    const a = {};
    let m;
    attrRe.lastIndex = 0;
    while ((m = attrRe.exec(s)) !== null) a[m[1]] = m[2];
    return a;
  }
  const root = { name: '#root', attrs: {}, children: [] };
  const stack = [root];
  let m;
  while ((m = tagRe.exec(xmlStr)) !== null) {
    const [, slash, name, attrStr, selfClose] = m;
    const top = stack[stack.length - 1];
    if (slash) {
      if (stack.length > 1) stack.pop();
    } else {
      const node = { name: name.toLowerCase(), attrs: parseAttrs(attrStr), children: [] };
      top.children.push(node);
      if (!selfClose) stack.push(node);
    }
  }
  return root.children[0] || null;
}

/**
 * Parse a single stencil XML file and add entries to the registry.
 * Root element is <shapes name="mxgraph.xxx"> containing <shape name="N"> children.
 */
function buildStencilMap(xmlStr, registry) {
  const doc = parseXml(xmlStr);
  if (!doc) return;
  // Root element should be <shapes name="...">
  const packageName = (doc.attrs.name || '').toLowerCase();
  if (!packageName) return;
  for (const child of doc.children) {
    if (child.name !== 'shape') continue;
    const shapeName = (child.attrs.name || '').replace(/ /g, '_').toLowerCase();
    if (!shapeName) continue;
    const key = packageName + '.' + shapeName;
    registry.set(key, child);
  }
}

async function walkDir(dir, registry) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    return; // Directory doesn't exist or can't be read; silently skip
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkDir(full, registry);
    } else if (entry.name.endsWith('.xml') && entry.name !== 'LICENSE') {
      try {
        const xml = await readFile(full, 'utf8');
        buildStencilMap(xml, registry);
      } catch (e) {
        // Silently skip unreadable files
      }
    }
  }
}

/**
 * Recursively load all stencil XML files from stencilDir.
 * Returns a Map<string, shapeNode> where shapeNode is the parsed <shape> element.
 */
async function loadStencils(stencilDir) {
  const registry = new Map();
  await walkDir(stencilDir, registry);
  return registry;
}

export { loadStencils, parseXml };
