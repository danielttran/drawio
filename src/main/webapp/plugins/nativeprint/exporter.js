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

  // ---------------------------------------------------------------------------
  // Universal shape harvesting — the "solve it once and for all".
  //
  // The exporter used to re-derive geometry for a hand-picked set of named
  // shapes; everything else (umlActor, hexagon, BPMN/AWS/Azure/mscae, custom
  // stencils, ...) fell back to a bounding box + ExporterUnsupportedShape.
  // That can never scale to drawio's stencil catalogue.
  //
  // But drawio/mxGraph has ALREADY rendered every shape — whatever its kind —
  // into the live SVG DOM at `state.shape.node`, as plain vector primitives
  // with on-screen-accurate (theme-resolved) paint. So instead of reinventing
  // each shape we transcribe the geometry drawio already computed: walk the
  // rendered primitives, bake every transform (pan/zoom/rotation/flip) into
  // absolute, scale-independent path coordinates, and resolve fill/stroke from
  // the live computed style. The result is byte-faithful WYSIWYG for ANY
  // shape. Runs only where a live SVG shape node exists (the drawio
  // renderer); the Node test harness has no DOM, so the named-shape/bbox path
  // below is used there and stays unchanged.

  function mMul(P, Q) {
    return {
      a: P.a * Q.a + P.c * Q.b, b: P.b * Q.a + P.d * Q.b,
      c: P.a * Q.c + P.c * Q.d, d: P.b * Q.c + P.d * Q.d,
      e: P.a * Q.e + P.c * Q.f + P.e, f: P.b * Q.e + P.d * Q.f + P.f
    };
  }

  function mInv(M) {
    var det = M.a * M.d - M.b * M.c;
    if (!det || !Number.isFinite(det)) return null;
    var ia = M.d / det, ib = -M.b / det, ic = -M.c / det, id = M.a / det;
    return { a: ia, b: ib, c: ic, d: id,
      e: -(ia * M.e + ic * M.f), f: -(ib * M.e + id * M.f) };
  }

  function mPt(M, x, y) {
    return { x: M.a * x + M.c * y + M.e, y: M.b * x + M.d * y + M.f };
  }

  function svgMat(m) {
    return m ? { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f } : null;
  }

  // Transform from an element's local space to the FINAL contract space.
  // inv(parentCTM) * elementCTM removes everything up to (and including) the
  // shape node's parent — leaving the shape node's own transform (rotation /
  // flip) plus any nested group transforms — which lands us in the same
  // absolute view-pixel space as state.x/y. The leading Norm then maps that
  // to origin-relative, scale-independent contract units (matching scaledBox).
  function harvestMatrix(el, shapeNode, origin, scale) {
    try {
      var parent = shapeNode.parentNode;
      if (!parent || typeof el.getCTM !== 'function' ||
        typeof parent.getCTM !== 'function') return null;
      var ec = svgMat(el.getCTM()), pc = svgMat(parent.getCTM());
      if (!ec || !pc) return null;
      var pinv = mInv(pc);
      if (!pinv) return null;
      var Norm = { a: 1 / scale, b: 0, c: 0, d: 1 / scale,
        e: -origin.x / scale, f: -origin.y / scale };
      return mMul(Norm, mMul(pinv, ec));
    } catch (e) { return null; }
  }

  function clampByte(v) {
    var s = String(v).trim();
    var n = s.indexOf('%') >= 0
      ? parseFloat(s) / 100 * 255 : parseFloat(s);
    return Math.max(0, Math.min(255, Math.round(Number.isFinite(n) ? n : 0)));
  }

  function toHex2(n) { return n.toString(16).padStart(2, '0'); }

  // CSS color (computed-style form) -> { hex, alpha } | { none:true } | null.
  // null means "not a color we can represent" (caller skips that paint).
  function colorParts(c) {
    if (typeof c !== 'string') return null;
    var s = c.trim().toLowerCase();
    if (s === '' || s === 'none' || s === 'transparent') return { none: true };
    if (/^#[0-9a-f]{3}$/.test(s)) return { hex: hex(s), alpha: 1 };
    if (/^#[0-9a-f]{6}$/.test(s)) return { hex: s, alpha: 1 };
    var m = /^rgba?\(([^)]+)\)$/.exec(s);
    if (m) {
      var pr = m[1].split(/[ ,/]+/).filter(function (x) { return x !== ''; });
      if (pr.length < 3) return null;
      var al = pr.length > 3 ? parseFloat(pr[3]) : 1;
      return {
        hex: '#' + toHex2(clampByte(pr[0])) + toHex2(clampByte(pr[1])) +
          toHex2(clampByte(pr[2])),
        alpha: clamp01(Number.isFinite(al) ? al : 1)
      };
    }
    return null;
  }

  function resolveGradient(ref, el) {
    try {
      var m = /url\(\s*["']?#([^"')]+)["']?\s*\)/i.exec(ref || '');
      if (!m) return null;
      var doc = (el.ownerSVGElement && el.ownerSVGElement.ownerDocument) ||
        root.document;
      var g = doc && doc.getElementById ? doc.getElementById(m[1]) : null;
      if (!g) return null;
      var tag = String(g.tagName || '').toLowerCase();
      var kids = g.getElementsByTagName('stop');
      var stops = [];
      for (var i = 0; i < kids.length; i++) {
        var st = kids[i];
        var cs = root.getComputedStyle ? root.getComputedStyle(st) : null;
        var off = st.getAttribute('offset') || '0';
        off = off.indexOf('%') >= 0 ? parseFloat(off) / 100 : parseFloat(off);
        var col = (cs && cs.stopColor) || st.getAttribute('stop-color') ||
          '#000000';
        var so = (cs && cs.stopOpacity != null && cs.stopOpacity !== '')
          ? cs.stopOpacity : st.getAttribute('stop-opacity');
        var cp = colorParts(col);
        if (!cp || cp.none) continue;
        stops.push({
          offset: clamp01(Number.isFinite(off) ? off : 0),
          color: cp.hex,
          alpha: clamp01((so == null ? 1 : parseFloat(so)) * cp.alpha)
        });
      }
      if (!stops.length) return null;
      return { type: tag.indexOf('radial') >= 0 ? 'radial' : 'linear',
        stops: stops };
    } catch (e) { return null; }
  }

  // Resolve the element's effective paint exactly as the screen shows it.
  // strokeWidth/dash are in scaled view px (mxSvgCanvas baked the zoom in);
  // divide by `scale` so the contract stays zoom-independent like the rest.
  function elementPaint(el, scale) {
    var cs = root.getComputedStyle ? root.getComputedStyle(el) : null;
    var get = function (prop, attr) {
      if (cs && cs[prop] != null && cs[prop] !== '') return cs[prop];
      var a = el.getAttribute(attr);
      return a == null ? '' : a;
    };
    var go = parseFloat(get('opacity', 'opacity'));
    if (!Number.isFinite(go)) go = 1;

    var fill = null;
    var fillRaw = get('fill', 'fill');
    if (fillRaw && /url\(/i.test(fillRaw)) {
      fill = resolveGradient(fillRaw, el);
    } else {
      var fp = colorParts(fillRaw === '' ? 'none' : fillRaw);
      if (fp && !fp.none) {
        var fo = parseFloat(get('fillOpacity', 'fill-opacity'));
        fill = solid(fp.hex,
          clamp01(fp.alpha * (Number.isFinite(fo) ? fo : 1) * go));
      }
    }

    var stroke = null;
    var sp = colorParts(get('stroke', 'stroke') || 'none');
    if (sp && !sp.none) {
      var so = parseFloat(get('strokeOpacity', 'stroke-opacity'));
      var sw = parseFloat(get('strokeWidth', 'stroke-width'));
      if (!Number.isFinite(sw) || sw <= 0) sw = 1;
      var lc = get('strokeLinecap', 'stroke-linecap') || 'butt';
      var lj = get('strokeLinejoin', 'stroke-linejoin') || 'miter';
      var ml = parseFloat(get('strokeMiterlimit', 'stroke-miterlimit'));
      if (!Number.isFinite(ml) || ml <= 0) ml = 10;
      var da = get('strokeDasharray', 'stroke-dasharray');
      var dash = null;
      if (da && da !== 'none') {
        dash = String(da).split(/[ ,]+/).map(function (v) {
          return number(v, 0) / scale;
        }).filter(function (v) { return v > 0; });
        if (!dash.length) dash = null;
      }
      stroke = {
        paint: solid(sp.hex,
          clamp01(sp.alpha * (Number.isFinite(so) ? so : 1) * go)),
        width: Math.max(0.1, sw / scale),
        cap: lc === 'round' ? 'round' : lc === 'square' ? 'square' : 'butt',
        join: lj === 'round' ? 'round' : lj === 'bevel' ? 'bevel' : 'miter',
        miterLimit: Math.max(0.1, ml),
        dash: dash
      };
    }
    return { fill: fill, stroke: stroke };
  }

  // Transform an SVG arc by an affine matrix: endpoints move by the full
  // matrix; the ellipse's radii/rotation are recomputed from the matrix's
  // linear part; the sweep flag flips under a reflection (negative det).
  function transformArc(M, rx, ry, phiDeg, large, sweep, x2, y2) {
    var P2 = mPt(M, x2, y2);
    if (!(rx > 0) || !(ry > 0)) return { lineTo: P2 };
    var phi = phiDeg * Math.PI / 180;
    var cp = Math.cos(phi), sp = Math.sin(phi);
    var E = { a: rx * cp, b: rx * sp, c: -ry * sp, d: ry * cp };
    var N = {
      a: M.a * E.a + M.c * E.b, b: M.b * E.a + M.d * E.b,
      c: M.a * E.c + M.c * E.d, d: M.b * E.c + M.d * E.d
    };
    var A = N.a * N.a + N.b * N.b;
    var B = N.a * N.c + N.b * N.d;
    var C = N.c * N.c + N.d * N.d;
    var disc = Math.sqrt(Math.max(0, (A - C) * (A - C) + 4 * B * B));
    var nrx = Math.sqrt(Math.max(0, (A + C + disc) / 2));
    var nry = Math.sqrt(Math.max(0, (A + C - disc) / 2));
    var nphi = 0.5 * Math.atan2(2 * B, A - C) * 180 / Math.PI;
    var det = M.a * M.d - M.b * M.c;
    return {
      arc: {
        rx: nrx, ry: nry, phi: nphi, large: large,
        sweep: det < 0 ? (sweep ? 0 : 1) : sweep, x: P2.x, y: P2.y
      }
    };
  }

  // Parse any SVG path data, normalize to absolute, bake `M` into every
  // coordinate, and emit only the absolute M/L/C/A/Z command set the engine
  // already accepts (Q/T -> cubic, H/V -> L, S/T smoothing expanded).
  function transformPath(d, M) {
    var re = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)/g;
    var t, toks = [];
    while ((t = re.exec(d))) {
      toks.push(t[1] !== undefined ? { c: t[1] } : { n: parseFloat(t[2]) });
    }
    if (!toks.length || toks[0].c === undefined) return null;
    var i = 0, out = [], cmd = null;
    var cx = 0, cy = 0, sx = 0, sy = 0, pcx = 0, pcy = 0, pType = '';
    var num = function () { return toks[i++].n; };
    var more = function () {
      return i < toks.length && toks[i].c === undefined;
    };
    var Pl = function (pt) {
      var q = mPt(M, pt.x, pt.y);
      return fmt(q.x) + ' ' + fmt(q.y);
    };
    var quadToCubic = function (p0, qc, p2) {
      return [
        { x: p0.x + 2 / 3 * (qc.x - p0.x), y: p0.y + 2 / 3 * (qc.y - p0.y) },
        { x: p2.x + 2 / 3 * (qc.x - p2.x), y: p2.y + 2 / 3 * (qc.y - p2.y) },
        p2
      ];
    };
    var emitC = function (a, b, c2) {
      out.push('C ' + Pl(a) + ' ' + Pl(b) + ' ' + Pl(c2));
    };
    while (i < toks.length) {
      if (toks[i].c !== undefined) { cmd = toks[i].c; i++; }
      if (cmd == null) return null;
      // A coordinate with no owning command (e.g. trailing numbers after Z)
      // is malformed and non-consuming -> would spin forever. Bail; the
      // caller falls back to the named-shape/bbox path.
      if (i < toks.length && toks[i].c === undefined &&
        cmd.toUpperCase() === 'Z') return null;
      var rel = cmd === cmd.toLowerCase();
      var K = cmd.toUpperCase();
      if (K === 'Z') { out.push('Z'); cx = sx; cy = sy; pType = ''; continue; }
      if (K === 'M') {
        var mx = num(), my = num();
        if (rel) { mx += cx; my += cy; }
        cx = mx; cy = my; sx = mx; sy = my; pType = '';
        out.push('M ' + Pl({ x: mx, y: my }));
        while (more()) {
          var ax = num(), ay = num();
          if (rel) { ax += cx; ay += cy; }
          cx = ax; cy = ay;
          out.push('L ' + Pl({ x: ax, y: ay }));
        }
        continue;
      }
      if (K === 'L') {
        do {
          var lx = num(), ly = num();
          if (rel) { lx += cx; ly += cy; }
          cx = lx; cy = ly;
          out.push('L ' + Pl({ x: lx, y: ly }));
        } while (more());
        pType = ''; continue;
      }
      if (K === 'H') {
        do {
          var hx = num();
          cx = rel ? cx + hx : hx;
          out.push('L ' + Pl({ x: cx, y: cy }));
        } while (more());
        pType = ''; continue;
      }
      if (K === 'V') {
        do {
          var vy = num();
          cy = rel ? cy + vy : vy;
          out.push('L ' + Pl({ x: cx, y: cy }));
        } while (more());
        pType = ''; continue;
      }
      if (K === 'C') {
        do {
          var c1 = { x: num(), y: num() }, c2 = { x: num(), y: num() },
            cp2 = { x: num(), y: num() };
          if (rel) {
            c1.x += cx; c1.y += cy; c2.x += cx; c2.y += cy;
            cp2.x += cx; cp2.y += cy;
          }
          emitC(c1, c2, cp2);
          pcx = c2.x; pcy = c2.y; pType = 'C'; cx = cp2.x; cy = cp2.y;
        } while (more());
        continue;
      }
      if (K === 'S') {
        do {
          var r1 = pType === 'C'
            ? { x: 2 * cx - pcx, y: 2 * cy - pcy } : { x: cx, y: cy };
          var s2 = { x: num(), y: num() }, sp2 = { x: num(), y: num() };
          if (rel) { s2.x += cx; s2.y += cy; sp2.x += cx; sp2.y += cy; }
          emitC(r1, s2, sp2);
          pcx = s2.x; pcy = s2.y; pType = 'C'; cx = sp2.x; cy = sp2.y;
        } while (more());
        continue;
      }
      if (K === 'Q') {
        do {
          var qc = { x: num(), y: num() }, qp2 = { x: num(), y: num() };
          if (rel) { qc.x += cx; qc.y += cy; qp2.x += cx; qp2.y += cy; }
          var cu = quadToCubic({ x: cx, y: cy }, qc, qp2);
          emitC(cu[0], cu[1], cu[2]);
          pcx = qc.x; pcy = qc.y; pType = 'Q'; cx = qp2.x; cy = qp2.y;
        } while (more());
        continue;
      }
      if (K === 'T') {
        do {
          var tq = pType === 'Q'
            ? { x: 2 * cx - pcx, y: 2 * cy - pcy } : { x: cx, y: cy };
          var tp2 = { x: num(), y: num() };
          if (rel) { tp2.x += cx; tp2.y += cy; }
          var cu2 = quadToCubic({ x: cx, y: cy }, tq, tp2);
          emitC(cu2[0], cu2[1], cu2[2]);
          pcx = tq.x; pcy = tq.y; pType = 'Q'; cx = tp2.x; cy = tp2.y;
        } while (more());
        continue;
      }
      if (K === 'A') {
        do {
          var grx = Math.abs(num()), gry = Math.abs(num()), gxr = num(),
            glf = num() ? 1 : 0, gsf = num() ? 1 : 0,
            gex = num(), gey = num();
          if (rel) { gex += cx; gey += cy; }
          var ar = transformArc(M, grx, gry, gxr, glf, gsf, gex, gey);
          if (ar.lineTo) {
            out.push('L ' + fmt(ar.lineTo.x) + ' ' + fmt(ar.lineTo.y));
          } else if (ar.arc.rx > 0 && ar.arc.ry > 0) {
            out.push('A ' + fmt(ar.arc.rx) + ' ' + fmt(ar.arc.ry) + ' ' +
              fmt(ar.arc.phi) + ' ' + ar.arc.large + ' ' + ar.arc.sweep +
              ' ' + fmt(ar.arc.x) + ' ' + fmt(ar.arc.y));
          } else {
            var qe = mPt(M, gex, gey);
            out.push('L ' + fmt(qe.x) + ' ' + fmt(qe.y));
          }
          cx = gex; cy = gey; pType = '';
        } while (more());
        continue;
      }
      return null;
    }
    var s = out.join(' ');
    return s.charAt(0) === 'M' ? s : null;
  }

  function attrNum(el, name, dflt) {
    var v = parseFloat(el.getAttribute(name));
    return Number.isFinite(v) ? v : dflt;
  }

  // SVG primitive element -> local path data (consumed by transformPath).
  function primitiveToD(el, tag) {
    if (tag === 'path') {
      var dd = el.getAttribute('d');
      return dd && dd.trim() ? dd : null;
    }
    if (tag === 'rect') {
      var x = attrNum(el, 'x', 0), y = attrNum(el, 'y', 0),
        w = attrNum(el, 'width', 0), h = attrNum(el, 'height', 0);
      if (w <= 0 || h <= 0) return null;
      var rx = attrNum(el, 'rx', NaN), ry = attrNum(el, 'ry', NaN);
      if (!Number.isFinite(rx)) rx = ry;
      if (!Number.isFinite(ry)) ry = rx;
      if (Number.isFinite(rx) && Number.isFinite(ry) && rx > 0 && ry > 0) {
        rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
        return 'M ' + (x + rx) + ' ' + y +
          ' L ' + (x + w - rx) + ' ' + y +
          ' A ' + rx + ' ' + ry + ' 0 0 1 ' + (x + w) + ' ' + (y + ry) +
          ' L ' + (x + w) + ' ' + (y + h - ry) +
          ' A ' + rx + ' ' + ry + ' 0 0 1 ' + (x + w - rx) + ' ' + (y + h) +
          ' L ' + (x + rx) + ' ' + (y + h) +
          ' A ' + rx + ' ' + ry + ' 0 0 1 ' + x + ' ' + (y + h - ry) +
          ' L ' + x + ' ' + (y + ry) +
          ' A ' + rx + ' ' + ry + ' 0 0 1 ' + (x + rx) + ' ' + y + ' Z';
      }
      return 'M ' + x + ' ' + y + ' L ' + (x + w) + ' ' + y +
        ' L ' + (x + w) + ' ' + (y + h) + ' L ' + x + ' ' + (y + h) + ' Z';
    }
    if (tag === 'circle') {
      var ccx = attrNum(el, 'cx', 0), ccy = attrNum(el, 'cy', 0),
        cr = attrNum(el, 'r', 0);
      if (cr <= 0) return null;
      return 'M ' + (ccx - cr) + ' ' + ccy +
        ' A ' + cr + ' ' + cr + ' 0 1 0 ' + (ccx + cr) + ' ' + ccy +
        ' A ' + cr + ' ' + cr + ' 0 1 0 ' + (ccx - cr) + ' ' + ccy + ' Z';
    }
    if (tag === 'ellipse') {
      var ex = attrNum(el, 'cx', 0), ey = attrNum(el, 'cy', 0),
        erx = attrNum(el, 'rx', 0), ery = attrNum(el, 'ry', 0);
      if (erx <= 0 || ery <= 0) return null;
      return 'M ' + (ex - erx) + ' ' + ey +
        ' A ' + erx + ' ' + ery + ' 0 1 0 ' + (ex + erx) + ' ' + ey +
        ' A ' + erx + ' ' + ery + ' 0 1 0 ' + (ex - erx) + ' ' + ey + ' Z';
    }
    if (tag === 'line') {
      return 'M ' + attrNum(el, 'x1', 0) + ' ' + attrNum(el, 'y1', 0) +
        ' L ' + attrNum(el, 'x2', 0) + ' ' + attrNum(el, 'y2', 0);
    }
    if (tag === 'polyline' || tag === 'polygon') {
      var raw = (el.getAttribute('points') || '').trim();
      if (!raw) return null;
      var ns = raw.split(/[\s,]+/).map(parseFloat)
        .filter(function (v) { return Number.isFinite(v); });
      if (ns.length < 4) return null;
      var sd = 'M ' + ns[0] + ' ' + ns[1];
      for (var k = 2; k + 1 < ns.length; k += 2) sd += ' L ' + ns[k] + ' ' + ns[k + 1];
      if (tag === 'polygon') sd += ' Z';
      return sd;
    }
    return null;
  }

  function imageHref(el) {
    return el.getAttribute('href') ||
      (el.getAttributeNS ? el.getAttributeNS(
        'http://www.w3.org/1999/xlink', 'href') : null) ||
      el.getAttribute('xlink:href');
  }

  // Transcribe drawio's already-rendered SVG for this cell. Returns an array
  // of contract paint nodes, or null to signal "fall back to the named-shape
  // path" (no live SVG, or it couldn't be placed reliably).
  function harvestShape(cell, state, origin, scale, notices) {
    if (!state || !state.shape || !state.shape.node) return null;
    var node = state.shape.node;
    if (!node.childNodes || typeof node.getCTM !== 'function') return null;
    try {
      var GRAPHIC = ['path', 'rect', 'circle', 'ellipse', 'line',
        'polyline', 'polygon', 'image'];
      var list = [];
      (function rec(e) {
        if (!e || e.nodeType !== 1) return;
        var tg = String(e.tagName || '').toLowerCase();
        if (tg === 'text' || tg === 'tspan' || tg === 'foreignobject' ||
          tg === 'defs') return;          // labels/defs handled elsewhere
        if (GRAPHIC.indexOf(tg) >= 0) list.push(e);
        for (var k = 0; k < e.childNodes.length; k++) rec(e.childNodes[k]);
      })(node);
      if (!list.length) return null;
      var out = [];
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        var tag = String(el.tagName || '').toLowerCase();
        var M = harvestMatrix(el, node, origin, scale);
        // Not placeable (e.g. an unrendered display:none sub-element, which
        // is invisible on screen anyway) -> skip just this primitive; keep
        // the rest of the shape faithful instead of degrading the whole cell.
        if (!M) continue;
        if (tag === 'image') {
          var pim = parseImage(imageHref(el));
          if (pim && pim.format === 'png') {
            var q0 = mPt(M, attrNum(el, 'x', 0), attrNum(el, 'y', 0));
            var q1 = mPt(M, attrNum(el, 'x', 0) + attrNum(el, 'width', 0),
              attrNum(el, 'y', 0) + attrNum(el, 'height', 0));
            out.push({
              kind: 'image',
              box: { x: Math.min(q0.x, q1.x), y: Math.min(q0.y, q1.y),
                w: Math.max(1, Math.abs(q1.x - q0.x)),
                h: Math.max(1, Math.abs(q1.y - q0.y)) },
              format: 'png', data: pim.data, aspect: 'fill',
              flipH: false, flipV: false
            });
          } else if (Array.isArray(notices)) {
            notices.push(degradation('ExporterUnsupportedImage',
              'embedded stencil image is not an inline PNG; not rendered',
              cell.id));
          }
          continue;
        }
        var local = primitiveToD(el, tag);
        if (local == null) continue;
        var d = transformPath(local, M);
        if (!d) continue;
        var pp = elementPaint(el, scale);
        if (!pp.fill && !pp.stroke) continue;   // invisible hit-area: skip
        out.push({ kind: 'path', d: d, fill: pp.fill, stroke: pp.stroke });
      }
      return out.length ? out : null;
    } catch (e) { return null; }
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
    // Prefer the live rendered label DOM (accurate computed styles); only if
    // there is none do we parse the markup detached. Previously a found live
    // host fell into the `else return null`, so rich extraction NEVER ran in
    // the browser and every multi-paragraph/<p>/<div> label collapsed to a
    // single plainLabel line that overflowed its box and printed blank.
    host = resolveRichContentRoot(state);
    if (!host) {
      if (doc && doc.createElement) {
        host = doc.createElement('div');
        host.innerHTML = String(s);
        useFallback = true;
        if (Array.isArray(notices)) notices.push(degradation('RichApproximate', 'rich text live DOM not available; using detached parser', cell.id));
      } else {
        return null;
      }
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
    try {
      var startWs = 'normal';
      if (!useFallback && doc && typeof root.getComputedStyle === 'function') {
        var hostCs = root.getComputedStyle(host);
        if (hostCs && hostCs.whiteSpace) startWs = hostCs.whiteSpace.toLowerCase();
      }
      for (var i = 0; i < host.childNodes.length; i++) walk(host.childNodes[i], base, paras[0].align, startWs);
      mergeAdjacentRichRuns(paras);
      if (paras.length > 1 && paras[paras.length - 1].runs.length === 0) paras.pop();
      if (paras.length === 0) paras = [{ align: alignH(style.align), indentPx: 0, runs: [] }];
      // All runs empty (e.g. whitespace-only DOM) -> let the caller use the
      // plain static fallback instead of emitting an empty rich block.
      var hasText = paras.some(function (pr) {
        return pr.runs.some(function (r) { return r.text && r.text.trim() !== ''; });
      });
      return hasText ? { type: 'rich', paragraphs: paras } : null;
    } catch (e) { return null; }
  }

  function plainLabel(graph, cell) {
    var s = graph.getLabel(cell);
    if (s == null) return '';
    s = String(s);
    if (s.indexOf('<') >= 0) {
      // Block-level boundaries must become line breaks, otherwise multi-
      // paragraph labels collapse into one giant line that overflows the
      // box and prints blank (the reported "Paragraph of Text" bug).
      s = s
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre)\s*>/gi, '\n')
        .replace(/<(p|div|li|tr|h[1-6]|blockquote|pre)(\s[^>]*)?>/gi, '\n')
        .replace(/<[^>]+>/g, '');
      var d = (root.document && root.document.createElement)
        ? root.document.createElement('div') : null;
      if (d) { d.innerHTML = s; s = d.textContent || d.innerText || ''; }
      s = s.replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
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

  // ---------------------------------------------------------------------------
  // TRUE-WYSIWYG path: emit drawio's ACTUAL rendered SVG for the cell as a
  // frozen-contract `svg` node ({kind:'svg',box,source:<base64>,aspect}). The
  // host SVG rasterizer renders exactly what drawio drew — shapes, text,
  // gradients, filters, markers — with ZERO re-derivation. If the host has no
  // SVG backend the engine emits a loud `SvgArtworkStub` degradation (never
  // silent). The vector harvest/path code below remains the headless /
  // serialization-failure fallback only.
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  function utf8Bytes(str) {
    if (typeof root.TextEncoder === 'function') {
      return new root.TextEncoder().encode(str);
    }
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) { out.push(c); }
      else if (c < 0x800) {
        out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        var c2 = str.charCodeAt(++i);
        var cp = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
          0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      } else {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    }
    return out;
  }

  function base64(str) {
    var b = utf8Bytes(str), s = '';
    for (var i = 0; i < b.length; i += 3) {
      var n = (b[i] << 16) | ((i + 1 < b.length ? b[i + 1] : 0) << 8) |
        (i + 2 < b.length ? b[i + 2] : 0);
      s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] +
        (i + 1 < b.length ? B64[(n >> 6) & 63] : '=') +
        (i + 2 < b.length ? B64[n & 63] : '=');
    }
    return s;
  }

  function serializeEl(node) {
    try {
      if (typeof root.XMLSerializer === 'function') {
        return new root.XMLSerializer().serializeToString(node);
      }
    } catch (e) { /* fall through */ }
    return node && typeof node.outerHTML === 'string' ? node.outerHTML : null;
  }

  // Inline every <defs>-style resource the cell references (gradients,
  // filters, clip-paths, markers) so the emitted SVG is self-contained.
  function collectDefs(rootNode, doc, seen, acc) {
    if (!rootNode || !doc || typeof doc.getElementById !== 'function') return;
    var RE = /url\(\s*["']?#([^"')\s]+)["']?\s*\)/g;
    (function rec(e) {
      if (!e || e.nodeType !== 1) return;
      var probe = '';
      if (typeof e.getAttribute === 'function') {
        ['fill', 'stroke', 'filter', 'clip-path', 'mask',
         'marker-start', 'marker-mid', 'marker-end', 'style'].forEach(
          function (a) { var v = e.getAttribute(a); if (v) probe += ' ' + v; });
      }
      var m;
      while ((m = RE.exec(probe))) {
        var id = m[1];
        if (seen[id]) continue;
        seen[id] = true;
        var def = doc.getElementById(id);
        if (def) {
          var s = serializeEl(def);
          if (s) { acc.push(s); rec(def); }   // nested refs (gradient->href)
        }
      }
      for (var i = 0; e.childNodes && i < e.childNodes.length; i++) rec(e.childNodes[i]);
    })(rootNode);
  }

  function xmlEsc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function findForeignObjects(node, out) {
    if (!node || node.nodeType !== 1) return out;
    if (String(node.tagName || '').toLowerCase() === 'foreignobject') {
      out.push(node);
    }
    for (var i = 0; node.childNodes && i < node.childNodes.length; i++) {
      findForeignObjects(node.childNodes[i], out);
    }
    return out;
  }

  // A foreignObject is PRESENT but the live DOM cannot be measured. Per the
  // owner ruling, dropping/approximating an object on print is unacceptable
  // and there is no faithful source without the DOM (a browser is forbidden,
  // C2). So abort the WHOLE export loudly — operator is told exactly why and
  // NO partial/wrong page is produced. Marked so buildResult never swallows.
  function nativePrintFatal(msg, cellId) {
    var e = new Error('NativePrintFatal: ' + msg +
      (cellId ? ' (cell ' + String(cellId) + ')' : ''));
    e.nativePrintFatal = true;
    return e;
  }

  function romanize(n) {
    var t = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'],
      [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'],
      [4, 'iv'], [1, 'i']], s = '';
    for (var i = 0; i < t.length && n > 0; i++) {
      while (n >= t[i][0]) { s += t[i][1]; n -= t[i][0]; }
    }
    return s;
  }

  function alpha(n) {
    var s = '';
    while (n > 0) { n--; s = String.fromCharCode(97 + (n % 26)) + s;
      n = Math.floor(n / 26); }
    return s;
  }

  function listMarker(type, idx) {
    switch (type) {
      case 'disc': return '•';
      case 'circle': return '◦';
      case 'square': return '▪';
      case 'none': return '';
      case 'decimal-leading-zero':
        return (idx < 10 ? '0' : '') + idx + '.';
      case 'lower-roman': return romanize(idx) + '.';
      case 'upper-roman': return romanize(idx).toUpperCase() + '.';
      case 'lower-alpha': case 'lower-latin': return alpha(idx) + '.';
      case 'upper-alpha': case 'upper-latin':
        return alpha(idx).toUpperCase() + '.';
      case 'decimal': return idx + '.';
      default: return null;   // unknown -> caller raises a loud notice
    }
  }

  function fontRun(cs) {
    var cp = colorParts(cs.color || '') || { hex: '#000000', alpha: 1 };
    var wt = parseInt(cs.fontWeight, 10);
    var dec = String(cs.textDecorationLine || cs.textDecoration || '');
    var d = [];
    if (dec.indexOf('underline') >= 0) d.push('underline');
    if (dec.indexOf('line-through') >= 0) d.push('line-through');
    if (dec.indexOf('overline') >= 0) d.push('overline');
    var ls = parseFloat(cs.letterSpacing);
    return {
      fam: ((cs.fontFamily || 'Arial').split(',')[0] || 'Arial')
        .trim().replace(/^['"]|['"]$/g, ''),
      size: parseFloat(cs.fontSize) || 12,
      weight: Number.isFinite(wt) ? (wt >= 600 ? 700 : wt) : 400,
      italic: (cs.fontStyle || '').indexOf('italic') >= 0,
      fill: cp.none ? null : cp.hex,
      fillOpacity: cp.none ? 0 : (cp.alpha == null ? 1 : cp.alpha),
      decoration: d.length ? d.join(' ') : null,
      letterSpacing: (cs.letterSpacing && cs.letterSpacing !== 'normal' &&
        Number.isFinite(ls) && ls !== 0) ? ls : null
    };
  }

  function bgRect(cs, rect) {
    var cp = colorParts(cs.backgroundColor || '');
    if (!cp || cp.none || cp.alpha === 0 || !rect ||
      (!rect.width && !rect.height)) return '';
    return '<rect x="' + fmt(rect.left) + '" y="' + fmt(rect.top) +
      '" width="' + fmt(rect.width) + '" height="' + fmt(rect.height) +
      '" fill="' + cp.hex + '"' +
      (cp.alpha < 1 ? ' fill-opacity="' + fmt(cp.alpha) + '"' : '') + '/>';
  }

  function pushListMarkerApprox(notices, detail, cellId) {
    if (!Array.isArray(notices)) return;
    notices.push(degradation('SvgListMarkerApprox', detail, cellId));
  }

  function textRunSvg(run) {
    var R = run, f = R.f;
    if (f.fill == null) return '';
    // Client rects are line-box tall; the browser centres glyphs in the
    // line box (half-leading). Anchor the em-box top there so vertical
    // placement matches the screen exactly, not just the line-box top.
    var yy = R.rect.top + Math.max(0, (R.rect.height - f.size) / 2);
    return '<text x="' + fmt(R.rect.left) + '" y="' + fmt(yy) +
      '" font-family="' + xmlEsc(f.fam) + '" font-size="' + fmt(f.size) +
      '" font-weight="' + f.weight + '"' +
      (f.italic ? ' font-style="italic"' : '') +
      (f.decoration ? ' text-decoration="' + f.decoration + '"' : '') +
      (f.letterSpacing != null
        ? ' letter-spacing="' + fmt(f.letterSpacing) + '"' : '') +
      ' fill="' + f.fill + '"' +
      (f.fillOpacity < 1 ? ' fill-opacity="' + fmt(f.fillOpacity) + '"' : '') +
      ' text-anchor="' + (R.anchor || 'start') +
      '" dominant-baseline="text-before-edge"' +
      ' xml:space="preserve">' + xmlEsc(R.text) + '</text>';
  }

  // First rendered word's client rect inside `el` (document order), or null.
  function firstWordRect(el, doc) {
    try {
      var stack = [el];
      while (stack.length) {
        var n = stack.shift();
        if (n.nodeType === 3) {
          var mm = n.nodeValue && /\S+/.exec(n.nodeValue);
          if (mm) {
            var rg = doc.createRange();
            rg.setStart(n, mm.index);
            rg.setEnd(n, mm.index + mm[0].length);
            var li = (typeof rg.getClientRects === 'function')
              ? rg.getClientRects() : null;
            var rc = (li && li.length) ? li[0] : rg.getBoundingClientRect();
            if (rc && (rc.width || rc.height)) return rc;
          }
        } else if (n.nodeType === 1 && n.childNodes) {
          for (var i = n.childNodes.length - 1; i >= 0; i--) {
            stack.unshift(n.childNodes[i]);
          }
        }
      }
    } catch (e) { /* fall through */ }
    return null;
  }

  // TRUE-WYSIWYG HTML labels, browser-free and engine-frozen: harvest the
  // ACTUAL laid-out text/decorations/backgrounds from the live drawio DOM
  // (the same bake-time DOM read already used for shape geometry — NOT an
  // added browser) and transcribe them into plain SVG primitives at the
  // EXACT screen positions. Everything is emitted in screen px inside one
  // <g matrix> (M = screen->cell-SVG-local); the matrix carries drawio's
  // rotation/zoom/flip so glyphs are oriented exactly as on screen, and
  // <text> is top-anchored (dominant-baseline=text-before-edge) so there
  // is no baseline/metric guessing. Native SVG rasterizers draw <text>,
  // <rect> faithfully, so print == screen by construction. If a present
  // foreignObject cannot be measured this raises a loud FATAL (no silent
  // drop/approx — owner ruling). Returns '' when there is genuinely no
  // text (empty label) — not an error.
  function transcribeForeignObjects(fos, M, cellId, notices) {
    var bg = [], runs = [];
    var measurable = root && typeof root.getComputedStyle === 'function';
    for (var k = 0; k < fos.length; k++) {
      var fo = fos[k];
      var doc = fo.ownerDocument;
      var hasText = (fo.textContent || '').trim() !== '';
      if (!measurable || !doc || typeof doc.createRange !== 'function' ||
        typeof fo.getBoundingClientRect !== 'function') {
        if (hasText) {
          throw nativePrintFatal('HTML label present but the live DOM ' +
            'cannot be measured; refusing to print a page with a missing ' +
            'or non-WYSIWYG label', cellId);
        }
        continue;
      }
      // Outermost element background = drawio label background.
      var rootEl = null;
      for (var c = 0; fo.childNodes && c < fo.childNodes.length; c++) {
        if (fo.childNodes[c].nodeType === 1) { rootEl = fo.childNodes[c]; break; }
      }
      if (rootEl) {
        bg.push(bgRect(root.getComputedStyle(rootEl),
          rootEl.getBoundingClientRect()));
      }
      var walk = function (n) {
        if (!n) return;
        if (n.nodeType === 1) {
          var ecs = root.getComputedStyle(n);
          if (n !== rootEl) {
            bg.push(bgRect(ecs, n.getBoundingClientRect()));
          }
          if ((ecs.display || '').indexOf('list-item') >= 0 &&
            (ecs.listStyleType || 'disc') !== 'none') {
            var lt = ecs.listStyleType || 'disc';
            var idx = 1, ps = n.previousElementSibling;
            while (ps) {
              if (String(ps.tagName || '').toLowerCase() === 'li') idx++;
              ps = ps.previousElementSibling;
            }
            var glyph = listMarker(lt, idx);
            if (glyph === null) {
              glyph = '•';
              pushListMarkerApprox(notices,
                'list-style-type "' + lt + '" rendered as a bullet ' +
                '(no standard glyph)', cellId);
            } else {
              // The ::marker pseudo-box is not measurable without a browser
              // (C2); glyph + numbering are exact, the inset is derived
              // from the measured first-content position. Inherently loud.
              pushListMarkerApprox(notices,
                'list marker inset derived from content metrics ' +
                '(::marker box not measurable browser-free)', cellId);
            }
            if (glyph) {
              var fr0 = fontRun(ecs);
              var cRect = firstWordRect(n, doc);
              var mr = cRect || n.getBoundingClientRect();
              // Right-align the marker a font-derived gap left of content.
              var mx = cRect ? (cRect.left - fr0.size * 0.5) : mr.left;
              runs.push({ rect: { left: mx, top: mr.top,
                width: 0, height: mr.height },
                text: glyph, f: fr0, anchor: cRect ? 'end' : 'start' });
            }
          }
          for (var i = 0; n.childNodes && i < n.childNodes.length; i++) {
            walk(n.childNodes[i]);
          }
          return;
        }
        if (n.nodeType !== 3) return;
        var s = n.nodeValue;
        if (!s || !s.trim()) return;
        var f = fontRun(root.getComputedStyle(n.parentNode));
        var re = /\S+/g, m;
        while ((m = re.exec(s))) {
          var rg = doc.createRange();
          rg.setStart(n, m.index);
          rg.setEnd(n, m.index + m[0].length);
          var list = (typeof rg.getClientRects === 'function')
            ? rg.getClientRects() : null;
          var rects = (list && list.length)
            ? list : [rg.getBoundingClientRect()];
          for (var r = 0; r < rects.length; r++) {
            var rc = rects[r];
            if (!rc || (!rc.width && !rc.height)) {
              throw nativePrintFatal('HTML label fragment is unmeasurable ' +
                '(zero-rect); refusing to drop a visible label', cellId);
            }
            runs.push({ rect: { left: rc.left, top: rc.top,
              width: rc.width, height: rc.height }, text: m[0], f: f });
          }
        }
      };
      walk(fo);
    }
    if (!runs.length && !bg.some(function (x) { return x !== ''; })) return '';
    var body = bg.join('');
    for (var j = 0; j < runs.length; j++) body += textRunSvg(runs[j]);
    return '<g transform="matrix(' + fmt(M.a) + ' ' + fmt(M.b) + ' ' +
      fmt(M.c) + ' ' + fmt(M.d) + ' ' + fmt(M.e) + ' ' + fmt(M.f) + ')">' +
      body + '</g>';
  }

  // Build the contract `svg` node carrying the cell's literal rendered SVG.
  // Returns null (caller falls back) when there is no live DOM / serializer.
  var SVG_PAD = 2;   // contract px around the cell for stroke/marker overflow
  function svgCellNode(graph, cell, state, origin, scale, notices) {
    if (!state || !state.shape || !state.shape.node) return null;
    var shapeNode = state.shape.node;
    var doc = (shapeNode.ownerDocument) || root.document || null;
    var shapeStr = serializeEl(shapeNode);
    if (!shapeStr) return null;
    var textStr = (state.text && state.text.node)
      ? serializeEl(state.text.node) : null;
    // HTML labels serialize as <foreignObject>, which native SVG rasterizers
    // cannot draw and the frozen engine must not re-lay-out. Transcribe the
    // ACTUAL rendered text/decorations/backgrounds from the live DOM into
    // plain SVG at the exact screen positions (browser-free, engine-frozen).
    // The matrix is computed AFTER vb/box below; defer the splice via a flag.
    var fos = (state.text && state.text.node)
      ? findForeignObjects(state.text.node, []) : [];

    var vb = { x: state.x, y: state.y, w: state.width, h: state.height };
    if ((!(vb.w > 0) || !(vb.h > 0)) && state.absolutePoints) {
      var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
      for (var pi = 0; pi < state.absolutePoints.length; pi++) {
        var ap = state.absolutePoints[pi];
        if (!ap) continue;
        if (ap.x < minx) minx = ap.x; if (ap.x > maxx) maxx = ap.x;
        if (ap.y < miny) miny = ap.y; if (ap.y > maxy) maxy = ap.y;
      }
      if (Number.isFinite(minx) && maxx > minx - 1 && maxy > miny - 1) {
        // Pad by stroke + marker reach so the connector isn't clipped.
        var ep = Math.max(8, number(state.style && state.style.strokeWidth, 1) * 6);
        vb = { x: minx - ep, y: miny - ep,
          w: Math.max(1, maxx - minx) + 2 * ep,
          h: Math.max(1, maxy - miny) + 2 * ep };
      }
    }
    if (!(vb.w > 0) || !(vb.h > 0)) return null;
    var box = {
      x: (vb.x - origin.x) / scale - SVG_PAD,
      y: (vb.y - origin.y) / scale - SVG_PAD,
      w: vb.w / scale + 2 * SVG_PAD,
      h: vb.h / scale + 2 * SVG_PAD
    };

    var defs = [];
    try {
      var seen = {};
      collectDefs(shapeNode, doc, seen, defs);
      if (state.text && state.text.node) collectDefs(state.text.node, doc, seen, defs);
    } catch (e) { /* defs best-effort; never fatal */ }

    // HTML label present -> transcribe (never serialize foreignObject into
    // the contract). M maps screen px -> this svg's local space, carrying
    // drawio's rotation/zoom/flip exactly.
    var labelStr = textStr || '';
    if (fos.length) {
      var cellGroup = shapeNode.parentNode;
      var sctm = (cellGroup && typeof cellGroup.getScreenCTM === 'function')
        ? svgMat(cellGroup.getScreenCTM()) : null;
      var Sinv = sctm ? mInv(sctm) : null;
      if (!Sinv) {
        throw nativePrintFatal('HTML label present but the cell transform ' +
          'cannot be read from the live DOM; refusing a non-WYSIWYG print',
          cell.id);
      }
      var Mtr = { a: 1 / scale, b: 0, c: 0, d: 1 / scale,
        e: SVG_PAD - vb.x / scale, f: SVG_PAD - vb.y / scale };
      labelStr = transcribeForeignObjects(
        fos, mMul(Mtr, Sinv), cell && cell.id, notices);
    }

    // view coords -> svg-local: translate(pad) scale(1/s) translate(-vb)
    var tr = 'translate(' + fmt(SVG_PAD) + ' ' + fmt(SVG_PAD) + ') scale(' +
      fmt(1 / scale) + ') translate(' + fmt(-vb.x) + ' ' + fmt(-vb.y) + ')';
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" ' +
      'xmlns:xlink="http://www.w3.org/1999/xlink" width="' + fmt(box.w) +
      '" height="' + fmt(box.h) + '">' +
      (defs.length ? '<defs>' + defs.join('') + '</defs>' : '') +
      '<g transform="' + tr + '">' + shapeStr +
      labelStr + '</g></svg>';

    return { kind: 'svg', box: box, source: base64(svg), aspect: 'preserve' };
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

    // TRUE-WYSIWYG primary: emit the cell's literal rendered SVG (shape +
    // label together) so EVERY object type prints exactly as drawn, text
    // included. Falls through only with no live DOM (headless) or if
    // serialization fails.
    var svgNode = svgCellNode(graph, cell, state, origin, scale, notices);
    if (svgNode) { paint.push(svgNode); return; }

    // Vector fallback: transcribe drawio's own rendered SVG so EVERY shape —
    // built-in, stencil, UML/BPMN/AWS/Azure/mscae, custom — bakes faithfully.
    // Only when no live SVG exists (e.g. headless) do we fall back to the
    // named-shape geometry, and to a bounding box + loud notice as a last
    // resort.
    var harvested = harvestShape(cell, state, origin, scale, notices);
    if (harvested) {
      for (var hi = 0; hi < harvested.length; hi++) paint.push(harvested[hi]);
      if (label !== '') {
        var hlb = labelBoxNode(style, box);
        if (hlb) paint.push(hlb);
        paint.push(textNode(graph, cell, state, style, box, label, notices));
      }
      return;
    }

    // drawio's `text` shape (e.g. the "Paragraph of Text" element) paints no
    // body — it is a label-only object. Emitting a bbox path here is both
    // invisible (fill/stroke are none) and wrongly raised an
    // ExporterUnsupportedShape notice. Skip the body; just lay out the label.
    if (style.shape !== 'text') {
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
    }

    if (label !== '') {
      var vlb = labelBoxNode(style, box);
      if (vlb) paint.push(vlb);
      paint.push(textNode(graph, cell, state, style, box, label, notices));
    }
  }

  function emitEdge(graph, cell, state, style, origin, scale, paint, notices) {
    // TRUE-WYSIWYG primary: the edge's literal rendered SVG (connector +
    // markers + label exactly as drawn). Falls through only headless.
    var svgNode = svgCellNode(graph, cell, state, origin, scale, notices);
    if (svgNode) { paint.push(svgNode); return; }

    // Faithful vector fallback: transcribe drawio's own rendered connector +
    // markers (exact waypoints, curved/orthogonal/entity routing, real
    // arrowheads) instead of re-deriving them. Re-derivation below is the
    // headless fallback only (no live SVG); a known geometric approximation.
    var harvested = harvestShape(cell, state, origin, scale, notices);
    if (harvested) {
      for (var hi = 0; hi < harvested.length; hi++) paint.push(harvested[hi]);
      var hl = plainLabel(graph, cell);
      if (hl !== '') {
        var hlBox = edgeLabelBox(state, style, origin, scale, hl);
        var hlb = labelBoxNode(style, hlBox);
        if (hlb) paint.push(hlb);
        paint.push(textNode(graph, cell, state, style, hlBox, hl, notices));
      }
      return;
    }

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
