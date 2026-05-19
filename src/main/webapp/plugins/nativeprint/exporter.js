/**
 * Native Print exporter: the "bake" (host integration spec section 5).
 *
 * Runs in the drawio renderer where the computed graph view state exists, and
 * serializes the current diagram to a v1.1-schema-valid contract. The engine
 * never sees diagram/editor concepts, only this finished contract.
 */
(function (root) {
  'use strict';

  function number(v, fallback) {
    var n = parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function boolish(v) {
    return v === true || v === 1 || v === '1' || v === 'true';
  }

  function clamp01(v) {
    return Math.max(0, Math.min(1, v));
  }

  function opacity(style, key) {
    var raw = style && style[key] != null ? style[key] : style && style.opacity;
    return raw == null ? 1 : clamp01(number(raw, 100) / 100);
  }

  function isPaintable(c) {
    return c && c !== 'none' && c !== 'transparent' &&
      /^#?(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(c);
  }

  // STRICT WYSIWYG (project rule, no exceptions): the bake must resolve every
  // theme-dependent color to the side the editor is CURRENTLY rendering, not a
  // forced light side. drawio's defaultVertex / label styles resolve to CSS
  // `light-dark(<light>, <dark>)` (verified live, e.g.
  // `light-dark(#ffffff, var(--ge-dark-color,#121212))`); older builds leave
  // the literal sentinel "default". isPaintable() rejects both, so without
  // normalization a themed cell bakes with null paint and prints invisibly.
  // We pick the active side via Editor.isDarkMode() (drawio's authoritative
  // flag), unwrap `var(--x, #hex)` to its hex fallback, and resolve "default"
  // to the themed shapeBackground/shapeForeground. hex / `none` /
  // `transparent` are passed through untouched (genuinely unpainted cells —
  // text/group — stay unpainted; never invent paint).
  function isDark() {
    try {
      return !!(root.Editor && typeof root.Editor.isDarkMode === 'function' &&
        root.Editor.isDarkMode());
    } catch (e) { return false; }
  }

  // Resolve a possibly-themed CSS color to a concrete value for the ACTIVE
  // theme. `light-dark(L,D)` -> L or D; `var(--x, fb)` -> fb; else unchanged.
  function themeColor(cssColor, fallback) {
    if (typeof cssColor !== 'string' || cssColor === '') return fallback;
    var c = cssColor.trim();
    var ld = /^light-dark\(\s*([^,]+?)\s*,\s*(.+)\s*\)\s*$/i.exec(c);
    if (ld) c = (isDark() ? ld[2] : ld[1]).trim();
    var v = /^var\(\s*--[^,]+,\s*(.+?)\s*\)\s*$/i.exec(c);
    if (v) c = v[1].trim();
    return c || fallback;
  }

  function resolveThemeDefaults(style, graph) {
    if (!style) return style;
    var bg = themeColor(graph && graph.shapeBackgroundColor,
      isDark() ? '#121212' : '#ffffff');
    var fg = themeColor(graph && graph.shapeForegroundColor,
      isDark() ? '#ffffff' : '#000000');
    var out = style, cloned = false;
    var set = function (k, v) {
      if (out[k] === v) return;
      if (!cloned) { out = Object.assign({}, style); cloned = true; }
      out[k] = v;
    };
    // labelBackgroundColor/labelBorderColor are theme colors too
    // (Graph.colorStyles): "default" -> background / foreground respectively.
    [['fillColor', 0], ['gradientColor', 0], ['strokeColor', 1],
     ['fontColor', 1], ['labelBackgroundColor', 0], ['labelBorderColor', 1]]
      .forEach(function (pair) {
        var k = pair[0], v = style[k];
        if (typeof v !== 'string') return;
        var def = pair[1] === 0 ? bg : fg;
        var r = v;
        // Pick the active theme side first; the chosen side can itself be the
        // "default" sentinel (e.g. light-dark(default, #ad1414)) -> resolve
        // that to the themed bg/fg afterwards.
        if (/^\s*light-dark\(/i.test(r) || /^\s*var\(/i.test(r)) {
          r = themeColor(r, def);
        }
        if (r === 'default') { r = def; }
        if (r !== v) { set(k, r); }
      });
    return out;
  }

  // drawio draws a label background (and optional border) box behind the text,
  // ABOVE the shape. The bake never emitted it -> labelled text printed with
  // no box. Colors here are already theme-resolved by resolveThemeDefaults
  // (WYSIWYG). Accepts drawio's 8-digit #rrggbbaa label-bg alpha form too.
  // Box == the label box passed to textNode: exact for fixed/wrapped text
  // cells (the reported case); autosize/offset labels are a known follow-up
  // (would need sink-side measured-bg, like text position already is).
  function colorToSolid(c) {
    if (typeof c !== 'string') return null;
    var s = c.trim();
    var m8 = /^#?([0-9a-fA-F]{6})([0-9a-fA-F]{2})$/.exec(s);
    if (m8) return solid('#' + m8[1], parseInt(m8[2], 16) / 255);
    return isPaintable(s) ? solid(s, 1) : null;
  }

  function labelBoxNode(style, box) {
    var bg = colorToSolid(style.labelBackgroundColor);
    var bc = isPaintable(style.labelBorderColor) ? style.labelBorderColor : null;
    if (!bg && !bc) return null;
    return {
      kind: 'path',
      d: rectPath(box.x, box.y, box.w, box.h),
      fill: bg,
      stroke: bc ? {
        paint: solid(bc, 1),
        width: Math.max(0.1, number(style.labelBorderWidth, 1)),
        cap: 'butt', join: 'miter', miterLimit: 10, dash: null
      } : null
    };
  }

  function hex(c) {
    if (!c) return '#000000';
    c = String(c);
    if (c.charAt(0) !== '#') c = '#' + c;
    if (c.length === 4) {
      c = '#' + c.charAt(1) + c.charAt(1) + c.charAt(2) + c.charAt(2) +
        c.charAt(3) + c.charAt(3);
    }
    return c.toLowerCase();
  }

  function solid(color, alpha) {
    return { type: 'solid', color: hex(color), alpha: alpha == null ? 1 : alpha };
  }

  function fillOf(style) {
    if (!isPaintable(style.fillColor)) return null;
    if (isPaintable(style.gradientColor)) {
      return {
        type: 'linear',
        stops: [
          { offset: 0, color: hex(style.fillColor), alpha: opacity(style, 'fillOpacity') },
          { offset: 1, color: hex(style.gradientColor), alpha: opacity(style, 'fillOpacity') }
        ]
      };
    }
    return solid(style.fillColor, opacity(style, 'fillOpacity'));
  }

  function strokeOf(style) {
    if (!isPaintable(style.strokeColor)) return null;
    return {
      paint: solid(style.strokeColor, opacity(style, 'strokeOpacity')),
      width: Math.max(0.1, number(style.strokeWidth, 1)),
      cap: style.lineCap === 'round' ? 'round' : style.lineCap === 'square' ? 'square' : 'butt',
      join: style.lineJoin === 'round' || boolish(style.rounded) ? 'round' :
        style.lineJoin === 'bevel' ? 'bevel' : 'miter',
      miterLimit: Math.max(0.1, number(style.miterLimit, 10)),
      dash: boolish(style.dashed) ? dashPattern(style) : null
    };
  }

  function dashPattern(style) {
    var raw = style.dashPattern || '3 3';
    var out = String(raw).split(/[ ,]+/).map(function (v) {
      return number(v, 0);
    }).filter(function (v) { return v > 0; });
    return out.length ? out : [3, 3];
  }

  function fmt(n) {
    var rounded = Math.round(n * 1000) / 1000;
    return String(Object.is(rounded, -0) ? 0 : rounded);
  }

  function p(x, y) {
    return fmt(x) + ' ' + fmt(y);
  }

  function rectPath(x, y, w, h) {
    return 'M ' + p(x, y) + ' L ' + p(x + w, y) + ' L ' +
      p(x + w, y + h) + ' L ' + p(x, y + h) + ' Z';
  }

  function roundedRectPath(x, y, w, h, r) {
    r = Math.min(Math.max(0, r), w / 2, h / 2);
    if (r <= 0) return rectPath(x, y, w, h);
    return 'M ' + p(x + r, y) + ' L ' + p(x + w - r, y) +
      ' A ' + fmt(r) + ' ' + fmt(r) + ' 0 0 1 ' + p(x + w, y + r) +
      ' L ' + p(x + w, y + h - r) +
      ' A ' + fmt(r) + ' ' + fmt(r) + ' 0 0 1 ' + p(x + w - r, y + h) +
      ' L ' + p(x + r, y + h) +
      ' A ' + fmt(r) + ' ' + fmt(r) + ' 0 0 1 ' + p(x, y + h - r) +
      ' L ' + p(x, y + r) +
      ' A ' + fmt(r) + ' ' + fmt(r) + ' 0 0 1 ' + p(x + r, y) + ' Z';
  }

  function ellipsePath(x, y, w, h) {
    var rx = w / 2, ry = h / 2, cx = x + rx, cy = y + ry;
    return 'M ' + p(cx - rx, cy) +
      ' A ' + fmt(rx) + ' ' + fmt(ry) + ' 0 1 0 ' + p(cx + rx, cy) +
      ' A ' + fmt(rx) + ' ' + fmt(ry) + ' 0 1 0 ' + p(cx - rx, cy) + ' Z';
  }

  function rhombusPath(x, y, w, h) {
    return 'M ' + p(x + w / 2, y) + ' L ' + p(x + w, y + h / 2) +
      ' L ' + p(x + w / 2, y + h) + ' L ' + p(x, y + h / 2) + ' Z';
  }

  function trianglePath(x, y, w, h, dir) {
    if (dir === 'south') return 'M ' + p(x, y) + ' L ' + p(x + w, y) +
      ' L ' + p(x + w / 2, y + h) + ' Z';
    if (dir === 'east') return 'M ' + p(x, y) + ' L ' + p(x + w, y + h / 2) +
      ' L ' + p(x, y + h) + ' Z';
    if (dir === 'west') return 'M ' + p(x + w, y) + ' L ' + p(x, y + h / 2) +
      ' L ' + p(x + w, y + h) + ' Z';
    return 'M ' + p(x + w / 2, y) + ' L ' + p(x + w, y + h) +
      ' L ' + p(x, y + h) + ' Z';
  }

  function cylinderPath(x, y, w, h) {
    var e = Math.min(h * 0.18, w * 0.28);
    var k = 0.5522847498;
    return 'M ' + p(x, y + e) +
      ' C ' + p(x, y + e - e * k) + ' ' + p(x + w, y + e - e * k) + ' ' + p(x + w, y + e) +
      ' L ' + p(x + w, y + h - e) +
      ' C ' + p(x + w, y + h + e * k - e) + ' ' + p(x, y + h + e * k - e) + ' ' + p(x, y + h - e) +
      ' Z M ' + p(x, y + e) +
      ' C ' + p(x, y + e + e * k) + ' ' + p(x + w, y + e + e * k) + ' ' + p(x + w, y + e);
  }

  function cloudPath(x, y, w, h) {
    return 'M ' + p(x + w * 0.25, y + h * 0.75) +
      ' C ' + p(x - w * 0.05, y + h * 0.72) + ' ' + p(x, y + h * 0.35) + ' ' + p(x + w * 0.25, y + h * 0.38) +
      ' C ' + p(x + w * 0.28, y + h * 0.08) + ' ' + p(x + w * 0.62, y + h * 0.08) + ' ' + p(x + w * 0.65, y + h * 0.36) +
      ' C ' + p(x + w * 0.95, y + h * 0.28) + ' ' + p(x + w * 1.07, y + h * 0.68) + ' ' + p(x + w * 0.78, y + h * 0.75) +
      ' C ' + p(x + w * 0.66, y + h * 0.95) + ' ' + p(x + w * 0.38, y + h * 0.95) + ' ' + p(x + w * 0.25, y + h * 0.75) + ' Z';
  }

  function shapePath(style, x, y, w, h) {
    var shape = style.shape || 'rectangle';
    if (shape === 'ellipse') return ellipsePath(x, y, w, h);
    if (shape === 'rhombus' || shape === 'diamond') return rhombusPath(x, y, w, h);
    if (shape === 'triangle') return trianglePath(x, y, w, h, style.direction);
    if (shape === 'cylinder') return cylinderPath(x, y, w, h);
    if (shape === 'cloud') return cloudPath(x, y, w, h);
    if (shape === 'rectangle' || shape === 'label' || !shape) {
      return boolish(style.rounded)
        ? roundedRectPath(x, y, w, h, Math.min(w, h) * 0.12)
        : rectPath(x, y, w, h);
    }
    return null;
  }

  function edgePath(points, rounded) {
    if (!rounded || points.length < 3) {
      var d = 'M ' + p(points[0].x, points[0].y);
      for (var i = 1; i < points.length; i++) d += ' L ' + p(points[i].x, points[i].y);
      return d;
    }
    var radius = 8;
    var out = 'M ' + p(points[0].x, points[0].y);
    for (var j = 1; j < points.length - 1; j++) {
      var prev = points[j - 1], cur = points[j], next = points[j + 1];
      var a1 = cornerPoint(cur, prev, radius);
      var a2 = cornerPoint(cur, next, radius);
      out += ' L ' + p(a1.x, a1.y) + ' C ' + p(cur.x, cur.y) + ' ' +
        p(cur.x, cur.y) + ' ' + p(a2.x, a2.y);
    }
    var last = points[points.length - 1];
    return out + ' L ' + p(last.x, last.y);
  }

  function cornerPoint(cur, toward, radius) {
    var dx = toward.x - cur.x, dy = toward.y - cur.y;
    var len = Math.max(0.001, Math.sqrt(dx * dx + dy * dy));
    var r = Math.min(radius, len / 2);
    return { x: cur.x + dx / len * r, y: cur.y + dy / len * r };
  }

  function arrowPath(from, to, size) {
    var dx = to.x - from.x, dy = to.y - from.y;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len <= 0.001) return null;
    var ux = dx / len, uy = dy / len;
    var px = -uy, py = ux;
    var base = { x: to.x - ux * size, y: to.y - uy * size };
    return 'M ' + p(to.x, to.y) + ' L ' +
      p(base.x + px * size * 0.45, base.y + py * size * 0.45) + ' L ' +
      p(base.x - px * size * 0.45, base.y - py * size * 0.45) + ' Z';
  }

  function alignH(a) {
    return a === 'center' || a === 'right' ? a : 'left';
  }

  function alignV(a) {
    if (a === 'middle') return 'middle';
    if (a === 'bottom') return 'bottom';
    return 'top';
  }



  function rgbToHex(color) {
    if (typeof color !== 'string') return null;
    var v = color.trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(v)) return v;
    var m = /^rgba?\(([^)]+)\)$/.exec(v);
    if (!m) return null;
    var parts = m[1].split(',').map(function (x) { return x.trim(); });
    if (parts.length < 3) return null;
    var r = Math.max(0, Math.min(255, parseInt(parts[0], 10) || 0));
    var g = Math.max(0, Math.min(255, parseInt(parts[1], 10) || 0));
    var b = Math.max(0, Math.min(255, parseInt(parts[2], 10) || 0));
    return '#' + [r, g, b].map(function (n) { return n.toString(16).padStart(2, '0'); }).join('');
  }

  function resolveRichContentRoot(state) {
    var wrapper = state && state.text && state.text.node ? state.text.node : null;
    if (!wrapper || !wrapper.childNodes) return null;
    var node = wrapper;
    // Walk through common single-child wrappers produced by mxText/layout.
    while (node && node.childNodes && node.childNodes.length === 1 && node.firstChild && node.firstChild.nodeType === 1) {
      node = node.firstChild;
    }
    if (node && node.nodeType === 1 && node !== wrapper) return node;
    // Fallback: first element descendant under wrapper.
    for (var i = 0; i < wrapper.childNodes.length; i++) {
      if (wrapper.childNodes[i] && wrapper.childNodes[i].nodeType === 1) return wrapper.childNodes[i];
    }
    return null;
  }


  function mergeAdjacentRichRuns(paragraphs) {
    for (var p = 0; p < paragraphs.length; p++) {
      var runs = paragraphs[p].runs || [];
      if (runs.length < 2) continue;
      var merged = [runs[0]];
      for (var i = 1; i < runs.length; i++) {
        var prev = merged[merged.length - 1];
        var cur = runs[i];
        var sameStyle = prev.fontFamily === cur.fontFamily &&
          prev.sizePx === cur.sizePx &&
          prev.weight === cur.weight &&
          prev.italic === cur.italic &&
          prev.underline === cur.underline &&
          prev.strikethrough === cur.strikethrough &&
          prev.color === cur.color;
        if (sameStyle) prev.text += cur.text;
        else merged.push(cur);
      }
      paragraphs[p].runs = merged;
    }
  }


  function richTextEnabled(graph) {
    var opts = graph && graph.nativePrintOptions ? graph.nativePrintOptions : null;
    return !(opts && opts.richText === false);
  }

  function richContent(graph, cell, state, style, notices) {
    if (!richTextEnabled(graph)) return null;
    if (!graph || typeof graph.isHtmlLabel !== 'function' || !graph.isHtmlLabel(cell)) return null;
    var s = graph.getLabel(cell);
    if (s == null) return null;
    var doc = root.document;
    var host = null;
    var useFallback = false;
    var alphaNotice = false;
    host = resolveRichContentRoot(state);
    if (!host && doc && doc.createElement) {
      host = doc.createElement('div');
      host.innerHTML = String(s);
      useFallback = true;
      if (Array.isArray(notices)) notices.push(degradation('RichApproximate', 'rich text live DOM not available; using detached parser', cell.id));
    } else {
      return null;
    }
    var base = {
      family: style.fontFamily || 'Arial',
      sizePx: number(style.fontSize, 12) || 12,
      weight: ((parseInt(style.fontStyle || 0, 10) || 0) & 1) ? 700 : 400,
      italic: ((parseInt(style.fontStyle || 0, 10) || 0) & 2) !== 0,
      underline: ((parseInt(style.fontStyle || 0, 10) || 0) & 4) !== 0,
      strikethrough: ((parseInt(style.fontStyle || 0, 10) || 0) & 8) !== 0,
      color: isPaintable(style.fontColor) ? hex(style.fontColor) : '#000000'
    };
    var paras = [{ align: alignH(style.align), indentPx: 0, runs: [] }];
    function cur() { return paras[paras.length - 1]; }
    function addRun(txt, st) {
      if (txt == null || txt === '') return;
      cur().runs.push({
        text: String(txt), fontFamily: st.family, sizePx: st.sizePx, weight: st.weight,
        italic: !!st.italic, underline: !!st.underline, strikethrough: !!st.strikethrough, color: st.color
      });
    }
    function br() { paras.push({ align: cur().align, indentPx: cur().indentPx, runs: [] }); }
    function cssStyle(el, inherited) {
      if (!doc || typeof root.getComputedStyle !== 'function' || !el || el.nodeType !== 1) return inherited;
      var cs = root.getComputedStyle(el);
      if (!cs) return inherited;
      var next = Object.assign({}, inherited);
      var fam = (cs.fontFamily || '').split(',')[0].trim().replace(/^['"]|['"]$/g, '');
      if (fam) next.family = fam;
      var sz = parseFloat(cs.fontSize || '');
      if (Number.isFinite(sz) && sz > 0) next.sizePx = sz;
      var wt = parseInt(cs.fontWeight, 10);
      if (Number.isFinite(wt)) next.weight = wt >= 600 ? 700 : 400;
      next.italic = (cs.fontStyle || '').toLowerCase() === 'italic';
      var dec = (cs.textDecorationLine || cs.textDecoration || '').toLowerCase();
      next.underline = dec.indexOf('underline') >= 0;
      next.strikethrough = dec.indexOf('line-through') >= 0;
      var rgb = rgbToHex(cs.color || '');
      if (rgb) next.color = rgb;
      if (!alphaNotice && typeof cs.color === 'string' && cs.color.toLowerCase().indexOf('rgba(') === 0 && notices) {
        if (Array.isArray(notices)) notices.push(degradation('RichApproximate', 'rgba text color alpha dropped for rich text run', cell.id));
        alphaNotice = true;
      }
      return next;
    }
    function collapseText(text, ws) {
      if (ws && ws.indexOf('pre') === 0) return text;
      return text.replace(/[\t\n\r ]+/g, ' ');
    }
    function walk(node, st, blockAlign, whiteSpace) {
      if (node.nodeType === 3) { addRun(collapseText(node.nodeValue, whiteSpace), st); return; }
      if (node.nodeType !== 1) return;
      var tag = String(node.tagName || '').toLowerCase();
      if (tag === 'br') { br(); cur().align = blockAlign; return; }
      var ns = cssStyle(node, Object.assign({}, st));
      var ws = whiteSpace;
      if (doc && typeof root.getComputedStyle === 'function') {
        var cs = root.getComputedStyle(node);
        if (cs && cs.whiteSpace) ws = cs.whiteSpace.toLowerCase();
      }
      if (tag === 'b' || tag === 'strong') ns.weight = 700;
      if (tag === 'i' || tag === 'em') ns.italic = true;
      if (tag === 'u') ns.underline = true;
      if (tag === 's' || tag === 'strike' || tag === 'del') ns.strikethrough = true;
      if (tag === 'font') {
        if (node.getAttribute('face')) ns.family = node.getAttribute('face');
        if (node.getAttribute('size')) ns.sizePx = Math.max(1, parseFloat(node.getAttribute('size')) || ns.sizePx);
        if (node.getAttribute('color')) {
          var fc = rgbToHex(node.getAttribute('color')) || (isPaintable(node.getAttribute('color')) ? hex(node.getAttribute('color')) : null);
          if (fc) ns.color = fc;
        }
      }
      if (tag === 'p' || tag === 'div' || tag === 'li') {
        if (cur().runs.length > 0) br();
        var al = node.style && node.style.textAlign ? alignH(node.style.textAlign) : cur().align;
        cur().align = al;
        blockAlign = al;
      }
      if (tag === 'img' || tag === 'table' || tag === 'sub' || tag === 'sup') {
        if (Array.isArray(notices)) notices.push(degradation('RichUnsupported', 'unsupported rich-text tag <' + tag + '> flattened', cell.id));
      }
      for (var i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i], ns, blockAlign, ws);
      if ((tag === 'p' || tag === 'div') && node !== host && paras.length && cur().runs.length > 0) br();
    }
    var startWs = 'normal';
    if (!useFallback && doc && typeof root.getComputedStyle === 'function') {
      var hostCs = root.getComputedStyle(host);
      if (hostCs && hostCs.whiteSpace) startWs = hostCs.whiteSpace.toLowerCase();
    }
    for (var i = 0; i < host.childNodes.length; i++) walk(host.childNodes[i], base, paras[0].align, startWs);
    mergeAdjacentRichRuns(paras);
    if (paras.length > 1 && paras[paras.length - 1].runs.length === 0) paras.pop();
    if (paras.length === 0) paras = [{ align: alignH(style.align), indentPx: 0, runs: [] }];
    return { type: 'rich', paragraphs: paras };
  }

  function plainLabel(graph, cell) {
    var s = graph.getLabel(cell);
    if (s == null) return '';
    s = String(s);
    if (s.indexOf('<') >= 0) {
      s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
      var d = (root.document && root.document.createElement)
        ? root.document.createElement('div') : null;
      if (d) { d.innerHTML = s; s = d.textContent || d.innerText || ''; }
    }
    return s;
  }

  function textNode(graph, cell, state, style, box, label, notices) {
    var fs = number(style.fontSize, 12);
    // drawio fontStyle bitmask: 1=bold, 2=italic, 4=underline, 8=strikethrough.
    var fst = parseInt(style.fontStyle || 0, 10) || 0;
    return {
      kind: 'text',
      box: box,
      font: {
        family: style.fontFamily || 'Arial',
        sizePx: fs > 0 ? fs : 12,
        weight: (fst & 1) ? 700 : 400,
        italic: !!(fst & 2),
        underline: !!(fst & 4),
        strikethrough: !!(fst & 8),
        color: isPaintable(style.fontColor) ? hex(style.fontColor) : '#000000'
      },
      align: { h: alignH(style.align), v: alignV(style.verticalAlign) },
      content: richContent(graph, cell, state, style, notices) || { type: 'static', lines: String(label).split('\n') }
    };
  }

  function scaledBox(state, origin, scale) {
    return {
      x: (state.x - origin.x) / scale,
      y: (state.y - origin.y) / scale,
      w: Math.max(1, state.width / scale),
      h: Math.max(1, state.height / scale)
    };
  }

  function edgeLabelBox(state, style, origin, scale, label) {
    var fs = number(style.fontSize, 12);
    var width = Math.max(24, String(label).length * fs * 0.65);
    var height = Math.max(fs * 1.4, String(label).split('\n').length * fs * 1.25);
    var x = state.absoluteOffset && Number.isFinite(state.absoluteOffset.x)
      ? state.absoluteOffset.x : state.x + state.width / 2;
    var y = state.absoluteOffset && Number.isFinite(state.absoluteOffset.y)
      ? state.absoluteOffset.y : state.y + state.height / 2;
    return {
      x: (x - origin.x) / scale - width / 2,
      y: (y - origin.y) / scale - height / 2,
      w: width,
      h: height
    };
  }

  function degradation(kind, detail, cellId) {
    return { kind: kind, detail: { detail: detail, cellId: String(cellId || '') } };
  }

  // drawio image cells carry the picture in the `image=` style value, almost
  // always a data URI. The engine renders raster images natively but ONLY
  // accepts PNG (it loud-rejects other formats). So: embed PNG faithfully;
  // for anything we cannot embed, emit a SPECIFIC loud notice (never the
  // generic "unsupported shape", and never silent).
  function parseImage(src) {
    if (typeof src !== 'string' || src === '') return null;
    var m = /^data:image\/([a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(src);
    if (m) {
      var fmt = m[1].toLowerCase();
      var data = m[2].replace(/\s+/g, '');
      if (fmt === 'png') return { format: 'png', data: data };
      return { unsupportedFormat: fmt };       // jpeg/gif/bmp/svg+xml/...
    }
    if (/^data:image\//i.test(src)) return { unsupportedFormat: 'non-base64' };
    return { externalUrl: src };               // http(s)/relative URL
  }

  function isImageCell(style) {
    return style.shape === 'image' ||
      (typeof style.image === 'string' && style.image !== '');
  }

  function imageNode(style, box, parsed) {
    return {
      kind: 'image',
      box: box,
      format: 'png',
      data: parsed.data,
      aspect: String(style.imageAspect) === '0' ? 'fill' : 'preserve',
      flipH: boolish(style.imageFlipH) || boolish(style.flipH),
      flipV: boolish(style.imageFlipV) || boolish(style.flipV)
    };
  }

  // `paper`, when supplied, is the SELECTED stock's size in px at 96/in
  // ({ wPx, hPx }). The contract page then equals the chosen paper so the
  // diagram prints 1:1 with the extra paper as whitespace (larger paper does
  // NOT scale the diagram up). The single tile == one physical sheet; content
  // beyond it is clipped by the engine, which raises a loud notice. When no
  // paper is given the legacy diagram-bounds page is kept (back-compat).
  function buildResult(graph, paper) {
    var model = graph.getModel();
    var view = graph.view;
    var paint = [];
    var notices = [];
    var scale = (view && view.scale) ? view.scale : 1;
    var bounds = graph.getGraphBounds();
    var origin = {
      x: bounds && bounds.width > 0 ? bounds.x : 0,
      y: bounds && bounds.height > 0 ? bounds.y : 0
    };
    var page = (paper && paper.wPx > 0 && paper.hPx > 0)
      ? { w: Math.max(1, Math.round(paper.wPx)),
          h: Math.max(1, Math.round(paper.hPx)) }
      : { w: Math.max(1, Math.ceil((bounds ? bounds.width : 1) / scale)),
          h: Math.max(1, Math.ceil((bounds ? bounds.height : 1) / scale)) };

    Object.keys(model.cells || {}).forEach(function (id) {
      var cell = model.cells[id];
      if (cell == null || (!model.isVertex(cell) && !model.isEdge(cell))) return;
      var state = view.getState(cell);
      if (state == null) return;
      var style = resolveThemeDefaults(
        graph.getCellStyle(cell) || state.style || {}, graph);

      if (model.isEdge(cell)) {
        emitEdge(graph, cell, state, style, origin, scale, paint, notices);
        return;
      }
      emitVertex(graph, cell, state, style, origin, scale, paint, notices);
    });

    return {
      contract: {
        schema: { major: 1, minor: 0 },
        document: {
          units: 'px',
          pages: [{
            id: 'page-1',
            size: { w: page.w, h: page.h },
            tiles: [{ origin: { x: 0, y: 0 }, size: { w: page.w, h: page.h } }],
            paint: paint
          }]
        }
      },
      notices: notices
    };
  }

  function emitVertex(graph, cell, state, style, origin, scale, paint, notices) {
    var box = scaledBox(state, origin, scale);
    var label = plainLabel(graph, cell);

    if (isImageCell(style)) {
      var img = parseImage(style.image);
      if (img && img.format === 'png') {
        paint.push(imageNode(style, box, img));        // faithful — WYSIWYG
      } else {
        // Cannot embed faithfully: loud, SPECIFIC notice + a placeholder box
        // so the operator sees exactly where/what is missing (never silent).
        var why = img && img.unsupportedFormat
          ? 'image format "' + img.unsupportedFormat +
            '" is not supported (engine renders PNG only)'
          : img && img.externalUrl
            ? 'external image URL is not embedded in the diagram'
            : 'image source is missing or unreadable';
        notices.push(degradation('ExporterUnsupportedImage',
          why + ' — placeholder box printed.', cell.id));
        paint.push({
          kind: 'path',
          d: rectPath(box.x, box.y, box.w, box.h),
          fill: null,
          stroke: strokeOf(style) || strokeOf({ strokeColor: '#000000', strokeWidth: 1 })
        });
      }
      if (label !== '') {
        var ilb = labelBoxNode(style, box);
        if (ilb) paint.push(ilb);
        paint.push(textNode(graph, cell, state, style, box, label, notices));
      }
      return;
    }

    var d = shapePath(style, box.x, box.y, box.w, box.h);
    if (!d) {
      d = rectPath(box.x, box.y, box.w, box.h);
      notices.push(degradation('ExporterUnsupportedShape',
        'Unsupported shape "' + style.shape + '" exported as bounding box.', cell.id));
    }
    paint.push({
      kind: 'path',
      d: d,
      fill: fillOf(style),
      stroke: strokeOf(style)
    });

    if (label !== '') {
      var vlb = labelBoxNode(style, box);
      if (vlb) paint.push(vlb);
      paint.push(textNode(graph, cell, state, style, box, label, notices));
    }
  }

  function emitEdge(graph, cell, state, style, origin, scale, paint, notices) {
    var raw = state.absolutePoints || [];
    var points = [];
    for (var i = 0; i < raw.length; i++) {
      if (raw[i]) points.push({ x: (raw[i].x - origin.x) / scale, y: (raw[i].y - origin.y) / scale });
    }
    if (points.length < 2) return;
    var stroke = strokeOf(style) || strokeOf({ strokeColor: '#000000', strokeWidth: 1 });
    paint.push({
      kind: 'path',
      d: edgePath(points, boolish(style.rounded)),
      fill: null,
      stroke: stroke
    });

    var arrowFill = stroke.paint || solid('#000000', 1);
    var arrowSize = Math.max(7, stroke.width * 5);
    if (style.endArrow && style.endArrow !== 'none') {
      var end = arrowPath(points[points.length - 2], points[points.length - 1], arrowSize);
      if (end) paint.push({ kind: 'path', d: end, fill: arrowFill, stroke: null });
    }
    if (style.startArrow && style.startArrow !== 'none') {
      var start = arrowPath(points[1], points[0], arrowSize);
      if (start) paint.push({ kind: 'path', d: start, fill: arrowFill, stroke: null });
    }

    var label = plainLabel(graph, cell);
    if (label !== '') {
      var elBox = edgeLabelBox(state, style, origin, scale, label);
      var elb = labelBoxNode(style, elBox);
      if (elb) paint.push(elb);
      paint.push(textNode(graph, cell, state, style, elBox, label, notices));
    }
  }

  function buildContract(graph) {
    return buildResult(graph).contract;
  }

  var api = { buildContract: buildContract, buildResult: buildResult };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.NativePrintExporter = api;
})(typeof window !== 'undefined' ? window : globalThis);
