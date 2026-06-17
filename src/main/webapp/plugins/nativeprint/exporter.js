/**
 * Native Print exporter: the "bake" (host integration spec section 5).
 *
 * Runs in the drawio renderer where the computed graph view state exists, and
 * serializes the current diagram to a v1.1-schema-valid contract. The engine
 * never sees diagram/editor concepts, only this finished contract.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Module-level stencil registry (set by registerStencils() from bake.mjs).
  // Map<string, shapeNodeTree> where keys are "mxgraph.package.shapename".
  var _stencilRegistry = null;

  // Deterministic gradient ID: hash fill+grad colors so golden comparisons stay stable.
  function stableGradId(fillColor, gradColor) {
    var s = (fillColor || '') + ':' + (gradColor || '');
    var h = 0;
    for (var i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) & 0xfffffff; }
    return 'sg' + h.toString(36);
  }

  // Map style.gradientDirection to SVG linearGradient x1/y1/x2/y2 (objectBoundingBox units).
  // draw.io default (unset / 'none' / 'south') is top-to-bottom.
  function gradientVector(dir) {
    switch ((dir || 'south').toLowerCase()) {
      case 'north': return { x1: 0, y1: 1, x2: 0, y2: 0 };
      case 'east':  return { x1: 0, y1: 0, x2: 1, y2: 0 };
      case 'west':  return { x1: 1, y1: 0, x2: 0, y2: 0 };
      default:      return { x1: 0, y1: 0, x2: 0, y2: 1 }; // south / none
    }
  }

  // When a shape is direction-rotated and the gradient is baked into the path
  // coordinates (not a group transform), the gradient axis must rotate with the
  // shape too. drawio direction adds south=+90, west=+180, north=+270 (CW).
  function rotateGradDir(gd, deg) {
    if (!deg || String(gd || '').toLowerCase() === 'radial') return gd;
    var ang = { east: 0, south: 90, west: 180, north: 270 };
    var inv = { 0: 'east', 90: 'south', 180: 'west', 270: 'north' };
    var base = ang[String(gd || 'south').toLowerCase()];
    if (base == null) return gd;
    return inv[((base + deg) % 360 + 360) % 360];
  }

  // Build a gradient definition string with correct direction.
  // gradientDirection=radial is a REAL radial gradient in drawio
  // (mxSvgCanvas2D creates <radialGradient>, default 50%/50%/50%) -- the
  // old fallthrough silently printed it as a top-to-bottom linear fade.
  function linearGradDef(id, c1, c2, dir) {
    if (String(dir || '').toLowerCase() === 'radial') {
      return '<radialGradient id="' + id + '" cx="0.5" cy="0.5" r="0.5"' +
        ' gradientUnits="objectBoundingBox">' +
        '<stop offset="0" stop-color="' + c1 + '"/>' +
        '<stop offset="1" stop-color="' + c2 + '"/>' +
        '</radialGradient>';
    }
    var v = gradientVector(dir);
    return '<linearGradient id="' + id + '" x1="' + v.x1 + '" y1="' + v.y1 +
      '" x2="' + v.x2 + '" y2="' + v.y2 + '" gradientUnits="objectBoundingBox">' +
      '<stop offset="0" stop-color="' + c1 + '"/>' +
      '<stop offset="1" stop-color="' + c2 + '"/>' +
      '</linearGradient>';
  }

  // ---------------------------------------------------------------------------
  // Pure-JS XML parser for stencil XML (no DOMParser needed).
  // Returns { name, attrs:{}, children:[] } or null.
  function parseXml(xmlStr) {
    var tagRe = /<(\/)?([A-Za-z][\w:-]*)([^>]*?)(\/)?>/g;
    var attrRe = /([\w:-]+)=["']([^"']*)["']/g;
    function parseAttrs(s) {
      var a = {}, m;
      attrRe.lastIndex = 0;
      while ((m = attrRe.exec(s)) !== null) a[m[1]] = m[2];
      return a;
    }
    var docRoot = { name: '#root', attrs: {}, children: [] };
    var stack = [docRoot];
    var m;
    while ((m = tagRe.exec(xmlStr)) !== null) {
      var slash = m[1], name = m[2], attrStr = m[3], selfClose = m[4];
      var top = stack[stack.length - 1];
      if (slash) {
        if (stack.length > 1) stack.pop();
      } else {
        var node = { name: name.toLowerCase(), attrs: parseAttrs(attrStr), children: [] };
        top.children.push(node);
        if (!selfClose) stack.push(node);
      }
    }
    return docRoot.children[0] || null;
  }

  // ---------------------------------------------------------------------------
  // computeAspect: maps stencil native coords to cell pixel space.
  // Returns { ox, oy, sw, sh, su } for the coordinate transform.
  function computeAspect(w0, h0, cellW, cellH, aspect) {
    if (aspect === 'fixed') {
      var su = Math.min(cellW / w0, cellH / h0);
      return {
        ox: (cellW - w0 * su) / 2,
        oy: (cellH - h0 * su) / 2,
        sw: su, sh: su, su: su
      };
    }
    // aspect = "variable" (default)
    var sw = cellW / w0, sh = cellH / h0;
    return { ox: 0, oy: 0, sw: sw, sh: sh, su: Math.min(sw, sh) };
  }

  // ---------------------------------------------------------------------------
  // stencilToSvg: render a parsed stencil <shape> node to an SVG string.
  // Returns SVG string, or null if unsupported feature encountered (notice pushed).
  // `nested` is set for include-shape sub-renders: drawio applies the
  // direction ROTATION and the flipH/flipV mirroring ONCE at the canvas level
  // for the whole shape (mxShape.updateTransform); an included stencil only
  // recomputes its aspect (scale swap + delta offset, mxStencil.js:490-528,
  // 862-874) — it must NOT rotate or flip again.
  function stencilToSvg(shapeNode, cellW, cellH, style, notices, resolved, nested) {
    // Step 1: Read shape metadata
    var w0 = parseFloat(shapeNode.attrs.w) || 100;
    var h0 = parseFloat(shapeNode.attrs.h) || 100;
    var aspect = shapeNode.attrs.aspect || 'variable';
    var stencilStrokeWidthAttr = shapeNode.attrs.strokewidth;

    // Step 2: Handle direction: north/south swap cellW/cellH for computeAspect
    var dir = style.direction || 'east';
    var cw = cellW, ch = cellH;
    if (dir === 'north' || dir === 'south') {
      cw = cellH; ch = cellW;
    }

    // Compute aspect transform
    var asp = computeAspect(w0, h0, cw, ch, aspect);
    var ox = asp.ox, oy = asp.oy, sw = asp.sw, sh = asp.sh, su = asp.su;

    // Step 3: Compute initial stroke width. mxStencil.parseDescription:313-314
    // defaults an ABSENT strokewidth attribute to the string '1', and
    // drawShape:428-431 scales any numeric value by minScale — only the
    // literal 'inherit' takes the cell style strokeWidth (unscaled).
    var sw_px;
    if (stencilStrokeWidthAttr === 'inherit') {
      sw_px = number(style.strokeWidth, 1);
    } else {
      sw_px = number(stencilStrokeWidthAttr, 1) * su;
    }

    // Step 4: Initialize render state
    var state = {
      fillColor: style.fillColor,
      strokeColor: style.strokeColor,
      strokeWidth: sw_px,
      dashed: boolish(style.dashed),
      dashPattern: style.dashPattern,
      lineCap: style.lineCap || 'butt',
      lineJoin: style.lineJoin || 'miter',
      miterLimit: number(style.miterLimit, 10),
      alpha: opacity(style, 'opacity'),
      // Stencil-internal <text> commands paint with the CANVAS DEFAULT font
      // state, NOT the cell style: mxShape.configureCanvas (mxShape.js:1023)
      // sets alpha/fill/stroke/dash/cap/join/miter but NEVER any font, so the
      // canvas keeps mxAbstractCanvas2D.createState defaults — fontColor
      // #000000, fontSize mxConstants.DEFAULT_FONTSIZE=11, fontFamily
      // DEFAULT_FONTFAMILY='Arial,Helvetica', fontStyle DEFAULT_FONTSTYLE=0.
      // A stencil only deviates via its own <fontcolor>/<fontsize>/<fontstyle>/
      // <fontfamily> commands (mxStencil.js:952-968). Seeding these from the
      // cell's fontColor/fontSize/fontStyle/fontFamily silently mis-rendered
      // every stencil's decorative lettering (e.g. electrical/logic_gates.xml
      // JK flip-flop "J/K/Q") whenever the cell carried a non-default font.
      fontColor: '#000000',
      fontSize: 11,
      fontFamily: 'Arial,Helvetica',
      fontStyle: 0
    };
    var stateStack = [];

    // mxStencil.parseColor / getColorValue parity (browser-free). A stencil
    // color node's `color` attribute may be a CONCRETE color (hex/rgb/named) OR
    // a STYLE-KEY reference (e.g. `fillColor2`). When it is a key, drawio looks
    // it up in the cell style and, if absent, falls back to the node's `default`
    // attribute. Without this, stencils that paint via
    // `<fillcolor color="fillColor2" default="#032d60"/>` (e.g. the whole
    // mxgraph.salesforce.* family) baked with fill="none" and printed INVISIBLE
    // — a silent WYSIWYG violation. Only the default-attr branch changes prior
    // behaviour; concrete colors and unresolved-no-default keys are untouched.
    function resolveStencilColor(rawColor, defaultAttr, prev) {
      if (rawColor == null || rawColor === '') return prev; // match prior `a.color || prev`
      if (rawColor === 'fill') return style.fillColor;
      if (rawColor === 'stroke') return style.strokeColor;
      if (rawColor === 'font') return style.fontColor || '#000000';
      if (isPaintable(rawColor) || rawColor === 'none' || rawColor === 'transparent') {
        return rawColor;
      }
      // style-key reference: resolve against the cell style, else the default attr.
      var v = (style && style[rawColor] != null) ? String(style[rawColor]) : null;
      if (v != null && v !== 'default') return v;
      if (defaultAttr != null && defaultAttr !== '' && defaultAttr !== 'none') {
        return defaultAttr;
      }
      return rawColor; // unresolved key, no usable default: preserve prior behaviour
    }

    // Gradient support: if gradientColor is paintable, the shape canvas starts
    // with a gradient fill (mxShape.configureCanvas → setGradient). The
    // gradient is part of the canvas STATE: <fillcolor> switches to a solid
    // fill (mxAbstractCanvas2D.setFillColor clears state.gradient) and
    // save/restore snapshots it. All emitted defs are COLLECTED (never
    // overwritten) so earlier elements keep referencing a live def.
    var gradId = null;     // current canvas gradient (null = solid fill)
    var gradDefs = [];     // every gradient def emitted for this stencil
    if (isPaintable(state.fillColor) && isPaintable(style.gradientColor)) {
      gradId = stableGradId(state.fillColor, style.gradientColor);
      gradDefs.push(linearGradDef(gradId, hex(state.fillColor), hex(style.gradientColor), style.gradientDirection));
    }

    // mxShape.configureCanvas seeds setFillAlpha(fillOpacity/100) +
    // setStrokeAlpha(strokeOpacity/100) (mxShape.js:1033-1034), and
    // mxSvgCanvas2D emits fill-opacity = alpha*fillAlpha / stroke-opacity =
    // alpha*strokeAlpha (mxSvgCanvas2D.js:1054/1135). The stencil interpreter
    // previously used the global alpha only, so a stencil cell with
    // fillOpacity/strokeOpacity printed fully opaque — a silent divergence.
    var stencilFillAlpha = style && style.fillOpacity != null
      ? clamp01(number(style.fillOpacity, 100) / 100) : 1;
    var stencilStrokeAlpha = style && style.strokeOpacity != null
      ? clamp01(number(style.strokeOpacity, 100) / 100) : 1;

    // Helper: fill SVG attr using current state
    function stateFillAttr() {
      if (!isPaintable(state.fillColor)) return ' fill="none"';
      // Gradient fills carry the canvas alpha too (mxSvgCanvas2D.updateFill
      // sets fill-opacity regardless of gradient).
      var a = state.alpha * stencilFillAlpha;
      var aAttr = a < 1 ? ' fill-opacity="' + fmt(a) + '"' : '';
      if (gradId) return ' fill="url(#' + gradId + ')"' + aAttr;
      return ' fill="' + hex(state.fillColor) + '"' + aAttr;
    }

    // Helper: stroke SVG attrs using current state
    function stateStrokeAttrs() {
      if (!isPaintable(state.strokeColor)) return ' stroke="none"';
      var s = ' stroke="' + hex(state.strokeColor) + '"';
      var sw2 = Math.max(0.1, state.strokeWidth);
      s += ' stroke-width="' + fmt(sw2) + '"';
      var sc = state.lineCap === 'round' ? 'round' : state.lineCap === 'square' ? 'square' : 'butt';
      var sj = state.lineJoin === 'round' ? 'round' : state.lineJoin === 'bevel' ? 'bevel' : 'miter';
      s += ' stroke-linecap="' + sc + '" stroke-linejoin="' + sj + '"';
      // mxSvgCanvas2D.updateStrokeAttributes emits stroke-miterlimit only when it
      // differs from the canvas default 10 (mxSvgCanvas2D.js:1192) — at 10 the
      // attr is OMITTED (so both drawio and the print render at the SVG default 4;
      // no divergence there). A stencil <miterlimit> command (e.g.
      // electrical/mosfets1.xml limit="2") changes it; that value was silently
      // dropped, clipping sharp miter spikes differently.
      if (sj === 'miter' && state.miterLimit !== 10) {
        s += ' stroke-miterlimit="' + fmt(state.miterLimit) + '"';
      }
      if (state.dashed) {
        var dp = state.dashPattern
          ? String(state.dashPattern).split(/[ ,]+/).map(function(v) { return number(v, 0); }).filter(function(v) { return v > 0; })
          : [3, 3];
        if (!dp.length) dp = [3, 3];
        // Match drawio: dash values scale with stroke width (createDashPattern),
        // unless fixDash=1 (then the pattern is in absolute px).
        var dsc = boolish(style.fixDash) ? 1 : (state.strokeWidth || 1);
        if (dsc > 0 && dsc !== 1) dp = dp.map(function (v) { return Math.round(v * dsc * 100) / 100; });
        s += ' stroke-dasharray="' + dp.map(fmt).join(' ') + '"';
      }
      var sa = state.alpha * stencilStrokeAlpha;
      if (sa < 1) s += ' stroke-opacity="' + fmt(sa) + '"';
      return s;
    }

    // Helper: transform a stencil x coordinate
    function tx(x) { return ox + x * sw; }
    // Helper: transform a stencil y coordinate
    function ty(y) { return oy + y * sh; }
    // Helper: transform arc radii (use su for fixed, asymmetric for variable)
    function trx(r) { return aspect === 'fixed' ? r * su : r * sw; }
    function try_(r) { return aspect === 'fixed' ? r * su : r * sh; }

    // Walk a <path> block's children, building an SVG path d string.
    // Returns d string, or null if unsupported command encountered.
    // Faithful transcription of mxShape.prototype.addPoints(c, pts, rounded=
    // true, arcSize, close) for <path rounded="1"> segments. Points are in
    // ALREADY-SCALED canvas coordinates; arcSize is used UNSCALED (drawio
    // passes the raw attribute straight through, mxStencil.js:715).
    // For closed segments a virtual midpoint between last and first point is
    // prepended, so the path starts mid-segment and EVERY corner is rounded.
    function addPointsD(pts, arcSize, close) {
      if (!pts.length) return '';
      pts = pts.slice();
      var pe2 = pts[pts.length - 1];
      if (close) {
        var p0 = pts[0];
        pts.unshift({ x: pe2.x + (p0.x - pe2.x) / 2, y: pe2.y + (p0.y - pe2.y) / 2 });
      }
      var pt = pts[0];
      var i = 1;
      var parts2 = ['M ' + p(pt.x, pt.y)];
      while (i < (close ? pts.length : pts.length - 1)) {
        var tmp = pts[i % pts.length];
        var dx2 = pt.x - tmp.x, dy2 = pt.y - tmp.y;
        if (dx2 !== 0 || dy2 !== 0) {
          var dist = Math.sqrt(dx2 * dx2 + dy2 * dy2);
          var nx1 = dx2 * Math.min(arcSize, dist / 2) / dist;
          var ny1 = dy2 * Math.min(arcSize, dist / 2) / dist;
          parts2.push('L ' + p(tmp.x + nx1, tmp.y + ny1));
          var next = pts[(i + 1) % pts.length];
          while (i < pts.length - 2 && Math.round(next.x - tmp.x) === 0 &&
                 Math.round(next.y - tmp.y) === 0) {
            next = pts[(i + 2) % pts.length];
            i++;
          }
          dx2 = next.x - tmp.x; dy2 = next.y - tmp.y;
          dist = Math.max(1, Math.sqrt(dx2 * dx2 + dy2 * dy2));
          var nx2 = dx2 * Math.min(arcSize, dist / 2) / dist;
          var ny2 = dy2 * Math.min(arcSize, dist / 2) / dist;
          var x2 = tmp.x + nx2, y2 = tmp.y + ny2;
          parts2.push('Q ' + p(tmp.x, tmp.y) + ' ' + p(x2, y2));
          tmp = { x: x2, y: y2 };
        } else {
          parts2.push('L ' + p(tmp.x, tmp.y));
        }
        pt = tmp;
        i++;
      }
      parts2.push(close ? 'Z' : 'L ' + p(pe2.x, pe2.y));
      return parts2.join(' ');
    }

    function walkPath(pathNode) {
      // Corner-rounding for <path rounded="1"> — mxStencil.js:664-721:
      //   * attribute is camelCase `arcSize` (XML getAttribute is
      //     case-sensitive; our parser preserves attribute case);
      //   * absent attribute → Number(null) = 0 (no rounding), NOT 10;
      //   * arcSize is UNSCALED — the points are scaled, the radius is not;
      //   * ONLY move/line children qualify — any other child (including an
      //     explicit <close/>) makes drawio parse the path regularly, i.e.
      //     UNROUNDED;
      //   * each <move> starts an independent segment; a segment whose first
      //     and last points coincide is auto-closed (duplicate point popped).
      if (pathNode.attrs.rounded === '1') {
        var arcSizeAttr = pathNode.attrs.arcSize;
        var arcSizeR = (arcSizeAttr == null) ? 0 : Number(arcSizeAttr);
        var rsegs = [], rok = true, rcount = 0;
        for (var rci = 0; rci < pathNode.children.length; rci++) {
          var rcc = pathNode.children[rci];
          if (rcc.name === 'move' || rcc.name === 'line') {
            if (rcc.name === 'move' || rsegs.length === 0) rsegs.push([]);
            // getAttribute(null) → Number(null) = 0 in drawio; our parser
            // yields undefined for absent attrs (Number(undefined) is NaN).
            rsegs[rsegs.length - 1].push({
              x: tx(Number(rcc.attrs.x != null ? rcc.attrs.x : 0)),
              y: ty(Number(rcc.attrs.y != null ? rcc.attrs.y : 0)) });
            rcount++;
          } else {
            rok = false; // close/curve/arc/quad — drawio parses regularly
            break;
          }
        }
        if (rok && rcount > 0) {
          var rparts = [];
          for (var rsi = 0; rsi < rsegs.length; rsi++) {
            var seg = rsegs[rsi];
            var rclose = false;
            var rs = seg[0], re = seg[seg.length - 1];
            if (seg.length > 1 && rs.x === re.x && rs.y === re.y) {
              seg = seg.slice(0, -1);
              rclose = true;
            }
            var segD = addPointsD(seg, arcSizeR, rclose);
            if (segD) rparts.push(segD);
          }
          return rparts.join(' ');
        }
        // Non-move/line child present — fall through to regular (unrounded) parse.
      }
      var parts = [];
      for (var i = 0; i < pathNode.children.length; i++) {
        var cmd = pathNode.children[i];
        var a = cmd.attrs;
        switch (cmd.name) {
          case 'move':
            parts.push('M ' + fmt(tx(parseFloat(a.x))) + ' ' + fmt(ty(parseFloat(a.y))));
            break;
          case 'line':
            parts.push('L ' + fmt(tx(parseFloat(a.x))) + ' ' + fmt(ty(parseFloat(a.y))));
            break;
          case 'curve':
            parts.push('C ' +
              fmt(tx(parseFloat(a.x1))) + ' ' + fmt(ty(parseFloat(a.y1))) + ' ' +
              fmt(tx(parseFloat(a.x2))) + ' ' + fmt(ty(parseFloat(a.y2))) + ' ' +
              fmt(tx(parseFloat(a.x3))) + ' ' + fmt(ty(parseFloat(a.y3))));
            break;
          case 'quad':
            parts.push('Q ' +
              fmt(tx(parseFloat(a.x1))) + ' ' + fmt(ty(parseFloat(a.y1))) + ' ' +
              fmt(tx(parseFloat(a.x2))) + ' ' + fmt(ty(parseFloat(a.y2))));
            break;
          case 'arc': {
            var rx = trx(parseFloat(a.rx));
            var ry = try_(parseFloat(a.ry));
            var xrot = parseFloat(a['x-axis-rotation'] || a['xAxisRotation'] || 0) || 0;
            var laf = parseInt(a['large-arc-flag'] || a['largeArcFlag'] || 0) || 0;
            var sf = parseInt(a['sweep-flag'] || a['sweepFlag'] || 0) || 0;
            parts.push('A ' + fmt(rx) + ' ' + fmt(ry) + ' ' + xrot + ' ' + laf + ' ' + sf +
              ' ' + fmt(tx(parseFloat(a.x))) + ' ' + fmt(ty(parseFloat(a.y))));
            break;
          }
          case 'close':
            parts.push('Z');
            break;
          default:
            // Unknown path command — silently ignore (draw.io may have extensions)
            break;
        }
      }
      return parts.join(' ');
    }

    // Walk stencil command nodes, emitting SVG elements into shared `elems` array.
    // The path accumulator is shared across background and foreground sections,
    // matching mxStencil.drawChildren() canvas-stateful behaviour:
    //   background: defines geometry path (no paint commands)
    //   foreground: first paint command (fillstroke/fill/stroke) applies to the
    //               background path, then additional geometry+paint for decorations.
    // Returns false if an unsupported feature found (notice already pushed), true otherwise.
    var elems = [];
    var currentPath = null;   // accumulated path d string (or direct element string)
    var currentIsDirect = false; // true when currentPath is a complete <rect>/<ellipse> string

    function walkNodes(nodeList) {
      for (var i = 0; i < nodeList.length; i++) {
        var node = nodeList[i];
        var a = node.attrs;

        switch (node.name) {
          case 'path': {
            var d = walkPath(node);
            if (d === null) return false; // unsupported — caller already got notice
            currentPath = d;
            currentIsDirect = false;
            break;
          }

          case 'rect': {
            var rx = parseFloat(a.x) || 0, ry2 = parseFloat(a.y) || 0;
            var rw = parseFloat(a.w) || 0, rh = parseFloat(a.h) || 0;
            currentPath = '<rect x="' + fmt(tx(rx)) + '" y="' + fmt(ty(ry2)) +
              '" width="' + fmt(rw * sw) + '" height="' + fmt(rh * sh) + '"';
            currentIsDirect = true;
            break;
          }

          case 'roundrect': {
            var rrx = parseFloat(a.x) || 0, rry = parseFloat(a.y) || 0;
            var rrw = parseFloat(a.w) || 0, rrh = parseFloat(a.h) || 0;
            var arcsize = parseFloat(a.arcsize) || 0;
            // mxConstants.RECTANGLE_ROUNDING_FACTOR = 0.15 → default 15% if arcsize=0
            if (!arcsize) arcsize = 15;
            var rr = arcsize / 100 * Math.min(rrw * sw, rrh * sh);
            currentPath = '<rect x="' + fmt(tx(rrx)) + '" y="' + fmt(ty(rry)) +
              '" width="' + fmt(rrw * sw) + '" height="' + fmt(rrh * sh) +
              '" rx="' + fmt(rr) + '" ry="' + fmt(rr) + '"';
            currentIsDirect = true;
            break;
          }

          case 'ellipse': {
            var ex = parseFloat(a.x) || 0, ey = parseFloat(a.y) || 0;
            var ew = parseFloat(a.w) || 0, eh = parseFloat(a.h) || 0;
            // x,y is top-left of the ellipse bounding box
            var ecx = tx(ex + ew / 2);
            var ecy = ty(ey + eh / 2);
            var erx = ew / 2 * sw;
            var ery = eh / 2 * sh;
            currentPath = '<ellipse cx="' + fmt(ecx) + '" cy="' + fmt(ecy) +
              '" rx="' + fmt(erx) + '" ry="' + fmt(ery) + '"';
            currentIsDirect = true;
            break;
          }

          // Paint commands
          case 'fillstroke':
          case 'fill':
          case 'stroke': {
            if (!currentPath) break; // empty accumulator — silently skip (spec §3.4 step 8)

            var fillAttr, strokeAttr;
            if (node.name === 'fill') {
              fillAttr = stateFillAttr();
              strokeAttr = ' stroke="none"';
            } else if (node.name === 'stroke') {
              fillAttr = ' fill="none"';
              strokeAttr = stateStrokeAttrs();
            } else { // fillstroke
              fillAttr = stateFillAttr();
              strokeAttr = stateStrokeAttrs();
            }

            if (currentIsDirect) {
              // currentPath is an SVG element string (rect/ellipse) without closing
              elems.push(currentPath + fillAttr + strokeAttr + '/>');
            } else {
              // currentPath is a path d string
              elems.push('<path d="' + currentPath + '"' + fillAttr + strokeAttr + '/>');
            }
            currentPath = null;
            currentIsDirect = false;
            break;
          }

          // State modifiers
          case 'save':
            stateStack.push({
              fillColor: state.fillColor, strokeColor: state.strokeColor,
              strokeWidth: state.strokeWidth, dashed: state.dashed,
              dashPattern: state.dashPattern, lineCap: state.lineCap,
              lineJoin: state.lineJoin, miterLimit: state.miterLimit,
              alpha: state.alpha, fontColor: state.fontColor,
              fontSize: state.fontSize, fontFamily: state.fontFamily,
              fontStyle: state.fontStyle,
              // the gradient is canvas state too (mxAbstractCanvas2D.save
              // snapshots state.gradient)
              gradId: gradId
            });
            break;
          case 'restore':
            if (stateStack.length > 0) {
              var saved = stateStack.pop();
              state.fillColor = saved.fillColor; state.strokeColor = saved.strokeColor;
              state.strokeWidth = saved.strokeWidth; state.dashed = saved.dashed;
              state.dashPattern = saved.dashPattern; state.lineCap = saved.lineCap;
              state.lineJoin = saved.lineJoin; state.miterLimit = saved.miterLimit;
              state.alpha = saved.alpha; state.fontColor = saved.fontColor;
              state.fontSize = saved.fontSize; state.fontFamily = saved.fontFamily;
              state.fontStyle = saved.fontStyle;
              // Restore the gradient captured at save time (its def is still
              // in gradDefs — defs are collected, never dropped).
              gradId = saved.gradId;
            }
            break;
          case 'strokecolor':
            state.strokeColor = resolveStencilColor(a.color, a.default, state.strokeColor);
            break;
          case 'fillcolor':
            state.fillColor = resolveStencilColor(a.color, a.default, state.fillColor);
            // mxAbstractCanvas2D.setFillColor CLEARS the gradient: after an
            // explicit <fillcolor> the canvas paints SOLID. Previously this
            // minted a NEW gradient id and dropped the old def — earlier
            // elements then referenced a dangling def (broken paint).
            gradId = null;
            break;
          case 'strokewidth': {
            var w = parseFloat(a.width) || 1;
            state.strokeWidth = (a.fixed === '1') ? w : w * su;
            break;
          }
          case 'dashed':
            state.dashed = a.dashed === '1';
            break;
          case 'dashpattern':
            // mxStencil.js:897-916 multiplies each dash value by minScale
            // BEFORE setDashPattern (the strokeWidth scaling in
            // stateStrokeAttrs/createDashPattern then applies on top).
            if (a.pattern != null) {
              state.dashPattern = String(a.pattern).split(/\s+/)
                .filter(function (v) { return v.length > 0; })
                .map(function (v) { return Number(v) * su; })
                .join(' ');
            }
            break;
          case 'linecap':
            state.lineCap = a.cap || 'butt';
            break;
          case 'linejoin':
            state.lineJoin = a.join || 'miter';
            break;
          case 'miterlimit':
            state.miterLimit = parseFloat(a.limit) || 10;
            break;
          case 'alpha':
          case 'fillalpha':
          case 'strokealpha': {
            // Both fill/stroke alpha map to global alpha in mxGraph stencil
            // engine (mxStencil.js:940-951 — all three call canvas.setAlpha).
            // alpha="0" is a VALID value (fully transparent) — `|| 1` treated
            // it as opaque (falsy-zero bug, e.g. hpe_aruba <fillalpha alpha="0">).
            var av = parseFloat(a.alpha);
            state.alpha = clamp01(Number.isFinite(av) ? av : 1);
            break;
          }
          case 'fontcolor':
            state.fontColor = resolveStencilColor(a.color, a.default, state.fontColor);
            break;
          case 'fontsize':
            state.fontSize = (parseFloat(a.size) || 11) * su;
            break;
          case 'fontstyle':
            state.fontStyle = parseInt(a.style || 0) || 0;
            break;
          case 'fontfamily':
            state.fontFamily = a.family || state.fontFamily;
            break;

          // image: emit inline when the source is already a data URI OR the
          // browser-free bake resolved its URL to one. Uses break (not return)
          // so subsequent siblings (fillstroke etc.) still run.
          case 'image': {
            var imgSrc = a.src || '';
            var embeddedImgSrc = (resolved && resolved[imgSrc]) || imgSrc;
            if (embeddedImgSrc.indexOf('data:') === 0) {
              // mxStencil.drawShape: canvas.image(...,aspect=false,flipH,flipV) —
              // stencil images ALWAYS stretch (preserveAspectRatio="none") and
              // honor the node's flipH/flipV; the `aspect` attr is NOT consulted
              // (it controls the SHAPE aspect, not the image). opacity = alpha *
              // fillAlpha (mxSvgCanvas2D.image).
              var iX = tx(parseFloat(a.x) || 0), iY = ty(parseFloat(a.y) || 0);
              var iW = trx(parseFloat(a.w) || 0), iH = try_(parseFloat(a.h) || 0);
              var imgOp = ((state.alpha == null) ? 1 : state.alpha) *
                clamp01(number(style.fillOpacity, 100) / 100);
              var iFlipH = String(a.flipH) === '1', iFlipV = String(a.flipV) === '1';
              var iEl = '<image href="' + embeddedImgSrc + '" x="' + fmt(iX) + '" y="' + fmt(iY) +
                '" width="' + fmt(iW) + '" height="' + fmt(iH) + '"' +
                (imgOp < 1 ? ' opacity="' + fmt(imgOp) + '"' : '') +
                ' preserveAspectRatio="none"/>';
              if (iFlipH || iFlipV) {
                iEl = '<g transform="translate(' + fmt(iFlipH ? 2 * iX + iW : 0) + ' ' +
                  fmt(iFlipV ? 2 * iY + iH : 0) + ') scale(' + (iFlipH ? -1 : 1) + ' ' +
                  (iFlipV ? -1 : 1) + ')">' + iEl + '</g>';
              }
              elems.push(iEl);
            } else {
              if (Array.isArray(notices)) notices.push(degradation('ExporterUnsupportedStencilFeature',
                'stencil uses <image> with unresolved external URL', ''));
            }
            break;
          }
          case 'include-shape': {
            var isName = (a.name || '').toLowerCase();
            var isX = parseFloat(a.x) || 0, isY = parseFloat(a.y) || 0;
            var isW = parseFloat(a.w) || 0, isH = parseFloat(a.h) || 0;
            if (!isName || isW <= 0 || isH <= 0) break;
            var isNode = _stencilRegistry && _stencilRegistry.get(isName);
            if (!isNode) {
              if (Array.isArray(notices)) notices.push(degradation('ExporterUnsupportedStencilFeature',
                'include-shape "' + isName + '" not found in stencil registry', ''));
              break;
            }
            // stencilToSvg() creates fresh state/elems — parent state is never
            // mutated. nested=true: direction rotation/flip apply ONCE at the
            // outermost level (drawio rotates the canvas once; the included
            // stencil only recomputes aspect, mxStencil.js:862-874).
            var isSvg = stencilToSvg(isNode, isW * sw, isH * sh, style, notices, resolved, true);
            if (isSvg) {
              // stencilToSvg() never emits nested <svg>, so this regex is safe.
              var isM = /^<svg[^>]*>([\s\S]*)<\/svg>\s*$/.exec(isSvg);
              var isInner = isM ? isM[1] : '';
              if (isInner) {
                elems.push('<g transform="translate(' + fmt(tx(isX)) + ',' + fmt(ty(isY)) + ')">' +
                  isInner + '</g>');
              }
            }
            break;
          }
          case 'text': {
            var tStr = a.str || '';
            if (tStr) {
              var ttx = tx(parseFloat(a.x) || 0);
              var tty = ty(parseFloat(a.y) || 0);
              // mxStencil.js:824-860 → canvas.text(x, y, 0, 0, str,
              // align||'left', valign||'top', …, rotation):
              //   align defaults LEFT (anchor start), valign defaults TOP;
              //   vertical="1" starts at -90 and the rotation attr SUBTRACTS.
              var tAnchor = a.align === 'right' ? 'end'
                : a.align === 'center' ? 'middle' : 'start';
              var tRot = (a.vertical === '1' ? -90 : 0) - number(a.rotation, 0);
              // align-shape="0" counter-rotates against the SHAPE rotation —
              // only observable when the cell itself is rotated. Not modelled
              // headless: loud notice instead of a silently wrong angle.
              if (a['align-shape'] === '0' && number(style.rotation, 0) !== 0) {
                if (Array.isArray(notices)) notices.push(degradation(
                  'ExporterUnsupportedStencilFeature',
                  'stencil <text align-shape="0"> on a rotated cell is not counter-rotated', ''));
              }
              // Font size is the CANVAS state: <fontsize> nodes were already
              // scaled by minScale when they set state.fontSize — multiplying
              // by su again here double-scaled every stencil text.
              var tFs = state.fontSize || 11;
              var tFf = state.fontFamily || 'Arial';
              var tFc = hex(state.fontColor || '#000000');
              // Baseline math from mxSvgCanvas2D.plainText (w=h=0, no clip):
              //   first-line baseline cy = y + size - 1; middle subtracts
              //   textHeight/2; bottom subtracts textHeight + 1;
              //   line height = round(size * mxConstants.LINE_HEIGHT (1.2)).
              var tLines = String(tStr).split('\n');
              var tLh = Math.round(tFs * 1.2);
              var tTextH = tFs + (tLines.length - 1) * tLh;
              var tCy = tty + tFs - 1;
              if (a.valign === 'middle') tCy -= tTextH / 2;
              else if (a.valign === 'bottom') tCy -= tTextH + 1;
              var tStyleAttrs = '';
              var tFsBits = number(state.fontStyle, 0);
              if (tFsBits & 1) tStyleAttrs += ' font-weight="bold"';
              if (tFsBits & 2) tStyleAttrs += ' font-style="italic"';
              if (tFsBits & 4) tStyleAttrs += ' text-decoration="underline"';
              if (state.alpha < 1) tStyleAttrs += ' opacity="' + fmt(state.alpha) + '"';
              // rotation about the anchor point, like plainText's
              // rotate(r, x, y) group transform.
              var tOpen = tRot !== 0
                ? '<g transform="rotate(' + fmt(tRot) + ' ' + fmt(ttx) + ' ' + fmt(tty) + ')">' : '';
              var tClose = tRot !== 0 ? '</g>' : '';
              var tBody = '';
              for (var tli = 0; tli < tLines.length; tli++) {
                tBody += '<text x="' + fmt(ttx) + '" y="' + fmt(tCy + tli * tLh) + '"' +
                  ' text-anchor="' + tAnchor + '"' +
                  ' font-family="' + escXml(tFf) + '" font-size="' + fmt(tFs) + '"' +
                  ' fill="' + tFc + '"' + tStyleAttrs + '>' + escXml(tLines[tli]) + '</text>';
              }
              elems.push(tOpen + tBody + tClose);
            }
            break;
          }

          default:
            // Unrecognized command — silently skip (forward-compatibility)
            break;
        }
      }
      return true;
    }

    // Step 5: Walk <background> and <foreground> sections with shared path accumulator.
    // Per draw.io stencil spec: background defines geometry, foreground first command paints it.
    for (var si = 0; si < shapeNode.children.length; si++) {
      var section = shapeNode.children[si];
      if (section.name === 'background' || section.name === 'foreground') {
        if (!walkNodes(section.children)) return null;
      }
      // 'connections' and other sections are silently skipped
    }

    // Step 12+3: flip + direction, composed exactly like mxShape.updateTransform
    // (flipH/flipV SWAPPED for N/S — mxShape.js:1417) + mxSvgCanvas2D.rotate
    // (mxSvgCanvas2D.js:1342): the path is drawn in the dimension-swapped (cw×ch)
    // computeAspect space; a single-axis flip NEGATES the rotation (swaps N↔S /
    // E↔W folding) AND mirrors in DISPLAY space about the cell centre; both flips
    // rotate +180 with no mirror. The direction transform maps the cw×ch space
    // onto the cellW×cellH viewport (translate forms handle non-square delta).
    var innerContent = elems.join('');
    if (nested) {
      // include-shape sub-render: the outermost render already rotated/flipped
      // the whole shape. drawio's nested computeAspect still swaps the scales for
      // north/south AND offsets by delta = (w-h)/2 (mxStencil.js:497-508); the
      // swap happened above via cw/ch — apply only the delta here.
      if (dir === 'north' || dir === 'south') {
        var dlt = (cellW - cellH) / 2;
        if (dlt !== 0) {
          innerContent = '<g transform="translate(' + fmt(dlt) + ',' + fmt(-dlt) + ')">' + innerContent + '</g>';
        }
      }
      // east/west: nothing — no nested rotation in drawio.
    } else {
      var nsInv = (dir === 'north' || dir === 'south');
      var sfH = boolish(style.flipH) || boolish(style.stencilFlipH);
      var sfV = boolish(style.flipV) || boolish(style.stencilFlipV);
      if (nsInv) { var swp = sfH; sfH = sfV; sfV = swp; }
      var bothF = sfH && sfV, xorF = sfH !== sfV;
      // theta adjustment as a direction relabel: both flips => +180 (N↔S, E↔W);
      // single flip => negate (N↔S; E/W are ±180 ≡ self).
      var effDir = dir;
      if (bothF) {
        effDir = dir === 'north' ? 'south' : dir === 'south' ? 'north'
          : dir === 'west' ? 'east' : 'west';
      } else if (xorF) {
        effDir = dir === 'north' ? 'south' : dir === 'south' ? 'north' : dir;
      }
      if (effDir === 'north') {
        innerContent = '<g transform="translate(0,' + fmt(cellH) + ') rotate(-90)">' + innerContent + '</g>';
      } else if (effDir === 'south') {
        innerContent = '<g transform="translate(' + fmt(cellW) + ',0) rotate(90)">' + innerContent + '</g>';
      } else if (effDir === 'west') {
        innerContent = '<g transform="rotate(180 ' + fmt(cellW / 2) + ' ' + fmt(cellH / 2) + ')">' + innerContent + '</g>';
      }
      // single-axis flip: mirror in DISPLAY space about the cell centre.
      if (xorF) {
        if (sfH) innerContent = '<g transform="translate(' + fmt(cellW) + ',0) scale(-1,1)">' + innerContent + '</g>';
        if (sfV) innerContent = '<g transform="translate(0,' + fmt(cellH) + ') scale(1,-1)">' + innerContent + '</g>';
      }
    }

    // Step 13: Assemble final SVG
    var defsStr = gradDefs.length ? '<defs>' + gradDefs.join('') + '</defs>' : '';
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + fmt(cellW) +
      '" height="' + fmt(cellH) + '">' +
      defsStr + innerContent + '</svg>';
  }

  function number(v, fallback) {
    var n = parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function boolish(v) {
    return v === true || v === 1 || v === '1' || v === 'true';
  }

  // Replicates drawio's `if (mxUtils.getValue(style, key, def))` truthiness for
  // flags it reads with a BARE `if(...)` (not an `== '1'` comparison). In the
  // browser, style values are STRINGS, so '0' and even 'false' are JS-truthy —
  // only '' / real false / null are falsy; an absent key uses `def`. The headless
  // parser numericizes '0'->0 (JS-falsy), which would silently flip such a flag,
  // so coerce a numeric 0 back to truthy to match what the operator sees.
  // (e.g. CylinderShape3 `lid`: `lid=0` still draws the lid in the app.)
  function drawioFlag(v, def) {
    if (v === undefined || v === null) return def;
    if (v === '' || v === false) return false;
    return true;
  }

  function clamp01(v) {
    return Math.max(0, Math.min(1, v));
  }

  function opacity(style, key) {
    // mxSvgCanvas2D composes MULTIPLICATIVELY: fill-opacity = alpha *
    // fillAlpha (same for stroke). The old "specific OR general" fallback
    // silently rendered opacity=50;fillOpacity=50 at 0.5 instead of 0.25.
    var base = style && style.opacity != null
      ? clamp01(number(style.opacity, 100) / 100) : 1;
    // key === 'opacity' callers want the base alpha itself, not its square.
    var specific = style && key && key !== 'opacity' && style[key] != null
      ? clamp01(number(style[key], 100) / 100) : null;
    return specific == null ? base : base * specific;
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

  // STRICT WYSIWYG on the HARVEST path: drawio's rendered SVG carries theme
  // colors as CSS `light-dark(L, D)` / `var(--x, fb)` in inline `style`
  // attributes (which OVERRIDE the hex presentation attrs). resvg (0.47) cannot
  // parse those → it drops the fill and the shape prints SOLID BLACK. Resolve
  // them to concrete colors for the ACTIVE theme right in the serialized SVG
  // string. Paren-aware (the inline form uses rgb(r, g, b) whose commas defeat
  // themeColor's simple regex); processes leftmost call each pass, looping so a
  // chosen light-dark side that is itself a var() resolves too.
  function getAutosizeTextFontSizeHeadless(raw, style, w, h) {
    // String() coercion: mxGraph getCellStyle returns numeric values as NUMBERS
    // (horizontal=0 → 0, not '0'), so a bare `=== '0'` silently fails in the
    // browser. Coerce before comparing.
    var isHorizontal = String(style.horizontal) !== '0';
    var dx = 0;
    var dy = 0;
    var spacing = parseFloat(style.spacing != null ? style.spacing : 2);
    var spacingLeft = parseFloat(style.spacingLeft != null ? style.spacingLeft : 2);
    var spacingRight = parseFloat(style.spacingRight != null ? style.spacingRight : 2);
    var spacingTop = parseFloat(style.spacingTop != null ? style.spacingTop : 2);
    var spacingBottom = parseFloat(style.spacingBottom != null ? style.spacingBottom : 2);

    dx += 2 * spacing + spacingLeft + spacingRight;
    dy += 2 * spacing + spacingTop + spacingBottom;

    var availW = (isHorizontal ? w : h) - dx;
    var availH = (isHorizontal ? h : w) - dy;

    if (availW <= 0 || availH <= 0) {
      return 1;
    }

    function checkFits(fontSize) {
      var baseSize = fontSize;
      var s = String(raw == null ? '' : raw);
      var blocks = [];
      if (s.indexOf('<') < 0) {
        blocks = s.split('\n').map(function (line) {
          return { text: line, size: baseSize, gap: 0 };
        });
      } else {
        var re = /<(h[1-6]|p|div|li)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
        var m;
        while ((m = re.exec(s))) {
          var tag = m[1].toLowerCase();
          var body = m[2].replace(/<br\s*\/?>/gi, '\n');
          var full = m[0];
          blocks.push({
            text: stripHtml(body).replace(/[ \t\r]+/g, ' ')
              .replace(/ *\n */g, '\n').trim(),
            size: tag === 'h1' ? Math.max(24, baseSize * 2) : baseSize,
            gap: tag.charAt(0) === 'h' ? 5 : 0
          });
        }
      }

      if (blocks.length === 0) {
        blocks.push({ text: String(raw || ''), size: baseSize, gap: 0 });
      }

      var rows = [];
      var isWrap = style.whiteSpace === 'wrap';
      // Keep the fit-check identical to the plain render path: thread
      // letterSpacing into the wrap and ROUND the line pitch (the render uses
      // Math.round(size*1.2)); otherwise the autosize fit can disagree with the
      // final layout by a sub-pixel-per-line drift.
      var autoLs = number(style.letterSpacing, 0);
      for (var bi = 0; bi < blocks.length; bi++) {
        var b = blocks[bi];
        var wrappedLines = wrapSvgText(b.text, b.size, availW, isWrap, autoLs, style.fontFamily, ((number(style.fontStyle, 0) & 1) !== 0));
        for (var li = 0; li < wrappedLines.length; li++) {
          rows.push({
            text: wrappedLines[li],
            size: b.size,
            lineH: Math.round(b.size * 1.2),   // mxConstants.LINE_HEIGHT, rounded like the render
            gap: li === 0 ? b.gap : 0
          });
        }
      }

      var totalH = 0;
      for (var ri = 0; ri < rows.length; ri++) {
        var r = rows[ri];
        totalH += r.lineH + (ri === 0 ? 0 : r.gap);
      }

      if (totalH > availH) return false;

      if (isWrap) {
        for (var bj = 0; bj < blocks.length; bj++) {
          var bk = blocks[bj];
          var words = bk.text.split(/\s+/).filter(function (w) { return w !== ''; });
          for (var wi = 0; wi < words.length; wi++) {
            // The unbreakable unit is the wrap unit, not the whole word: a
            // CJK run can break between any two ideographs.
            var units = splitBreakable(words[wi]);
            for (var ui = 0; ui < units.length; ui++) {
              if (textWidthPx(units[ui], bk.size, 0, style.fontFamily, ((number(style.fontStyle, 0) & 1) !== 0)) > availW) {
                return false;
              }
            }
          }
        }
      } else {
        for (var rj = 0; rj < rows.length; rj++) {
          if (textWidthPx(rows[rj].text, rows[rj].size, 0, style.fontFamily, ((number(style.fontStyle, 0) & 1) !== 0)) > availW) {
            return false;
          }
        }
      }

      return true;
    }

    var lo = 1;
    var hi = 84;
    var optimalFontSize = 12;
    while (lo <= hi) {
      var mid = Math.floor((lo + hi) / 2);
      if (checkFits(mid)) {
        optimalFontSize = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return optimalFontSize;
  }

  // isVertex flag distinguishes the default-style sets from styles/default.xml:
  // defaultVertex has fillColor="default", strokeColor="default", fontColor="default";
  // defaultEdge has strokeColor="default", fontColor="default" (no fill).
  // The live path: getCellStyle merges the mxStylesheet defaults so these keys
  // are always present. The headless path: getCellStyle returns only the raw cell
  // style → no defaults. Supply them here so headless and live are consistent.
  function resolveThemeDefaults(style, graph, isVertex, cell) {
    if (!style) return style;
    var model = graph && typeof graph.getModel === 'function' ? graph.getModel() : null;
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

    // Auto-size font if autosizeText=1 is specified (headless path only since live mxGraph handles it)
    if (isVertex && boolish(style.autosizeText) && cell) {
      var state = graph && graph.view && typeof graph.view.getState === 'function' ? graph.view.getState(cell) : null;
      var w = cell.geometry ? cell.geometry.width : (state ? state.width / (graph.view.scale || 1) : 0);
      var h = cell.geometry ? cell.geometry.height : (state ? state.height / (graph.view.scale || 1) : 0);
      if (w > 0 && h > 0) {
        var rawLabel = graph && typeof graph.getLabel === 'function' ? graph.getLabel(cell) : '';
        if (rawLabel) {
          var autoSize = getAutosizeTextFontSizeHeadless(rawLabel, style, w, h);
          if (autoSize) {
            set('fontSize', String(autoSize));
          }
        }
      }
    }
    // Resolve "inherit" values by walking up the parent chain
    Object.keys(style).forEach(function (k) {
      if (style[k] === 'inherit') {
        var curr = cell;
        while (curr && curr.parent && model && model.cells) {
          var parent = model.cells[curr.parent];
          if (!parent) break;
          var parentStyle = graph.getCellStyle(parent);
          var parentVal = parentStyle ? parentStyle[k] : null;
          if (parentVal && parentVal !== 'inherit') {
            set(k, parentVal);
            break;
          }
          curr = parent;
        }
      }
    });
    style = out;
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
    // Both style resolvers DELETE keys whose value is "none" (browser
    // getCellStyle and the headless faithfulCellStyle), so an explicit
    // strokeColor=none / fillColor=none would be re-forced to a theme default
    // below (e.g. a black border on a borderless note), and an explicit
    // endArrow=none would be re-forced to the defaultEdge classic arrow.
    // Recover the author's explicit "none" from the raw style string
    // (graph.getModel().getStyle(cell) returns it on both paths).
    var rawStyleStr = null;
    try {
      rawStyleStr = (graph && graph.getModel && typeof graph.getModel().getStyle === 'function')
        ? graph.getModel().getStyle(cell) : null;
      if (typeof rawStyleStr === 'string') {
        ['strokeColor', 'fillColor', 'fontColor', 'gradientColor'].forEach(function (key) {
          if (!(key in out) &&
              new RegExp('(^|;)\\s*' + key + '\\s*=\\s*none\\s*(;|$)', 'i').test(rawStyleStr)) {
            set(key, 'none');
          }
        });
      }
    } catch (e) { /* ignore — fall through to defaults */ }
    // True when the raw cell style explicitly sets key=none (deleted by the
    // stylesheet resolvers, so indistinguishable from "absent" in `out`).
    var rawExplicitNone = function (key) {
      return typeof rawStyleStr === 'string' &&
        new RegExp('(^|;)\\s*' + key + '\\s*=\\s*none\\s*(;|$)', 'i').test(rawStyleStr);
    };
    // Supply drawio's stylesheet defaults when absent (styles/default.xml
    // defaultVertex: fillColor="default", strokeColor="default", fontColor="default";
    // defaultEdge: strokeColor="default", fontColor="default").
    // On the live path getCellStyle already merges these; on the headless path
    // getCellStyle returns only the raw cell style, so we fill them in.
    if (!('strokeColor' in out)) set('strokeColor', fg);
    if (!('fontColor' in out)) set('fontColor', fg);
    if (isVertex && !('fillColor' in out)) set('fillColor', bg);
    // drawio's defaultEdge style carries endArrow=classic, so a plain edge DOES
    // print a classic arrowhead — but an author's explicit endArrow=none was
    // deleted by the stylesheet resolver and must NOT be re-defaulted here
    // (it silently printed an arrowhead the editor does not draw).
    if (!isVertex && !('endArrow' in out) && !rawExplicitNone('endArrow')) {
      set('endArrow', 'classic');
    }
    return out;
  }

  // drawio draws a label background (and optional border) box behind the text,
  // ABOVE the shape. The bake never emitted it -> labelled text printed with
  // no box. Colors here are already theme-resolved by resolveThemeDefaults
  // (WYSIWYG). Accepts drawio's 8-digit #rrggbbaa label-bg alpha form too.
  // Box == the label box passed to labelTextNode: exact for fixed/wrapped text
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

  // SVG-string form of labelBoxNode (labelBackgroundColor/labelBorderColor),
  // for the rotated label builders where the box must live INSIDE the rotate
  // group (it rotates with the text). Returns '' when neither is set.
  function labelBoxSvgStr(style, bx, by, bw, bh) {
    var bg = colorToSolid(style.labelBackgroundColor);
    var bc = isPaintable(style.labelBorderColor) ? style.labelBorderColor : null;
    if (!bg && !bc) return '';
    return '<rect x="' + fmt(bx) + '" y="' + fmt(by) + '" width="' + fmt(Math.max(0, bw)) +
      '" height="' + fmt(Math.max(0, bh)) + '" fill="' + (bg ? hex(bg.color) : 'none') + '"' +
      (bg && bg.alpha < 1 ? ' fill-opacity="' + fmt(bg.alpha) + '"' : '') +
      (bc ? ' stroke="' + hex(bc) + '" stroke-width="' +
        fmt(Math.max(0.1, number(style.labelBorderWidth, 1))) + '"' : ' stroke="none"') + '/>';
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

  // Fill a sub-region rect (e.g. a swimlane header) with the cell's fillColor,
  // emitting a faithful kind:'svg' linear-gradient node when gradientColor is
  // set (so the gradient direction is preserved) instead of a structural
  // gradient path (which loses direction -> GradientDirectionApprox). Returns
  // null when there is no fill.
  function regionFillNode(style, rbox) {
    if (!isPaintable(style.fillColor)) return null;
    if (isPaintable(style.gradientColor)) {
      var gid = 'r' + stableGradId(style.fillColor, style.gradientColor);
      var rfa = opacity(style, 'fillOpacity');
      var inner = '<defs>' + linearGradDef(gid, hex(style.fillColor),
        hex(style.gradientColor), style.gradientDirection) + '</defs>' +
        '<rect x="0" y="0" width="' + fmt(rbox.w) + '" height="' + fmt(rbox.h) +
        '" fill="url(#' + gid + ')"' +
        (rfa < 1 ? ' fill-opacity="' + fmt(rfa) + '"' : '') + '/>';
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + fmt(rbox.w) +
        '" height="' + fmt(rbox.h) + '">' + inner + '</svg>';
      return { kind: 'svg', box: { x: rbox.x, y: rbox.y, w: rbox.w, h: rbox.h },
        source: base64(svg), aspect: 'preserve' };
    }
    return { kind: 'path', d: rectPath(rbox.x, rbox.y, rbox.w, rbox.h),
      fill: solid(style.fillColor, opacity(style, 'fillOpacity')), stroke: null };
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
    if (!out.length) out = [3, 3];
    // drawio mxSvgCanvas2D.createDashPattern multiplies each dash value by the
    // stroke width (unless fixDash=1), so thick dashed strokes have
    // proportionally larger dashes/gaps. Match it — previously strokeWidth was
    // ignored, making thick dashes look near-solid.
    var sc = boolish(style.fixDash) ? 1 : number(style.strokeWidth, 1);
    if (sc > 0 && sc !== 1) out = out.map(function (v) { return Math.round(v * sc * 100) / 100; });
    return out;
  }

  function fmt(n) {
    var rounded = Math.round(n * 1000) / 1000;
    return String(Object.is(rounded, -0) ? 0 : rounded);
  }

  // --- SVG-string helpers for headless rotated-shape nodes ---
  // Used by emitVertex when style.rotation≠0.
  // Produces kind:'svg' so shape + label rotate together.

  function escXml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fillSvgAttr(style, gradId) {
    if (!isPaintable(style.fillColor)) return ' fill="none"';
    // mxSvgCanvas2D.updateFill sets fill-opacity = alpha * fillAlpha for BOTH
    // solid and gradient fills (mxSvgCanvas2D.js:1056) — a gradient cell with
    // fillOpacity/opacity previously printed fully opaque.
    var a = opacity(style, 'fillOpacity');
    var aAttr = a < 1 ? ' fill-opacity="' + fmt(a) + '"' : '';
    if (isPaintable(style.gradientColor) && gradId) return ' fill="url(#' + gradId + ')"' + aAttr;
    return ' fill="' + hex(style.fillColor) + '"' + aAttr;
  }

  function strokeSvgAttrs(style) {
    if (!isPaintable(style.strokeColor)) return ' stroke="none"';
    var s = ' stroke="' + hex(style.strokeColor) + '"';
    var sw = Math.max(0.1, number(style.strokeWidth, 1));
    s += ' stroke-width="' + fmt(sw) + '"';
    var sc = style.lineCap === 'round' ? 'round' : style.lineCap === 'square' ? 'square' : 'butt';
    var sj = style.lineJoin === 'round' || boolish(style.rounded) ? 'round' :
      style.lineJoin === 'bevel' ? 'bevel' : 'miter';
    s += ' stroke-linecap="' + sc + '" stroke-linejoin="' + sj + '"';
    if (boolish(style.dashed)) {
      var dp = dashPattern(style);
      s += ' stroke-dasharray="' + dp.map(fmt).join(' ') + '"';
    }
    var so = opacity(style, 'strokeOpacity');
    if (so < 1) s += ' stroke-opacity="' + fmt(so) + '"';
    return s;
  }

  // Generate an inline SVG with hatch/dot fill for sketch=1 shapes.
  // relD is the 0-origin shape path; w/h are the shape box dimensions in px.
  function sketchFillSvg(style, relD, w, h) {
    var fs = style.fillStyle || 'hachure';
    var sw = Math.max(0.1, number(style.strokeWidth, 1));
    var rawFw = number(style.fillWeight, -1);
    var fw = rawFw < 0 ? Math.max(0.1, sw / 2) : Math.max(0.1, rawFw);
    var gap = Math.max(0.5, number(style.hachureGap, fw * 4));
    var angle = number(style.hachureAngle, -41);
    var fColor = isPaintable(style.fillColor) ? hex(style.fillColor) : '#000000';
    var fOpacity = opacity(style, 'fillOpacity');
    var fOpAttr = fOpacity < 1 ? ' stroke-opacity="' + fmt(fOpacity) + '"' : '';
    var fFillOpAttr = fOpacity < 1 ? ' fill-opacity="' + fmt(fOpacity) + '"' : '';
    var diag = Math.sqrt(w * w + h * h);
    var cx = w / 2, cy = h / 2;

    function lineSet(ang) {
      var theta = ang * Math.PI / 180;
      var cosT = Math.cos(theta), sinT = Math.sin(theta);
      var lines = '';
      for (var offset = -diag; offset <= diag + gap; offset += gap) {
        var px = cx + offset * cosT, py = cy + offset * sinT;
        var x1 = px - diag * sinT, y1 = py + diag * cosT;
        var x2 = px + diag * sinT, y2 = py - diag * cosT;
        lines += '<line x1="' + fmt(x1) + '" y1="' + fmt(y1) +
                 '" x2="' + fmt(x2) + '" y2="' + fmt(y2) +
                 '" stroke="' + fColor + '"' + fOpAttr +
                 ' stroke-width="' + fmt(fw) + '"/>';
      }
      return lines;
    }

    var content;
    if (fs === 'dots') {
      // draw.io's current rough renderer paints this fixture's "dots" style as
      // a single diagonal hatch, not circular dots.
      content = lineSet(angle);
    } else if (fs === 'cross-hatch') {
      content = lineSet(angle) + lineSet(angle + 90);
    } else { // hachure (default for sketch=1)
      content = lineSet(angle);
    }

    // Inner content only (no <svg> wrapper) so the caller can pad the viewport
    // via paddedSvgShapeNode — otherwise the outline stroke is half-clipped.
    return '<defs><clipPath id="sk"><path d="' + relD + '"/></clipPath></defs>' +
      '<g clip-path="url(#sk)">' + content + '</g>' +
      '<path d="' + relD + '" fill="none"' + strokeSvgAttrs(style) + '/>';
  }

  function textSvgStr(label, cx, cy, style) {
    if (!label) return '';
    var fs = Math.max(1, number(style.fontSize, 11));
    var ff = style.fontFamily || 'Arial';
    var fc = style.fontColor || '#000000';
    var fsVal = number(style.fontStyle, 0);
    var isBold = !!(fsVal & 1);
    var isItalic = !!(fsVal & 2);
    var deco = [];
    if (fsVal & 4) deco.push('underline');
    if (fsVal & 8) deco.push('line-through');
    var topac = number(style.textOpacity, 100) / 100;
    var attrs = ' text-anchor="middle" dominant-baseline="central"' +
      ' font-family="' + escXml(ff) + '" font-size="' + fmt(fs) + '"' +
      ' fill="' + fc + '"' +
      (topac < 1 ? ' fill-opacity="' + fmt(topac) + '"' : '') +
      (isBold ? ' font-weight="bold"' : '') +
      (isItalic ? ' font-style="italic"' : '') +
      (deco.length ? ' text-decoration="' + deco.join(' ') + '"' : '');
    var lines = label.split('\n');
    if (lines.length === 1) {
      return '<text x="' + fmt(cx) + '" y="' + fmt(cy) + '"' + attrs + '>' +
        escXml(label) + '</text>';
    }
    var lineH = fs * 1.2;
    var startDy = -(lines.length - 1) * lineH / 2;
    var spans = lines.map(function (ln, i) {
      return '<tspan x="' + fmt(cx) + '" dy="' + fmt(i === 0 ? startDy : lineH) + '">' +
        escXml(ln) + '</tspan>';
    }).join('');
    return '<text x="' + fmt(cx) + '" y="' + fmt(cy) + '"' + attrs + '>' + spans + '</text>';
  }

  // Label SVG for the rotated-cell builders (rotation≠0). HTML labels route
  // through the faithful rich renderer so per-run formatting survives rotation;
  // plain labels use the centered single-block textSvgStr. `ox,oy,w,h` is the
  // shape's box inside the (un-rotated) expanded viewport.
  function rotatedLabelEls(graph, cell, style, ox, oy, w, h, label, notices, resolved) {
    var raw = graph && typeof graph.getLabel === 'function' ? graph.getLabel(cell) : label;
    var src = raw != null ? raw : label;
    // drawio computes getLabelBounds PRE-rotation, then rotates; so inset the
    // label box by the shape's margin here too (internal labels only) — a
    // rotated boundedLbl cube/datastore/process/etc. is inset in the app.
    var rbox = { x: ox, y: oy, w: w, h: h };
    if (externalLabelBox(style, rbox) === rbox) {
      var rlm = applyLabelMargins(rbox, style);
      ox = rlm.x; oy = rlm.y; w = rlm.w; h = rlm.h;
    }
    // Non-HTML labels are literal text: a '<' must not trigger rich HTML parsing.
    if (isHtmlLabelStyle(style) && String(src == null ? '' : src).indexOf('<') >= 0) {
      var rich = renderRichLabel(src, style, { w: w, h: h }, resolved, notices, cell && cell.id);
      if (!rich || rich.body === '') return '';
      var v = textDefaultValign(style);
      var fillW = style.overflow === 'fill' || style.overflow === 'width';
      if (fillW) v = 'top';
      var rlpads = labelPads(style);
      var off = v === 'middle' ? (h - rich.height) / 2 : v === 'bottom' ? h - rich.height - rlpads.b : rlpads.t;
      off = Math.max(0, off);
      // labelBackgroundColor/labelBorderColor box (rotates with the label) —
      // sized to the laid-out text bbox (or the full region for fill/width),
      // matching drawio's mxText label background. Dropped silently before.
      var rbg = fillW
        ? labelBoxSvgStr(style, ox, oy, w, h)
        : labelBoxSvgStr(style, ox + rlpads.l + (rich.minX || 0), oy + off,
            Math.max(1, (rich.maxX || 0) - (rich.minX || 0)), rich.height);
      return rbg + '<g transform="translate(' + fmt(ox + rlpads.l) + ' ' + fmt(oy + off) + ')">' +
        rich.body + '</g>';
    }
    // HTML-style label without markup: still entity-encoded (browser innerHTML
    // decodes &amp;/&nbsp;/… even with no tags) — decode before literal render.
    var lit = isHtmlLabelStyle(style) ? decodeHtmlEntities(src) : label;
    if (lit === '') return '';
    // labelBackground/border box for the plain centered label: text bbox sized
    // via the AFM metrics (or the full region for fill/width overflow).
    var pbg = '';
    if (style.labelBackgroundColor || style.labelBorderColor) {
      if (style.overflow === 'fill' || style.overflow === 'width') {
        pbg = labelBoxSvgStr(style, ox, oy, w, h);
      } else {
        var pfs = Math.max(1, number(style.fontSize, 11));
        var pbold = !!(number(style.fontStyle, 0) & 1);
        var plines = String(lit).split('\n');
        var pw = 0;
        for (var pli = 0; pli < plines.length; pli++) {
          pw = Math.max(pw, textWidthPx(plines[pli], pfs, 0, style.fontFamily, pbold));
        }
        var ph = plines.length * pfs * 1.2;
        pbg = labelBoxSvgStr(style, ox + w / 2 - pw / 2, oy + h / 2 - ph / 2, pw, ph);
      }
    }
    return pbg + textSvgStr(lit, ox + w / 2, oy + h / 2, style);
  }

  function decodeHtmlEntities(s) {
    // &amp; must decode LAST (decoding it first double-decoded "&amp;lt;" to
    // "<" instead of the literal 4-char "&lt;"); numeric references need
    // fromCodePoint (fromCharCode corrupts astral code points like emoji);
    // &nbsp; is U+00A0 (NO-BREAK SPACE), not a plain collapsible space.
    return String(s == null ? '' : s)
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, '\u00A0')
      .replace(/&#(\d+);/g, function(_, n) { return String.fromCodePoint(+n); })
      .replace(/&#x([0-9a-fA-F]+);/g, function(_, h) {
        return String.fromCodePoint(parseInt(h, 16));
      })
      .replace(/&amp;/g, '&');
  }

  function stripHtml(s) {
    return decodeHtmlEntities(String(s == null ? '' : s).replace(/<[^>]+>/g, ''));
  }

  // drawio Graph.isHtmlLabel: a label is HTML iff style html==1 OR
  // whiteSpace==wrap. Otherwise it is PLAIN text and any '<' is a literal
  // character (e.g. a UML label "List<String>" shows the angle brackets).
  function isHtmlLabelStyle(style) {
    return number(style && style.html, 0) === 1 ||
      (style && style.whiteSpace === 'wrap');
  }

  // Per-side label padding, matching drawio mxText: each side = global spacing
  // (STYLE_SPACING default 2) + the per-side spacingLeft/Right/Top/Bottom
  // (default 0). The `text` shape keeps the bake's historical zero base. The old
  // code used a flat pad=2 and ignored per-side spacing, so a label with e.g.
  // spacingLeft=52 printed flush-left instead of indented.
  function labelPads(style) {
    var base = (style && style.shape === 'text') ? 0 : number(style && style.spacing, 2);
    // labelPadding (STYLE_LABEL_PADDING) is a uniform inset added to every side
    // of the label bounds; previously ignored, so a padded label printed flush.
    var lp = number(style && style.labelPadding, 0);
    return {
      l: base + lp + number(style && style.spacingLeft, 0),
      r: base + lp + number(style && style.spacingRight, 0),
      t: base + lp + number(style && style.spacingTop, 0),
      b: base + lp + number(style && style.spacingBottom, 0)
    };
  }

  // Place a label box OUTSIDE the shape per drawio's labelPosition (left/right)
  // and verticalLabelPosition (top/bottom). Returns the shape box unchanged for
  // the default center/middle placement. The existing style.align/verticalAlign
  // anchoring then lands the text against the correct shape edge (e.g.
  // labelPosition=right is paired with align=left so text starts at the right
  // edge). Width/height for the external band are generous so text isn't clipped.
  function externalLabelBox(style, box) {
    // Exact mxGraphView.updateVertexLabelOffset + mxCellRenderer label
    // bounds: the external band is the FULL cell size shifted by one cell
    // extent (not an invented fontSize-derived band, which landed
    // band-interior align combos tens of px off), and labelWidth overrides
    // the band width (center: shifted inside the cell by the align dx).
    var lp = style && style.labelPosition;
    var vlp = style && style.verticalLabelPosition;
    var lwOver = style && style.labelWidth != null && style.labelWidth !== ''
      ? number(style.labelWidth, 0) : null;
    var horiz = lp && lp !== 'center';
    var vert = vlp && vlp !== 'middle';
    if (!horiz && !vert && lwOver == null) return box;
    var bx = box.x, by = box.y, bw = box.w, bh = box.h;
    if (vert) {
      if (vlp === 'bottom') { by = box.y + box.h; }
      else if (vlp === 'top') { by = box.y - box.h; }
    }
    if (lp === 'left') {
      bw = lwOver != null ? lwOver : box.w;
      bx = box.x - bw;
    } else if (lp === 'right') {
      bx = box.x + box.w;
      if (lwOver != null) bw = lwOver;
    } else if (lwOver != null) {
      var dxA = style.align === 'right' ? 1 : (style.align === 'left' ? 0 : 0.5);
      bx = box.x - (lwOver - box.w) * dxA;
      bw = lwOver;
    }
    return { x: bx, y: by, w: bw, h: bh };
  }

  // Per-shape label INSETS (mxShape.getLabelMargins / getLabelBounds): some
  // shapes confine the label to a sub-region of the cell (e.g. the cube reserves
  // the depth band, the datastore the disk stack, the callout the tail recess).
  // Returns {l,t,r,b} in EAST orientation, or null when the shape applies none.
  // The exporter previously honored this only for umlFrame/umlLifeline, so every
  // other margin-defining shape printed its label over the reserved region.
  function labelMargins(style, w, h) {
    var shape = style.shape;
    var sw = number(style.strokeWidth, 1);
    // drawio reads boundedLbl with `if(getValue(style,'boundedLbl',false))`, so
    // the string '0' is truthy too — use drawioFlag (not boolish) to match the
    // app even for the hand-authored boundedLbl=0 case (NB-2).
    var bounded = drawioFlag(style.boundedLbl, false);
    if (shape === 'cube' && bounded) {
      var cs = Math.max(0, Math.min(w, Math.min(h, number(style.size, 20))));
      return { l: cs, t: cs, r: 0, b: 0 };
    }
    if (shape === 'datastore' || shape === 'dataStore') { // unconditional
      var dy = Math.min(h / 2, Math.round(h / 8) + sw - 1);
      return { l: 0, t: 2.5 * dy, r: 0, b: 0 };
    }
    if (shape === 'callout') { // unconditional
      return { l: 0, t: 0, r: 0, b: number(style.size, 30) };
    }
    if (shape === 'cylinder' && bounded) {
      return { l: 0, t: Math.min(40, h * number(style.size, 0.15) * 2), r: 0, b: 0 };
    }
    if (shape === 'note2' && bounded) {
      // NoteShape2.getLabelMargins (Shapes.js:1453): top AND bottom by size.
      var n2 = number(style.size, 15);
      return { l: 0, t: Math.min(h, n2), r: 0, b: Math.max(0, n2) };
    }
    if (shape === 'note' && bounded) {
      // NoteShape extends mxCylinder → inherits mxCylinder.getLabelMargins:
      // top = min(maxHeight=40, h*size*2), size default 0.15.
      return { l: 0, t: Math.min(40, h * number(style.size, 0.15) * 2), r: 0, b: 0 };
    }
    if (shape === 'cylinder3' && bounded) {
      // CylinderShape3.getLabelMargins (Shapes.js:1377): top min(h,size*2),
      // bottom size*0.3; size halves when lid=false. size default 15.
      var c3 = number(style.size, 15);
      // drawio halves only when `!getValue('lid',true)` — i.e. never for a '0'
      // string. Match the paint's drawioFlag semantics (don't halve for lid=0).
      if (!drawioFlag(style.lid, true)) c3 /= 2;
      return { l: 0, t: Math.min(h, c3 * 2), r: 0, b: Math.max(0, c3 * 0.3) };
    }
    if (shape === 'tape' && bounded) {
      // TapeShape.getLabelBounds (Shapes.js:1282): for the horizontal (east/west
      // or undefined) direction, top AND bottom by h*size (size default 0.4).
      var tdir = String(style.direction || 'east');
      if (tdir === 'east' || tdir === 'west') {
        var tdy = h * number(style.size, 0.4);
        return { l: 0, t: tdy, r: 0, b: tdy };
      }
      var twx = w * number(style.size, 0.4); // vertical tape insets left+right
      return { l: twx, t: 0, r: twx, b: 0 };
    }
    if ((shape === 'rhombus' || shape === 'ext') && String(style.double) === '1') {
      // mxRhombus/ExtendedShape double=1 (Shapes.js:2076/2206): inset all sides.
      // rhombus margin = max(2,sw+1)*2 + STYLE_MARGIN; ext = max(2,sw+1) + margin.
      var base = Math.max(2, sw + 1);
      var dm = (shape === 'rhombus' ? base * 2 : base) + number(style.margin, 0);
      return { l: dm, t: dm, r: dm, b: dm };
    }
    if (shape === 'umlControl') { // getLabelBounds, UNCONDITIONAL: top h/8
      return { l: 0, t: h / 8, r: 0, b: 0 };
    }
    if (shape === 'umlBoundary') { // getLabelMargins, UNCONDITIONAL: left w/6
      return { l: w / 6, t: 0, r: 0, b: 0 };
    }
    if (shape === 'umlState' && bounded && style.umlStateConnection != null &&
        style.umlStateConnection !== '') { // left inset 10 only with a connection
      return { l: 10, t: 0, r: 0, b: 0 };
    }
    if (shape === 'doubleEllipse') { // mxDoubleEllipse.getLabelBounds, UNCONDITIONAL
      var dem = (style.margin != null && style.margin !== '')
        ? number(style.margin, 0)
        : Math.min(3 + sw, Math.min(w / 5, h / 5));
      return { l: dem, t: dem, r: dem, b: dem };
    }
    if (shape === 'gitTag') { // body is right of the tab (tabSize default 8)
      return { l: number(style.tabSize, 8), t: 0, r: 0, b: 0 };
    }
    if (shape === 'mindmapBang') { // inner 80% rect (10% inset each side)
      return { l: w * 0.1, t: h * 0.1, r: w * 0.1, b: h * 0.1 };
    }
    if (shape === 'mermaidOdd') { // notch = h/4 on the left
      return { l: h / 4, t: 0, r: 0, b: 0 };
    }
    if (shape === 'document' && bounded) {
      return { l: 0, t: 0, r: 0, b: number(style.size, 0.3) * h };
    }
    if (shape === 'manualInput' && bounded) {
      return { l: 0, t: number(style.size, 30), r: 0, b: 0 };
    }
    if (shape === 'folder' && bounded) {
      // FolderShape.getLabelMargins (Shapes.js): labelInHeader=1 confines the
      // label to the side TAB (tabWidth × tabHeight at tabPosition), else the
      // label drops below the top tab band.
      if (drawioFlag(style.labelInHeader, false)) {
        var fSizeX = number(style.tabWidth, 15);
        var fSizeY = number(style.tabHeight, 15);
        var fArc = number(style.arcSize, 0.1);
        if (!boolish(style.absoluteArcSize)) fArc = Math.min(w, h) * fArc;
        fArc = Math.min(fArc, w * 0.5, (h - fSizeY) * 0.5);
        if (!boolish(style.rounded)) fArc = 0;
        if (String(style.tabPosition || 'right') === 'left') {
          return { l: fArc, t: 0, r: w - fSizeX, b: h - fSizeY };
        }
        return { l: w - fSizeX, t: 0, r: fArc, b: h - fSizeY };
      }
      return { l: 0, t: number(style.tabHeight, 15), r: 0, b: 0 };
    }
    if (shape === 'process' || shape === 'process2') {
      // ProcessShape.getLabelBounds: insets left+right by the bar inset, but
      // ONLY when horizontal == (direction is east/west) — else no inset.
      var dir = String(style.direction || 'east');
      var horiz = String(style.horizontal) !== '0';
      var dirH = dir === 'east' || dir === 'west';
      if (horiz !== dirH) return null;
      var inset = number(style.size, 0.1);
      if (boolish(style.fixedSize)) inset = Math.max(0, Math.min(w, inset));
      else {
        inset = w * Math.max(0, Math.min(1, inset));
        if (boolish(style.rounded)) {
          var pf = number(style.arcSize, 15) / 100;
          inset = Math.max(inset, Math.min(w * pf, h * pf));
        }
      }
      inset = Math.round(inset);
      return { l: inset, t: 0, r: inset, b: 0 };
    }
    return null;
  }

  // Apply labelMargins to an internal-label box, rotating the margin by the
  // shape direction exactly like mxUtils.getDirectedBounds (m={x:l,y:t,
  // width:r,height:b}). Returns the box unchanged when no margin applies.
  function applyLabelMargins(box, style) {
    var m = labelMargins(style, box.w, box.h);
    if (!m) return box;
    var l = Math.max(0, Math.min(box.w, m.l)), t = Math.max(0, Math.min(box.h, m.t));
    var r = Math.max(0, Math.min(box.w, m.r)), b = Math.max(0, Math.min(box.h, m.b));
    var dir = String(style.direction || 'east');
    var mx = l, my = t, mw = r, mh = b; // east default
    if (dir === 'south') { mx = b; my = l; mw = t; mh = r; }
    else if (dir === 'west') { mx = r; my = b; mw = l; mh = t; }
    else if (dir === 'north') { mx = t; my = r; mw = b; mh = l; }
    return { x: box.x + mx, y: box.y + my,
      w: Math.max(1, box.w - mw - mx), h: Math.max(1, box.h - mh - my) };
  }

  function textDefaultAlign(style) {
    return alignH(style.align || (style.shape === 'text' ? 'left' : 'center'));
  }

  function textDefaultValign(style) {
    return alignV(style.verticalAlign || (style.shape === 'text' ? 'top' : 'middle'));
  }

  function htmlTextBlocks(raw, style, plain) {
    var s = String(raw == null ? '' : raw);
    // `plain` (non-HTML label): the text is already literal/decoded — split on
    // newlines only, never interpret tags, so literal '<'/'>' survive verbatim.
    // An HTML-style label WITHOUT element markup still carries HTML entities
    // (drawio stores a typed '&' as &amp;amp;): browser innerHTML decodes them,
    // so the headless path must too — otherwise "Tom &amp; Jerry" prints the
    // entity text literally.
    if (plain || s.indexOf('<') < 0) {
      var lit = plain ? String(s) : decodeHtmlEntities(s);
      return lit.split('\n').map(function (line) {
        // drawio's plain-text path emits SVG <text> with DEFAULT xml:space:
        // the browser collapses whitespace runs and trims line edges, so the
        // editor shows "a b" for "a   b". Preserving the runs printed wider
        // text than the screen. NBSP survives (it is not XML whitespace).
        return { text: line.replace(/[ \t]+/g, ' ').replace(/^ | $/g, ''),
          size: Math.max(1, number(style.fontSize, 12)),
          weight: ((parseInt(style.fontStyle || 0, 10) || 0) & 1) ? 700 : 400,
          gap: 0 };
      });
    }

    var blocks = [];
    // Match an <hr> divider (void element, no closing tag) OR a paired block
    // tag, in document order. The <hr> branch carries no capture groups so the
    // paired branch's groups stay at m[1] (tag) / m[2] (body). UML object/
    // component templates put an <hr> between the title <p> and the body <p>;
    // dropping it (as the old paired-only regex did) lost the divider line.
    var re = /<hr\b[^>]*>|<(h[1-6]|p|div|li)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
    var m;
    while ((m = re.exec(s))) {
      if (/^<hr/i.test(m[0])) {
        blocks.push({ rule: true, size: Math.max(1, number(style.fontSize, 12)),
          weight: 400, align: null, underline: false, gap: 2 });
        continue;
      }
      var tag = m[1].toLowerCase();
      var body = m[2].replace(/<br\s*\/?>/gi, '\n');
      var full = m[0];
      var baseSize = Math.max(1, number(style.fontSize, 12));
      var am = /text-align\s*:\s*(left|center|right)/i.exec(full);
      blocks.push({
        text: stripHtml(body).replace(/[ \t\r]+/g, ' ')
          .replace(/ *\n */g, '\n').trim(),
        size: tag === 'h1' ? Math.max(24, baseSize * 2) : baseSize,
        weight: tag.charAt(0) === 'h' || /<(b|strong)\b/i.test(body) ? 700 :
          (((parseInt(style.fontStyle || 0, 10) || 0) & 1) ? 700 : 400),
        align: am ? am[1].toLowerCase() : null,
        underline: /text-decoration\s*:\s*underline/i.test(full) || /<u\b/i.test(body),
        gap: tag.charAt(0) === 'h' ? 5 : 0
      });
    }
    if (!blocks.length) {
      blocks.push({
        text: plainLabel({ getLabel: function () { return s; } }, {}),
        size: Math.max(1, number(style.fontSize, 12)),
        weight: ((parseInt(style.fontStyle || 0, 10) || 0) & 1) ? 700 : 400,
        gap: 0
      });
    }
    return blocks.filter(function (b) { return b.text !== ''; });
  }

  // Per-glyph advance width as a fraction of the font size (em), approximating
  // Arial/Helvetica metrics. A single average factor wraps narrow-letter text
  // (lorem ipsum, "this note") far too early; per-class widths reproduce the
  // browser's line breaks closely without bundling a full AFM table.
  // East-Asian fullwidth glyphs (CJK ideographs, kana, Hangul, fullwidth
  // forms). Browsers give these a break opportunity between ANY two of them
  // under white-space:normal (standard Unicode line breaking, independent of
  // word-wrap), and they advance ~1.0 em -- both must be mirrored here or a
  // wrapped CJK label bakes as ONE clipped line (silent content loss).
  function isWideBreakChar(ch) {
    var c = ch.charCodeAt(0);
    return (c >= 0x1100 && c <= 0x115F) ||  // Hangul Jamo
           (c >= 0x2E80 && c <= 0x303E) ||  // CJK radicals, Kangxi, CJK punct
           (c >= 0x3041 && c <= 0x33FF) ||  // kana, CJK symbols/compat
           (c >= 0x3400 && c <= 0x4DBF) ||  // CJK ext A
           (c >= 0x4E00 && c <= 0x9FFF) ||  // CJK unified
           (c >= 0xA000 && c <= 0xA4CF) ||  // Yi
           (c >= 0xAC00 && c <= 0xD7A3) ||  // Hangul syllables
           (c >= 0xF900 && c <= 0xFAFF) ||  // CJK compat ideographs
           (c >= 0xFE30 && c <= 0xFE4F) ||  // CJK compat forms
           (c >= 0xFF00 && c <= 0xFF60) ||  // fullwidth forms
           (c >= 0xFFE0 && c <= 0xFFE6);    // fullwidth signs
  }
  // Basic kinsoku: a line must not START with a closing mark nor END with an
  // opening bracket (matches browser CJK line breaking).
  var CJK_CLOSING = '、。，．：；？！）' +
    '」』】〉》〕ー々・｡｣､';
  var CJK_OPENING = '（「『【〈《〔｢';
  // Split one whitespace-free word into unbreakable units: runs of non-wide
  // chars stay one unit; each wide char is its own unit (with kinsoku gluing).
  // Adjacent units join with NO space. Latin-only words return [word].
  function splitBreakable(word) {
    var units = [];
    var cur = '';
    for (var i = 0; i < word.length; i++) {
      var ch = word.charAt(i);
      if (isWideBreakChar(ch)) {
        if (CJK_OPENING.indexOf(ch) >= 0) {
          cur += ch;                                  // opener glues forward
          continue;
        }
        if (cur !== '' && (CJK_CLOSING.indexOf(ch) >= 0 ||
            CJK_OPENING.indexOf(word.charAt(i - 1)) >= 0)) {
          units.push(cur + ch); cur = '';             // closer glues backward
          continue;
        }
        if (cur !== '') { units.push(cur); cur = ''; }
        units.push(ch);
      } else {
        // closing mark may not start a line: keep it on the wide char before
        if (cur === '' && units.length && CJK_CLOSING.indexOf(ch) >= 0 &&
            isWideBreakChar(word.charAt(i - 1) || '')) {
          units[units.length - 1] += ch;
          continue;
        }
        cur += ch;
      }
    }
    if (cur !== '') units.push(cur);
    return units.length ? units : [word];
  }
  // Per-glyph advance widths (units per 1000 em) for ASCII 32..126: the
  // standard Arial/Helvetica (sans) and Times New Roman (serif) core AFM
  // metrics; Courier (mono) is a fixed 600. resvg rasterizes text with the
  // installed face -- real Arial on the Windows print server, the
  // metric-compatible Liberation Sans on Linux (both Arial-metric), Times on
  // both -- so these tables match resvg's own shaping to sub-pixel. They replace
  // the old per-class estimate that drifted up to ~17% per glyph and shifted
  // wrap points / centre-right alignment / label-background boxes silently -- a
  // WYSIWYG hazard for precise (e.g. medical-label) layouts.
  var AFM_SANS = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,
    556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,
    667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,
    278,278,278,469,556,333,
    556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,
    334,260,334,584];
  var AFM_SERIF = [250,333,408,500,500,833,778,180,333,333,500,564,250,333,250,278,
    500,500,500,500,500,500,500,500,500,500,278,278,564,564,564,444,921,
    722,667,667,722,611,556,722,722,333,389,722,611,889,722,722,556,722,667,556,611,722,722,944,722,722,611,
    333,278,333,469,500,333,
    444,500,444,500,444,333,500,500,278,278,500,278,778,500,500,500,500,333,389,278,500,500,722,500,500,444,
    480,200,480,541];
  // Arial/Helvetica BOLD advance widths (units/1000). Arial Bold runs ~5-9%
  // wider than Regular, so bold runs (drug names on labels) need their own
  // table or wrapping/rich-token-x drifts. Arial ITALIC shares Regular's
  // widths, and Arial BOLD-ITALIC shares Bold's, so this one extra table covers
  // all sans weight/style combinations. (Serif bold/italic reuse the Times
  // regular table — a small residual for the rare serif-label case.)
  var AFM_SANS_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,
    556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,
    722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,
    333,278,333,584,556,333,
    556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,
    389,280,389,584];
  // Accented Latin-1 letters advance like their unaccented base in Arial/Times;
  // map them to the base ASCII char so the table covers common diacritics.
  var AFM_DEACCENT = {
    'À':'A','Á':'A','Â':'A','Ã':'A','Ä':'A','Å':'A','Ç':'C',
    'È':'E','É':'E','Ê':'E','Ë':'E','Ì':'I','Í':'I','Î':'I','Ï':'I',
    'Ñ':'N','Ò':'O','Ó':'O','Ô':'O','Õ':'O','Ö':'O','Ø':'O',
    'Ù':'U','Ú':'U','Û':'U','Ü':'U','Ý':'Y',
    'à':'a','á':'a','â':'a','ã':'a','ä':'a','å':'a','ç':'c',
    'è':'e','é':'e','ê':'e','ë':'e','ì':'i','í':'i','î':'i','ï':'i',
    'ñ':'n','ò':'o','ó':'o','ô':'o','õ':'o','ö':'o','ø':'o',
    'ù':'u','ú':'u','û':'u','ü':'u','ý':'y','ÿ':'y'
  };
  function fontMetricClass(fam) {
    var f = String(fam == null ? '' : fam).toLowerCase();
    if (/courier|consol|mono/.test(f)) return 'mono';
    if (/times|serif|georgia|garamond|cambria|book antiqua|palatino/.test(f)) return 'serif';
    return 'sans';
  }
  function glyphEmWidth(ch, fam, bold) {
    if (isWideBreakChar(ch)) return 1.0; // fullwidth advance (CJK etc.)
    var cls = fontMetricClass(fam);
    if (cls === 'mono') return 0.6;        // Courier: fixed advance
    var tbl = cls === 'serif' ? AFM_SERIF : (bold ? AFM_SANS_BOLD : AFM_SANS);
    var code = ch.charCodeAt(0);
    if (code >= 32 && code <= 126) return tbl[code - 32] / 1000;
    if (code === 0x00A0) return tbl[0] / 1000; // NBSP advances like a space
    var base = AFM_DEACCENT[ch];
    if (base) return tbl[base.charCodeAt(0) - 32] / 1000;
    // Fallback for glyphs outside the AFM tables (rare punctuation, unlisted
    // scripts): the old per-class heuristic, so exotic text is never zero-width.
    if ('iIl.,:;|!\'`'.indexOf(ch) >= 0) return 0.26;
    if ('jftr()[]{}/\\'.indexOf(ch) >= 0) return 0.33;
    if ('mMW'.indexOf(ch) >= 0) return 0.87;
    if (ch >= 'A' && ch <= 'Z') return 0.70;
    if (ch >= '0' && ch <= '9') return 0.56;
    return 0.52;
  }
  function textWidthPx(str, size, letterSpacing, fam, bold) {
    var t = String(str == null ? '' : str), sum = 0;
    for (var i = 0; i < t.length; i++) sum += glyphEmWidth(t.charAt(i), fam, bold);
    // CSS letter-spacing adds a gap AFTER each glyph (including the last); the
    // plain SVG emit + extent already add it, so the wrap must too or a spaced
    // label breaks at the wrong column. Default 0 -> identical to before.
    return sum * size + (letterSpacing > 0 ? letterSpacing * t.length : 0);
  }

  function wrapSvgText(text, size, width, wrap, letterSpacing, fam, bold) {
    var rawLines = String(text == null ? '' : text).split('\n');
    if (!wrap) return rawLines;
    var maxW = Math.max(1, width);
    var lines = [];
    rawLines.forEach(function (raw) {
      // U+00A0 (&nbsp;) is non-breaking: never a wrap opportunity.
      var words = raw.split(/[\t\f\r ]+/).filter(function (w) { return w !== ''; });
      if (!words.length) { lines.push(''); return; }
      // Each token = an unbreakable unit; `sp` = preceded by a space when it
      // stays on the same line. Wide (CJK) units inside a word break with no
      // joiner, exactly like browser line breaking under white-space:normal.
      var tokens = [];
      words.forEach(function (word) {
        splitBreakable(word).forEach(function (unit, ui) {
          tokens.push({ text: unit, sp: ui === 0 });
        });
      });
      var line = '', lineW = 0;
      tokens.forEach(function (tk, ti) {
        var sp = (tk.sp && ti > 0 && line !== '');
        var tw = textWidthPx(tk.text, size, letterSpacing, fam, bold);
        var spW = sp ? glyphEmWidth(' ', fam, bold) * size : 0;
        if (line !== '' && lineW + spW + tw > maxW) {
          lines.push(line); line = tk.text; lineW = tw;
        } else {
          line += (sp ? ' ' : '') + tk.text; lineW += spW + tw;
        }
      });
      if (line) lines.push(line);
    });
    return lines;
  }

  // ── Headless rich-text (HTML label) faithful renderer ──────────────────────
  // drawio stores HTML labels as markup; its rich-text toolbar emits <b>,<i>,
  // <u>,<s>, <font color/face/size>, <span style>, <sub>,<sup>, <ul>/<ol>/<li>,
  // <hr>, <a>, <img>, <table>, per-paragraph alignment, highlight colours, and
  // mixed font sizes. Native print must reconstruct each run
  // FAITHFULLY with no browser — otherwise inline formatting silently collapses
  // to the cell's base font (a C1 silent-divergence). This builds an inline-run
  // line model from the markup (browser-free) and lays it out into plain SVG
  // <text>/<rect>/<image>/<line> that any SVG rasterizer draws 1:1.

  var LIST_INDENT_PX = 40;   // UA ul/ol padding-left (40px) per nesting level
  var richClipCounter = 0;       // stable per-exporter SVG clip ids for rich labels
  var CSS_NAMED_COLORS = {
    black: '#000000', white: '#ffffff', red: '#ff0000', lime: '#00ff00',
    green: '#008000', blue: '#0000ff', yellow: '#ffff00', cyan: '#00ffff',
    aqua: '#00ffff', magenta: '#ff00ff', fuchsia: '#ff00ff', silver: '#c0c0c0',
    gray: '#808080', grey: '#808080', maroon: '#800000', olive: '#808000',
    navy: '#000080', teal: '#008080', purple: '#800080', orange: '#ffa500',
    pink: '#ffc0cb', brown: '#a52a2a', gold: '#ffd700', indigo: '#4b0082',
    violet: '#ee82ee', darkgray: '#a9a9a9', darkgrey: '#a9a9a9',
    lightgray: '#d3d3d3', lightgrey: '#d3d3d3', transparent: null, none: null
  };

  // Resolve any CSS colour the drawio editor can emit (#rgb/#rrggbb, rgb()/
  // rgba(), or a named colour) to { hex, alpha } or { none:true } or null.
  function cssColor(v) {
    if (v == null) return null;
    var s = String(v).trim();
    if (s === '') return null;
    var lc = s.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(CSS_NAMED_COLORS, lc)) {
      var h = CSS_NAMED_COLORS[lc];
      return h == null ? { none: true } : { hex: h, alpha: 1 };
    }
    var cp = colorParts(s);
    if (cp) return cp;
    if (/^#?(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s)) return { hex: hex(s), alpha: 1 };
    return null;
  }

  function parseInlineStyle(el) {
    var out = {};
    var sv = (el && el.getAttribute && el.getAttribute('style')) || '';
    String(sv).split(';').forEach(function (p) {
      var i = p.indexOf(':');
      if (i < 0) return;
      out[p.slice(0, i).trim().toLowerCase()] = p.slice(i + 1).trim();
    });
    return out;
  }

  // CSS font-size value -> px (relative to the parent run's px size).
  function cssFontSizePx(v, parentSize) {
    if (v == null || v === '') return null;
    var s = String(v).trim().toLowerCase();
    var f = parseFloat(s);
    if (s.indexOf('px') >= 0) return Number.isFinite(f) ? f : null;
    if (s.indexOf('pt') >= 0) return Number.isFinite(f) ? f * 96 / 72 : null;
    // `rem` is relative to the document root font-size (16px default), not the
    // parent; check it before the substring `em` test (which also matches "rem").
    if (s.indexOf('rem') >= 0) return Number.isFinite(f) ? f * 16 : null;
    if (s.indexOf('em') >= 0) return Number.isFinite(f) ? f * parentSize : null;
    if (s.indexOf('%') >= 0) return Number.isFinite(f) ? f / 100 * parentSize : null;
    if (s === 'smaller') return parentSize * 0.83;
    if (s === 'larger') return parentSize * 1.2;
    if (s === 'xx-small') return 7; if (s === 'x-small') return 10;
    if (s === 'small') return 13; if (s === 'medium') return 16;
    if (s === 'large') return 18; if (s === 'x-large') return 24;
    if (s === 'xx-large') return 32;
    if (Number.isFinite(f)) return f;   // bare number -> px
    return null;
  }

  // HTML <font size="1..7"> attribute -> px (the legacy 7-step scale).
  function htmlFontSizePx(n) {
    var t = { 1: 10, 2: 13, 3: 16, 4: 18, 5: 24, 6: 32, 7: 48 };
    return t[n] || 16;
  }

  function baseRunStyle(style) {
    var fst = parseInt(style.fontStyle || 0, 10) || 0;
    return {
      family: style.fontFamily || 'Arial',
      size: Math.max(1, number(style.fontSize, 12)),
      weight: (fst & 1) ? 700 : 400,
      italic: !!(fst & 2),
      underline: !!(fst & 4),
      strike: !!(fst & 8),
      overline: false,
      color: isPaintable(style.fontColor) ? hex(style.fontColor) : '#000000',
      colorAlpha: 1,
      bg: null,
      bgAlpha: 1,
      vshift: 0,
      letterSpacing: 0
    };
  }

  // Derive a run style from a parent run style + one element's own declared
  // styling (tag semantics + inline CSS + legacy font attributes). Inheritance
  // is explicit (we copy the parent) so this is identical in a real browser and
  // in the headless shim — it never relies on getComputedStyle's cascade.
  function applyElStyle(parentSt, el) {
    var st = Object.assign({}, parentSt);
    var tag = String(el.tagName || '').toLowerCase();
    var inl = parseInlineStyle(el);
    if (tag === 'b' || tag === 'strong') st.weight = 700;
    if (tag === 'i' || tag === 'em' || tag === 'cite' || tag === 'var' ||
      tag === 'dfn' || tag === 'address') st.italic = true;
    if (tag === 'u' || tag === 'ins') st.underline = true;
    if (tag === 's' || tag === 'strike' || tag === 'del') st.strike = true;
    if (tag === 'mark' && !inl['background-color']) { st.bg = '#ffff00'; st.bgAlpha = 1; }
    if (tag === 'small') st.size = st.size * 0.83;
    if (tag === 'big') st.size = st.size * 1.2;
    if (tag === 'tt' || tag === 'code' || tag === 'kbd' || tag === 'samp' || tag === 'pre') {
      if (!inl['font-family']) st.family = 'Courier New';
    }
    if (tag === 'sup' || tag === 'sub') {
      // mxSvgCanvas2D.js:2639 — dyPx = (SUP?-0.35:0.15) * parent effectiveFontSize
      // (st.size here is still the PARENT size; the shrink below happens after).
      // mxSvgCanvas2D.js:2624-2626 — sub/sup font becomes 'smaller' = parent/1.2,
      // and ONLY when the run carries no explicit font-size (an inline
      // font-size at line ~1896 overrides st.size, matching drawio:2680-2693).
      st.vshift = st.vshift + (tag === 'sup' ? -0.35 : 0.15) * st.size;
      st.size = st.size / 1.2;
    }
    if (tag === 'font') {
      var fc = el.getAttribute && el.getAttribute('color');
      if (fc) { var c0 = cssColor(fc); if (c0 && !c0.none) { st.color = c0.hex; st.colorAlpha = c0.alpha; } }
      var ff = el.getAttribute && el.getAttribute('face');
      if (ff) st.family = ff.split(',')[0].trim().replace(/^['"]|['"]$/g, '');
      var fz = el.getAttribute && el.getAttribute('size');
      if (fz) { var ni = parseInt(fz, 10); if (Number.isFinite(ni)) st.size = htmlFontSizePx(ni); }
    }
    if (inl['font-weight']) {
      var w = inl['font-weight'];
      st.weight = (w === 'bold' || w === 'bolder' || (parseInt(w, 10) || 0) >= 600) ? 700 : 400;
    }
    if (inl['font-style']) st.italic = inl['font-style'].indexOf('italic') >= 0 ||
      inl['font-style'].indexOf('oblique') >= 0;
    if (inl['font-family']) st.family = inl['font-family'].split(',')[0].trim().replace(/^['"]|['"]$/g, '');
    if (inl['font-size']) { var fs2 = cssFontSizePx(inl['font-size'], parentSt.size); if (fs2) st.size = Math.max(1, fs2); }
    var dec = ((inl['text-decoration'] || '') + ' ' + (inl['text-decoration-line'] || '')).toLowerCase();
    if (dec.trim()) {
      if (/\bnone\b/.test(dec)) { st.underline = false; st.strike = false; st.overline = false; }
      if (dec.indexOf('underline') >= 0) st.underline = true;
      if (dec.indexOf('line-through') >= 0) st.strike = true;
      if (dec.indexOf('overline') >= 0) st.overline = true;
    }
    if (inl['color']) { var c1 = cssColor(inl['color']); if (c1 && !c1.none) { st.color = c1.hex; st.colorAlpha = c1.alpha; } }
    var bgv = inl['background-color'] || inl['background'];
    if (bgv) { var b1 = cssColor(bgv); if (b1) { if (b1.none) st.bg = null; else { st.bg = b1.hex; st.bgAlpha = b1.alpha; } } }
    if (inl['letter-spacing']) { var lsp = parseFloat(inl['letter-spacing']); if (Number.isFinite(lsp)) st.letterSpacing = lsp; }
    if (inl['vertical-align']) {
      var va = inl['vertical-align'].toLowerCase();
      if (va === 'super') st.vshift += -0.35 * st.size;
      else if (va === 'sub') st.vshift += 0.15 * st.size;
    }
    return st;
  }

  function inlineAlign(el) {
    var inl = parseInlineStyle(el);
    var a = inl['text-align'];
    if (a === 'left' || a === 'center' || a === 'right' || a === 'justify') {
      return a === 'justify' ? 'left' : a;
    }
    var attr = el.getAttribute && el.getAttribute('align');
    if (attr === 'left' || attr === 'center' || attr === 'right') return attr;
    return null;
  }

  var RICH_BLOCK_TAGS = {
    p: 1, div: 1, h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1, li: 1,
    blockquote: 1, pre: 1, center: 1, section: 1, article: 1, header: 1,
    footer: 1, figure: 1, figcaption: 1, dl: 1, dt: 1, dd: 1, address: 1,
    fieldset: 1, form: 1, main: 1, nav: 1, aside: 1
  };
  // UA-stylesheet default vertical margins for block elements, in em of the
  // ELEMENT's own font-size (heading margins use the heading's em). <div> has
  // no UA margin (drawio's default line container — must stay zero).
  var UA_BLOCK_MARGIN_EM = {
    p: 1, blockquote: 1,
    h1: 0.67, h2: 0.83, h3: 1, h4: 1.33, h5: 1.67, h6: 2.33
  };

  // CSS margin component -> px (em relative to the element font-size).
  // Returns null when the value is absent/unparseable (caller keeps UA value).
  function cssMarginPx(v, size) {
    if (v == null) return null;
    var s = String(v).trim().toLowerCase();
    if (s === '') return null;
    if (s === 'auto' || s === 'inherit' || s === 'initial' || s === 'unset') return 0;
    var f = parseFloat(s);
    if (!Number.isFinite(f)) return null;
    if (s.indexOf('rem') >= 0) return f * 16;
    if (s.indexOf('em') >= 0) return f * size;
    if (s.indexOf('pt') >= 0) return f * 96 / 72;
    if (s.indexOf('%') >= 0) return 0;   // % of container width — not modeled
    return f;                            // px or bare number
  }

  // Vertical margins for one block element: UA default (overridable per call
  // for nested lists) unless the inline style declares margin/margin-top/
  // margin-bottom (drawio templates set margin:0 inline — that must win).
  function blockVMargins(tag, el, size, uaEm) {
    var ua = uaEm != null ? uaEm : (UA_BLOCK_MARGIN_EM[tag] || 0);
    var mt = ua * size, mb = ua * size;
    var inl = parseInlineStyle(el);
    if (inl.margin) {
      var vals = inl.margin.split(/\s+/);
      var top = cssMarginPx(vals[0], size);
      // shorthand: 1 value=all, 2=vert/horiz, 3=top/horiz/bottom, 4=t/r/b/l.
      var bot = cssMarginPx(vals.length >= 3 ? vals[2] : vals[0], size);
      if (top != null) mt = top;
      if (bot != null) mb = bot;
    }
    var mtv = cssMarginPx(inl['margin-top'], size);
    if (mtv != null) mt = mtv;
    var mbv = cssMarginPx(inl['margin-bottom'], size);
    if (mbv != null) mb = mbv;
    return { mt: Math.max(0, mt), mb: Math.max(0, mb) };
  }

  function headingPx(tag, baseSize) {
    // UA stylesheet heading sizes in em of the base size. No floor: h5
    // (0.83em) and h6 (0.67em) are SMALLER than the base size by design.
    var f = { h1: 2, h2: 1.5, h3: 1.17, h4: 1, h5: 0.83, h6: 0.67 };
    return baseSize * (f[tag] || 1);
  }
  function listStyleType(node) {
    var inl = parseInlineStyle(node);
    var t = inl['list-style-type'] || inl['list-style'];
    if (t) {
      t = t.split(/\s+/)[0].toLowerCase().replace(/^['"]|['"]$/g, '');
      if (t && t !== 'inherit' && t !== 'initial') return t;
    }
    var attr = node.getAttribute && node.getAttribute('type');
    if (attr) {
      var map = { '1': 'decimal', 'a': 'lower-alpha', 'A': 'upper-alpha',
        i: 'lower-roman', I: 'upper-roman', disc: 'disc', circle: 'circle',
        square: 'square' };
      if (map[attr]) return map[attr];
    }
    return null;
  }

  function resolveInlineImage(el, resolved, notices, cellId) {
    var src = el.getAttribute && el.getAttribute('src');
    var w = parseFloat(el.getAttribute && el.getAttribute('width')) || 0;
    var hh = parseFloat(el.getAttribute && el.getAttribute('height')) || 0;
    var parsed = parseImage(src);
    var mime = embeddableImageMime(parsed);
    var href = (mime && parsed) ? 'data:' + mime + ';base64,' + parsed.data
      : (resolved && src && resolved[src]) || null;
    if (!href) {
      if (Array.isArray(notices)) {
        notices.push(degradation('RichUnsupported',
          'inline <img> in HTML label cannot be embedded headlessly (' +
          (parsed && parsed.externalUrl ? 'external URL not resolved'
            : parsed && parsed.unsupportedFormat ? 'format=' + parsed.unsupportedFormat
              : 'unreadable src') + '); printed without the image', cellId));
      }
      return null;
    }
    // Fall back to a sane default box if the markup omitted dimensions.
    if (!(w > 0)) w = 16;
    if (!(hh > 0)) hh = 16;
    return { href: href, w: w, h: hh };
  }

  // Build the line/run model from a label's HTML root node (browser-free).
  function buildRichModel(rootNode, baseSt, defaultAlign, resolved, notices, cellId) {
    var out = [];
    var cur = null;
    function emptyPara(align, indent, size) {
      return { kind: 'para', frags: [], align: align, indent: indent, baseSize: size };
    }
    // Attach a block element's vertical margins to the first/last entry it
    // produced. max() so a parent block's margin collapses with its first/last
    // child's margin (CSS adjoining-margin collapse through nesting).
    function attachVMargins(before, mt, mb) {
      if (out.length <= before) return;
      var first = out[before], last = out[out.length - 1];
      if (mt > (first.mt || 0)) first.mt = mt;
      if (mb > (last.mb || 0)) last.mb = mb;
    }
    function process(node, st, align, indent, pre, listDepth) {
      var kids = node.childNodes || [];
      for (var i = 0; i < kids.length; i++) {
        var ch = kids[i];
        if (ch.nodeType === 3) {
          var tv = ch.nodeValue;
          if (tv == null) continue;
          // ASCII-whitespace-only check: String.trim() also strips U+00A0, so
          // an &nbsp;-only text node would be wrongly collapsed to one space.
          if (!pre && tv.replace(/[\t\n\f\r ]+/g, '') === '') {
            if (cur && cur.frags.length) cur.frags.push({ type: 'text', text: ' ', st: st });
            continue;
          }
          if (!cur) { cur = emptyPara(align, indent, st.size); out.push(cur); }
          cur.frags.push({ type: 'text', text: tv, st: st, pre: pre });
          continue;
        }
        if (ch.nodeType !== 1) continue;
        var tag = String(ch.tagName || '').toLowerCase();
        if (tag === 'br') {
          if (cur) cur = null; else out.push(emptyPara(align, indent, st.size));
          continue;
        }
        if (tag === 'hr') { cur = null; out.push({ kind: 'rule', size: st.size, color: st.color }); continue; }
        if (tag === 'wbr' || tag === 'script' || tag === 'style') continue;
        if (tag === 'img') {
          var im = resolveInlineImage(ch, resolved, notices, cellId);
          if (im) {
            if (!cur) { cur = emptyPara(align, indent, st.size); out.push(cur); }
            cur.frags.push({ type: 'img', img: im, st: st });
          }
          continue;
        }
        if (tag === 'foreignobject') {
          // SVG <foreignObject> is the browser feature that normally lets HTML
          // appear inside SVG. The native engine's resvg backend correctly
          // refuses raw foreignObject (it would otherwise print blank), so the
          // bake flattens its XHTML subtree into ordinary SVG text/rect/image
          // primitives right here, browser-free. This preserves the declared
          // x/y/width/height box and reuses the same rich HTML renderer as normal
          // drawio labels; no <foreignObject> reaches the C++ print engine.
          cur = null;
          var foSt = applyElStyle(st, ch);
          var foInl = parseInlineStyle(ch);
          var fx = cssLengthPx(ch.getAttribute && ch.getAttribute('x'), 0);
          var fy = cssLengthPx(ch.getAttribute && ch.getAttribute('y'), 0);
          var fw = cssLengthPx(ch.getAttribute && ch.getAttribute('width'),
            cssLengthPx(foInl.width, 0));
          var fh = cssLengthPx(ch.getAttribute && ch.getAttribute('height'),
            cssLengthPx(foInl.height, 0));
          if (!(fw > 0)) fw = Math.max(1, st.size * 12);
          if (!(fh > 0)) fh = Math.max(1, st.size * RICH_LINE_FACTOR);
          var savedOut = out, savedCur = cur;
          out = []; cur = null;
          process(ch, foSt, inlineAlign(ch) || align, 0, pre, listDepth);
          var foBlocks = out;
          out = savedOut; cur = savedCur;
          out.push({ kind: 'foreign', x: fx, y: fy, w: fw, h: fh,
            blocks: foBlocks, st: foSt, align: inlineAlign(ch) || align });
          continue;
        }
        if (tag === 'table') {
          cur = null;
          out.push(buildTableEntry(ch, st, align, resolved, notices, cellId));
          continue;
        }
        if (tag === 'ul' || tag === 'ol') {
          cur = null;
          // UA: outer lists carry 1em vertical margins; NESTED lists have
          // margin 0 (html.css). Inline margin overrides still win.
          var lvm = blockVMargins(tag, ch, applyElStyle(st, ch).size,
            listDepth > 0 ? 0 : 1);
          var lBefore = out.length;
          processList(ch, st, align, indent, pre, listDepth, tag === 'ol');
          attachVMargins(lBefore, lvm.mt, lvm.mb);
          continue;
        }
        if (RICH_BLOCK_TAGS[tag]) {
          cur = null;
          var bst = applyElStyle(st, ch);
          if (tag.charAt(0) === 'h' && tag.length === 2) { bst.weight = 700; bst.size = headingPx(tag, st.size); }
          // UA vertical margins (p/h1-h6/blockquote) in the element's own em,
          // overridden by inline margin styles (drawio emits margin:0 on its
          // template paragraphs — those must stay flush).
          var bvm = blockVMargins(tag, ch, bst.size);
          var bAlign = inlineAlign(ch) || align;
          var bIndent = indent + (tag === 'blockquote' ? LIST_INDENT_PX : 0);
          var bPre = pre || tag === 'pre';
          var before = out.length;
          process(ch, bst, bAlign, bIndent, bPre, listDepth);
          if (out.length === before) out.push(emptyPara(bAlign, bIndent, bst.size));
          attachVMargins(before, bvm.mt, bvm.mb);
          cur = null;
          continue;
        }
        // inline element (b/i/u/s/font/span/sub/sup/a/small/big/mark/code/…)
        process(ch, applyElStyle(st, ch), align, indent, pre, listDepth);
      }
    }
    function processList(listNode, st, align, indent, pre, listDepth, ordered) {
      var declType = listStyleType(listNode);
      var counter = parseInt(listNode.getAttribute && listNode.getAttribute('start'), 10);
      if (!Number.isFinite(counter)) counter = 1;
      var kids = listNode.childNodes || [];
      for (var i = 0; i < kids.length; i++) {
        var li = kids[i];
        if (li.nodeType !== 1) continue;
        var ltag = String(li.tagName || '').toLowerCase();
        if (ltag === 'ul' || ltag === 'ol') {
          // stray nested list directly under ul/ol (malformed): one level deeper.
          processList(li, st, align, indent + LIST_INDENT_PX, pre, listDepth + 1, ltag === 'ol');
          continue;
        }
        if (ltag !== 'li') continue;
        var lst = applyElStyle(st, li);
        // Unordered marker cycles disc → circle → square with nesting depth
        // (CSS default); ordered stays decimal unless the list declares a type.
        var liType = listStyleType(li) || declType ||
          (ordered ? 'decimal' : (listDepth % 3 === 0 ? 'disc' : listDepth % 3 === 1 ? 'circle' : 'square'));
        var idxVal = parseInt(li.getAttribute && li.getAttribute('value'), 10);
        if (Number.isFinite(idxVal)) counter = idxVal;
        var marker = listMarker(liType, counter);
        if (marker === null) marker = '•';   // unknown system -> faithful bullet substitute
        counter++;
        // `indent` already accumulates one LIST_INDENT_PX per ancestor list, so
        // each level adds exactly one more step (do NOT also scale by depth).
        var liIndent = indent + LIST_INDENT_PX;
        var markerSt = { family: lst.family, size: lst.size, weight: lst.weight,
          italic: false, underline: false, strike: false, overline: false,
          color: lst.color, colorAlpha: lst.colorAlpha, bg: null, bgAlpha: 1,
          vshift: 0, letterSpacing: 0 };
        cur = emptyPara(align, liIndent, lst.size);
        if (marker !== '') cur.frags.push({ type: 'text', text: marker + ' ', st: markerSt });
        out.push(cur);
        // Descend one nesting level so a nested <ul>/<ol> inside this <li>
        // gets the next bullet style + one more indent step.
        process(li, lst, align, liIndent, pre, listDepth + 1);
        cur = null;
      }
    }
    function buildTableEntry(tableNode, st, align, resolved, notices, cellId) {
      var tst = applyElStyle(st, tableNode);
      var inl = parseInlineStyle(tableNode);
      var borderAttr = parseFloat(tableNode.getAttribute && tableNode.getAttribute('border'));
      var hasBorder = (Number.isFinite(borderAttr) && borderAttr > 0) ||
        (inl['border'] && !/(^|\s)(0|none)(\s|$|px)/.test(inl['border']));
      var rows = [];
      var trList = [];
      (function collectRows(n) {
        var c = n.childNodes || [];
        for (var i = 0; i < c.length; i++) {
          var e = c[i];
          if (e.nodeType !== 1) continue;
          var t = String(e.tagName || '').toLowerCase();
          if (t === 'tr') trList.push(e);
          else if (t === 'thead' || t === 'tbody' || t === 'tfoot') collectRows(e);
        }
      })(tableNode);
      trList.forEach(function (tr) {
        var cells = [];
        var tc = tr.childNodes || [];
        for (var j = 0; j < tc.length; j++) {
          var cell = tc[j];
          if (cell.nodeType !== 1) continue;
          var ct = String(cell.tagName || '').toLowerCase();
          if (ct !== 'td' && ct !== 'th') continue;
          var cst = applyElStyle(tst, cell);
          if (ct === 'th') cst.weight = 700;
          var calign = inlineAlign(cell) || (ct === 'th' ? 'center' : 'left');
          var cspan = Math.max(1, parseInt(cell.getAttribute && cell.getAttribute('colspan'), 10) || 1);
          var rspan = Math.max(1, parseInt(cell.getAttribute && cell.getAttribute('rowspan'), 10) || 1);
          cells.push({
            blocks: buildRichModel(cell, cst, calign, resolved, notices, cellId),
            align: calign, colspan: cspan, rowspan: rspan
          });
        }
        if (cells.length) rows.push(cells);
      });
      return { kind: 'table', rows: rows, border: hasBorder, color: tst.color };
    }
    process(rootNode, baseSt, defaultAlign, 0, false, 0);
    return out;
  }

  // ── Layout: line/run model -> SVG body string ──────────────────────────────
  var RICH_LINE_FACTOR = 1.2;       // CSS default line-height
  var RICH_ASCENT = 0.92;           // baseline offset from line-box top (em)
  function spaceWidthPx(size, fam, bold) { return glyphEmWidth(' ', fam, bold) * size; }
  function tokenWidth(tk) {
    if (tk.img) return tk.img.w;
    var w = textWidthPx(tk.text, tk.st.size, 0, tk.st.family, tk.st.weight >= 600);
    if (tk.st.letterSpacing) w += tk.st.letterSpacing * tk.text.length;
    return w;
  }
  function tokenizeFrags(frags) {
    var tokens = [];
    var pendingSpace = false;
    frags.forEach(function (fr) {
      if (fr.type === 'img') {
        tokens.push({ img: fr.img, st: fr.st, space: pendingSpace && tokens.length > 0 });
        pendingSpace = false;
        return;
      }
      var t = String(fr.text);
      if (fr.pre) {
        if (t !== '') tokens.push({ text: t, st: fr.st, space: pendingSpace && tokens.length > 0 });
        pendingSpace = false;
        return;
      }
      // Only ASCII whitespace collapses/breaks in HTML; U+00A0 (&nbsp;) is a
      // non-breaking, non-collapsible character that must stay inside its run
      // (JS \s would wrongly match it).
      var lead = /^[\t\n\f\r ]/.test(t);
      var trail = /[\t\n\f\r ]$/.test(t);
      var words = t.replace(/[\t\n\f\r ]+/g, ' ').replace(/^ +| +$/g, '')
        .split(' ').filter(function (w) { return w !== ''; });
      words.forEach(function (w, idx) {
        var sp = (idx === 0) ? (pendingSpace || lead) : true;
        // Wide (CJK) sub-units of one word are separately wrappable with no
        // joining space (browser CJK line breaking).
        splitBreakable(w).forEach(function (unit, ui) {
          tokens.push({ text: unit, st: fr.st,
            space: ui === 0 && sp && tokens.length > 0 });
        });
      });
      if (words.length) pendingSpace = trail;
      else if (lead || trail) pendingSpace = true;
    });
    return tokens;
  }
  // Lay out an array of block entries inside [0..width], from y=0 downward.
  // Returns { svg, height }. `wrap` enables word wrapping (whiteSpace=wrap).
  function layoutBlocks(entries, width, wrap, defAlign) {
    var parts = [];
    var y = 0;
    // Tight horizontal extent of the laid-out ink (label space). Callers use
    // it both for visible-overflow viewport growth (negative minX / maxX >
    // width) and for the measured label-background box, so it must hug the
    // text rather than being clamped to [0, 0].
    var minX = Infinity;
    var maxX = -Infinity;
    function extend(x0, x1) {
      if (x0 < minX) minX = x0;
      if (x1 > maxX) maxX = x1;
    }
    function emitPara(entry) {
      var indent = entry.indent || 0;
      var avail = Math.max(1, width - indent);
      var tokens = tokenizeFrags(entry.frags);
      var rows = [];
      if (!tokens.length) { rows.push([]); }
      else {
        var curRow = [], curW = 0;
        tokens.forEach(function (tk) {
          var tw = tokenWidth(tk);
          var sp = (tk.space && curRow.length) ? spaceWidthPx(tk.st.size, tk.st.family, tk.st.weight >= 600) : 0;
          if (wrap && curRow.length && curW + sp + tw > avail) {
            rows.push(curRow); curRow = []; curW = 0;
            tk = Object.assign({}, tk, { space: false }); sp = 0;
          }
          curRow.push(tk); curW += sp + tw;
        });
        if (curRow.length) rows.push(curRow);
      }
      rows.forEach(function (row) {
        // Row metrics in one pass: maxSize = tallest text run (drives the text
        // line box + baseline); imgMax = tallest inline image (an image sits on
        // the baseline, so the line box must also clear its height).
        var maxSize = entry.baseSize || 12;
        var imgMax = 0;
        var rowW = 0;
        // supSubExp grows the line DESCENDER (the baseline stays put), exactly
        // like mxSvgCanvas2D.getSupSubLineExpansion: a sup/sub run extends past
        // the normal line box only after the CSS half-leading is absorbed, and
        // the overflow is added below so the NEXT line is pushed down (the
        // baseline does not move). Sized off the line font (maxSize).
        var supSubExp = 0;
        row.forEach(function (tk, i) {
          if (tk.img) { if (tk.img.h > imgMax) imgMax = tk.img.h; }
          else { if (tk.st.size > maxSize) maxSize = tk.st.size; }
          rowW += tokenWidth(tk) + ((tk.space && i > 0) ? spaceWidthPx(tk.st.size, tk.st.family, tk.st.weight >= 600) : 0);
        });
        var halfLeading = maxSize * (RICH_LINE_FACTOR - 1) / 2;
        row.forEach(function (tk) {
          if (tk.img) return;
          var vs = tk.st.vshift || 0;
          var sfz = tk.st.size || (maxSize / RICH_LINE_FACTOR);
          if (vs < 0) { // superscript: extends above the line box
            supSubExp = Math.max(supSubExp, sfz - maxSize - vs - halfLeading);
          } else if (vs > 0) { // subscript: extends below the line box
            supSubExp = Math.max(supSubExp,
              (vs + sfz * (RICH_LINE_FACTOR - 1)) - maxSize * (RICH_LINE_FACTOR - 1));
          }
        });
        if (supSubExp < 0) supSubExp = 0;
        // An inline image sits ON the baseline with its whole height above it,
        // so the baseline must also clear the tallest image. Text-only no-shift
        // rows reduce to ascent = size*0.92, lineH = size*1.2 (unchanged).
        var ascent = Math.max(maxSize * RICH_ASCENT, imgMax);
        var lineH = ascent + maxSize * (RICH_LINE_FACTOR - RICH_ASCENT) + supSubExp;
        var baseline = y + ascent;
        var align = alignH(entry.align || defAlign);
        var x0 = indent + (align === 'right' ? (avail - rowW)
          : align === 'center' ? (avail - rowW) / 2 : 0);
        // drawio default overflow is VISIBLE: long unbreakable rows extend
        // past the box on screen (left for right-align, both for center).
        // The old clamp hid the real x0, so the overflow side was wrong
        // and the viewport could not be grown to show it.
        extend(x0, x0 + rowW);
        var x = x0;
        var bgRects = [], texts = [];
        row.forEach(function (tk, i) {
          var sp = (tk.space && i > 0) ? spaceWidthPx(tk.st.size, tk.st.family, tk.st.weight >= 600) : 0;
          x += sp;
          var tw = tokenWidth(tk);
          if (tk.img) {
            texts.push('<image x="' + fmt(x) + '" y="' + fmt(baseline - tk.img.h) +
              '" width="' + fmt(tk.img.w) + '" height="' + fmt(tk.img.h) +
              '" preserveAspectRatio="none" xlink:href="' + tk.img.href + '"/>');
          } else {
            var st = tk.st;
            if (st.bg) {
              bgRects.push('<rect x="' + fmt(x) + '" y="' + fmt(y) +
                '" width="' + fmt(tw) + '" height="' + fmt(lineH) +
                '" fill="' + st.bg + '"' +
                (st.bgAlpha < 1 ? ' fill-opacity="' + fmt(st.bgAlpha) + '"' : '') + '/>');
            }
            var deco = [];
            if (st.underline) deco.push('underline');
            if (st.strike) deco.push('line-through');
            if (st.overline) deco.push('overline');
            texts.push('<text x="' + fmt(x) + '" y="' + fmt(baseline + st.vshift) +
              '" font-family="' + escXml(st.family) + ', Arial, sans-serif"' +
              ' font-size="' + fmt(st.size) + '" font-weight="' + st.weight + '"' +
              (st.italic ? ' font-style="italic"' : '') +
              (deco.length ? ' text-decoration="' + deco.join(' ') + '"' : '') +
              (st.letterSpacing ? ' letter-spacing="' + fmt(st.letterSpacing) + '"' : '') +
              ' fill="' + st.color + '"' +
              (st.colorAlpha < 1 ? ' fill-opacity="' + fmt(st.colorAlpha) + '"' : '') +
              ' xml:space="preserve">' + escXml(tk.text) + '</text>');
          }
          x += tw;
        });
        parts.push(bgRects.join('') + texts.join(''));
        y += lineH;
      });
    }
    function emitRule(entry) {
      var size = entry.size || 12;
      var ry = y + size * 0.6;
      parts.push('<line x1="0" y1="' + fmt(ry) + '" x2="' + fmt(width) +
        '" y2="' + fmt(ry) + '" stroke="' + (entry.color || '#000000') +
        '" stroke-width="1"/>');
      extend(0, width);
      y += size * 1.2;
    }
    function emitForeign(entry) {
      var fw = Math.max(1, entry.w || width);
      var fh = Math.max(1, entry.h || ((entry.st && entry.st.size) || 12) * RICH_LINE_FACTOR);
      var laid = layoutBlocks(entry.blocks || [], fw, true, entry.align || defAlign);
      var cid = 'fo' + (++richClipCounter);
      var bg = entry.st && entry.st.bg
        ? '<rect x="0" y="0" width="' + fmt(fw) + '" height="' + fmt(fh) +
          '" fill="' + entry.st.bg + '"' +
          (entry.st.bgAlpha < 1 ? ' fill-opacity="' + fmt(entry.st.bgAlpha) + '"' : '') + '/>'
        : '';
      parts.push('<g transform="translate(' + fmt(entry.x || 0) + ' ' + fmt(entry.y || 0) + ')">' +
        '<defs><clipPath id="' + cid + '"><rect x="0" y="0" width="' + fmt(fw) +
        '" height="' + fmt(fh) + '"/></clipPath></defs>' + bg +
        '<g clip-path="url(#' + cid + ')">' + laid.svg + '</g></g>');
      extend(entry.x || 0, (entry.x || 0) + fw);
      y = Math.max(y, (entry.y || 0) + fh);
    }

    function emitTable(entry) {
      var rows = entry.rows || [];
      if (!rows.length) return;
      var cellPad = 3;
      // Place cells into an occupancy grid honoring colspan/rowspan (browser
      // table model): a spanning cell reserves its columns/rows so following
      // cells flow into the next free column. Previously colspan/rowspan were
      // ignored (every <td> took one sequential column → misaligned grids).
      var placed = [];          // {r,c,colspan,rowspan,cell}
      var occ = [];             // occ[r][c] = true when covered
      function isFree(r, c) { return !(occ[r] && occ[r][c]); }
      var ncols = 0;
      for (var r = 0; r < rows.length; r++) {
        var col = 0;
        var rowCells = rows[r];
        for (var ci = 0; ci < rowCells.length; ci++) {
          while (!isFree(r, col)) col++;
          var cell = rowCells[ci];
          var cs = Math.max(1, cell.colspan || 1);
          var rs = Math.max(1, cell.rowspan || 1);
          for (var rr = r; rr < r + rs; rr++) {
            if (!occ[rr]) occ[rr] = [];
            for (var cc = col; cc < col + cs; cc++) occ[rr][cc] = true;
          }
          placed.push({ r: r, c: col, colspan: cs, rowspan: rs, cell: cell });
          col += cs;
          if (col > ncols) ncols = col;
        }
      }
      if (ncols === 0) return;
      // Content-based column widths (CSS auto-layout): measure each cell's
      // natural (unwrapped) ink width, accumulate the per-column maximum (a
      // spanning cell contributes its width / colspan to each spanned column),
      // then distribute the table width proportionally. Was width/ncols (equal).
      var natural = new Array(ncols).fill(1);
      placed.forEach(function (pc) {
        var m = layoutBlocks(pc.cell.blocks, 1e6, false, pc.cell.align);
        var natW = Math.max(0, (m.maxX || 0) - (m.minX || 0)) + cellPad * 2;
        var share = natW / pc.colspan;
        for (var k = pc.c; k < pc.c + pc.colspan; k++) {
          if (share > natural[k]) natural[k] = share;
        }
      });
      var totalNat = natural.reduce(function (a, b) { return a + b; }, 0);
      var colW = natural.map(function (n) { return width * n / totalNat; });
      var colX = [0];
      for (var x1 = 0; x1 < ncols; x1++) colX.push(colX[x1] + colW[x1]);
      extend(0, width);
      // Compute row heights first (a rowspan cell adds to its LAST row).
      var rowH = new Array(rows.length).fill(0);
      var laidMap = [];
      placed.forEach(function (pc) {
        var boxW = 0;
        for (var k = pc.c; k < pc.c + pc.colspan; k++) boxW += colW[k];
        var inner = layoutBlocks(pc.cell.blocks, Math.max(1, boxW - cellPad * 2), wrap, pc.cell.align);
        pc.laid = inner;
        var needH = inner.height + cellPad * 2;
        if (pc.rowspan === 1 && needH > rowH[pc.r]) rowH[pc.r] = needH;
      });
      for (var ri = 0; ri < rows.length; ri++) {
        if (rowH[ri] <= 0) rowH[ri] = (entry.size || 12) * RICH_LINE_FACTOR + cellPad * 2;
      }
      // Second pass: ensure rowspan cells fit across their rows. Distribute the
      // deficit EVENLY across the spanned rows (browsers spread a rowspan cell's
      // extra height over its rows, not all onto the last one).
      placed.forEach(function (pc) {
        if (pc.rowspan > 1) {
          var have = 0;
          for (var k = pc.r; k < pc.r + pc.rowspan; k++) have += rowH[k];
          var need = pc.laid.height + cellPad * 2;
          if (need > have) {
            var add = (need - have) / pc.rowspan;
            for (var k2 = pc.r; k2 < pc.r + pc.rowspan; k2++) rowH[k2] += add;
          }
        }
      });
      var rowY = [y];
      for (var ry = 0; ry < rows.length; ry++) rowY.push(rowY[ry] + rowH[ry]);
      void laidMap;
      placed.forEach(function (pc) {
        var cx = colX[pc.c];
        var cw = colX[pc.c + pc.colspan] - cx;
        var cy = rowY[pc.r];
        var ch = rowY[pc.r + pc.rowspan] - cy;
        if (entry.border) {
          parts.push('<rect x="' + fmt(cx) + '" y="' + fmt(cy) +
            '" width="' + fmt(cw) + '" height="' + fmt(ch) +
            '" fill="none" stroke="' + (entry.color || '#000000') +
            '" stroke-width="1"/>');
        }
        if (pc.laid) {
          parts.push('<g transform="translate(' + fmt(cx + cellPad) + ' ' +
            fmt(cy + cellPad) + ')">' + pc.laid.svg + '</g>');
        }
      });
      y = rowY[rows.length];
    }
    // UA/inline block margins: adjacent vertical margins collapse (max of the
    // two); the first/last child's margin stays inside the label container
    // (inline-block contains its children's margins), so it counts toward the
    // total height — that shifts centered labels exactly like the browser.
    var pendingMb = 0;
    var firstEntry = true;
    entries.forEach(function (entry) {
      var mt = entry.mt || 0;
      y += firstEntry ? mt : Math.max(pendingMb, mt);
      firstEntry = false;
      if (entry.kind === 'rule') emitRule(entry);
      else if (entry.kind === 'table') emitTable(entry);
      else if (entry.kind === 'foreign') emitForeign(entry);
      else emitPara(entry);
      pendingMb = entry.mb || 0;
    });
    y += pendingMb;
    return { svg: parts.join(''), height: y,
      minX: Number.isFinite(minX) ? minX : 0,
      maxX: Number.isFinite(maxX) ? maxX : 0 };
  }

  // Render an HTML label faithfully (headless) -> { body, height }.
  function renderRichLabel(raw, style, box, resolved, notices, cellId) {
    var doc = root.document;
    if (!doc || typeof doc.createElement !== 'function') return null;
    var host = doc.createElement('div');
    host.innerHTML = String(raw);
    var baseSt = baseRunStyle(style);
    var defAlign = textDefaultAlign(style);
    var entries = buildRichModel(host, baseSt, defAlign, resolved, notices, cellId);
    if (!entries.length) return { body: '', height: 0 };
    var rpads = labelPads(style);
    var wrap = style.whiteSpace === 'wrap';
    var contentW = Math.max(1, box.w - rpads.l - rpads.r);
    var laid = layoutBlocks(entries, contentW, wrap, defAlign);
    return { body: laid.svg, height: laid.height, pad: rpads.l,
      contentW: contentW, minX: laid.minX, maxX: laid.maxX };
  }


  // Assemble the final label <svg> node. drawio clips a label to its box
  // ONLY for overflow=hidden (and fill, which sizes content to the cell);
  // the DEFAULT is overflow visible -- long unwrapped lines and overflowing
  // paragraphs extend past the shape on screen. The old unconditional
  // clipPath silently amputated that ink. For visible overflow the SVG
  // viewport (and the contract box) is grown by the measured overhang and
  // the content translated, so the printed label shows exactly what the
  // editor shows. `over` = {l,r,t,b} in BOX space.
  function labelSvgAssemble(box, content, clipId, clipped, gOpacityAttr, over) {
    if (clipped || !over || (over.l <= 0 && over.r <= 0 && over.t <= 0 && over.b <= 0)) {
      var svg = '<svg xmlns="http://www.w3.org/2000/svg"' +
        ' xmlns:xlink="http://www.w3.org/1999/xlink" width="' + fmt(box.w) +
        '" height="' + fmt(box.h) + '">' +
        (clipped
          ? '<defs><clipPath id="' + clipId + '"><rect x="0" y="0" width="' +
            fmt(box.w) + '" height="' + fmt(box.h) + '"/></clipPath></defs>' +
            '<g clip-path="url(#' + clipId + ')"' + gOpacityAttr + '>'
          : '<g' + gOpacityAttr + '>') +
        content + '</g></svg>';
      return { kind: 'svg',
        box: { x: box.x, y: box.y, w: box.w, h: box.h },
        source: base64(svg), aspect: 'preserve' };
    }
    var gl = Math.max(0, over.l), gr = Math.max(0, over.r);
    var gt = Math.max(0, over.t), gb = Math.max(0, over.b);
    var w2 = box.w + gl + gr, h2 = box.h + gt + gb;
    var grown = '<svg xmlns="http://www.w3.org/2000/svg"' +
      ' xmlns:xlink="http://www.w3.org/1999/xlink" width="' + fmt(w2) +
      '" height="' + fmt(h2) + '"><g transform="translate(' + fmt(gl) + ' ' +
      fmt(gt) + ')"' + gOpacityAttr + '>' + content + '</g></svg>';
    return { kind: 'svg',
      box: { x: box.x - gl, y: box.y - gt, w: w2, h: h2 },
      source: base64(grown), aspect: 'preserve' };
  }

  // Map label-space overflow (l,r,t,b) into box space for a vertical
  // (horizontal=0, rotate -90) label: label +x (right) exits the box TOP,
  // label +y (down) exits the box RIGHT.
  function rotateOverflow(over, vertical) {
    if (!vertical) return over;
    return { l: over.t, r: over.b, t: over.r, b: over.l };
  }

  // Measured extent (CONTRACT coords) of the most recent textSvgNode layout.
  // drawio paints labelBackgroundColor/labelBorderColor hugging the laid-out
  // text, not the whole cell box — labelNodes() reads this to size the box.
  var lastLabelExtent = null;

  function textSvgNode(graph, cell, style, box, label, notices, resolved) {
    var raw = graph && typeof graph.getLabel === 'function' ? graph.getLabel(cell) : label;
    var src = raw != null ? raw : label;
    var labelIsHtml = isHtmlLabelStyle(style);
    var fst = parseInt(style.fontStyle || 0, 10) || 0;
    var family = style.fontFamily || 'Arial';
    var color = isPaintable(style.fontColor) ? hex(style.fontColor) : '#000000';
    var h = textDefaultAlign(style);
    var v = textDefaultValign(style);
    // overflow=fill/width sizes the label to the whole cell and flows content
    // from the top (mxGraph), so the vertical alignment is effectively top —
    // not the style's verticalAlign. (UML Component has no verticalAlign yet
    // its title sits at the top in the editor.)
    if (style.overflow === 'fill' || style.overflow === 'width') v = 'top';
    var pads = labelPads(style);
    var pl = pads.l, pr = pads.r, pt = pads.t, pb = pads.b;
    var letterSp = number(style.letterSpacing, 0); // drawio letterSpacing (CSS letter-spacing)
    // drawio STYLE_TEXT_OPACITY: the whole label is drawn at this opacity.
    // Applied as a group opacity so every run/decoration fades uniformly.
    var topac = number(style.textOpacity, 100) / 100;
    var gOpacityAttr = topac < 1 ? ' opacity="' + fmt(topac) + '"' : '';
    var clipId = 'txt' + String(cell && cell.id || Math.random()).replace(/[^a-z0-9]/gi, '');

    // HTML label -> faithful per-run rich-text renderer (colour / family / size
    // / weight / italic / decoration / highlight / sub-sup / lists / hr / inline
    // images / tables). Plain labels keep the simple line renderer below.
    // renderRichLabel returns null when no DOM is available (e.g. a harness with
    // no shim); we then fall through to the regex htmlTextBlocks path below.
    var vertical = String(style.horizontal) === '0';
    var lw = vertical ? box.h : box.w;
    var lh = vertical ? box.w : box.h;
    var rich = (labelIsHtml && String(src == null ? '' : src).indexOf('<') >= 0)
      ? renderRichLabel(src, style, { w: lw, h: lh }, resolved, notices, cell && cell.id)
      : null;
    // Map a label-space rect to a CONTRACT-coords rect (identity when
    // horizontal; the vertical -90° rotation maps label x → box -y and
    // label y → box x). Used for the measured label-background extent.
    function extentFromLabelSpace(x0, y0, x1, y1) {
      var bx0, by0, bx1, by1;
      if (vertical) { bx0 = y0; bx1 = y1; by0 = box.h - x1; by1 = box.h - x0; }
      else { bx0 = x0; bx1 = x1; by0 = y0; by1 = y1; }
      return { x: box.x + bx0, y: box.y + by0,
        w: Math.max(0, bx1 - bx0), h: Math.max(0, by1 - by0) };
    }
    lastLabelExtent = null;

    if (rich) {
      var richEls = '';
      // mxText.getSpacing(ALIGN_MIDDLE): dy = (spacingTop - spacingBottom)/2 —
      // asymmetric per-side spacing SHIFTS a middle label; it never re-anchors
      // it. And drawio never clamps oy to 0: a label taller than its box
      // centers regardless (spilling above AND below); bottom spills above.
      var oy = v === 'middle' ? (lh - rich.height) / 2 + (pt - pb) / 2 :
        v === 'bottom' ? lh - rich.height - pb : pt;
      if (rich.body !== '') {
        var body = '<g transform="translate(' + fmt(pl) + ' ' + fmt(oy) + ')">' +
          rich.body + '</g>';
        if (vertical) {
          var vcx = box.w / 2, vcy = box.h / 2;
          richEls = '<g transform="translate(' + fmt(vcx) + ' ' + fmt(vcy) +
            ') rotate(-90) translate(' + fmt(-lw / 2) + ' ' + fmt(-lh / 2) + ')">' +
            body + '</g>';
        } else {
          richEls = body;
        }
      }
      // 'block' clips too: mxSvgCanvas2D.createCss block branch caps the
      // label at max-height=round(h) — the bake printed the overflow lines
      // the editor clips.
      // 'width' clips too: createCss width branch (mxSvgCanvas2D.js:1915-1926)
      // keeps overflow:hidden + max-height:round(h), so a width-overflow label
      // clips to the cell instead of growing the viewport (it just uses the
      // cell width for wrapping). The bake printed the overhang for overflow=width.
      var richClipped = style.overflow === 'hidden' || style.overflow === 'fill' ||
        style.overflow === 'block' || style.overflow === 'width';
      // Label-space overflow: rows can overhang horizontally (minX<0 /
      // maxX>contentW) and the paragraph stack can overhang the top (negative
      // oy for too-tall middle/bottom labels) and/or the bottom.
      var labelOver = rich.body !== '' ? {
        l: Math.max(0, -((rich.minX || 0) + pl)),
        r: Math.max(0, (rich.maxX || 0) + pl - lw),
        t: Math.max(0, -oy),
        b: Math.max(0, oy + rich.height - lh)
      } : { l: 0, r: 0, t: 0, b: 0 };
      if (rich.body !== '') {
        lastLabelExtent = extentFromLabelSpace(pl + (rich.minX || 0), oy,
          pl + (rich.maxX || 0), oy + rich.height);
      }
      return labelSvgAssemble(box, richEls, clipId, richClipped, gOpacityAttr,
        rotateOverflow(labelOver, vertical));
    }

    // Non-HTML labels are literal text: render verbatim (no tag stripping), so
    // e.g. "List<String>" keeps its angle brackets exactly as drawio shows them.
    // Layout happens in LABEL space (lw × lh): for horizontal=0 these are the
    // box dimensions swapped, and the laid-out multi-row block is rotated as a
    // whole — wrapping, per-row alignment, valign and gaps all survive,
    // exactly like the rich path (previously the vertical branch collapsed
    // everything to one centered line).
    var blocks = htmlTextBlocks(src, style, !labelIsHtml);
    var usableW = Math.max(1, lw - pl - pr);
    var rows = [];
    blocks.forEach(function (b) {
      if (b.rule) {
        rows.push({ rule: true, size: 0, weight: 400, lineH: b.size, gap: b.gap });
        return;
      }
      wrapSvgText(b.text, b.size, usableW, style.whiteSpace === 'wrap', letterSp, style.fontFamily, ((number(style.fontStyle, 0) & 1) !== 0)).forEach(function (line) {
        rows.push({ text: line, size: b.size, weight: b.weight,
          // plain labels: drawio ROUNDS the line pitch
          // (mxSvgCanvas2D.plainText lh = Math.round(size * LINE_HEIGHT));
          // unrounded 1.2 drifted 0.4px per line on e.g. fontSize 13. HTML
          // labels keep unrounded CSS 1.2 via renderRichLabel, not here.
          lineH: Math.round(b.size * 1.2), gap: b.gap, align: b.align,
          underline: !!b.underline });
      });
    });
    if (!rows.length) rows.push({ text: String(label || ''), size: 12, weight: 400, lineH: 14, gap: 0 });
    var totalH = rows.reduce(function (sum, r, i) {
      return sum + r.lineH + (i === 0 ? 0 : r.gap);
    }, 0);
    // mxText.getSpacing(ALIGN_MIDDLE): dy = (spacingTop - spacingBottom)/2.
    // No clamp to 0: a too-tall middle/bottom label spills ABOVE the box
    // (drawio overflow=visible semantics); the viewport grows upward below.
    // EXCEPT when the label is CLIPPED: mxSvgCanvas2D.plainText
    // (matchHtmlAlignment) clamps the effective text height to min(H, box)
    // before applying valign, so the clip window shows the FIRST lines --
    // the unclamped offset showed the MIDDLE/LAST lines instead.
    var plainClipped = style.overflow === 'hidden' || style.overflow === 'fill' ||
      style.overflow === 'block' || style.overflow === 'width';  // createCss block/width branch clips at round(h)
    var effTotalH = plainClipped ? Math.min(totalH, lh) : totalH;
    var y = v === 'middle' ? (lh - effTotalH) / 2 + (pt - pb) / 2 :
      v === 'bottom' ? lh - effTotalH - pb : pt;
    var yTop = y;
    var decoration = [];
    if (fst & 4) decoration.push('underline');
    if (fst & 8) decoration.push('line-through');
    var textEls = rows.map(function (r, i) {
      y += (i === 0 ? 0 : r.gap);
      var ty = y;
      y += r.lineH;
      if (r.rule) {
        // <hr> divider: a horizontal line across the inner width, centered in
        // its row band (≈ baseSize tall → ~half above / half below the line).
        var ry = ty + r.lineH / 2;
        return '<line x1="' + fmt(pl) + '" y1="' + fmt(ry) +
          '" x2="' + fmt(lw - pr) + '" y2="' + fmt(ry) +
          '" stroke="' + color + '" stroke-width="1"/>';
      }
      var rowH = alignH(r.align || h);
      var anchor = rowH === 'right' ? 'end' : rowH === 'center' ? 'middle' : 'start';
      // mxText.getSpacing(ALIGN_CENTER): dx = (spacingLeft - spacingRight)/2.
      var x = rowH === 'right' ? lw - pr :
        rowH === 'center' ? lw / 2 + (pl - pr) / 2 : pl;
      var rowDec = decoration.slice();
      if (r.underline && rowDec.indexOf('underline') < 0) rowDec.push('underline');
      return '<text x="' + fmt(x) + '" y="' + fmt(ty) +
        '" font-family="' + escXml(family) + ', Arial, sans-serif"' +
        ' font-size="' + fmt(r.size) + '" font-weight="' + r.weight + '"' +
        ((fst & 2) ? ' font-style="italic"' : '') +
        (rowDec.length ? ' text-decoration="' + rowDec.join(' ') + '"' : '') +
        (letterSp ? ' letter-spacing="' + fmt(letterSp) + '"' : '') +
        ' fill="' + color + '" text-anchor="' + anchor +
        '" dominant-baseline="text-before-edge" xml:space="preserve">' +
        escXml(r.text) + '</text>';
    }).join('');
    var yEnd = y;

    // Label-space text extent (rows are anchored, so widths come from the
    // shared glyph metrics) — feeds both the visible-overflow viewport growth
    // and the measured label-background box.
    var exMinX = Infinity, exMaxX = -Infinity;
    rows.forEach(function (r) {
      if (r.rule) { exMinX = Math.min(exMinX, pl); exMaxX = Math.max(exMaxX, lw - pr); return; }
      if (r.text == null) return;
      var rw = textWidthPx(r.text, r.size, 0, style.fontFamily, ((number(style.fontStyle, 0) & 1) !== 0)) +
        (letterSp ? letterSp * r.text.length : 0);
      var rh2 = alignH(r.align || h);
      var rx0 = rh2 === 'right' ? lw - pr - rw :
        rh2 === 'center' ? lw / 2 + (pl - pr) / 2 - rw / 2 : pl;
      exMinX = Math.min(exMinX, rx0);
      exMaxX = Math.max(exMaxX, rx0 + rw);
    });
    if (!Number.isFinite(exMinX)) { exMinX = pl; exMaxX = pl; }
    var plainOver = {
      l: Math.max(0, -exMinX),
      r: Math.max(0, exMaxX - lw),
      t: Math.max(0, -yTop),
      b: Math.max(0, yEnd - lh)
    };
    if (vertical) {
      textEls = '<g transform="translate(' + fmt(box.w / 2) + ' ' + fmt(box.h / 2) +
        ') rotate(-90) translate(' + fmt(-lw / 2) + ' ' + fmt(-lh / 2) + ')">' +
        textEls + '</g>';
    }
    lastLabelExtent = extentFromLabelSpace(exMinX, yTop, exMaxX, yEnd);
    return labelSvgAssemble(box, textEls, clipId, plainClipped, gOpacityAttr,
      rotateOverflow(plainOver, vertical));
  }

  function labelTextNode(graph, cell, state, style, box, label, notices, resolved) {
    // Native print is headless-only: every label is built as an SVG text node
    // (which also fades correctly when drawio's textOpacity<100), with no
    // contract-schema change. (state is retained in the signature for call-site
    // stability but is not needed by the SVG label builder.)
    return textSvgNode(graph, cell, style, box, label, notices, resolved);
  }

  // Label background/border (labelBackgroundColor/labelBorderColor) + text,
  // in paint order. drawio sizes the background rect to the laid-out text
  // bounding box (mxSvgCanvas2D.addTextBackground / the HTML label div), NOT
  // to the whole cell box — so the text node is built first and the measured
  // extent drives the box. overflow=fill/width sizes the label to the whole
  // box (mxGraph), so the background covers the full box there.
  function labelNodes(graph, cell, state, style, box, label, notices, resolved) {
    var textNode = labelTextNode(graph, cell, state, style, box, label, notices, resolved);
    var out = [];
    var extent = (style.overflow === 'fill' || style.overflow === 'width')
      ? box : (lastLabelExtent || box);
    var bg = labelBoxNode(style, extent);
    if (bg) out.push(bg);
    out.push(textNode);
    return out;
  }

  function p(x, y) {
    return fmt(x) + ' ' + fmt(y);
  }

  function rectPath(x, y, w, h) {
    return 'M ' + p(x, y) + ' L ' + p(x + w, y) + ' L ' +
      p(x + w, y + h) + ' L ' + p(x, y + h) + ' Z';
  }

  // The C++ engine's path parser (path_parser.cpp) accepts only absolute
  // M/L/H/V/C/A/Z — NOT Q (quadratic). kind:"path" nodes (plain shapePath
  // shapes) are parsed by the engine, so any Q would be rejected with
  // "unsupported SVG path command". Convert each quadratic to its exact cubic
  // equivalent (control points = current/end + 2/3*(ctrl - current/end)).
  // (kind:"svg" nodes go through resvg, which handles Q, and never reach here.)
  function quadToCubicPath(d) {
    if (!d || d.indexOf('Q') < 0) return d;
    var toks = d.match(/[A-Za-z]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || [];
    var out = [], i = 0, cmd = '', cx = 0, cy = 0, sx = 0, sy = 0;
    var num = function () { return parseFloat(toks[i++]); };
    while (i < toks.length) {
      if (/[A-Za-z]/.test(toks[i])) cmd = toks[i++];
      var C = cmd.toUpperCase();
      if (C === 'M' || C === 'L') {
        var x1 = num(), y1 = num(); out.push(C, fmt(x1), fmt(y1)); cx = x1; cy = y1;
        if (C === 'M') { sx = cx; sy = cy; }
      } else if (C === 'H') { var hx = num(); out.push('H', fmt(hx)); cx = hx;
      } else if (C === 'V') { var vy = num(); out.push('V', fmt(vy)); cy = vy;
      } else if (C === 'C') {
        var a = num(), b = num(), c2 = num(), d2 = num(), e = num(), f = num();
        out.push('C', fmt(a), fmt(b), fmt(c2), fmt(d2), fmt(e), fmt(f)); cx = e; cy = f;
      } else if (C === 'A') {
        var rx = num(), ry = num(), rot = num(), laf = num(), sf = num(), ax = num(), ay = num();
        out.push('A', fmt(rx), fmt(ry), fmt(rot), fmt(laf), fmt(sf), fmt(ax), fmt(ay)); cx = ax; cy = ay;
      } else if (C === 'Q') {
        var qx = num(), qy = num(), ex = num(), ey = num();
        out.push('C', fmt(cx + 2 / 3 * (qx - cx)), fmt(cy + 2 / 3 * (qy - cy)),
          fmt(ex + 2 / 3 * (qx - ex)), fmt(ey + 2 / 3 * (qy - ey)), fmt(ex), fmt(ey));
        cx = ex; cy = ey;
      } else if (C === 'Z') { out.push('Z'); cx = sx; cy = sy;
      } else { i++; }
    }
    return out.join(' ');
  }

  // Mirror an absolute SVG path about the box centre (cx,cy) for flipH/flipV.
  // Built-in shapePath shapes ignored flip (only stencils flipped). Reflecting
  // the geometry (label stays unflipped/upright, as drawio does) fixes that.
  // Arc commands flip their x-axis-rotation sign and toggle the sweep flag when
  // exactly one axis is mirrored (orientation reverses).
  function flipPathD(d, cx, cy, fh, fv) {
    if (!fh && !fv) return d;
    var toks = String(d).match(/[a-zA-Z]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || [];
    var out = [], i = 0, cmd = '';
    var FX = function (x) { return fh ? 2 * cx - x : x; };
    var FY = function (y) { return fv ? 2 * cy - y : y; };
    var num = function () { return parseFloat(toks[i++]); };
    var swap = fh !== fv; // exactly one mirror -> orientation reversed
    while (i < toks.length) {
      if (/[a-zA-Z]/.test(toks[i])) { cmd = toks[i++]; out.push(cmd); }
      var C = cmd.toUpperCase();
      if (C === 'M' || C === 'L' || C === 'T' || C === 'S' || C === 'Q' || C === 'C') {
        var pairs = C === 'C' ? 3 : (C === 'S' || C === 'Q') ? 2 : 1;
        for (var k = 0; k < pairs; k++) { out.push(fmt(FX(num()))); out.push(fmt(FY(num()))); }
      } else if (C === 'H') { out.push(fmt(FX(num())));
      } else if (C === 'V') { out.push(fmt(FY(num())));
      } else if (C === 'A') {
        out.push(fmt(num())); out.push(fmt(num())); // rx ry
        out.push(fmt(swap ? -num() : num()));        // x-axis-rotation
        out.push(fmt(num()));                        // large-arc-flag (unchanged)
        out.push(fmt(swap ? (num() ? 0 : 1) : num())); // sweep-flag toggled if one mirror
        out.push(fmt(FX(num()))); out.push(fmt(FY(num()))); // x y
      } else if (C === 'Z') { /* no args */ }
    }
    return out.join(' ');
  }

  // Rotate a path's geometry by `deg` (exact for the 90/180/270 multiples used
  // by drawio's direction= handling) around (cx,cy). Mirrors flipPathD's token
  // walk. H/V become L (a horizontal segment is no longer horizontal once
  // rotated); arc x-axis-rotation gains `deg`; sweep/large-arc flags are
  // preserved (pure rotation keeps orientation).
  function rotatePathD(d, cx, cy, deg) {
    deg = ((deg % 360) + 360) % 360;
    if (deg === 0) return d;
    var rad = deg * Math.PI / 180;
    var cos = Math.round(Math.cos(rad)), sin = Math.round(Math.sin(rad));
    var RX = function (x, y) { return cx + (x - cx) * cos - (y - cy) * sin; };
    var RY = function (x, y) { return cy + (x - cx) * sin + (y - cy) * cos; };
    var toks = String(d).match(/[a-zA-Z]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || [];
    var out = [], i = 0, cmd = '', curX = 0, curY = 0, startX = 0, startY = 0;
    var num = function () { return parseFloat(toks[i++]); };
    while (i < toks.length) {
      if (/[a-zA-Z]/.test(toks[i])) { cmd = toks[i++]; }
      var C = cmd.toUpperCase(), x, y;
      if (C === 'M' || C === 'L' || C === 'T') {
        x = num(); y = num();
        out.push(C, fmt(RX(x, y)), fmt(RY(x, y)));
        curX = x; curY = y; if (C === 'M') { startX = x; startY = y; }
      } else if (C === 'C') {
        var x1 = num(), y1 = num(), x2 = num(), y2 = num(); x = num(); y = num();
        out.push('C', fmt(RX(x1, y1)), fmt(RY(x1, y1)),
          fmt(RX(x2, y2)), fmt(RY(x2, y2)), fmt(RX(x, y)), fmt(RY(x, y)));
        curX = x; curY = y;
      } else if (C === 'Q' || C === 'S') {
        var qx = num(), qy = num(); x = num(); y = num();
        out.push(C, fmt(RX(qx, qy)), fmt(RY(qx, qy)), fmt(RX(x, y)), fmt(RY(x, y)));
        curX = x; curY = y;
      } else if (C === 'H') {
        x = num(); y = curY; out.push('L', fmt(RX(x, y)), fmt(RY(x, y))); curX = x;
      } else if (C === 'V') {
        y = num(); x = curX; out.push('L', fmt(RX(x, y)), fmt(RY(x, y))); curY = y;
      } else if (C === 'A') {
        var rx = num(), ry = num(), xr = num(), laf = num(), sf = num();
        x = num(); y = num();
        out.push('A', fmt(rx), fmt(ry), fmt((xr + deg) % 360), fmt(laf), fmt(sf),
          fmt(RX(x, y)), fmt(RY(x, y)));
        curX = x; curY = y;
      } else if (C === 'Z') { out.push('Z'); curX = startX; curY = startY; }
    }
    return out.join(' ');
  }

  // Rounded-rectangle corner radius, matching drawio mxRectangleShape.
  // Relative (default): f = arcSize/100 (default RECTANGLE_ROUNDING_FACTOR*100
  // = 15), r = min(w,h)*f. Absolute (absoluteArcSize=1): r = min(w/2, h/2,
  // arcSize/2) with arcSize default LINE_ARCSIZE = 20. Previously a hardcoded
  // 0.12*min(w,h) that ignored arcSize/absoluteArcSize — wrong radius.
  function roundedRectRadius(style, w, h) {
    if (number(style && style.absoluteArcSize, 0) === 1) {
      var as = number(style.arcSize, 20);
      return Math.min(w / 2, Math.min(h / 2, as / 2));
    }
    var f = number(style && style.arcSize, 15) / 100;
    return Math.min(w * f, h * f);
  }

  // drawio shadow: SHADOWCOLOR #808080 at SHADOW_OPACITY 1, offset
  // (SHADOW_OFFSET_X=2, SHADOW_OFFSET_Y=3), with per-cell shadowColor /
  // shadowOpacity / shadowOffsetX / shadowOffsetY overrides. The bake previously
  // used black@0.18 at (4,4) — too light and too far offset.
  function shadowParams(style) {
    // The APP overrides the raw mxConstants defaults (Graph.js:161-162:
    // SHADOW_OPACITY=0.25, SHADOWCOLOR='#000000'; offsets stay 2,3) — the
    // earlier #808080@1 matched mxgraph-the-library, not what the drawio
    // editor actually shows.
    // mxSvgCanvas2D.createShadow CLONES the painted node (which keeps its
    // own fill/stroke-opacity from the shape's opacity style) and sets the
    // clone's group opacity to shadowAlpha — so the effective shadow ink is
    // shadowAlpha * shape alpha. A flat shadowAlpha printed translucent
    // shapes' shadows twice as dark as the editor.
    return {
      color: (style && isPaintable(style.shadowColor)) ? style.shadowColor : '#000000',
      alpha: number(style && style.shadowOpacity, 0.25) *
        (style ? opacity(style, 'opacity') : 1),
      dx: number(style && style.shadowOffsetX, 2),
      dy: number(style && style.shadowOffsetY, 3)
    };
  }

  // mxSvgCanvas2D shadow (createShadow): every painted node is duplicated with
  // its non-none fill AND stroke replaced by the shadow color, offset by the
  // shadow dx/dy in SCREEN space (the translate is prepended to the node's
  // transform) and composited at the shadow alpha. Re-color a builtin shape's
  // inner-SVG content string the same way: gradient defs are dropped (the
  // shadow is flat) and per-node fill/stroke opacities removed (the caller
  // applies the shadow alpha once via a group opacity, so overlapping
  // sub-paths do not double-darken). Foreground/glass sub-paths painted after
  // drawio's setShadow(false) are included too, but they lie inside the
  // background silhouette and the flattened group composite makes the union
  // visually identical to the background-only silhouette.
  function shadowRecolorSvg(content, color) {
    return content
      .replace(/<defs>[\s\S]*?<\/defs>/g, '')
      .replace(/\b(fill|stroke)="(?!none")[^"]*"/g, '$1="' + color + '"')
      .replace(/ (?:fill|stroke)-opacity="[^"]*"/g, '');
  }

  // drawio glass effect (mxShape.paintGlassEffect): a white highlight over the
  // top ~40% of the shape, filled with a south gradient fading 0.9 -> 0.1 alpha.
  // Previously dropped silently. Returns the inner SVG content for a box-sized
  // overlay node (no own stroke). Coordinates are box-relative (0..w, 0..h).
  // glass=1 highlight. drawio paints it via paintGlassEffect (Shapes.js:2123)
  // which delegates the SILHOUETTE to paintGlassEffectPath: the rectangle family
  // + swimlane use the default rect path; mxEllipse (Shapes.js:2157) and
  // mxRhombus (Shapes.js:2171) override it with an ellipse/diamond-matching path.
  // `shape` selects the variant (default = rectangular).
  function glassOverlaySvg(style, w, h, shape) {
    var sw = Math.ceil(number(style.strokeWidth, 1) / 2);
    var size = 0.4;
    var d;
    if (shape === 'ellipse') {
      var k = 0.5522847498;
      var cx = w / 2, cy = h / 2, rx = w / 2 + sw, ry = h / 2 + sw;
      d = 'M ' + p(cx - rx, cy) +
        ' C ' + p(cx - rx, cy - ry * k) + ' ' + p(cx - rx * k, cy - ry) + ' ' + p(cx, cy - ry) +
        ' C ' + p(cx + rx * k, cy - ry) + ' ' + p(cx + rx, cy - ry * k) + ' ' + p(cx + rx, cy) +
        ' Q ' + p(cx, cy + h * 0.2) + ' ' + p(cx - rx, cy) + ' Z';
    } else if (shape === 'rhombus' || shape === 'diamond') {
      var hw = w / 2, hh = h / 2;
      d = 'M ' + p(0, hh) + ' L ' + p(hw, 0) + ' L ' + p(w, hh) +
        ' Q ' + p(hw, h * 0.7) + ' ' + p(0, hh) + ' Z';
    } else {
      var rounded = boolish(style.rounded);
      var arc = (rounded ? roundedRectRadius(style, w, h) : 0) + 2 * sw;
      d = rounded
        ? 'M ' + p(-sw + arc, -sw) + ' Q ' + p(-sw, -sw) + ' ' + p(-sw, -sw + arc) +
          ' L ' + p(-sw, h * size) + ' Q ' + p(w * 0.5, h * 0.7) + ' ' + p(w + sw, h * size) +
          ' L ' + p(w + sw, -sw + arc) + ' Q ' + p(w + sw, -sw) + ' ' + p(w + sw - arc, -sw) + ' Z'
        : 'M ' + p(-sw, -sw) + ' L ' + p(-sw, h * size) + ' Q ' + p(w * 0.5, h * 0.7) + ' ' +
          p(w + sw, h * size) + ' L ' + p(w + sw, -sw) + ' Z';
    }
    return '<defs><linearGradient id="glassg" gradientUnits="userSpaceOnUse" ' +
      'x1="0" y1="0" x2="0" y2="' + fmt(h * 0.6) + '">' +
      '<stop offset="0" stop-color="#ffffff" stop-opacity="0.9"/>' +
      '<stop offset="1" stop-color="#ffffff" stop-opacity="0.1"/></linearGradient></defs>' +
      '<path d="' + d + '" fill="url(#glassg)" stroke="none"/>';
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

  // Faithful port of mxGraph mxShape.addPoints (close=true polygon path): emits
  // straight edges with quadratic-rounded corners exactly as drawio draws a
  // rounded polygon, so a rounded rhombus/triangle/etc. prints WYSIWYG. With
  // arcSize<=0 it degrades to the sharp "M..L..Z" form (byte-identical to the
  // plain polygon paths). Verified equal to drawio's own geometry by the
  // tools/wysiwyg-oracle differential oracle.
  function roundedPoly(pts, arcSize, close) {
    if (pts == null || pts.length === 0) return '';
    close = (close == null) ? true : close;
    var pe = pts[pts.length - 1];
    if (close && arcSize > 0) {
      pts = pts.slice();
      var p0 = pts[0];
      pts.unshift({ x: pe.x + (p0.x - pe.x) / 2, y: pe.y + (p0.y - pe.y) / 2 });
    }
    var mod = function (n, m) { return ((n % m) + m) % m; };
    var pt = pts[0], i = 1, d = ['M ' + p(pt.x, pt.y)];
    while (i < (close ? pts.length : pts.length - 1)) {
      var tmp = pts[mod(i, pts.length)];
      var dx = pt.x - tmp.x, dy = pt.y - tmp.y;
      if (arcSize > 0 && (dx !== 0 || dy !== 0)) {
        var dist = Math.sqrt(dx * dx + dy * dy);
        var nx1 = dx * Math.min(arcSize, dist / 2) / dist;
        var ny1 = dy * Math.min(arcSize, dist / 2) / dist;
        d.push('L ' + p(tmp.x + nx1, tmp.y + ny1));
        var next = pts[mod(i + 1, pts.length)];
        while (i < pts.length - 2 && Math.round(next.x - tmp.x) === 0 && Math.round(next.y - tmp.y) === 0) {
          next = pts[mod(i + 2, pts.length)]; i++;
        }
        dx = next.x - tmp.x; dy = next.y - tmp.y;
        dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        var nx2 = dx * Math.min(arcSize, dist / 2) / dist;
        var ny2 = dy * Math.min(arcSize, dist / 2) / dist;
        var x2 = tmp.x + nx2, y2 = tmp.y + ny2;
        d.push('Q ' + p(tmp.x, tmp.y) + ' ' + p(x2, y2));
        tmp = { x: x2, y: y2 };
      } else {
        d.push('L ' + p(tmp.x, tmp.y));
      }
      pt = tmp; i++;
    }
    d.push(close ? 'Z' : ('L ' + p(pe.x, pe.y)));
    return d.join(' ');
  }

  // drawio rounded-corner arc size for polygon shapes: STYLE_ARCSIZE (default
  // LINE_ARCSIZE=20) halved, exactly as mxShape passes to addPoints.
  function polyArcSize(style) {
    return boolish(style.rounded) ? number(style.arcSize, 20) / 2 : 0;
  }

  // drawio isRoundable() shapes whose headless port does NOT yet round
  // faithfully: these emit a loud notice when rounded=1 so a rounded setting
  // is never a silent divergence. All straight-line polygon shapes (rhombus,
  // triangle, hexagon, parallelogram, step, trapezoid, card, manualInput,
  // loopLimit, offPageConnector, corner, tee, singleArrow, doubleArrow) and
  // process round faithfully via roundedPoly/roundedRectPath and are NOT
  // listed; zigzag rounded=1 is the faithful cubic wave in builtinShapeSvg.
  // folder/callout mix curves or multi-part paint with the rounding and are
  // not practically portable in this pass — loud, not silent.
  var ROUNDED_NOT_YET = { folder: 1, callout: 1 };

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

  // drawio mxTriangle.redrawPath draws the default (east) triangle
  // (0,0)->(w,h/2)->(0,h); direction= rotation is applied generically by the
  // caller's outlinePath (mxShape.getShapeRotation), so this never branches.
  function trianglePath(x, y, w, h) {
    return 'M ' + p(x, y) + ' L ' + p(x + w, y + h / 2) +
      ' L ' + p(x, y + h) + ' Z';
  }

  function cylinderPath(style, x, y, w, h) {
    // mxCylinder.redrawPath (mxCylinder.js:86-110). The cap controls are the
    // drawio cubic controls -dy/3 (top), h+dy/3 (bottom), 2*dy (front lid) —
    // NOT a circle-bezier (k=0.5522), which made the caps far too shallow (a
    // -dy/3 top rim peaks at the box top y=0; a circle bezier peaked at
    // ~0.59*dy). getCylinderSize = min(maxHeight=40, round(h/5)), OVERRIDDEN
    // by style.size to h*clamp01(size) when present (Shapes.js:1351-1363) —
    // the size key was previously ignored entirely.
    var e = (style && style.size != null)
      ? h * Math.max(0, Math.min(1, number(style.size, 0)))
      : Math.min(40, Math.round(h / 5));
    return 'M ' + p(x, y + e) +
      ' C ' + p(x, y - e / 3) + ' ' + p(x + w, y - e / 3) + ' ' + p(x + w, y + e) +
      ' L ' + p(x + w, y + h - e) +
      ' C ' + p(x + w, y + h + e / 3) + ' ' + p(x, y + h + e / 3) + ' ' + p(x, y + h - e) +
      ' Z M ' + p(x, y + e) +
      ' C ' + p(x, y + 2 * e) + ' ' + p(x + w, y + 2 * e) + ' ' + p(x + w, y + e);
  }

  function cloudPath(x, y, w, h) {
    // Exact mxCloud.redrawPath silhouette (mxCloud.js:45-55). The previous
    // hand-drawn approximation was a visibly different cloud outline.
    return 'M ' + p(x + 0.25 * w, y + 0.25 * h) +
      ' C ' + p(x + 0.05 * w, y + 0.25 * h) + ' ' + p(x, y + 0.5 * h) + ' ' + p(x + 0.16 * w, y + 0.55 * h) +
      ' C ' + p(x, y + 0.66 * h) + ' ' + p(x + 0.18 * w, y + 0.9 * h) + ' ' + p(x + 0.31 * w, y + 0.8 * h) +
      ' C ' + p(x + 0.4 * w, y + h) + ' ' + p(x + 0.7 * w, y + h) + ' ' + p(x + 0.8 * w, y + 0.8 * h) +
      ' C ' + p(x + w, y + 0.8 * h) + ' ' + p(x + w, y + 0.6 * h) + ' ' + p(x + 0.875 * w, y + 0.5 * h) +
      ' C ' + p(x + w, y + 0.3 * h) + ' ' + p(x + 0.8 * w, y + 0.1 * h) + ' ' + p(x + 0.625 * w, y + 0.2 * h) +
      ' C ' + p(x + 0.5 * w, y + 0.05 * h) + ' ' + p(x + 0.3 * w, y + 0.05 * h) + ' ' + p(x + 0.25 * w, y + 0.25 * h) + ' Z';
  }

  // doubleEllipse: outer ellipse + inner ellipse (concentric, inset by margin
  // each side). mxDoubleEllipse.paintForeground: margin = getValue(style,
  // 'margin', min(3 + strokewidth, min(w/5, h/5))) — the previous
  // min(w,h)*0.1+2 was a different inset and ignored the margin style key.
  function doubleEllipsePath(style, x, y, w, h) {
    var sw = Math.max(0, number(style && style.strokeWidth, 1));
    var margin = number(style && style.margin,
      Math.min(3 + sw, Math.min(w / 5, h / 5)));
    var d = ellipsePath(x, y, w, h);
    if (w - 2 * margin > 0 && h - 2 * margin > 0) {
      d += ' ' + ellipsePath(x + margin, y + margin, w - 2 * margin, h - 2 * margin);
    }
    return d;
  }

  // actor: exact mxActor.redrawPath silhouette (mxActor.js:77-87) — a single
  // closed path (rounded head blending into shoulders), not the previous
  // separate-circle-plus-trapezoid approximation.
  function actorPath(x, y, w, h) {
    var width = w / 3;
    return 'M ' + p(x, y + h) +
      ' C ' + p(x, y + 3 * h / 5) + ' ' + p(x, y + 2 * h / 5) + ' ' + p(x + w / 2, y + 2 * h / 5) +
      ' C ' + p(x + w / 2 - width, y + 2 * h / 5) + ' ' + p(x + w / 2 - width, y) + ' ' + p(x + w / 2, y) +
      ' C ' + p(x + w / 2 + width, y) + ' ' + p(x + w / 2 + width, y + 2 * h / 5) + ' ' + p(x + w / 2, y + 2 * h / 5) +
      ' C ' + p(x + w, y + 2 * h / 5) + ' ' + p(x + w, y + 3 * h / 5) + ' ' + p(x + w, y + h) + ' Z';
  }

  // swimlane: rectangle with a header bar + divider line.
  // horizontal=1 (default): header at top, divider is horizontal at y=startSize.
  // horizontal=0: header on the left, divider is vertical at x=startSize.
  function swimlanePath(style, x, y, w, h) {
    var isHoriz = String(style.horizontal) !== '0';
    // mxSwimlane.getTitleSize falls back to mxConstants.DEFAULT_STARTSIZE=40
    // when startSize is unset (was 30 here, a 10px header/divider/body shift).
    var startSize = Math.min(Math.max(0, number(style.startSize, 40)), isHoriz ? h : w);
    var body = boolish(style.rounded)
      ? roundedRectPath(x, y, w, h, roundedRectRadius(style, w, h))
      : rectPath(x, y, w, h);
    if (isHoriz) {
      return body +
        ' M ' + p(x, y + startSize) + ' L ' + p(x + w, y + startSize);
    } else {
      return body +
        ' M ' + p(x + startSize, y) + ' L ' + p(x + startSize, y + h);
    }
  }

  // hexagon: 6-sided polygon (flat top, like a hex cell)
  function hexagonPath(x, y, w, h, dx) {
    if (dx == null) dx = w * 0.25;
    return 'M ' + p(x + dx, y) +
      ' L ' + p(x + w - dx, y) +
      ' L ' + p(x + w, y + h / 2) +
      ' L ' + p(x + w - dx, y + h) +
      ' L ' + p(x + dx, y + h) +
      ' L ' + p(x, y + h / 2) + ' Z';
  }

  // line: simple horizontal/vertical line through cell center
  function linePath(x, y, w, h) {
    return 'M ' + p(x, y + h / 2) + ' L ' + p(x + w, y + h / 2);
  }

  // arrow: a right-pointing arrow shape
  function arrowShapePath(x, y, w, h) {
    var arrowW = w * 0.6;
    var arrowH = h * 0.4;
    var dy = (h - arrowH) / 2;
    return 'M ' + p(x, y + h * 0.25) +
      ' L ' + p(x + arrowW, y + h * 0.25) +
      ' L ' + p(x + arrowW, y) +
      ' L ' + p(x + w, y + h / 2) +
      ' L ' + p(x + arrowW, y + h) +
      ' L ' + p(x + arrowW, y + h * 0.75) +
      ' L ' + p(x, y + h * 0.75) + ' Z';
  }

  // arrowConnector: simple arrow with connector visual (diamond + arrow)
  function arrowConnectorPath(x, y, w, h) {
    // Similar to arrow shape
    return arrowShapePath(x, y, w, h);
  }

  // connector: just a line (edge-like connector used as vertex)
  function connectorPath(x, y, w, h) {
    return 'M ' + p(x, y + h / 2) + ' L ' + p(x + w, y + h / 2);
  }

  // Flowchart / general palette shapes that are plain mxShape subclasses in
  // draw.io. The live exporter harvests their already-rendered SVG; these
  // headless equivalents keep browser-free bake output faithful enough to avoid
  // a degradation notice for normal object types.
  function parallelogramPath(x, y, w, h, dx) {
    if (dx == null) dx = w * 0.2;
    return 'M ' + p(x + dx, y) + ' L ' + p(x + w, y) + ' L ' +
      p(x + w - dx, y + h) + ' L ' + p(x, y + h) + ' Z';
  }

  function stepPath(x, y, w, h, dx) {
    if (dx == null) dx = w * 0.2;
    return 'M ' + p(x, y) + ' L ' + p(x + w - dx, y) + ' L ' +
      p(x + w, y + h / 2) + ' L ' + p(x + w - dx, y + h) +
      ' L ' + p(x, y + h) + ' Z';
  }

  function calloutPath(style, x, y, w, h) {
    // CalloutShape.redrawPath (Shapes.js:1969-1983), a mxHexagon subclass.
    // Square-cornered 7-point polygon: body top is the full cell, recedes to
    // (h - size), and a downward tail tip sits exactly on the bottom edge at
    // (position*w, h). Defaults size=30, position=0.5, position2=0.5, base=20.
    // The prior path hard-coded rounded corners, ignored every style key, and
    // placed the tail tip BELOW the cell (poking past the footprint).
    // (rounded=1 is loud-noticed via ROUNDED_NOT_YET, so square is faithful here.)
    var s = Math.max(0, Math.min(h, number(style.size, 30)));
    var dx = w * Math.max(0, Math.min(1, number(style.position, 0.5)));
    var dx2 = w * Math.max(0, Math.min(1, number(style.position2, 0.5)));
    var base = Math.max(0, Math.min(w, number(style.base, 20)));
    return roundedPoly([
      { x: x, y: y }, { x: x + w, y: y }, { x: x + w, y: y + h - s },
      { x: x + Math.min(w, dx + base), y: y + h - s }, { x: x + dx2, y: y + h },
      { x: x + Math.max(0, dx), y: y + h - s }, { x: x, y: y + h - s }
    ], 0, true);
  }

  function tapePath(x, y, w, h, dyIn) {
    var dy = (dyIn == null) ? h * 0.4 : dyIn; // drawio TapeShape size default 0.4
    // quadratic waves top and bottom (fy = 1.4), midlines at dy/2 and h-dy/2.
    return 'M ' + p(x, y + dy / 2) +
      ' Q ' + p(x + w / 4, y + dy * 1.4) + ' ' + p(x + w / 2, y + dy / 2) +
      ' Q ' + p(x + w * 3 / 4, y - dy * 0.4) + ' ' + p(x + w, y + dy / 2) +
      ' L ' + p(x + w, y + h - dy / 2) +
      ' Q ' + p(x + w * 3 / 4, y + h - dy * 1.4) + ' ' + p(x + w / 2, y + h - dy / 2) +
      ' Q ' + p(x + w / 4, y + h + dy * 0.4) + ' ' + p(x, y + h - dy / 2) + ' Z';
  }

  function cardPath(x, y, w, h, dx) {
    if (dx == null) dx = Math.min(w, h, 30);
    return 'M ' + p(x, y) + ' L ' + p(x + w - dx, y) + ' L ' +
      p(x + w, y + dx) + ' L ' + p(x + w, y + h) + ' L ' +
      p(x, y + h) + ' Z';
  }

  function cubePath(x, y, w, h, sIn) {
    // drawio CubeShape: depth toward the TOP-RIGHT (size default 20, abs). The
    // bake previously cut the wrong corners (top-left), drawing a mirrored cube.
    var s = (sIn == null) ? Math.min(w, Math.min(h, 20)) : sIn;
    return 'M ' + p(x, y) + ' L ' + p(x + w - s, y) + ' L ' + p(x + w, y + s) +
      ' L ' + p(x + w, y + h) + ' L ' + p(x + s, y + h) + ' L ' + p(x, y + h - s) + ' Z' +
      ' M ' + p(x + w, y + s) + ' L ' + p(x + s, y + s) + ' L ' + p(x, y) +
      ' M ' + p(x + s, y + s) + ' L ' + p(x + s, y + h);
  }

  function trapezoidPath(x, y, w, h, dx) {
    if (dx == null) dx = w * 0.2;
    return 'M ' + p(x + dx, y) + ' L ' + p(x + w - dx, y) + ' L ' +
      p(x + w, y + h) + ' L ' + p(x, y + h) + ' Z';
  }

  function documentPath(x, y, w, h, dy) {
    if (dy == null) dy = h * 0.3; // drawio DocumentShape size default 0.3
    // drawio uses two quadratic waves at the bottom (fy = 1.4).
    return 'M ' + p(x, y) + ' L ' + p(x + w, y) + ' L ' + p(x + w, y + h - dy / 2) +
      ' Q ' + p(x + w * 0.75, y + h - dy * 1.4) + ' ' + p(x + w * 0.5, y + h - dy / 2) +
      ' Q ' + p(x + w * 0.25, y + h + dy * 0.4) + ' ' + p(x, y + h - dy / 2) + ' Z';
  }

  function isoRectanglePath(x, y, w, h) {
    var tan30 = Math.tan(Math.PI / 6);
    var tan30Dx = (0.5 - tan30) / 2;
    var m = Math.min(w, h / tan30);
    var ox = x + (w - m) / 2, oy = y + (h - m) / 2 + m / 4;
    return 'M ' + p(ox, oy + 0.25 * m) + ' L ' + p(ox + 0.5 * m, oy + m * tan30Dx) +
      ' L ' + p(ox + m, oy + 0.25 * m) + ' L ' + p(ox + 0.5 * m, oy + (0.5 - tan30Dx) * m) + ' Z';
  }

  function isoCubePath(x, y, w, h) {
    var tan30 = Math.tan(Math.PI / 6);
    var tan30Dx = (0.5 - tan30) / 2;
    var m = Math.min(w, h / (0.5 + tan30));
    var ox = x + (w - m) / 2, oy = y + (h - m) / 2;
    var topY = oy + 0.25 * m, midY = oy + (0.5 - tan30Dx) * m, botY = oy + 0.75 * m;
    var lowY = oy + (1 - tan30Dx) * m;
    return 'M ' + p(ox, topY) + ' L ' + p(ox + 0.5 * m, oy + m * tan30Dx) +
      ' L ' + p(ox + m, topY) + ' L ' + p(ox + m, botY) +
      ' L ' + p(ox + 0.5 * m, lowY) + ' L ' + p(ox, botY) + ' Z' +
      ' M ' + p(ox, topY) + ' L ' + p(ox + 0.5 * m, midY) + ' L ' + p(ox + m, topY) +
      ' M ' + p(ox + 0.5 * m, midY) + ' L ' + p(ox + 0.5 * m, lowY);
  }

  function datastorePath(x, y, w, h, sw) {
    // DataStoreShape.redrawPath (Shapes.js:587-636), a mxCylinder subclass.
    // dy = min(h/2, round(h/8) + strokewidth - 1). The body silhouette (top
    // rim arcs UP to -dy/3, bottom bulges DOWN to h+dy/3) plus THREE stacked
    // "platter" rim curves at relative offsets 0, dy/2, dy (the two c.translate
    // (0,dy/2) calls). Previously only one rim was drawn and the bottom control
    // was h (flat) instead of h+dy/3 — the stacked-disk identity was lost.
    var strokew = (sw == null) ? 1 : sw;
    var dy = Math.min(h / 2, Math.round(h / 8) + strokew - 1);
    // body outline
    var d = 'M ' + p(x, y + dy) + ' C ' + p(x, y - dy / 3) + ' ' + p(x + w, y - dy / 3) + ' ' + p(x + w, y + dy) +
      ' L ' + p(x + w, y + h - dy) + ' C ' + p(x + w, y + h + dy / 3) + ' ' + p(x, y + h + dy / 3) + ' ' + p(x, y + h - dy) + ' Z';
    // three stacked rim curves (downward-bulging), each offset by dy/2
    for (var k = 0; k < 3; k++) {
      var oy = y + dy + k * (dy / 2);
      d += ' M ' + p(x, oy) + ' C ' + p(x, oy + dy) + ' ' + p(x + w, oy + dy) + ' ' + p(x + w, oy);
    }
    return d;
  }

  function manualInputPath(x, y, w, h, sIn) {
    var s = (sIn == null) ? Math.min(h, 30) : sIn; // drawio ManualInputShape size default 30
    // top edge slopes from (0,s) up to (w,0).
    return 'M ' + p(x, y + h) + ' L ' + p(x, y + s) + ' L ' + p(x + w, y) + ' L ' + p(x + w, y + h) + ' Z';
  }

  function dataStoragePath(x, y, w, h, sIn) {
    var s = (sIn == null) ? w * 0.1 : sIn; // drawio DataStorageShape size default 0.1
    // D-shape: bulging right edge, concave left edge (drawio redrawPath).
    return 'M ' + p(x + s, y) + ' L ' + p(x + w, y) +
      ' Q ' + p(x + w - s * 2, y + h / 2) + ' ' + p(x + w, y + h) +
      ' L ' + p(x + s, y + h) +
      ' Q ' + p(x - s, y + h / 2) + ' ' + p(x + s, y) + ' Z';
  }

  function offPageConnectorPath(x, y, w, h, sIn) {
    // drawio OffPageConnectorShape: shoulder at h - s, s = h*(size||3/8).
    var s = (sIn == null) ? h * 0.375 : sIn;
    return 'M ' + p(x, y) + ' L ' + p(x + w, y) + ' L ' + p(x + w, y + h - s) +
      ' L ' + p(x + w / 2, y + h) + ' L ' + p(x, y + h - s) + ' Z';
  }

  // SingleArrowShape (Shapes.js): aw = h*clamp01(arrowWidth, default 0.3) is
  // the FULL body height (the old code used it as a half-height, printing a
  // 2x-too-thick body and ignoring arrowWidth/arrowSize/rounded);
  // as = w*clamp01(arrowSize, default 0.2). Rounded via addPoints with
  // arcSize = LINE_ARCSIZE(20)/2 (roundedPoly/polyArcSize).
  function singleArrowPath(style, x, y, w, h) {
    var aw = h * clamp01(number(style.arrowWidth, 0.3));
    var as = w * clamp01(number(style.arrowSize, 0.2));
    var at = (h - aw) / 2, ab = at + aw;
    return roundedPoly([
      { x: x, y: y + at }, { x: x + w - as, y: y + at }, { x: x + w - as, y: y },
      { x: x + w, y: y + h / 2 }, { x: x + w - as, y: y + h },
      { x: x + w - as, y: y + ab }, { x: x, y: y + ab }
    ], polyArcSize(style), true);
  }

  // DoubleArrowShape (Shapes.js): same arrowWidth/arrowSize defaults as
  // singleArrow, head on both ends, roundable via addPoints.
  function doubleArrowPath(style, x, y, w, h) {
    var aw = h * clamp01(number(style.arrowWidth, 0.3));
    var as = w * clamp01(number(style.arrowSize, 0.2));
    var at = (h - aw) / 2, ab = at + aw;
    return roundedPoly([
      { x: x, y: y + h / 2 }, { x: x + as, y: y }, { x: x + as, y: y + at },
      { x: x + w - as, y: y + at }, { x: x + w - as, y: y },
      { x: x + w, y: y + h / 2 }, { x: x + w - as, y: y + h },
      { x: x + w - as, y: y + ab }, { x: x + as, y: y + ab }, { x: x + as, y: y + h }
    ], polyArcSize(style), true);
  }

  function crossPath(x, y, w, h, szIn) {
    var m = Math.min(w, h), sz = (szIn == null) ? m * 0.2 : szIn;
    var t = y + (h - sz) / 2, b = t + sz, l = x + (w - sz) / 2, r = l + sz;
    return 'M ' + p(x, t) + ' L ' + p(l, t) + ' L ' + p(l, y) + ' L ' + p(r, y) +
      ' L ' + p(r, t) + ' L ' + p(x + w, t) + ' L ' + p(x + w, b) +
      ' L ' + p(r, b) + ' L ' + p(r, y + h) + ' L ' + p(l, y + h) +
      ' L ' + p(l, b) + ' L ' + p(x, b) + ' Z';
  }

  function displayPath(x, y, w, h, sIn) {
    var dx = Math.min(w, h / 2);
    var s = (sIn == null) ? Math.min(w - dx, w * 0.25) : Math.min(w - dx, sIn); // drawio size default 0.25
    // right edge = two quadratics through (w, h/2) (drawio DisplayShape).
    return 'M ' + p(x, y + h / 2) + ' L ' + p(x + s, y) + ' L ' + p(x + w - dx, y) +
      ' Q ' + p(x + w, y) + ' ' + p(x + w, y + h / 2) +
      ' Q ' + p(x + w, y + h) + ' ' + p(x + w - dx, y + h) +
      ' L ' + p(x + s, y + h) + ' Z';
  }

  function delayPath(x, y, w, h) {
    // drawio DelayShape: right edge = two quadratics through (w, h/2).
    var dx = Math.min(w, h / 2);
    return 'M ' + p(x, y) + ' L ' + p(x + w - dx, y) +
      ' Q ' + p(x + w, y) + ' ' + p(x + w, y + h / 2) +
      ' Q ' + p(x + w, y + h) + ' ' + p(x + w - dx, y + h) +
      ' L ' + p(x, y + h) + ' Z';
  }

  function loopLimitPath(x, y, w, h, sIn) {
    var s = (sIn == null) ? Math.min(w / 2, Math.min(h, 20)) : sIn; // drawio LoopLimitShape size default 20
    // cut top corners: (s,0)(w-s,0)(w,s*0.8)(w,h)(0,h)(0,s*0.8).
    return 'M ' + p(x + s, y) + ' L ' + p(x + w - s, y) + ' L ' + p(x + w, y + s * 0.8) +
      ' L ' + p(x + w, y + h) + ' L ' + p(x, y + h) + ' L ' + p(x, y + s * 0.8) + ' Z';
  }

  // drawio shape "size" resolution (parallelogram/step/trapezoid/hexagon etc.):
  // relative w*min(relCap, size||relDefault), or absolute min(fixedCap, size||
  // fixedDefault) when the fixedSize style flag is set. The bake previously
  // hardcoded approximate proportions and ignored the size/fixedSize style.
  function shapeSize(style, w, relDefault, relCap, fixedDefault, fixedCap) {
    var fixed = style.fixedSize != null && String(style.fixedSize) !== '0';
    if (fixed) return Math.max(0, Math.min(fixedCap, number(style.size, fixedDefault)));
    return w * Math.max(0, Math.min(relCap, number(style.size, relDefault)));
  }

  // Wrapper: ensure shapePath output uses only engine-supported path commands
  // (Q -> exact C) before it can be emitted as a kind:"path" node.
  function shapePath(style, x, y, w, h) {
    return quadToCubicPath(shapePathImpl(style, x, y, w, h));
  }
  function shapePathImpl(style, x, y, w, h) {
    var shape = style.shape || 'rectangle';
    if (shape === 'ellipse') return ellipsePath(x, y, w, h);
    if (shape === 'rhombus' || shape === 'diamond') {
      if (boolish(style.rounded)) return roundedPoly([{ x: x + w / 2, y: y },
        { x: x + w, y: y + h / 2 }, { x: x + w / 2, y: y + h }, { x: x, y: y + h / 2 }],
        polyArcSize(style), true);
      return rhombusPath(x, y, w, h);
    }
    if (shape === 'triangle') {
      if (boolish(style.rounded)) return roundedPoly([{ x: x, y: y },
        { x: x + w, y: y + h / 2 }, { x: x, y: y + h }], polyArcSize(style), true);
      return trianglePath(x, y, w, h);
    }
    if (shape === 'cylinder') return cylinderPath(style, x, y, w, h);
    if (shape === 'cloud') return cloudPath(x, y, w, h);
    if (shape === 'hexagon') {
      var hxS = shapeSize(style, w, 0.25, 1, 20, w * 0.5);
      if (boolish(style.rounded)) return roundedPoly([
        { x: x + hxS, y: y }, { x: x + w - hxS, y: y }, { x: x + w, y: y + h / 2 },
        { x: x + w - hxS, y: y + h }, { x: x + hxS, y: y + h }, { x: x, y: y + h / 2 }
      ], polyArcSize(style), true);
      return hexagonPath(x, y, w, h, hxS);
    }
    if (shape === 'doubleEllipse') return doubleEllipsePath(style, x, y, w, h);
    if (shape === 'actor') return actorPath(x, y, w, h);
    if (shape === 'swimlane') return swimlanePath(style, x, y, w, h);
    if (shape === 'line') return linePath(x, y, w, h);
    if (shape === 'arrow') return arrowShapePath(x, y, w, h);
    if (shape === 'arrowConnector') return arrowConnectorPath(x, y, w, h);
    if (shape === 'connector' || shape === 'tableLine' || shape === 'wire' || shape === 'filledEdge' || shape === 'pipe') return connectorPath(x, y, w, h);
    if (shape === 'isoRectangle') return isoRectanglePath(x, y, w, h);
    // isoCube2 is a different shape (IsoCubeShape2) handled by builtinShapeSvg
    // (fill body + stroke-only interior edges); only plain isoCube stays here.
    if (shape === 'isoCube') return isoCubePath(x, y, w, h);
    if (shape === 'datastore' || shape === 'dataStore') return datastorePath(x, y, w, h, number(style.strokeWidth, 1));
    if (shape === 'dataStorage') return dataStoragePath(x, y, w, h, shapeSize(style, w, 0.1, 1, 20, w));
    if (shape === 'document') return documentPath(x, y, w, h, h * Math.max(0, Math.min(1, number(style.size, 0.3))));
    if (shape === 'trapezoid') {
      var tzS = shapeSize(style, w, 0.2, 0.5, 20, w * 0.5);
      if (boolish(style.rounded)) return roundedPoly([
        { x: x, y: y + h }, { x: x + tzS, y: y }, { x: x + w - tzS, y: y }, { x: x + w, y: y + h }
      ], polyArcSize(style), true);
      return trapezoidPath(x, y, w, h, tzS);
    }
    if (shape === 'manualInput') {
      var miS = Math.min(h, number(style.size, 30));
      if (boolish(style.rounded)) return roundedPoly([
        { x: x, y: y + h }, { x: x, y: y + miS }, { x: x + w, y: y }, { x: x + w, y: y + h }
      ], polyArcSize(style), true);
      return manualInputPath(x, y, w, h, miS);
    }
    // internalStorage is a multi-paint mxRectangleShape subclass (rounded bg +
    // stroke-only dividers with the rounded inset clamp) handled by
    // builtinShapeSvg before shapePath is consulted.
    if (shape === 'offPageConnector') {
      var opS = h * Math.max(0, Math.min(1, number(style.size, 0.375)));
      if (boolish(style.rounded)) return roundedPoly([
        { x: x, y: y }, { x: x + w, y: y }, { x: x + w, y: y + h - opS },
        { x: x + w / 2, y: y + h }, { x: x, y: y + h - opS }
      ], polyArcSize(style), true);
      return offPageConnectorPath(x, y, w, h, opS);
    }
    // mermaidBlockArrow is NOT a singleArrow — it has its own dirs/nodePadding
    // polygon (MermaidBlockArrowShape) ported in builtinShapeSvg.
    if (shape === 'singleArrow' || shape === 'flexArrow') return singleArrowPath(style, x, y, w, h);
    if (shape === 'doubleArrow') return doubleArrowPath(style, x, y, w, h);
    if (shape === 'cross') return crossPath(x, y, w, h, Math.min(w, h) * Math.max(0, Math.min(1, number(style.size, 0.2))));
    if (shape === 'display') return displayPath(x, y, w, h, Math.max(0, number(style.size, 0.25)) * w);
    if (shape === 'delay') return delayPath(x, y, w, h);
    if (shape === 'loopLimit') {
      var llS = Math.min(w / 2, Math.min(h, number(style.size, 20)));
      if (boolish(style.rounded)) return roundedPoly([
        { x: x + llS, y: y }, { x: x + w - llS, y: y }, { x: x + w, y: y + llS * 0.8 },
        { x: x + w, y: y + h }, { x: x, y: y + h }, { x: x, y: y + llS * 0.8 }
      ], polyArcSize(style), true);
      return loopLimitPath(x, y, w, h, llS);
    }
    if (shape === 'parallelogram') {
      var pgS = shapeSize(style, w, 0.2, 1, 20, w);
      if (boolish(style.rounded)) return roundedPoly([
        { x: x, y: y + h }, { x: x + pgS, y: y }, { x: x + w, y: y }, { x: x + w - pgS, y: y + h }
      ], polyArcSize(style), true);
      return parallelogramPath(x, y, w, h, pgS);
    }
    if (shape === 'step') {
      // StepShape points (Shapes.js): (0,0)(w-s,0)(w,h/2)(w-s,h)(0,h)(s,h/2) —
      // including the left notch at (s, h/2), roundable via addPoints.
      var stS = shapeSize(style, w, 0.2, 1, 20, w);
      return roundedPoly([
        { x: x, y: y }, { x: x + w - stS, y: y }, { x: x + w, y: y + h / 2 },
        { x: x + w - stS, y: y + h }, { x: x, y: y + h }, { x: x + stS, y: y + h / 2 }
      ], polyArcSize(style), true);
    }
    if (shape === 'callout') return calloutPath(style, x, y, w, h);
    if (shape === 'tape') return tapePath(x, y, w, h, h * Math.max(0, Math.min(1, number(style.size, 0.4))));
    if (shape === 'card') {
      var cdS = Math.max(0, Math.min(w, Math.min(h, number(style.size, 30))));
      if (boolish(style.rounded)) return roundedPoly([
        { x: x + cdS, y: y }, { x: x + w, y: y }, { x: x + w, y: y + h },
        { x: x, y: y + h }, { x: x, y: y + cdS }
      ], polyArcSize(style), true);
      return cardPath(x, y, w, h, cdS);
    }
    if (shape === 'cube') return cubePath(x, y, w, h, Math.max(0, Math.min(w, Math.min(h, number(style.size, 20)))));
    // note/note2 (dog-ear), plus, cylinder2/cylinder3 and isoCube2 are
    // multi-paint shapes handled before shapePath (noteInner/builtinShapeSvg);
    // no silent single-path flattening here.
    if (shape === 'umlState') return roundedRectPath(x, y, w, h, Math.min(w, h) * 0.12);
    // transparent / link-as-vertex paint NOTHING in drawio (TransparentShape
    // fills NONE; LinkShape has no paintVertexShape) — emitVertex skips the
    // body for both, so they never reach this dispatcher.
    // umlFrame (title pentagon + L-border) is handled by builtinShapeSvg.
    // ext;double=1 (inner rect) and message (rect + flap) are multi-paint
    // shapes in builtinShapeSvg; a plain ext is the mxRectangleShape rect.
    if (shape === 'ext') return rectPath(x, y, w, h);
    // umlBoundary/umlEntity/umlControl/umlLifeline, lollipop/requires/waypoint,
    // curlyBracket, the *Ellipse decorations, tapeData, dimension, zigzag and
    // the git* shapes are multi-element or stroke/fill-rule-bending painters —
    // ported faithfully in builtinShapeSvg (their old single-path mappings here
    // were wrong silhouettes).
    if (shape === 'umlDestroy') return 'M ' + p(x, y) + ' L ' + p(x + w, y + h) + ' M ' + p(x + w, y) + ' L ' + p(x, y + h);
    if (shape === 'startState') return ellipsePath(x, y, w, h);
    if (shape === 'parallelMarker') return 'M ' + p(x + w * 0.25, y) + ' L ' + p(x + w * 0.25, y + h) + ' M ' + p(x + w * 0.75, y) + ' L ' + p(x + w * 0.75, y + h);
    if (shape === 'corner') {
      // CornerShape (Shapes.js): FILLED L-polygon, dx/dy default 20 clamped to
      // [0,w]/[0,h], roundable via addPoints. Was a bare 3-point polyline.
      var cnDx = Math.max(0, Math.min(w, number(style.dx, 20)));
      var cnDy = Math.max(0, Math.min(h, number(style.dy, 20)));
      return roundedPoly([
        { x: x, y: y }, { x: x + w, y: y }, { x: x + w, y: y + cnDy },
        { x: x + cnDx, y: y + cnDy }, { x: x + cnDx, y: y + h }, { x: x, y: y + h }
      ], polyArcSize(style), true);
    }
    if (shape === 'crossbar') {
      // CrossbarShape (Shapes.js): end bars + middle line — (0,0)-(0,h),
      // (w,0)-(w,h), (0,h/2)-(w,h/2). Was drawn as a plus.
      return 'M ' + p(x, y) + ' L ' + p(x, y + h) +
        ' M ' + p(x + w, y) + ' L ' + p(x + w, y + h) +
        ' M ' + p(x, y + h / 2) + ' L ' + p(x + w, y + h / 2);
    }
    if (shape === 'tee') {
      // TeeShape (Shapes.js): FILLED T-polygon, dx/dy default 20, roundable.
      var teDx = Math.max(0, Math.min(w, number(style.dx, 20)));
      var teDy = Math.max(0, Math.min(h, number(style.dy, 20)));
      return roundedPoly([
        { x: x, y: y }, { x: x + w, y: y }, { x: x + w, y: y + teDy },
        { x: x + (w + teDx) / 2, y: y + teDy }, { x: x + (w + teDx) / 2, y: y + h },
        { x: x + (w - teDx) / 2, y: y + h }, { x: x + (w - teDx) / 2, y: y + teDy },
        { x: x, y: y + teDy }
      ], polyArcSize(style), true);
    }
    if (shape === 'or') {
      // OrShape (Shapes.js:3639-3646): D-shape M0,0 Q(w,0)(w,h/2) Q(w,h)(0,h)
      // Z — was a full ellipse.
      return 'M ' + p(x, y) + ' Q ' + p(x + w, y) + ' ' + p(x + w, y + h / 2) +
        ' Q ' + p(x + w, y + h) + ' ' + p(x, y + h) + ' Z';
    }
    if (shape === 'xor') {
      // XorShape (Shapes.js:3658-3666): the OrShape D plus a concave back quad
      // through (w/2,h/2) to (0,0) — was a full ellipse.
      return 'M ' + p(x, y) + ' Q ' + p(x + w, y) + ' ' + p(x + w, y + h / 2) +
        ' Q ' + p(x + w, y + h) + ' ' + p(x, y + h) +
        ' Q ' + p(x + w / 2, y + h / 2) + ' ' + p(x, y) + ' Z';
    }
    if (shape === 'sortShape') return rhombusPath(x, y, w, h) + ' M ' + p(x, y + h / 2) + ' L ' + p(x + w, y + h / 2);
    if (shape === 'collate') return 'M ' + p(x, y) + ' L ' + p(x + w, y) + ' L ' + p(x + w / 2, y + h / 2) + ' Z M ' + p(x, y + h) + ' L ' + p(x + w, y + h) + ' L ' + p(x + w / 2, y + h / 2) + ' Z';
    if (shape === 'mindmapBang') {
      // MindmapBangShape (Shapes.js:6575-6618): starburst of elliptical arcs —
      // design box W,H = 0.8*cell offset by (0.10W, 0.10H) so the spike tips
      // touch the cell edges. Verbatim port of the arcTo delta sequence
      // (4 top, 3 right, 4 bottom, 3 left). Was a plain ellipse.
      var bW = w * 0.8, bH = h * 0.8;
      var bR = bW * 0.15, bR8 = bR * 0.8;
      var bPx = bW * 0.10, bPy = bH * 0.10;
      var bD = 'M ' + p(x + bPx, y + bPy);
      var bArc = function (r, dx2, dy2) {
        bPx += dx2; bPy += dy2;
        bD += ' A ' + fmt(r) + ' ' + fmt(r) + ' 0 0 0 ' + p(x + bPx, y + bPy);
      };
      bArc(bR, bW * 0.25, -bH * 0.10); bArc(bR, bW * 0.25, 0);
      bArc(bR, bW * 0.25, 0); bArc(bR, bW * 0.25, bH * 0.10);
      bArc(bR, bW * 0.15, bH * 0.33); bArc(bR8, 0, bH * 0.34); bArc(bR, -bW * 0.15, bH * 0.33);
      bArc(bR, -bW * 0.25, bH * 0.15); bArc(bR, -bW * 0.25, 0);
      bArc(bR, -bW * 0.25, 0); bArc(bR, -bW * 0.25, -bH * 0.15);
      bArc(bR, -bW * 0.10, -bH * 0.33); bArc(bR8, 0, -bH * 0.34); bArc(bR, bW * 0.10, -bH * 0.33);
      return bD + ' Z';
    }
    if (shape === 'ishikawaHead') {
      // IshikawaHeadShape (Shapes.js:6647-6654): flat left edge + quadTo(2w,
      // h/2) teardrop bulge back to the origin. Was a plain ellipse.
      return 'M ' + p(x, y) + ' L ' + p(x, y + h) +
        ' Q ' + p(x + 2 * w, y + h / 2) + ' ' + p(x, y) + ' Z';
    }
    if (shape === 'mermaidOdd') {
      // OddShape (Shapes.js:6672-6683): rectangle with an inward left chevron
      // notch = h/4. Was a plain ellipse.
      return 'M ' + p(x, y) + ' L ' + p(x + h / 4, y + h / 2) + ' L ' + p(x, y + h) +
        ' L ' + p(x + w, y + h) + ' L ' + p(x + w, y) + ' Z';
    }
    if (shape === 'rectangle' || shape === 'label' || !shape) {
      return boolish(style.rounded)
        ? roundedRectPath(x, y, w, h, roundedRectRadius(style, w, h))
        : rectPath(x, y, w, h);
    }
    // group: draw.io's container group — rendered as a plain rectangle
    if (shape === 'group') {
      return rectPath(x, y, w, h);
    }
    if (shape === 'switch') {
      // Closed bezier diamond (SwitchShape curve=0.5, Shapes.js).
      // Q→C conversion: C1=start+2/3*(ctrl-start), C2=end+2/3*(ctrl-end).
      var sw3 = w / 3, sw23 = 2 * w / 3, sh3 = h / 3, sh23 = 2 * h / 3;
      return 'M ' + p(x, y) +
        ' C ' + p(x + sw3, y + sh3) + ' ' + p(x + sw23, y + sh3) + ' ' + p(x + w, y) +
        ' C ' + p(x + sw23, y + sh3) + ' ' + p(x + sw23, y + sh23) + ' ' + p(x + w, y + h) +
        ' C ' + p(x + sw23, y + sh23) + ' ' + p(x + sw3, y + sh23) + ' ' + p(x, y + h) +
        ' C ' + p(x + sw3, y + sh23) + ' ' + p(x + sw3, y + sh3) + ' ' + p(x, y) + ' Z';
    }
    // mxgraph namespace shapes: stencil lookup happens first; if we reach here the
    // stencil is absent. The live canvas renders the JS-registered shape faithfully
    // (mxCellRenderer.registerShape), so returning null here lets the caller emit
    // an ExporterUnsupportedShape notice rather than silently approximating (§5).
    if (/^mxgraph\./.test(shape)) return null;
    return null;
  }

  // Returns inner SVG element string(s) for built-in multi-element shapes
  // (registered via mxCellRenderer.registerShape in Shapes.js). The content is
  // positioned in a (0,0)→(w,h) local viewport; the caller wraps it in <svg>.
  // Returns null for unknown shapes.
  // Column/row separator lines for a shape=table, derived from the child
  // tableRow/cell geometry. drawio's TableShape draws these at the table level
  // (columnLines/rowLines default on) independently of the cells' own borders,
  // so a table whose cells have all borders off still shows a column divider.
  // Live path harvests the real SVG; this is the headless equivalent.
  function tableGridLines(graph, cell, style, w, h) {
    if (!cell || !cell.children || !cell.children.length) return '';
    var styleOf = function (c) {
      return (graph && typeof graph.getCellStyle === 'function') ? (graph.getCellStyle(c) || {}) : (c.style || {});
    };
    var strk = strokeSvgAttrs(style);
    var header = Math.min(h, Math.max(0, number(style.startSize, 40)));
    var colOn = style.columnLines !== '0' && style.columnLines !== 0;
    var rowOn = style.rowLines !== '0' && style.rowLines !== 0;
    var rows = cell.children.filter(function (c) {
      return c && styleOf(c).shape === 'tableRow';
    });
    if (!rows.length) return '';
    var lines = '';
    if (colOn) {
      var cells = (rows[0].children || []).filter(function (c) { return c && c.geometry; })
        .slice().sort(function (a, b) { return (a.geometry.x || 0) - (b.geometry.x || 0); });
      for (var ci = 1; ci < cells.length; ci++) {
        var bx = cells[ci].geometry.x || 0;
        if (bx > 0 && bx < w) {
          lines += '<line x1="' + fmt(bx) + '" y1="' + fmt(header) +
            '" x2="' + fmt(bx) + '" y2="' + fmt(h) + '" fill="none"' + strk + '/>';
        }
      }
    }
    if (rowOn && rows.length > 1) {
      for (var ri = 1; ri < rows.length; ri++) {
        var ry = (rows[ri].geometry && rows[ri].geometry.y) || 0;
        if (ry > header && ry < h) {
          lines += '<line x1="0" y1="' + fmt(ry) + '" x2="' + fmt(w) +
            '" y2="' + fmt(ry) + '" fill="none"' + strk + '/>';
        }
      }
    }
    return lines;
  }

  // Wrap shape-geometry SVG in a viewport padded by strokeWidth/2 so an edge
  // stroke (a rect/path drawn at x=0..w) is NOT half-clipped by a tight w×h
  // viewport. Without this, a shape's outer border renders at ~half thickness
  // while its interior lines render full — the asymmetry reads as "thick"
  // interior lines (most visible on tables). The box grows by the pad on each
  // side (the stroke halo), matching how drawio's own renderer paints strokes.
  function paddedSvgShapeNode(content, box, style, extraPad) {
    var sw = Math.max(0.1, number(style.strokeWidth, 1));
    var pad = sw / 2 + (extraPad > 0 ? extraPad : 0);
    var W = box.w + sw, H = box.h + sw;
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + fmt(W) +
      '" height="' + fmt(H) + '" viewBox="' + fmt(-pad) + ' ' + fmt(-pad) + ' ' +
      fmt(W) + ' ' + fmt(H) + '">' + content + '</svg>';
    return { kind: 'svg', box: { x: box.x - pad, y: box.y - pad, w: W, h: H },
      source: base64(svg), aspect: 'preserve' };
  }

  // Note shape: a rectangle with a folded-over corner (dog-ear). drawio's
  // NoteShape draws a pentagon (one corner cut at `size`) plus a small fold
  // triangle; `direction` rotates which corner folds (east=top-right default,
  // west=bottom-left). shapePath would flatten this to a plain rectangle.
  // fillOverride/opacityOverride render the silhouette only (used for shadow).
  // NOTE: north/south on a non-square note rotate about centre and may slightly
  // overspill; the note in practice is square, so this is faithful here.
  function noteInner(style, w, h, fillOverride, opacityOverride) {
    // NoteShape (Shapes.js): s = max(0, min(w, min(h, size))), size default 30.
    var s = Math.max(0, Math.min(w, Math.min(h, number(style.size, 30))));
    // darkOpacity (NoteShape.prototype.darkOpacity = 0), clamped to [-1, 1].
    var op = Math.max(-1, Math.min(1, number(style.darkOpacity, 0)));
    var penta = 'M 0 0 L ' + fmt(w - s) + ' 0 L ' + fmt(w) + ' ' + fmt(s) +
      ' L ' + fmt(w) + ' ' + fmt(h) + ' L 0 ' + fmt(h) + ' L 0 0 Z';
    var foldTri = 'M ' + fmt(w - s) + ' 0 L ' + fmt(w - s) + ' ' + fmt(s) +
      ' L ' + fmt(w) + ' ' + fmt(s) + ' Z';
    var foldLine = 'M ' + fmt(w - s) + ' 0 L ' + fmt(w - s) + ' ' + fmt(s) +
      ' L ' + fmt(w) + ' ' + fmt(s);
    var content;
    if (fillOverride) {
      content = '<path d="' + penta + '" fill="' + fillOverride + '"' +
        (opacityOverride != null ? ' fill-opacity="' + fmt(opacityOverride) + '"' : '') +
        ' stroke="none"/>';
    } else {
      // Body: fillAndStroke honoring fill-opacity (= opacity * fillOpacity,
      // mxSvgCanvas2D.updateFill) and the gradient when set.
      var defs = '', fillAttr;
      var nfa = opacity(style, 'fillOpacity');
      var nfaAttr = nfa < 1 ? ' fill-opacity="' + fmt(nfa) + '"' : '';
      if (isPaintable(style.fillColor) && isPaintable(style.gradientColor)) {
        defs = '<defs>' + linearGradDef('ngrad', hex(style.fillColor), hex(style.gradientColor), style.gradientDirection) + '</defs>';
        fillAttr = ' fill="url(#ngrad)"' + nfaAttr;
      } else if (isPaintable(style.fillColor)) {
        fillAttr = ' fill="' + hex(style.fillColor) + '"' + nfaAttr;
      } else {
        fillAttr = ' fill="none"';
      }
      content = defs + '<path d="' + penta + '"' + fillAttr + strokeSvgAttrs(style) + '/>';
      // Fold (NoteShape paint order): the closed triangle is FILLED only when
      // darkOpacity != 0 — black for op>0, white for op<0 — then the open fold
      // path is STROKED in the strokeColor. NoteShape calls c.setFillAlpha(|op|)
      // which REPLACES fillAlpha, so mxSvgCanvas2D.updateFill paints the fold at
      // fill-opacity = alpha * |op| (the cell's base opacity times |darkOpacity|),
      // not a flat |op|.
      if (op !== 0) {
        content += '<path d="' + foldTri + '" fill="' + (op < 0 ? '#ffffff' : '#000000') +
          '" fill-opacity="' + fmt(Math.abs(op) * opacity(style, 'opacity')) + '" stroke="none"/>';
      }
      content += '<path d="' + foldLine + '" fill="none"' + strokeSvgAttrs(style) + '/>';
    }
    // flipH/flipV mirror the shape inside its box (mxShape.updateTransform);
    // applied innermost, before the direction rotation — the same order as the
    // stencil path (flip transform in the pre-direction space). Labels stay
    // unflipped (drawio flips the shape, never the label text).
    content = flipWrapSvg(content, w, h, style);
    var dir = style.direction || 'east';
    var deg = dir === 'west' ? 180 : dir === 'north' ? 270 : dir === 'south' ? 90 : 0;
    if (deg) content = '<g transform="rotate(' + fmt(deg) + ' ' + fmt(w / 2) + ' ' + fmt(h / 2) + ')">' + content + '</g>';
    return content;
  }

  // Cube with darkOpacity/darkOpacity2 shaded faces (CubeShape.paintVertexShape,
  // Shapes.js:361-419). The body is fillAndStroke'd, then (when op/op2 != 0) the
  // top face (0,0)(w-s,0)(w,s)(s,s) and left face (0,0)(s,s)(s,h)(0,h-s) are
  // FILLED black (op>0) / white (op<0) at |op| alpha, then the interior edges
  // are stroked. The plain cube path (cubePath) drops both shaded faces with no
  // notice; this builder is used only when a face opacity is set.
  function cubeInner(style, w, h, fillOverride, opacityOverride) {
    // direction=north/south paints in a w↔h-SWAPPED viewport (cw×ch) and then
    // rotates, exactly like mxShape.isPaintBoundsInverted / the builtin
    // dirInvBI path — otherwise a non-square N/S cube has the wrong proportions.
    var dir = style.direction || 'east';
    var deg = dir === 'west' ? 180 : dir === 'north' ? 270 : dir === 'south' ? 90 : 0;
    var inv = (dir === 'north' || dir === 'south');
    var cw = inv ? h : w, ch = inv ? w : h;
    var s = Math.max(0, Math.min(cw, Math.min(ch, number(style.size, 20))));
    var op = Math.max(-1, Math.min(1, number(style.darkOpacity, 0)));
    var op2 = Math.max(-1, Math.min(1, number(style.darkOpacity2, 0)));
    var body = 'M 0 0 L ' + fmt(cw - s) + ' 0 L ' + fmt(cw) + ' ' + fmt(s) +
      ' L ' + fmt(cw) + ' ' + fmt(ch) + ' L ' + fmt(s) + ' ' + fmt(ch) +
      ' L 0 ' + fmt(ch - s) + ' Z';
    var content;
    if (fillOverride) {
      content = '<path d="' + body + '" fill="' + fillOverride + '"' +
        (opacityOverride != null ? ' fill-opacity="' + fmt(opacityOverride) + '"' : '') +
        ' stroke="none"/>';
    } else {
      var defs = '', fillAttr;
      var cfa = opacity(style, 'fillOpacity');
      var cfaAttr = cfa < 1 ? ' fill-opacity="' + fmt(cfa) + '"' : '';
      if (isPaintable(style.fillColor) && isPaintable(style.gradientColor)) {
        defs = '<defs>' + linearGradDef('cgrad', hex(style.fillColor), hex(style.gradientColor), style.gradientDirection) + '</defs>';
        fillAttr = ' fill="url(#cgrad)"' + cfaAttr;
      } else if (isPaintable(style.fillColor)) {
        fillAttr = ' fill="' + hex(style.fillColor) + '"' + cfaAttr;
      } else {
        fillAttr = ' fill="none"';
      }
      content = defs + '<path d="' + body + '"' + fillAttr + strokeSvgAttrs(style) + '/>';
      // setFillAlpha(|op|) REPLACES fillAlpha → painted at alpha*|op| like the note fold.
      if (op !== 0) {
        var topFace = 'M 0 0 L ' + fmt(cw - s) + ' 0 L ' + fmt(cw) + ' ' + fmt(s) + ' L ' + fmt(s) + ' ' + fmt(s) + ' Z';
        content += '<path d="' + topFace + '" fill="' + (op < 0 ? '#ffffff' : '#000000') +
          '" fill-opacity="' + fmt(Math.abs(op) * opacity(style, 'opacity')) + '" stroke="none"/>';
      }
      if (op2 !== 0) {
        var leftFace = 'M 0 0 L ' + fmt(s) + ' ' + fmt(s) + ' L ' + fmt(s) + ' ' + fmt(ch) + ' L 0 ' + fmt(ch - s) + ' Z';
        content += '<path d="' + leftFace + '" fill="' + (op2 < 0 ? '#ffffff' : '#000000') +
          '" fill-opacity="' + fmt(Math.abs(op2) * opacity(style, 'opacity')) + '" stroke="none"/>';
      }
      var edges = 'M ' + fmt(s) + ' ' + fmt(ch) + ' L ' + fmt(s) + ' ' + fmt(s) + ' L 0 0 M ' + fmt(s) + ' ' + fmt(s) + ' L ' + fmt(cw) + ' ' + fmt(s);
      content += '<path d="' + edges + '" fill="none"' + strokeSvgAttrs(style) + '/>';
    }
    content = flipWrapSvg(content, cw, ch, style);
    if (deg) {
      content = '<g transform="rotate(' + fmt(deg) + ' ' + fmt(w / 2) + ' ' + fmt(h / 2) +
        ') translate(' + fmt((w - cw) / 2) + ' ' + fmt((h - ch) / 2) + ')">' + content + '</g>';
    }
    return content;
  }

  // Mirror inner-SVG content within a (0,0)→(w,h) viewport for flipH/flipV.
  // translate(w,0) scale(-1,1) / translate(0,h) scale(1,-1), matching the
  // stencil implementation (exporter stencil Step 12).
  // stencilFlipH/V are deliberately NOT read here: mxShape.apply ORs them into
  // flipH/flipV ONLY when a stencil exists (mxShape.js:1410-1415); on the
  // non-stencil paths drawio ignores them.
  // Builds the SVG transform PREFIX replicating mxSvgCanvas2D.rotate
  // (mxSvgCanvas2D.js:1342-1366) for content already centred about (cx,cy):
  // both flips => theta+180 and no mirror; a single-axis flip => append the
  // mirror translate/scale AND negate theta. Flags must already be swapped for
  // N/S by the caller (mxShape.js:1417). Returned string is meant to wrap a
  // centring translate + the content (outermost transform first).
  function flipRotatePrefix(baseTheta, fH, fV, cx, cy) {
    var theta = baseTheta;
    var mirror = '';
    if (fH && fV) { theta = (theta + 180) % 360; }
    else if (fH !== fV) {
      theta = (360 - theta) % 360;
      var tx = fH ? cx : 0, sx = fH ? -1 : 1;
      var ty = fV ? cy : 0, sy = fV ? -1 : 1;
      mirror = 'translate(' + fmt(tx) + ' ' + fmt(ty) + ') scale(' + sx + ' ' + sy +
        ') translate(' + fmt(-tx) + ' ' + fmt(-ty) + ') ';
    }
    var rot = theta ? 'rotate(' + fmt(theta) + ' ' + fmt(cx) + ' ' + fmt(cy) + ') ' : '';
    return mirror + rot;
  }

  function flipWrapSvg(content, w, h, style) {
    if (boolish(style.flipH)) {
      content = '<g transform="translate(' + fmt(w) + ',0) scale(-1,1)">' + content + '</g>';
    }
    if (boolish(style.flipV)) {
      content = '<g transform="translate(0,' + fmt(h) + ') scale(1,-1)">' + content + '</g>';
    }
    return content;
  }

  // builtinShapeSvg: gradient-aware wrapper. A cell with gradientColor must
  // render a real gradient on the builtin path too — previously every builtin
  // shape silently dropped its gradient to solid fillColor (fillSvgAttr was
  // called with an empty gradId). The defs are prepended to the content; under
  // the emitVertex direction= wrapper the whole <g> rotates, which rotates the
  // objectBoundingBox gradient axis with the shape exactly like drawio's
  // canvas-level rotation does (mxShape.updateTransform runs before
  // setGradient), so the axis needs no extra rotateGradDir here.
  function builtinShapeSvg(style, w, h) {
    var gradId = '';
    var defs = '';
    if (isPaintable(style.fillColor) && isPaintable(style.gradientColor)) {
      gradId = 'b' + stableGradId(style.fillColor, style.gradientColor);
      defs = '<defs>' + linearGradDef(gradId, hex(style.fillColor),
        hex(style.gradientColor), style.gradientDirection) + '</defs>';
    }
    var content = builtinShapeSvgImpl(style, w, h, gradId);
    return content == null ? null : defs + content;
  }

  function builtinShapeSvgImpl(style, w, h, gradId) {
    var shape = style.shape;
    var fill = fillSvgAttr(style, gradId);
    var strk = strokeSvgAttrs(style);
    // drawio paints the glass highlight ONLY for shapes that actually call
    // paintGlassEffect: the mxRectangleShape family (paintForeground,
    // mxRectangleShape.js:107-110 — process/plus/internalStorage here) and the
    // swimlane family header (mxSwimlane.js:267-270 — table here). Other
    // builtin shapes (cylinder/actor/folder/...) never paint glass in drawio,
    // so omitting it there IS the faithful render, not a silent drop.
    var glassEl = (boolish(style.glass) && isPaintable(style.fillColor))
      ? glassOverlaySvg(style, w, h) : '';
    if (shape === 'umlActor') {
      // Head (fillAndStroke) + body/arms/legs (stroke) — UmlActorShape, Shapes.js
      var head = '<ellipse cx="' + fmt(w / 2) + '" cy="' + fmt(h / 8) + '" rx="' + fmt(w / 4) + '" ry="' + fmt(h / 8) + '"' + fill + strk + '/>';
      var lns = [
        [w / 2, h / 4, w / 2, 2 * h / 3],
        [w / 2, h / 3, 0, h / 3],
        [w / 2, h / 3, w, h / 3],
        [w / 2, 2 * h / 3, 0, h],
        [w / 2, 2 * h / 3, w, h]
      ];
      return head + lns.map(function (l) {
        return '<line x1="' + fmt(l[0]) + '" y1="' + fmt(l[1]) + '" x2="' + fmt(l[2]) + '" y2="' + fmt(l[3]) + '" fill="none"' + strk + '/>';
      }).join('');
    }
    if (shape === 'process' || shape === 'process2') {
      // Rectangle + two vertical inset lines — ProcessShape, Shapes.js.
      // fixedSize=1: inset is absolute px clamped to [0,w]; else relative
      // (default size=0.1). rounded=1 enlarges the inset to at least the
      // corner radius factor f = arcSize/100 (default RECTANGLE_ROUNDING_
      // FACTOR*100 = 15), and the background is a rounded rect.
      var pInsetRaw = number(style.size, 0.1);
      var pInset = boolish(style.fixedSize)
        ? Math.max(0, Math.min(w, pInsetRaw))
        : w * Math.max(0, Math.min(1, pInsetRaw));
      var pRounded = boolish(style.rounded);
      if (pRounded) {
        var pF = number(style.arcSize, 15) / 100;
        pInset = Math.max(pInset, Math.min(w * pF, h * pF));
      }
      pInset = Math.round(pInset);
      var pBg = pRounded
        ? '<path d="' + roundedRectPath(0, 0, w, h, roundedRectRadius(style, w, h)) + '"' + fill + strk + '/>'
        : '<rect x="0" y="0" width="' + fmt(w) + '" height="' + fmt(h) + '"' + fill + strk + '/>';
      // Glass under the foreground lines (mxRectangleShape.paintForeground
      // paints glass first, then ProcessShape draws its inset lines over it).
      return pBg + glassEl +
        '<line x1="' + fmt(pInset) + '" y1="0" x2="' + fmt(pInset) + '" y2="' + fmt(h) + '" fill="none"' + strk + '/>' +
        '<line x1="' + fmt(w - pInset) + '" y1="0" x2="' + fmt(w - pInset) + '" y2="' + fmt(h) + '" fill="none"' + strk + '/>';
    }
    if (shape === 'plus') {
      // PlusShape (Shapes.js) extends mxRectangleShape: full rect background
      // (honoring rounded= like a normal rect) + STROKE-ONLY plus lines inset
      // by border = min(w/5, h/5) + 1. Previously printed as a filled Greek
      // cross silhouette.
      var plB = Math.min(w / 5, h / 5) + 1;
      var plBg = boolish(style.rounded)
        ? '<path d="' + roundedRectPath(0, 0, w, h, roundedRectRadius(style, w, h)) + '"' + fill + strk + '/>'
        : '<rect x="0" y="0" width="' + fmt(w) + '" height="' + fmt(h) + '"' + fill + strk + '/>';
      return plBg + glassEl +
        '<path d="M ' + p(w / 2, plB) + ' L ' + p(w / 2, h - plB) +
        ' M ' + p(plB, h / 2) + ' L ' + p(w - plB, h / 2) + '" fill="none"' + strk + '/>';
    }
    if (shape === 'cylinder2' || shape === 'cylinder3') {
      // CylinderShape / CylinderShape3 (Shapes.js): size is ABSOLUTE px
      // (default 15) clamped to h*0.5; size=0 degrades to a plain rect.
      // Body fillAndStroke; the inner lid arc is STROKE-ONLY. cylinder3
      // supports lid=0 (default on): the top edge becomes a downward arc
      // (sweep 0) and the inner lid stroke is omitted.
      var cySz = Math.max(0, Math.min(h * 0.5, number(style.size, 15)));
      if (cySz === 0) {
        return '<rect x="0" y="0" width="' + fmt(w) + '" height="' + fmt(h) + '"' + fill + strk + '/>';
      }
      // mxGraph reads lid with `if (getValue(style,'lid',true))` — a string
      // '0'/'false' is truthy, so drawio ALWAYS draws the lid (the no-lid branch
      // is effectively dead in the app). Match that via drawioFlag, NOT the
      // numericized 0 (which previously dropped the lid — a silent divergence on
      // the shipped Basic-sidebar `cylinder3;lid=0`).
      var cyLid = shape !== 'cylinder3' || drawioFlag(style.lid, true);
      var cyR = fmt(w * 0.5) + ' ' + fmt(cySz) + ' 0 0 ';
      var cyTop = cyLid
        ? 'M ' + p(0, cySz) + ' A ' + cyR + '1 ' + p(w / 2, 0) + ' A ' + cyR + '1 ' + p(w, cySz)
        : 'M ' + p(0, 0) + ' A ' + cyR + '0 ' + p(w / 2, cySz) + ' A ' + cyR + '0 ' + p(w, 0);
      var cyBody = cyTop +
        ' L ' + p(w, h - cySz) +
        ' A ' + cyR + '1 ' + p(w / 2, h) +
        ' A ' + cyR + '1 ' + p(0, h - cySz) + ' Z';
      var cyOut = '<path d="' + cyBody + '"' + fill + strk + '/>';
      if (cyLid) {
        cyOut += '<path d="M ' + p(w, cySz) + ' A ' + cyR + '1 ' + p(w / 2, 2 * cySz) +
          ' A ' + cyR + '1 ' + p(0, cySz) + '" fill="none"' + strk + '/>';
      }
      return cyOut;
    }
    if (shape === 'isoCube2') {
      // IsoCubeShape2 (Shapes.js): isoAngle (default 15) clamped to
      // [0.01, 94] then * PI/200; isoH = min(w*tan(isoAngle), h*0.5).
      // Hexagonal body fillAndStroke + STROKE-ONLY interior edges.
      var icA = Math.max(0.01, Math.min(94, number(style.isoAngle, 15))) * Math.PI / 200;
      var icH = Math.min(w * Math.tan(icA), h * 0.5);
      var icBody = 'M ' + p(w * 0.5, 0) + ' L ' + p(w, icH) + ' L ' + p(w, h - icH) +
        ' L ' + p(w * 0.5, h) + ' L ' + p(0, h - icH) + ' L ' + p(0, icH) + ' Z';
      var icFg = 'M ' + p(0, icH) + ' L ' + p(w * 0.5, 2 * icH) + ' L ' + p(w, icH) +
        ' M ' + p(w * 0.5, 2 * icH) + ' L ' + p(w * 0.5, h);
      return '<path d="' + icBody + '"' + fill + strk + '/>' +
        '<path d="' + icFg + '" fill="none"' + strk + '/>';
    }
    if (shape === 'smileyFace') {
      // Face circle + 2 eyes + crescent/line mouth — SmileyFaceShape, Shapes.js
      var sType = style.smileyType || 'happy';
      var fColor = style.smileyFeatureColor || '#666666';
      var sr = Math.min(w, h) / 2, ss = Math.min(w, h) / 30;
      var sfcx = w / 2, sfcy = h / 2;
      var face = '<ellipse cx="' + fmt(sfcx) + '" cy="' + fmt(sfcy) + '" rx="' + fmt(sr) + '" ry="' + fmt(sr) + '"' + fill + strk + '/>';
      var eyeR = 1.5 * ss, eyeXOff = 5 * ss, eyeYOff = 5 * ss;
      var eyeA = ' fill="' + fColor + '" stroke="' + fColor + '" stroke-width="' + fmt(2 * ss) + '"';
      var eye1 = '<ellipse cx="' + fmt(sfcx - eyeXOff) + '" cy="' + fmt(sfcy - eyeYOff) + '" rx="' + fmt(eyeR) + '" ry="' + fmt(eyeR) + '"' + eyeA + '/>';
      var eye2 = '<ellipse cx="' + fmt(sfcx + eyeXOff) + '" cy="' + fmt(sfcy - eyeYOff) + '" rx="' + fmt(eyeR) + '" ry="' + fmt(eyeR) + '"' + eyeA + '/>';
      var mouth, sfmcy;
      if (sType === 'happy') {
        sfmcy = sfcy + 2 * ss;
        mouth = '<path d="M ' + fmt(sfcx + 7.5 * ss) + ' ' + fmt(sfmcy) +
          ' A ' + fmt(7.5 * ss) + ' ' + fmt(7.5 * ss) + ' 0 1 1 ' + fmt(sfcx - 7.5 * ss) + ' ' + fmt(sfmcy) +
          ' L ' + fmt(sfcx - 6.818 * ss) + ' ' + fmt(sfmcy) +
          ' A ' + fmt(6.818 * ss) + ' ' + fmt(6.818 * ss) + ' 0 1 0 ' + fmt(sfcx + 6.818 * ss) + ' ' + fmt(sfmcy) +
          ' Z" fill="#000000" stroke="' + fColor + '" stroke-width="' + fmt(ss) + '"/>';
      } else if (sType === 'sad') {
        sfmcy = sfcy + 7 * ss;
        mouth = '<path d="M ' + fmt(sfcx - 7.5 * ss) + ' ' + fmt(sfmcy) +
          ' A ' + fmt(7.5 * ss) + ' ' + fmt(7.5 * ss) + ' 0 1 1 ' + fmt(sfcx + 7.5 * ss) + ' ' + fmt(sfmcy) +
          ' L ' + fmt(sfcx + 6.818 * ss) + ' ' + fmt(sfmcy) +
          ' A ' + fmt(6.818 * ss) + ' ' + fmt(6.818 * ss) + ' 0 1 0 ' + fmt(sfcx - 6.818 * ss) + ' ' + fmt(sfmcy) +
          ' Z" fill="#000000" stroke="' + fColor + '" stroke-width="' + fmt(ss) + '"/>';
      } else {
        mouth = '<line x1="' + fmt(sfcx - 5 * ss) + '" y1="' + fmt(sfcy + 7 * ss) +
          '" x2="' + fmt(sfcx + 5 * ss) + '" y2="' + fmt(sfcy + 7 * ss) +
          '" fill="none" stroke="' + fColor + '" stroke-width="' + fmt(ss) + '"/>';
      }
      return face + eye1 + eye2 + mouth;
    }
    if (shape === 'associativeEntity') {
      // AssociativeEntity (mxRectangleShape subclass, Shapes.js:3245-3257):
      // rectangle background (rounds via mxRectangleShape when rounded=1) +
      // diamond stroke overlay drawn with addPoints(...,isRounded,arcSize,true)
      // (so the diamond rounds too) + glass via mxRectangleShape.paintForeground
      // when glass=1. Previously square corners + no glass with no notice.
      var aeRounded = boolish(style.rounded);
      var aeBg = aeRounded
        ? '<path d="' + roundedRectPath(0, 0, w, h, roundedRectRadius(style, w, h)) + '"' + fill + strk + '/>'
        : '<rect x="0" y="0" width="' + fmt(w) + '" height="' + fmt(h) + '"' + fill + strk + '/>';
      var aeDiamond = '<path d="' + roundedPoly([
        { x: w / 2, y: 0 }, { x: w, y: h / 2 }, { x: w / 2, y: h }, { x: 0, y: h / 2 }
      ], polyArcSize(style), true) + '" fill="none"' + strk + '/>';
      return aeBg + aeDiamond + glassEl;
    }
    if (shape === 'endState') {
      // Inner ellipse (fillAndStroke) + outer ellipse (stroke only) — StateShape, Shapes.js
      var esInset = Math.min(4, Math.min(w / 5, h / 5));
      return '<ellipse cx="' + fmt(w / 2) + '" cy="' + fmt(h / 2) +
        '" rx="' + fmt((w - 2 * esInset) / 2) + '" ry="' + fmt((h - 2 * esInset) / 2) + '"' + fill + strk + '/>' +
        '<ellipse cx="' + fmt(w / 2) + '" cy="' + fmt(h / 2) +
        '" rx="' + fmt(w / 2) + '" ry="' + fmt(h / 2) + '" fill="none"' + strk + '/>';
    }
    if (shape === 'folder') {
      // Tab + body path (fillAndStroke, non-rounded) — FolderShape, Shapes.js
      var fDx = Math.max(0, Math.min(w, number(style.tabWidth, 60)));
      var fDy = Math.max(0, Math.min(h, number(style.tabHeight, 20)));
      var fTp = style.tabPosition || 'right';
      var fD;
      if (fTp === 'left') {
        fD = 'M 0 ' + fmt(fDy) + ' L 0 0 L ' + fmt(fDx) + ' 0 L ' + fmt(fDx) + ' ' + fmt(fDy) +
          ' M 0 ' + fmt(fDy) + ' L ' + fmt(w) + ' ' + fmt(fDy) + ' L ' + fmt(w) + ' ' + fmt(h) + ' L 0 ' + fmt(h) + ' Z';
      } else {
        fD = 'M ' + fmt(w - fDx) + ' ' + fmt(fDy) + ' L ' + fmt(w - fDx) + ' 0 L ' + fmt(w) + ' 0 L ' + fmt(w) + ' ' + fmt(fDy) +
          ' M 0 ' + fmt(fDy) + ' L ' + fmt(w) + ' ' + fmt(fDy) + ' L ' + fmt(w) + ' ' + fmt(h) + ' L 0 ' + fmt(h) + ' Z';
      }
      return '<path d="' + fD + '"' + fill + strk + '/>';
    }
    if (shape === 'component') {
      // Main body (notched, fillAndStroke) + jetty outlines (stroke only) — ComponentShape, Shapes.js
      var cJw = number(style.jettyWidth, 32), cJh = number(style.jettyHeight, 12);
      var cx0 = cJw / 2, cx1 = cJw;
      var cy0 = 0.3 * h - cJh / 2, cy1 = 0.7 * h - cJh / 2;
      var cBody = 'M ' + fmt(cx0) + ' 0 L ' + fmt(w) + ' 0 L ' + fmt(w) + ' ' + fmt(h) +
        ' L ' + fmt(cx0) + ' ' + fmt(h) +
        ' L ' + fmt(cx0) + ' ' + fmt(cy1 + cJh) + ' L 0 ' + fmt(cy1 + cJh) +
        ' L 0 ' + fmt(cy1) + ' L ' + fmt(cx0) + ' ' + fmt(cy1) +
        ' L ' + fmt(cx0) + ' ' + fmt(cy0 + cJh) + ' L 0 ' + fmt(cy0 + cJh) +
        ' L 0 ' + fmt(cy0) + ' L ' + fmt(cx0) + ' ' + fmt(cy0) + ' Z';
      var cFg = 'M ' + fmt(cx0) + ' ' + fmt(cy0) + ' L ' + fmt(cx1) + ' ' + fmt(cy0) +
        ' L ' + fmt(cx1) + ' ' + fmt(cy0 + cJh) + ' L ' + fmt(cx0) + ' ' + fmt(cy0 + cJh) +
        ' M ' + fmt(cx0) + ' ' + fmt(cy1) + ' L ' + fmt(cx1) + ' ' + fmt(cy1) +
        ' L ' + fmt(cx1) + ' ' + fmt(cy1 + cJh) + ' L ' + fmt(cx0) + ' ' + fmt(cy1 + cJh);
      return '<path d="' + cBody + '"' + fill + strk + '/><path d="' + cFg + '" fill="none"' + strk + '/>';
    }
    if (shape === 'table') {
      // TableShape extends mxSwimlane (Shapes.js:240-330 + mxSwimlane.js
      // paintSwimlane): the TITLE row is filled with fillColor, the BODY with
      // swimlaneFillColor (default none = transparent) — previously the whole
      // table was filled with fillColor, silently filling the body. The
      // divider honors swimlaneLine (default on); head/body stroke gates per
      // mxSwimlane. startSize=0 falls back to PartialRectangleShape (full
      // rect in fillColor, TableShape.paintVertexShape:260-263).
      var tStart = Math.min(h, Math.max(0, number(style.startSize, 40)));
      if (tStart <= 0) {
        return '<rect x="0" y="0" width="' + fmt(w) + '" height="' + fmt(h) + '"' + fill + strk + '/>';
      }
      var tHead = String(style.swimlaneHead) !== '0';   // default 1
      var tBody = String(style.swimlaneBody) !== '0';   // default 1
      var tLaneA = opacity(style, 'fillOpacity');
      var tLane = isPaintable(style.swimlaneFillColor)
        ? ' fill="' + hex(style.swimlaneFillColor) + '"' +
          (tLaneA < 1 ? ' fill-opacity="' + fmt(tLaneA) + '"' : '')
        : ' fill="none"';
      // header: 3-sided path, fillAndStroke (or fill only when swimlaneHead=0)
      var tOut = '<path d="M 0 ' + fmt(tStart) + ' L 0 0 L ' + fmt(w) + ' 0 L ' +
        fmt(w) + ' ' + fmt(tStart) + '"' + fill + (tHead ? strk : ' stroke="none"') + '/>';
      // glass over the header only (mxSwimlane.js:267-270)
      if (glassEl) tOut += glassOverlaySvg(style, w, tStart);
      // body: 3-sided path, laneFill (+stroke gated on swimlaneBody)
      if (tStart < h) {
        tOut += '<path d="M 0 ' + fmt(tStart) + ' L 0 ' + fmt(h) + ' L ' + fmt(w) +
          ' ' + fmt(h) + ' L ' + fmt(w) + ' ' + fmt(tStart) + '"' + tLane +
          (tBody ? strk : ' stroke="none"') + '/>';
      }
      // divider between title and body (paintDivider, gated swimlaneLine)
      if (String(style.swimlaneLine) !== '0' && tStart < h) {
        tOut += '<line x1="0" y1="' + fmt(tStart) + '" x2="' + fmt(w) +
          '" y2="' + fmt(tStart) + '" fill="none"' + strk + '/>';
      }
      return tOut;
    }
    if (shape === 'mxgraph.basic.button') {
      // 3D bevel button — mxShapeBasicButton.paintVertexShape (mxBasic.js).
      // Outer rect + left/top/right/bottom bevel faces (all fillAndStroke, same color).
      var dx = Math.max(0, Math.min(w, number(style.dx, 0.5)));
      dx = Math.min(w * 0.5, h * 0.5, dx);
      var attr = fill + strk;
      return '<path d="M 0 0 L ' + fmt(w) + ' 0 L ' + fmt(w) + ' ' + fmt(h) + ' L 0 ' + fmt(h) + ' Z"' + attr + '/>' +
        '<path d="M 0 ' + fmt(h) + ' L 0 0 L ' + fmt(dx) + ' ' + fmt(dx) + ' L ' + fmt(dx) + ' ' + fmt(h - dx) + ' Z"' + attr + '/>' +
        '<path d="M 0 0 L ' + fmt(w) + ' 0 L ' + fmt(w - dx) + ' ' + fmt(dx) + ' L ' + fmt(dx) + ' ' + fmt(dx) + ' Z"' + attr + '/>' +
        '<path d="M ' + fmt(w) + ' 0 L ' + fmt(w) + ' ' + fmt(h) + ' L ' + fmt(w - dx) + ' ' + fmt(h - dx) + ' L ' + fmt(w - dx) + ' ' + fmt(dx) + ' Z"' + attr + '/>' +
        '<path d="M 0 ' + fmt(h) + ' L ' + fmt(dx) + ' ' + fmt(h - dx) + ' L ' + fmt(w - dx) + ' ' + fmt(h - dx) + ' L ' + fmt(w) + ' ' + fmt(h) + ' Z"' + attr + '/>' +
        '<path d="M 0 ' + fmt(h) + ' L 0 0 L ' + fmt(dx) + ' ' + fmt(dx) + ' L ' + fmt(dx) + ' ' + fmt(h - dx) + ' Z"' + attr + '/>';
    }
    if (shape === 'internalStorage') {
      // InternalStorageShape extends mxRectangleShape (Shapes.js:3402-3446):
      // rounded=1 rounds the background like a normal rect AND raises dx/dy to
      // at least the corner inset min(w*f, h*f), f = arcSize/100 (default 15).
      // Previously rounded was silently square and the inset clamp was missing.
      var isR = boolish(style.rounded);
      var isInset = 0;
      if (isR) {
        var isF = number(style.arcSize, 15) / 100;
        isInset = Math.max(isInset, Math.min(w * isF, h * isF));
      }
      var isDx = Math.max(isInset, Math.min(w, number(style.dx, 20)));
      var isDy = Math.max(isInset, Math.min(h, number(style.dy, 20)));
      var isBg = isR
        ? '<path d="' + roundedRectPath(0, 0, w, h, roundedRectRadius(style, w, h)) + '"' + fill + strk + '/>'
        : '<rect x="0" y="0" width="' + fmt(w) + '" height="' + fmt(h) + '"' + fill + strk + '/>';
      // foreground (stroke-only divider lines) over glass, like drawio's
      // paintForeground order (mxRectangleShape glass first, then dividers).
      return isBg + glassEl +
        '<path d="M 0 ' + fmt(isDy) + ' L ' + fmt(w) + ' ' + fmt(isDy) +
        ' M ' + fmt(isDx) + ' 0 L ' + fmt(isDx) + ' ' + fmt(h) + '" fill="none"' + strk + '/>';
    }
    if (shape === 'requiredInterface') {
      // RequiredInterfaceShape (Shapes.js:3087-3097): a STROKE-ONLY open
      // half-circle arc M0,0 Q w,0 w,h/2 Q w,h 0,h — never filled. Previously
      // printed as a filled full ellipse.
      return '<path d="M 0 0 Q ' + p(w, 0) + ' ' + p(w, h / 2) +
        ' Q ' + p(w, h) + ' ' + p(0, h) + '" fill="none"' + strk + '/>';
    }
    if (shape === 'providedRequiredInterface') {
      // ProvidedRequiredInterfaceShape (Shapes.js:3111-3125): ellipse inset by
      // (style inset default 2) + strokewidth, fillAndStroke; plus the open
      // stroke-only arc M w/2,0 Q w,0 w,h/2 Q w,h w/2,h.
      var priI = number(style.inset, 2) + Math.max(0.1, number(style.strokeWidth, 1));
      return '<ellipse cx="' + fmt((w - 2 * priI) / 2) + '" cy="' + fmt(h / 2) +
        '" rx="' + fmt(Math.max(0, (w - 2 * priI) / 2)) + '" ry="' + fmt(Math.max(0, (h - 2 * priI) / 2)) + '"' + fill + strk + '/>' +
        '<path d="M ' + p(w / 2, 0) + ' Q ' + p(w, 0) + ' ' + p(w, h / 2) +
        ' Q ' + p(w, h) + ' ' + p(w / 2, h) + '" fill="none"' + strk + '/>';
    }
    if (shape === 'module') {
      // ModuleShape (Shapes.js:3141-3179, mxCylinder two-pass): body polygon
      // with two jetty notches on the left (fillAndStroke) + stroke-only jetty
      // box outlines. jettyWidth default 20, jettyHeight default 10 (NOT the
      // 32/12 of ComponentShape). x0=jw/2, x1=jw; y0=min(jh,h-jh),
      // y1=min(y0+2jh,h-jh). Previously printed as a plain rectangle.
      var mJw = number(style.jettyWidth, 20), mJh = number(style.jettyHeight, 10);
      var mx0 = mJw / 2, mx1 = mx0 + mJw / 2;
      var my0 = Math.min(mJh, h - mJh), my1 = Math.min(my0 + 2 * mJh, h - mJh);
      var mBody = 'M ' + p(mx0, 0) + ' L ' + p(w, 0) + ' L ' + p(w, h) + ' L ' + p(mx0, h) +
        ' L ' + p(mx0, my1 + mJh) + ' L ' + p(0, my1 + mJh) + ' L ' + p(0, my1) + ' L ' + p(mx0, my1) +
        ' L ' + p(mx0, my0 + mJh) + ' L ' + p(0, my0 + mJh) + ' L ' + p(0, my0) + ' L ' + p(mx0, my0) + ' Z';
      var mFg = 'M ' + p(mx0, my0) + ' L ' + p(mx1, my0) + ' L ' + p(mx1, my0 + mJh) + ' L ' + p(mx0, my0 + mJh) +
        ' M ' + p(mx0, my1) + ' L ' + p(mx1, my1) + ' L ' + p(mx1, my1 + mJh) + ' L ' + p(mx0, my1 + mJh);
      return '<path d="' + mBody + '"' + fill + strk + '/><path d="' + mFg + '" fill="none"' + strk + '/>';
    }
    if (shape === 'umlFrame') {
      // UmlFrame (Shapes.js:2605-2650): optional swimlaneFillColor full-rect
      // background (fill only), title pentagon (corner cut, fillAndStroke with
      // fillColor) and the body's L-shaped border (stroke only). width default
      // 60 (>= corner=10), height default 30 (>= corner*1.5). Previously
      // printed as a plain rect filled with fillColor over the whole frame.
      var ufCo = 10;
      var ufW0 = Math.min(w, Math.max(ufCo, number(style.width, 60)));
      var ufH0 = Math.min(h, Math.max(ufCo * 1.5, number(style.height, 30)));
      var ufOut = '';
      if (isPaintable(style.swimlaneFillColor)) {
        var ufA = opacity(style, 'fillOpacity');
        ufOut += '<rect x="0" y="0" width="' + fmt(w) + '" height="' + fmt(h) +
          '" fill="' + hex(style.swimlaneFillColor) +
          (ufA < 1 ? '" fill-opacity="' + fmt(ufA) : '') + '" stroke="none"/>';
      }
      ufOut += '<path d="M 0 0 L ' + p(ufW0, 0) + ' L ' + p(ufW0, Math.max(0, ufH0 - ufCo * 1.5)) +
        ' L ' + p(Math.max(0, ufW0 - ufCo), ufH0) + ' L ' + p(0, ufH0) + ' Z"' + fill + strk + '/>';
      ufOut += '<path d="M ' + p(ufW0, 0) + ' L ' + p(w, 0) + ' L ' + p(w, h) +
        ' L ' + p(0, h) + ' L ' + p(0, ufH0) + '" fill="none"' + strk + '/>';
      return ufOut;
    }
    if (shape === 'mermaidBlockArrow') {
      // MermaidBlockArrowShape (Shapes.js:6697-6863): a closed polygon whose
      // points depend on dirs (default 'right') and nodePadding (default 8);
      // source stores points as (px, -py) and paints at (px, h+py). Forces a
      // round line join (paintVertexShape). Previously silently mapped to
      // singleArrowPath — a different shape.
      var mbDirs = {};
      String(style.dirs == null ? 'right' : style.dirs).split(/[,| ]+/).forEach(function (dd) {
        dd = dd.trim().toLowerCase();
        if (dd === 'x') { mbDirs.right = true; mbDirs.left = true; }
        else if (dd === 'y') { mbDirs.up = true; mbDirs.down = true; }
        else if (dd) { mbDirs[dd] = true; }
      });
      var mbPadF = number(style.nodePadding, 8) / 2;
      var mbM = h / 2;
      var mbPts;
      if (mbDirs.right && mbDirs.left && mbDirs.up && mbDirs.down) {
        mbPts = [[0, 0], [mbM, 0], [w / 2, 2 * mbPadF], [w - mbM, 0], [w, 0],
          [w, -h / 3], [w + 2 * mbPadF, -h / 2], [w, -2 * h / 3], [w, -h],
          [w - mbM, -h], [w / 2, -h - 2 * mbPadF], [mbM, -h],
          [0, -h], [0, -2 * h / 3], [-2 * mbPadF, -h / 2], [0, -h / 3]];
      } else if (mbDirs.right && mbDirs.left && mbDirs.up) {
        mbPts = [[mbM, 0], [w - mbM, 0], [w, -h / 2], [w - mbM, -h], [mbM, -h], [0, -h / 2]];
      } else if (mbDirs.right && mbDirs.left && mbDirs.down) {
        mbPts = [[0, 0], [mbM, -h], [w - mbM, -h], [w, 0]];
      } else if (mbDirs.right && mbDirs.up && mbDirs.down) {
        mbPts = [[0, 0], [w, -mbM], [w, -h + mbM], [0, -h]];
      } else if (mbDirs.left && mbDirs.up && mbDirs.down) {
        mbPts = [[w, 0], [0, -mbM], [0, -h + mbM], [w, -h]];
      } else if (mbDirs.right && mbDirs.left) {
        mbPts = [[mbM, 0], [mbM, -mbPadF], [w - mbM, -mbPadF], [w - mbM, 0],
          [w, -h / 2], [w - mbM, -h], [w - mbM, -h + mbPadF],
          [mbM, -h + mbPadF], [mbM, -h], [0, -h / 2]];
      } else if (mbDirs.up && mbDirs.down) {
        mbPts = [[w / 2, 0], [0, -mbPadF], [mbM, -mbPadF], [mbM, -h + mbPadF],
          [0, -h + mbPadF], [w / 2, -h], [w, -h + mbPadF],
          [w - mbM, -h + mbPadF], [w - mbM, -mbPadF], [w, -mbPadF]];
      } else if (mbDirs.right && mbDirs.up) {
        mbPts = [[0, 0], [w, -mbM], [0, -h]];
      } else if (mbDirs.right && mbDirs.down) {
        mbPts = [[0, 0], [w, 0], [0, -h]];
      } else if (mbDirs.left && mbDirs.up) {
        mbPts = [[w, 0], [0, -mbM], [w, -h]];
      } else if (mbDirs.left && mbDirs.down) {
        mbPts = [[w, 0], [0, 0], [w, -h]];
      } else if (mbDirs.right) {
        mbPts = [[mbM, -mbPadF], [w - mbM, -mbPadF], [w - mbM, 0], [w, -h / 2],
          [w - mbM, -h], [w - mbM, -h + mbPadF], [mbM, -h + mbPadF]];
      } else if (mbDirs.left) {
        mbPts = [[mbM, 0], [mbM, -mbPadF], [w - mbM, -mbPadF], [w - mbM, -h + mbPadF],
          [mbM, -h + mbPadF], [mbM, -h], [0, -h / 2]];
      } else if (mbDirs.up) {
        mbPts = [[mbM, -mbPadF], [mbM, -h + mbPadF], [0, -h + mbPadF], [w / 2, -h],
          [w, -h + mbPadF], [w - mbM, -h + mbPadF], [w - mbM, -mbPadF]];
      } else if (mbDirs.down) {
        mbPts = [[w / 2, 0], [0, -mbPadF], [mbM, -mbPadF], [mbM, -h + mbPadF],
          [w - mbM, -h + mbPadF], [w - mbM, -mbPadF], [w, -mbPadF]];
      } else {
        mbPts = [[0, 0], [w, 0], [w, -h], [0, -h]];
      }
      var mbD = 'M ' + p(mbPts[0][0], h + mbPts[0][1]);
      for (var mbI = 1; mbI < mbPts.length; mbI++) {
        mbD += ' L ' + p(mbPts[mbI][0], h + mbPts[mbI][1]);
      }
      mbD += ' Z';
      // MermaidBlockArrowShape.paintVertexShape forces a round line join.
      var mbStrk = strk.replace(/stroke-linejoin="[^"]*"/, 'stroke-linejoin="round"');
      return '<path d="' + mbD + '"' + fill + mbStrk + '/>';
    }
    if (shape === 'orEllipse' || shape === 'sumEllipse' ||
        shape === 'lineEllipse' || shape === 'tapeData') {
      // mxEllipse subclasses that paint the full ellipse (fillAndStroke) plus
      // STROKE-ONLY decoration lines — previously the lines were silently
      // dropped (the whole shape baked as a bare ellipse):
      //   orEllipse  (Shapes.js:3750-3766): horizontal AND vertical mid lines.
      //   sumEllipse (Shapes.js:3778-3795): two diagonals inset by s2=0.145.
      //   lineEllipse(Shapes.js:3983-4003): one mid line, vertical when
      //                                     line=vertical, else horizontal.
      //   tapeData   (Shapes.js:3729-3738): bottom-center -> bottom-right line.
      var oeBody = '<ellipse cx="' + fmt(w / 2) + '" cy="' + fmt(h / 2) +
        '" rx="' + fmt(w / 2) + '" ry="' + fmt(h / 2) + '"' + fill + strk + '/>';
      var oeD;
      if (shape === 'orEllipse') {
        oeD = 'M ' + p(0, h / 2) + ' L ' + p(w, h / 2) +
          ' M ' + p(w / 2, 0) + ' L ' + p(w / 2, h);
      } else if (shape === 'sumEllipse') {
        var seS2 = 0.145;
        oeD = 'M ' + p(w * seS2, h * seS2) + ' L ' + p(w * (1 - seS2), h * (1 - seS2)) +
          ' M ' + p(w * (1 - seS2), h * seS2) + ' L ' + p(w * seS2, h * (1 - seS2));
      } else if (shape === 'lineEllipse') {
        oeD = style.line === 'vertical'
          ? 'M ' + p(w / 2, 0) + ' L ' + p(w / 2, h)
          : 'M ' + p(0, h / 2) + ' L ' + p(w, h / 2);
      } else {
        oeD = 'M ' + p(w / 2, h) + ' L ' + p(w, h);
      }
      return oeBody + '<path d="' + oeD + '" fill="none"' + strk + '/>';
    }
    if (shape === 'dimension') {
      // DimensionShape (Shapes.js:3856-3882): STROKE-ONLY double-headed
      // dimension arrow — end bars full height, the measure line + arrowheads
      // near the bottom. sw = strokeWidth/2, al = 10 + 2*sw, cy = h - al/2.
      // fillColor is never painted. Was a filled rectangle.
      var dmSw = Math.max(0.1, number(style.strokeWidth, 1)) / 2;
      var dmAl = 10 + 2 * dmSw;
      var dmCy = h - dmAl / 2;
      var dmD = 'M ' + p(0, 0) + ' L ' + p(0, h) +
        ' M ' + p(dmSw, dmCy) + ' L ' + p(dmSw + dmAl, dmCy - dmAl / 2) +
        ' M ' + p(dmSw, dmCy) + ' L ' + p(dmSw + dmAl, dmCy + dmAl / 2) +
        ' M ' + p(dmSw, dmCy) + ' L ' + p(w - dmSw, dmCy) +
        ' M ' + p(w, 0) + ' L ' + p(w, h) +
        ' M ' + p(w - dmSw, dmCy) + ' L ' + p(w - dmAl - dmSw, dmCy - dmAl / 2) +
        ' M ' + p(w - dmSw, dmCy) + ' L ' + p(w - dmAl - dmSw, dmCy + dmAl / 2);
      return '<path d="' + dmD + '" fill="none"' + strk + '/>';
    }
    if (shape === 'umlBoundary') {
      // UmlBoundaryShape (Shapes.js:2397-2418): stroke-only left bar h/4->3h/4
      // and connector (0,h/2)->(w/6,h/2), then the ellipse at (w/6,0,5w/6,h)
      // fillAndStroke. Was a full-cell ellipse without the bar/connector.
      return '<path d="M ' + p(0, h / 4) + ' L ' + p(0, h * 3 / 4) +
        ' M ' + p(0, h / 2) + ' L ' + p(w / 6, h / 2) + '" fill="none"' + strk + '/>' +
        '<ellipse cx="' + fmt(w * 7 / 12) + '" cy="' + fmt(h / 2) +
        '" rx="' + fmt(w * 5 / 12) + '" ry="' + fmt(h / 2) + '"' + fill + strk + '/>';
    }
    if (shape === 'umlEntity') {
      // UmlEntityShape (Shapes.js:2430-2438): ellipse + stroke-only bottom
      // underline from w/8 to 7w/8 at y+h. The underline was silently dropped.
      return '<ellipse cx="' + fmt(w / 2) + '" cy="' + fmt(h / 2) +
        '" rx="' + fmt(w / 2) + '" ry="' + fmt(h / 2) + '"' + fill + strk + '/>' +
        '<path d="M ' + p(w / 8, h) + ' L ' + p(w * 7 / 8, h) + '" fill="none"' + strk + '/>';
    }
    if (shape === 'umlControl') {
      // UmlControlShape (Shapes.js:2479-2502): upper arrow stroke (3w/8,
      // 1.1h/8)->(5w/8,0), ellipse at (0,h/8,w,7h/8) fillAndStroke, then the
      // lower arrow stroke (3w/8,1.1h/8)->(5w/8,h/4) in paintForeground.
      return '<path d="M ' + p(w * 3 / 8, h / 8 * 1.1) + ' L ' + p(w * 5 / 8, 0) + '" fill="none"' + strk + '/>' +
        '<ellipse cx="' + fmt(w / 2) + '" cy="' + fmt(h / 8 + h * 7 / 16) +
        '" rx="' + fmt(w / 2) + '" ry="' + fmt(h * 7 / 16) + '"' + fill + strk + '/>' +
        '<path d="M ' + p(w * 3 / 8, h / 8 * 1.1) + ' L ' + p(w * 5 / 8, h / 4) + '" fill="none"' + strk + '/>';
    }
    if (shape === 'umlLifeline') {
      // UmlLifeline (Shapes.js:2530-2561): header of height size (default 40,
      // clamped to h) — the default mxRectangleShape rect, or the participant=
      // sub-shape when it names another registered shape — plus the stem
      // (w/2,size)->(w/2,h) dashed per lifelineDashed (default on). Previously
      // the FULL cell was a filled rect with a solid stem from 0.25h.
      var llSz = Math.max(0, Math.min(h, number(style.size, 40)));
      var llOut = null;
      // drawio resolves participant via cellRenderer.getShape and refuses
      // UmlLifeline itself; mirror with the builtin/shapePath dispatchers
      // (emitVertex emits the LOUD notice when this resolution fails).
      if (style.participant && style.participant !== 'umlLifeline') {
        var llSub = Object.assign({}, style, { shape: style.participant });
        llOut = builtinShapeSvgImpl(llSub, w, llSz, gradId);
        if (llOut == null) {
          var llD = shapePath(llSub, 0, 0, w, llSz);
          if (llD) llOut = '<path d="' + llD + '"' + fill + strk + '/>';
        }
      }
      if (llOut == null) {
        llOut = boolish(style.rounded)
          ? '<path d="' + roundedRectPath(0, 0, w, llSz, roundedRectRadius(style, w, llSz)) + '"' + fill + strk + '/>'
          : '<rect x="0" y="0" width="' + fmt(w) + '" height="' + fmt(llSz) + '"' + fill + strk + '/>';
        if (boolish(style.glass) && isPaintable(style.fillColor)) {
          llOut += glassOverlaySvg(style, w, llSz);
        }
      }
      if (llSz < h) {
        var llDashed = String(style.lifelineDashed == null ? '1' : style.lifelineDashed) === '1';
        llOut += '<path d="M ' + p(w / 2, llSz) + ' L ' + p(w / 2, h) + '" fill="none"' +
          strokeSvgAttrs(Object.assign({}, style, { dashed: llDashed ? '1' : '0' })) + '/>';
      }
      return llOut;
    }
    if (shape === 'message') {
      // MessageShape (Shapes.js:2325-2342, mxCylinder two-pass): rect
      // background fillAndStroke + STROKE-ONLY envelope flap 0,0 -> w/2,h/2 ->
      // w,0. The flap was silently dropped.
      return '<rect x="0" y="0" width="' + fmt(w) + '" height="' + fmt(h) + '"' + fill + strk + '/>' +
        '<path d="M 0 0 L ' + p(w / 2, h / 2) + ' L ' + p(w, 0) + '" fill="none"' + strk + '/>';
    }
    if (shape === 'lollipop') {
      // LollipopShape (Shapes.js:3028-3041): size circle (default 10) at the
      // top-center (fillAndStroke) + stroke-only stem to the bottom. Was a
      // full-cell ellipse.
      var lpSz = number(style.size, 10);
      return '<ellipse cx="' + fmt(w / 2) + '" cy="' + fmt(lpSz / 2) +
        '" rx="' + fmt(lpSz / 2) + '" ry="' + fmt(lpSz / 2) + '"' + fill + strk + '/>' +
        '<path d="M ' + p(w / 2, lpSz) + ' L ' + p(w / 2, h) + '" fill="none"' + strk + '/>';
    }
    if (shape === 'requires') {
      // RequiresShape (Shapes.js:3057-3074): STROKE-ONLY stem + open half-arc
      // around the (would-be) lollipop, inset = (style inset default 2) +
      // strokewidth; size default 10. Never filled. Was a filled ellipse.
      var rqSz = number(style.size, 10);
      var rqIn = number(style.inset, 2) + Math.max(0.1, number(style.strokeWidth, 1));
      return '<path d="M ' + p(w / 2, rqSz + rqIn) + ' L ' + p(w / 2, h) + '" fill="none"' + strk + '/>' +
        '<path d="M ' + p((w - rqSz) / 2 - rqIn, rqSz / 2) +
        ' Q ' + p((w - rqSz) / 2 - rqIn, rqSz + rqIn) + ' ' + p(w / 2, rqSz + rqIn) +
        ' Q ' + p((w + rqSz) / 2 + rqIn, rqSz + rqIn) + ' ' + p((w + rqSz) / 2 + rqIn, rqSz / 2) +
        '" fill="none"' + strk + '/>';
    }
    if (shape === 'waypoint') {
      // WaypointShape (Shapes.js:500-510): a centered dot of diameter
      // max(0,size-2)+2*sw (size default 6) FILLED with the STROKE color
      // (c.setFillColor(this.stroke); c.fill()) — never stroked; the cell rect
      // is filled NONE (invisible). Was a full-cell fillColor ellipse.
      var wpS = Math.max(0, number(style.size, 6) - 2) +
        2 * Math.max(0.1, number(style.strokeWidth, 1));
      if (!isPaintable(style.strokeColor) || wpS <= 0) return '';
      var wpA = opacity(style, 'fillOpacity');
      return '<ellipse cx="' + fmt(w / 2) + '" cy="' + fmt(h / 2) +
        '" rx="' + fmt(wpS / 2) + '" ry="' + fmt(wpS / 2) +
        '" fill="' + hex(style.strokeColor) + '"' +
        (wpA < 1 ? ' fill-opacity="' + fmt(wpA) + '"' : '') + ' stroke="none"/>';
    }
    if (shape === 'curlyBracket') {
      // CurlyBracketShape (Shapes.js:1535-1544): c.setFillColor(null) — NEVER
      // filled; open polyline (w,0)(s,0)(s,h/2)(0,h/2)(s,h/2)(s,h)(w,h) with
      // s = w*size (default 0.5), rounded via addPoints (close=false). Was a
      // closed, fillable double-C of invented cubics.
      var cbS = w * Math.max(0, Math.min(1, number(style.size, 0.5)));
      var cbD = roundedPoly([
        { x: w, y: 0 }, { x: cbS, y: 0 }, { x: cbS, y: h / 2 }, { x: 0, y: h / 2 },
        { x: cbS, y: h / 2 }, { x: cbS, y: h }, { x: w, y: h }
      ], polyArcSize(style), false);
      return '<path d="' + cbD + '" fill="none"' + strk + '/>';
    }
    if (shape === 'zigzag') {
      // ZigzagShape (Shapes.js:5708-5796): optional UNSTROKED background rect
      // in fillColor, then the stroke-only tooth line from (0,h/2) to (w,h/2):
      // numFull = max(1, round(w/size)-1) peak-to-peak segments (size default
      // 10, min 5) between half-width end segments, peaks inset by sw (sw/2
      // when rounded); rounded=1 draws the cubic wave with k=0.4. Was a fixed
      // 16-step full-height sawtooth that ignored size/fill/rounded.
      var zzOut = '';
      if (isPaintable(style.fillColor)) {
        zzOut += '<rect x="0" y="0" width="' + fmt(w) + '" height="' + fmt(h) + '"' +
          fill + ' stroke="none"/>';
      }
      var zzSize = Math.max(5, number(style.size, 10));
      var zzCy = h / 2;
      var zzSw = Math.max(0.1, number(style.strokeWidth, 1));
      var zzRounded = boolish(style.rounded);
      var zzInset = zzRounded ? zzSw / 2 : zzSw;
      var zzTop = zzInset, zzBot = h - zzInset;
      var zzN = Math.max(1, Math.round(w / zzSize) - 1);
      var zzHalf = w / (zzN + 1);
      var zzEnd = zzHalf / 2;
      var zzD = 'M ' + p(0, zzCy);
      var zzJ;
      if (zzRounded) {
        var zzK = 0.4;
        zzD += ' C ' + p(zzK * zzEnd, zzCy - (zzCy - zzTop) * zzK) + ' ' +
          p((1 - zzK) * zzEnd, zzTop) + ' ' + p(zzEnd, zzTop);
        for (zzJ = 0; zzJ < zzN; zzJ++) {
          var zzSx = zzEnd + zzJ * zzHalf, zzEx = zzSx + zzHalf;
          var zzSy = (zzJ % 2 === 0) ? zzTop : zzBot;
          var zzEy = (zzJ % 2 === 0) ? zzBot : zzTop;
          zzD += ' C ' + p(zzSx + zzK * zzHalf, zzSy) + ' ' +
            p(zzEx - zzK * zzHalf, zzEy) + ' ' + p(zzEx, zzEy);
        }
        var zzLx = zzEnd + zzN * zzHalf;
        var zzLy = (zzN % 2 === 0) ? zzTop : zzBot;
        var zzDir = (zzLy === zzTop) ? 1 : -1;
        zzD += ' C ' + p(zzLx + zzK * zzEnd, zzLy) + ' ' +
          p(w - zzK * zzEnd, zzCy - zzDir * (zzCy - zzTop) * zzK) + ' ' + p(w, zzCy);
      } else {
        zzD += ' L ' + p(zzEnd, zzTop);
        for (zzJ = 0; zzJ < zzN; zzJ++) {
          zzD += ' L ' + p(zzEnd + (zzJ + 1) * zzHalf, (zzJ % 2 === 0) ? zzBot : zzTop);
        }
        zzD += ' L ' + p(w, zzCy);
      }
      return zzOut + '<path d="' + zzD + '" fill="none"' + strk + '/>';
    }
    if (shape === 'gitTag') {
      // GitTagShape (Shapes.js:6424-6468): paper-tag polygon — flat tab tip of
      // height tabInset (default 4) centered on the left, tab extent tabSize
      // (default 8) — fillAndStroke, plus the pierce-hole circle (holeSize
      // default 1) at (tabSize/2, h/2) fill+stroke in holeColor (default
      // fontColor default #333333). Was a generic arrow-left pentagon.
      var gtTab = Math.max(0, Math.min(w, number(style.tabSize, 8)));
      var gtIns = Math.max(0, Math.min(h, number(style.tabInset, 4)));
      var gtY1 = (h - gtIns) / 2, gtY2 = gtY1 + gtIns;
      var gtOut = '<path d="M ' + p(0, gtY1) + ' L ' + p(0, gtY2) +
        ' L ' + p(gtTab, h) + ' L ' + p(w, h) + ' L ' + p(w, 0) +
        ' L ' + p(gtTab, 0) + ' Z"' + fill + strk + '/>';
      var gtHole = Math.max(0, number(style.holeSize, 1));
      if (gtHole > 0) {
        var gtHc = hex(style.holeColor || style.fontColor || '#333333');
        gtOut += '<ellipse cx="' + fmt(gtTab / 2) + '" cy="' + fmt(h / 2) +
          '" rx="' + fmt(gtHole) + '" ry="' + fmt(gtHole) +
          '" fill="' + gtHc + '" stroke="' + gtHc +
          '" stroke-width="' + fmt(Math.max(0.1, number(style.strokeWidth, 1))) + '"/>';
      }
      return gtOut;
    }
    if (shape === 'gitMergeCommit') {
      // GitMergeCommitShape (Shapes.js:6488-6505): outer circle fillAndStroke
      // + inner circle of diameter min(w,h)*0.6 fill+stroke in innerColor
      // (default #ECECFF). The inner circle was silently dropped.
      var gmC = hex(style.innerColor || '#ECECFF');
      var gmR = Math.min(w, h) * 0.6 / 2;
      return '<ellipse cx="' + fmt(w / 2) + '" cy="' + fmt(h / 2) +
        '" rx="' + fmt(w / 2) + '" ry="' + fmt(h / 2) + '"' + fill + strk + '/>' +
        '<ellipse cx="' + fmt(w / 2) + '" cy="' + fmt(h / 2) +
        '" rx="' + fmt(gmR) + '" ry="' + fmt(gmR) +
        '" fill="' + gmC + '" stroke="' + gmC +
        '" stroke-width="' + fmt(Math.max(0.1, number(style.strokeWidth, 1))) + '"/>';
    }
    if (shape === 'gitCherryPick') {
      // GitCherryPickShape (Shapes.js:6519-6552): circle fillAndStroke +
      // featureColor (default #fff) details — two eye circles r=2.75s at
      // (cx±3s, cy+2s) painted with strokeWidth 0 (fill only) and the
      // inverted-V stem strokes (cx±3s,cy+s)->(cx,cy-5s) at width 1*s,
      // s = min(w,h)/20. The details were silently dropped.
      var gcF = hex(style.featureColor || '#fff');
      var gcS = Math.min(w, h) / 20;
      var gcCx = w / 2, gcCy = h / 2, gcEye = 2.75 * gcS;
      return '<ellipse cx="' + fmt(gcCx) + '" cy="' + fmt(gcCy) +
        '" rx="' + fmt(w / 2) + '" ry="' + fmt(h / 2) + '"' + fill + strk + '/>' +
        '<ellipse cx="' + fmt(gcCx - 3 * gcS) + '" cy="' + fmt(gcCy + 2 * gcS) +
        '" rx="' + fmt(gcEye) + '" ry="' + fmt(gcEye) + '" fill="' + gcF + '" stroke="none"/>' +
        '<ellipse cx="' + fmt(gcCx + 3 * gcS) + '" cy="' + fmt(gcCy + 2 * gcS) +
        '" rx="' + fmt(gcEye) + '" ry="' + fmt(gcEye) + '" fill="' + gcF + '" stroke="none"/>' +
        '<path d="M ' + p(gcCx + 3 * gcS, gcCy + gcS) + ' L ' + p(gcCx, gcCy - 5 * gcS) +
        ' M ' + p(gcCx - 3 * gcS, gcCy + gcS) + ' L ' + p(gcCx, gcCy - 5 * gcS) +
        '" fill="none" stroke="' + gcF + '" stroke-width="' + fmt(gcS) + '"/>';
    }
    if (shape === 'ext' && String(style['double']) === '1') {
      // ExtendedShape (Shapes.js:2220-2236) with double=1: the outer
      // mxRectangleShape rect + an inner rect inset by margin = max(2, sw+1) +
      // style margin (both fillAndStroke; rounded honored on both like
      // mxRectangleShape.paintBackground). symbol0..n sub-shapes are NOT
      // rendered — emitVertex raises a LOUD ExporterUnsupportedShape notice
      // for them. Previously double=1 baked as a single plain rect.
      var exM = Math.max(2, Math.max(0.1, number(style.strokeWidth, 1)) + 1) +
        number(style.margin, 0);
      var exRounded = boolish(style.rounded);
      var exOut = exRounded
        ? '<path d="' + roundedRectPath(0, 0, w, h, roundedRectRadius(style, w, h)) + '"' + fill + strk + '/>'
        : '<rect x="0" y="0" width="' + fmt(w) + '" height="' + fmt(h) + '"' + fill + strk + '/>';
      var exW = w - 2 * exM, exH = h - 2 * exM;
      if (exW > 0 && exH > 0) {
        exOut += exRounded
          ? '<path d="' + roundedRectPath(exM, exM, exW, exH, roundedRectRadius(style, exW, exH)) + '"' + fill + strk + '/>'
          : '<rect x="' + fmt(exM) + '" y="' + fmt(exM) + '" width="' + fmt(exW) +
            '" height="' + fmt(exH) + '"' + fill + strk + '/>';
        // glass paints over the INNER rect (paintForeground sees the inset
        // arguments object — sloppy-mode aliasing in Shapes.js:2312).
        if (glassEl) {
          exOut += '<g transform="translate(' + fmt(exM) + ' ' + fmt(exM) + ')">' +
            glassOverlaySvg(style, exW, exH) + '</g>';
        }
      } else if (glassEl) {
        exOut += glassEl;
      }
      return exOut;
    }
    if (shape === 'tableRow' || shape === 'partialRectangle') {
      // Fill rect + selective border lines — PartialRectangleShape/TableRowShape, Shapes.js
      // Default: all borders ON (mxUtils.getValue default '1'); explicit '0' turns them off.
      var prTop = style.top !== '0' && style.top !== 0;
      var prRight = style.right !== '0' && style.right !== 0;
      var prBottom = style.bottom !== '0' && style.bottom !== 0;
      var prLeft = style.left !== '0' && style.left !== 0;
      var prOut = '<rect x="0" y="0" width="' + fmt(w) + '" height="' + fmt(h) + '"' + fill + ' stroke="none"/>';
      if (prTop || prRight || prBottom || prLeft) {
        var prD = 'M 0 0';
        if (prTop) { prD += ' L ' + fmt(w) + ' 0'; } else { prD += ' M ' + fmt(w) + ' 0'; }
        if (prRight) { prD += ' L ' + fmt(w) + ' ' + fmt(h); } else { prD += ' M ' + fmt(w) + ' ' + fmt(h); }
        if (prBottom) { prD += ' L 0 ' + fmt(h); } else { prD += ' M 0 ' + fmt(h); }
        if (prLeft) { prD += ' L 0 0'; }
        prOut += '<path d="' + prD + '" fill="none"' + strk + '/>';
      }
      return prOut;
    }
    return null;
  }

  function edgePath(points, rounded, curved, radius, bezier) {
    // mxPolyline.paintEdgeShape checks STYLE_BEZIER FIRST: waypoints are
    // cubic CONTROL points when they fit the 3n+1 pattern, else
    // through-point quads. Without this branch bezier=1 edges printed as
    // (rounded) straight polylines through the control points — silently.
    if (bezier && points.length > 2) {
      var bd = 'M ' + p(points[0].x, points[0].y);
      var n = points.length;
      if ((n - 1) % 3 === 0) {
        for (var bi = 1; bi + 2 < n; bi += 3) {
          bd += ' C ' + p(points[bi].x, points[bi].y) + ' ' +
            p(points[bi + 1].x, points[bi + 1].y) + ' ' +
            p(points[bi + 2].x, points[bi + 2].y);
        }
        return bd;
      }
      var bcur = points[0];
      var bquad = function (cp, ep) {
        var c1 = { x: bcur.x + (2 / 3) * (cp.x - bcur.x),
                   y: bcur.y + (2 / 3) * (cp.y - bcur.y) };
        var c2 = { x: ep.x + (2 / 3) * (cp.x - ep.x),
                   y: ep.y + (2 / 3) * (cp.y - ep.y) };
        bd += ' C ' + p(c1.x, c1.y) + ' ' + p(c2.x, c2.y) + ' ' + p(ep.x, ep.y);
        bcur = ep;
      };
      for (var bj = 1; bj < n - 2; bj++) {
        var b0 = points[bj], b1 = points[bj + 1];
        bquad(b0, { x: (b0.x + b1.x) / 2, y: (b0.y + b1.y) / 2 });
      }
      bquad(points[n - 2], points[n - 1]);
      return bd;
    }
    if (curved && points.length > 2) {
      // mxPolyline.paintCurvedLine: quadratics through successive segment
      // midpoints, for ANY point count (the old 4-point-only cubic left
      // every other curved edge printing as a cornered polyline). Each
      // quadratic is emitted as its exact cubic (the engine path parser
      // accepts C, not Q).
      var d = 'M ' + p(points[0].x, points[0].y);
      var cur = points[0];
      var quadTo = function (cp, ep) {
        var c1 = { x: cur.x + (2 / 3) * (cp.x - cur.x),
                   y: cur.y + (2 / 3) * (cp.y - cur.y) };
        var c2 = { x: ep.x + (2 / 3) * (cp.x - ep.x),
                   y: ep.y + (2 / 3) * (cp.y - ep.y) };
        d += ' C ' + p(c1.x, c1.y) + ' ' + p(c2.x, c2.y) + ' ' + p(ep.x, ep.y);
        cur = ep;
      };
      for (var qi = 1; qi < points.length - 2; qi++) {
        var q0 = points[qi], q1 = points[qi + 1];
        quadTo(q0, { x: (q0.x + q1.x) / 2, y: (q0.y + q1.y) / 2 });
      }
      quadTo(points[points.length - 2], points[points.length - 1]);
      return d;
    }
    if (!rounded || points.length < 3) {
      var d = 'M ' + p(points[0].x, points[0].y);
      for (var i = 1; i < points.length; i++) d += ' L ' + p(points[i].x, points[i].y);
      return d;
    }
    // drawio mxPolyline rounds corners with arcSize = (style arcSize ||
    // LINE_ARCSIZE=20) / 2 = 10 by default. An EXPLICIT arcSize=0 (radius 0)
    // means SHARP corners (mxShape.addPoints Math.min(arcSize, …)=0) — only the
    // missing/invalid case falls back to 10 (the caller never passes 0 by
    // default, so radius===0 reliably signals an explicit arcSize=0).
    var radius = (radius >= 0 && isFinite(radius)) ? radius : 10;
    var out = 'M ' + p(points[0].x, points[0].y);
    // mxShape.addPoints: the corner curve is a QUADRATIC with control at
    // the corner (its exact cubic elevation is c = a + 2/3(corner - a));
    // the old `C corner corner a2` cubic bulged ~1.77px past the true arc
    // apex at the default radius. The incoming arm's available length is
    // measured from the PREVIOUS arc end (pe), not the original corner, so
    // consecutive short segments shorten exactly like the editor.
    var pe = points[0];
    for (var j = 1; j < points.length - 1; j++) {
      var cur = points[j], next = points[j + 1];
      var a1 = cornerPoint(cur, pe, radius);
      var a2 = cornerPoint(cur, next, radius);
      var cc1 = { x: a1.x + (2 / 3) * (cur.x - a1.x),
                  y: a1.y + (2 / 3) * (cur.y - a1.y) };
      var cc2 = { x: a2.x + (2 / 3) * (cur.x - a2.x),
                  y: a2.y + (2 / 3) * (cur.y - a2.y) };
      out += ' L ' + p(a1.x, a1.y) + ' C ' + p(cc1.x, cc1.y) + ' ' +
        p(cc2.x, cc2.y) + ' ' + p(a2.x, a2.y);
      pe = a2;
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

  // Faithful headless edge-marker renderer, transcribed 1:1 from mxMarker.js
  // and the Shapes.js marker registrations (dash/box/cross/circle/circlePlus/
  // halfCircle/async/openAsync/ER family). drawio markers do two things:
  //   1. paint the marker glyph (after the line, never dashed, fillAndStroke
  //      in the marker fill color when `filled`, stroke-only otherwise);
  //   2. RECEDE the line endpoint (the factory mutates pe) so the edge line
  //      stops behind the marker instead of bisecting it.
  // Returns { nodes: [paintNode…], pe: {x,y} } — pe is the receded endpoint
  // the polyline must be drawn to — or null for a degenerate segment.
  // `size` is the per-end endSize/startSize (mxConnector.js:107-108, default
  // mxConstants.DEFAULT_MARKERSIZE = 6); `source` selects the half-arrow side
  // for async/openAsync (mxMarker passes the source flag through).
  function edgeMarkerNode(type, from, to, size, stroke, arrowFill, cellId, notices, filled, source) {
    var dx = to.x - from.x, dy = to.y - from.y;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len <= 0.001) return null;
    var ux = dx / len, uy = dy / len;
    var sw = (stroke && stroke.width) || 1;
    var t = String(type);
    // markers paint with the edge stroke but NEVER dashed
    // (mxConnector.paintEdgeShape calls c.setDashed(false) before markers).
    var mstroke = stroke ? { paint: stroke.paint, width: stroke.width,
      cap: stroke.cap, join: stroke.join, miterLimit: stroke.miterLimit,
      dash: null } : null;
    var pe = { x: to.x, y: to.y };
    // fillAndStroke when filled (fill AND stroke, mxMarker), stroke-only when
    // endFill/startFill=0 (hollow outline).
    function node(d, isFilled) {
      return { kind: 'path', d: d, fill: isFilled ? arrowFill : null, stroke: mstroke };
    }
    function strokeNode(d) { return node(d, false); }
    function done(nodes) { return { nodes: nodes, pe: pe }; }
    function ellipseD(cx, cy, r) {
      return 'M ' + p(cx - r, cy) +
        ' A ' + fmt(r) + ' ' + fmt(r) + ' 0 1 0 ' + fmt(cx + r) + ' ' + fmt(cy) +
        ' A ' + fmt(r) + ' ' + fmt(r) + ' 0 1 0 ' + fmt(cx - r) + ' ' + fmt(cy) + ' Z';
    }

    // classic / classicThin / block / blockThin — mxMarker.js createArrow.
    if (t === 'classic' || t === 'classicThin' || t === 'block' || t === 'blockThin' || t === '') {
      var wf = (t === 'classicThin' || t === 'blockThin') ? 3 : 2;
      var eoX = ux * sw * 1.118, eoY = uy * sw * 1.118;
      var nx = ux * (size + sw), ny = uy * (size + sw);
      var ptx = to.x - eoX, pty = to.y - eoY;
      var f = (t === 'classic' || t === 'classicThin') ? 3 / 4 : 1;
      pe = { x: to.x - nx * f - eoX, y: to.y - ny * f - eoY };
      var d = 'M ' + p(ptx, pty) +
        ' L ' + p(ptx - nx - ny / wf, pty - ny + nx / wf);
      if (t === 'classic' || t === 'classicThin') {
        d += ' L ' + p(ptx - nx * 3 / 4, pty - ny * 3 / 4);
      }
      d += ' L ' + p(ptx + ny / wf - nx, pty - ny - nx / wf) + ' Z';
      return done([node(d, filled !== false)]);
    }

    // open / openThin — mxMarker.js createOpenArrow (stroke-only V, line
    // recedes by 2 * the strokewidth offset only).
    if (t === 'open' || t === 'openThin') {
      var owf = t === 'openThin' ? 3 : 2;
      var oeX = ux * sw * 1.118, oeY = uy * sw * 1.118;
      var onx = ux * (size + sw), ony = uy * (size + sw);
      var optx = to.x - oeX, opty = to.y - oeY;
      pe = { x: to.x - 2 * oeX, y: to.y - 2 * oeY };
      return done([strokeNode(
        'M ' + p(optx - onx - ony / owf, opty - ony + onx / owf) +
        ' L ' + p(optx, opty) +
        ' L ' + p(optx + ony / owf - onx, opty - ony - onx / owf))]);
    }

    // oval — mxMarker.js:139-159: circle of DIAMETER size centered AT the
    // endpoint; the line recedes by size/2 (to the circle center).
    if (t === 'oval') {
      var oa = size / 2;
      pe = { x: to.x - ux * oa, y: to.y - uy * oa };
      return done([node(ellipseD(to.x, to.y, oa), filled !== false)]);
    }

    // diamond / diamondThin — mxMarker.js:218-260.
    if (t === 'diamond' || t === 'diamondThin') {
      var swF = (t === 'diamond') ? 0.7071 : 0.9862;
      var deX = ux * sw * swF, deY = uy * sw * swF;
      var dnx = ux * (size + sw), dny = uy * (size + sw);
      var dptx = to.x - deX, dpty = to.y - deY;
      pe = { x: to.x - dnx - deX, y: to.y - dny - deY };
      var tk = (t === 'diamond') ? 2 : 3.4;
      var dd = 'M ' + p(dptx, dpty) +
        ' L ' + p(dptx - dnx / 2 - dny / tk, dpty + dnx / tk - dny / 2) +
        ' L ' + p(dptx - dnx, dpty - dny) +
        ' L ' + p(dptx - dnx / 2 + dny / tk, dpty - dny / 2 - dnx / tk) + ' Z';
      return done([node(dd, filled !== false)]);
    }

    // box — Shapes.js:5840-5868: square of side ~(size+sw+1), line recedes by
    // the full (size+sw+1) so it stops at the back face.
    if (t === 'box') {
      var bnx = ux * (size + sw + 1), bny = uy * (size + sw + 1);
      var bpx = to.x + bnx / 2, bpy = to.y + bny / 2;
      pe = { x: to.x - bnx, y: to.y - bny };
      var bd = 'M ' + p(bpx - bnx / 2 - bny / 2, bpy - bny / 2 + bnx / 2) +
        ' L ' + p(bpx - bnx / 2 + bny / 2, bpy - bny / 2 - bnx / 2) +
        ' L ' + p(bpx + bny / 2 - 3 * bnx / 2, bpy - 3 * bny / 2 - bnx / 2) +
        ' L ' + p(bpx - bny / 2 - 3 * bnx / 2, bpy - 3 * bny / 2 + bnx / 2) + ' Z';
      return done([node(bd, filled !== false)]);
    }

    // circle / circlePlus — Shapes.js:5887-5934 circleMarker: radius (size+sw),
    // centered (size+2sw) behind the tip; line recedes by 2(size+sw)+sw.
    function circleNode() {
      var cs = size + sw;
      var ccx = to.x - ux * (cs + sw), ccy = to.y - uy * (cs + sw);
      pe = { x: to.x - ux * (2 * cs + sw), y: to.y - uy * (2 * cs + sw) };
      return node(ellipseD(ccx, ccy, cs), filled !== false);
    }
    if (t === 'circle') return done([circleNode()]);
    if (t === 'circlePlus') {
      var cpn = circleNode(); // mutates pe like circleMarker
      var pnx = ux * (size + 2 * sw), pny = uy * (size + 2 * sw);
      var cpd = 'M ' + p(to.x - ux * sw, to.y - uy * sw) +
        ' L ' + p(to.x - 2 * pnx + ux * sw, to.y - 2 * pny + uy * sw) +
        ' M ' + p(to.x - pnx - pny + uy * sw, to.y - pny + pnx - ux * sw) +
        ' L ' + p(to.x + pny - pnx - uy * sw, to.y - pny - pnx + ux * sw);
      return done([cpn, strokeNode(cpd)]);
    }

    // halfCircle — Shapes.js:5937-5954: two quadratics through the receded pe.
    // The engine path grammar has no Q; emit the EXACT cubic equivalent
    // (C1 = P0 + 2/3(Q-P0), C2 = P2 + 2/3(Q-P2) — identical curve).
    if (t === 'halfCircle') {
      var hnx = ux * (size + sw + 1), hny = uy * (size + sw + 1);
      pe = { x: to.x - hnx, y: to.y - hny };
      function quadC(x0, y0, qx2, qy2, x1, y1) {
        return ' C ' + p(x0 + 2 / 3 * (qx2 - x0), y0 + 2 / 3 * (qy2 - y0)) +
          ' ' + p(x1 + 2 / 3 * (qx2 - x1), y1 + 2 / 3 * (qy2 - y1)) +
          ' ' + p(x1, y1);
      }
      var h0x = to.x - hny, h0y = to.y + hnx;
      var h2x = to.x + hny, h2y = to.y - hnx;
      return done([strokeNode(
        'M ' + p(h0x, h0y) +
        quadC(h0x, h0y, pe.x - hny, pe.y + hnx, pe.x, pe.y) +
        quadC(pe.x, pe.y, pe.x + hny, pe.y - hnx, h2x, h2y))]);
    }

    // async — Shapes.js:5956-6001: half arrowhead (side depends on source).
    if (t === 'async') {
      var aeX = ux * sw * 1.118, aeY = uy * sw * 1.118;
      var anx = ux * (size + sw), any_ = uy * (size + sw);
      var aptx = to.x - aeX, apty = to.y - aeY;
      pe = { x: to.x - anx - aeX, y: to.y - any_ - aeY };
      var ad = 'M ' + p(aptx, apty) + ' L ' +
        (source ? p(aptx - anx - any_ / 2, apty - any_ + anx / 2)
                : p(aptx + any_ / 2 - anx, apty - any_ - anx / 2)) +
        ' L ' + p(aptx - anx, apty - any_) + ' Z';
      return done([node(ad, filled !== false)]);
    }
    // openAsync — Shapes.js:6003-6033: single stroked side, NO recession.
    if (t === 'openAsync') {
      var onx2 = ux * (size + sw), ony2 = uy * (size + sw);
      return done([strokeNode('M ' + p(to.x, to.y) + ' L ' +
        (source ? p(to.x - onx2 - ony2 / 2, to.y - ony2 + onx2 / 2)
                : p(to.x + ony2 / 2 - onx2, to.y - ony2 - onx2 / 2)))]);
    }

    // doubleBlock — mxMarker.js:177-216: two stacked triangles, line recedes
    // by 2*(size+sw) plus the strokewidth offset.
    if (t === 'doubleBlock') {
      var beX = ux * sw * 1.118, beY = uy * sw * 1.118;
      var bnx2 = ux * (size + sw), bny2 = uy * (size + sw);
      var bptx = to.x - beX, bpty = to.y - beY;
      pe = { x: to.x - 2 * bnx2 - beX, y: to.y - 2 * bny2 - beY };
      var dbd = 'M ' + p(bptx, bpty) +
        ' L ' + p(bptx - bnx2 - bny2 / 2, bpty - bny2 + bnx2 / 2) +
        ' L ' + p(bptx + bny2 / 2 - bnx2, bpty - bny2 - bnx2 / 2) + ' Z' +
        ' M ' + p(bptx - bnx2, bpty - bny2) +
        ' L ' + p(bptx - 2 * bnx2 - 0.5 * bny2, bpty + 0.5 * bnx2 - 2 * bny2) +
        ' L ' + p(bptx - 2 * bnx2 + 0.5 * bny2, bpty - 0.5 * bnx2 - 2 * bny2) + ' Z';
      return done([node(dbd, filled !== false)]);
    }

    // Stroked-line markers (dash, baseDash, cross) and the ER family — pure
    // stroked lines/feet matching the Shapes.js formulas exactly
    // (n = unit*(size+sw+1)); no recession except the hollow ERzeroTo* forms.
    var g = size + sw + 1;
    var qx = ux * g, qy = uy * g;
    function line(x0, y0, x1, y1) {
      return strokeNode('M ' + p(x0, y0) + ' L ' + p(x1, y1));
    }
    function poly3(x0, y0, x1, y1, x2, y2) {
      return strokeNode('M ' + p(x0, y0) + ' L ' + p(x1, y1) + ' L ' + p(x2, y2));
    }
    if (t === 'dash') {
      return done([line(to.x - qx / 2 - qy / 2, to.y - qy / 2 + qx / 2,
        to.x + qy / 2 - 3 * qx / 2, to.y - 3 * qy / 2 - qx / 2)]);
    }
    if (t === 'baseDash') {
      // mxMarker.js:162-175 — perpendicular dash AT the endpoint.
      return done([line(to.x - qy / 2, to.y + qx / 2, to.x + qy / 2, to.y - qx / 2)]);
    }
    if (t === 'cross') {
      return done([
        line(to.x - qx / 2 - qy / 2, to.y - qy / 2 + qx / 2,
          to.x + qy / 2 - 3 * qx / 2, to.y - 3 * qy / 2 - qx / 2),
        line(to.x - qx / 2 + qy / 2, to.y - qy / 2 - qx / 2,
          to.x - qy / 2 - 3 * qx / 2, to.y - 3 * qy / 2 + qx / 2)
      ]);
    }
    if (t === 'ERone') {
      return done([line(to.x - qx / 2 - qy / 2, to.y - qy / 2 + qx / 2,
        to.x - qx / 2 + qy / 2, to.y - qy / 2 - qx / 2)]);
    }
    if (t === 'ERmany') {
      return done([poly3(to.x + qy / 2, to.y - qx / 2, to.x - qx, to.y - qy,
        to.x - qy / 2, to.y + qx / 2)]);
    }
    if (t === 'ERmandOne') {
      return done([
        line(to.x - qx / 2 - qy / 2, to.y - qy / 2 + qx / 2,
          to.x - qx / 2 + qy / 2, to.y - qy / 2 - qx / 2),
        line(to.x - qx - qy / 2, to.y - qy + qx / 2,
          to.x - qx + qy / 2, to.y - qy - qx / 2)
      ]);
    }
    if (t === 'ERoneToMany') {
      return done([
        line(to.x - qx - qy / 2, to.y - qy + qx / 2,
          to.x - qx + qy / 2, to.y - qy - qx / 2),
        poly3(to.x + qy / 2, to.y - qx / 2, to.x - qx, to.y - qy,
          to.x - qy / 2, to.y + qx / 2)
      ]);
    }
    // ERzeroToOne / ERzeroToMany — Shapes.js (min): circle of radius size/2
    // centered 1.5n behind the tip. Filled: WHITE-filled circle, no recession
    // (the line passes under the opaque circle). Hollow: recede the line and
    // draw the tail segment(s) explicitly.
    if (t === 'ERzeroToOne' || t === 'ERzeroToMany') {
      var za = size / 2;
      var isF = (filled !== false);
      if (!isF) {
        pe = { x: to.x - (2 * qx - ux * sw / 2), y: to.y - (2 * qy - uy * sw / 2) };
      }
      var zCircle = {
        kind: 'path',
        d: ellipseD(to.x - 1.5 * qx, to.y - 1.5 * qy, za),
        fill: isF ? solid('#ffffff', 1) : null,
        stroke: mstroke
      };
      var zd;
      if (t === 'ERzeroToOne') {
        zd = 'M ' + p(to.x - qx / 2 - qy / 2, to.y - qy / 2 + qx / 2) +
          ' L ' + p(to.x - qx / 2 + qy / 2, to.y - qy / 2 - qx / 2);
        if (!isF) {
          zd += ' M ' + p(to.x - qx - ux * sw / 2, to.y - qy - uy * sw / 2) +
            ' L ' + p(to.x, to.y);
        }
      } else {
        zd = 'M ' + p(to.x + qy / 2, to.y - qx / 2) +
          ' L ' + p(to.x - qx, to.y - qy) +
          ' L ' + p(to.x - qy / 2, to.y + qx / 2);
        if (!isF) {
          zd += ' M ' + p(to.x - qx, to.y - qy) + ' L ' + p(to.x, to.y);
        }
      }
      return done([zCircle, strokeNode(zd)]);
    }
    // Genuinely unsupported (sysML glyphs, plugins, …): loud notice + classic-
    // triangle placeholder so the edge still terminates visibly. NEVER a
    // silent wrong marker. No recession (the placeholder is approximate anyway).
    if (Array.isArray(notices)) notices.push(degradation('ExporterUnsupportedShape',
      'edge marker "' + type + '" approximated as a classic arrowhead', cellId));
    return done([{ kind: 'path', d: arrowPath(from, to, size), fill: arrowFill, stroke: null }]);
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

  // Replace external <image> hrefs in a serialized SVG string with the
  // pre-resolved data URI (embedExternalImages), so resvg paints real pixels
  // instead of failing on a relative/cross-origin URL. Scoped to <image> tags
  // only (never gradient/pattern internal "#id" refs) and skips already-inline
  // "data:" hrefs. Falls back to resolved[style.image] when drawio rendered the
  // href absolute and the literal string isn't a map key.
  function embedImageHrefs(s, resolved, style) {
    if (typeof s !== 'string') return s;
    return s.replace(/<image\b[^>]*>/gi, function (tag) {
      return tag.replace(/(xlink:href|href)="([^"]+)"/g, function (m, attr, url) {
        if (/^(data:|#)/i.test(url)) return m;
        var d = (resolved && (resolved[url] ||
          (style && style.image && resolved[style.image]))) || null;
        return d ? attr + '="' + d + '"' : m;
      });
    });
  }

  // base64 (UTF-8) -> string. Browser-only fallback (atob/TextDecoder); in Node
  // the callers use Buffer instead, so these globals are only needed in-browser.
  function decodeUtf8B64(b64) {
    var bin = root.atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return (typeof root.TextDecoder === 'function')
      ? new root.TextDecoder().decode(bytes) : bin;
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
      // Decode HTML entities without DOM dependency (shim innerHTML doesn't
      // support textContent extraction reliably headlessly). &amp; decodes
      // LAST so "&amp;lt;" yields the literal "&lt;", never "<".
      s = decodeHtmlEntities(s);
      s = s.replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
    }
    return s;
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
    if (!(state.absoluteOffset && Number.isFinite(state.absoluteOffset.x)) &&
        state.absolutePoints && state.absolutePoints.length >= 2) {
      var mid = polylineMidpoint(state.absolutePoints);
      x = mid.x;
      y = mid.y;
    }
    // mxUtils.getAlignmentAsPoint: top → dy=0 (label hangs fully below the
    // anchor), bottom → dy=-1 (fully above), middle → dy=-0.5. The SAME rule
    // applies horizontally: align=left puts the label's LEFT edge at the
    // anchor (dx=0), right its right edge (dx=-1); always centering shifted
    // left/right-aligned edge labels by half the label width.
    var dyOff = style.verticalAlign === 'bottom' ? height + 2 :
      style.verticalAlign === 'top' ? 0 : height / 2;
    var dxOff = style.align === 'left' ? 0 :
      style.align === 'right' ? width : width / 2;
    return {
      x: (x - origin.x) / scale - dxOff,
      y: (y - origin.y) / scale - dyOff,
      w: width,
      h: height
    };
  }

  function polylineMidpoint(points) {
    var total = 0;
    for (var i = 1; i < points.length; i++) {
      var dx = points[i].x - points[i - 1].x;
      var dy = points[i].y - points[i - 1].y;
      total += Math.sqrt(dx * dx + dy * dy);
    }
    if (total <= 0) return points[Math.floor(points.length / 2)];
    var target = total / 2, walked = 0;
    for (var j = 1; j < points.length; j++) {
      var sx = points[j].x - points[j - 1].x;
      var sy = points[j].y - points[j - 1].y;
      var seg = Math.sqrt(sx * sx + sy * sy);
      if (walked + seg >= target) {
        var t = (target - walked) / Math.max(seg, 0.001);
        return { x: points[j - 1].x + sx * t, y: points[j - 1].y + sy * t };
      }
      walked += seg;
    }
    return points[points.length - 1];
  }

  // Direction of the segment containing arc-length fraction t.
  function segmentAt(points, t) {
    var total = 0, i;
    for (i = 1; i < points.length; i++) {
      var ddx = points[i].x - points[i - 1].x;
      var ddy = points[i].y - points[i - 1].y;
      total += Math.sqrt(ddx * ddx + ddy * ddy);
    }
    var target = Math.max(0, Math.min(1, t)) * total, walked = 0;
    for (i = 1; i < points.length; i++) {
      var sx = points[i].x - points[i - 1].x;
      var sy = points[i].y - points[i - 1].y;
      var seg = Math.sqrt(sx * sx + sy * sy);
      if (walked + seg >= target || i === points.length - 1) {
        return { dx: sx, dy: sy, len: seg };
      }
      walked += seg;
    }
    return { dx: 0, dy: 0, len: 0 };
  }

  // Point at fraction t in [0,1] of a polyline's arc length.
  function polylinePointAt(points, t) {
    if (!points || points.length === 0) return { x: 0, y: 0 };
    if (points.length === 1) return points[0];
    var total = 0, i;
    for (i = 1; i < points.length; i++) {
      var dx = points[i].x - points[i - 1].x, dy = points[i].y - points[i - 1].y;
      total += Math.sqrt(dx * dx + dy * dy);
    }
    if (total <= 0) return points[0];
    var target = Math.max(0, Math.min(1, t)) * total, walked = 0;
    for (i = 1; i < points.length; i++) {
      var sx = points[i].x - points[i - 1].x, sy = points[i].y - points[i - 1].y;
      var seg = Math.sqrt(sx * sx + sy * sy);
      if (walked + seg >= target) {
        var f = (target - walked) / Math.max(seg, 0.001);
        return { x: points[i - 1].x + sx * f, y: points[i - 1].y + sy * f };
      }
      walked += seg;
    }
    return points[points.length - 1];
  }

  // Render a label cell that is a CHILD of an edge (drawio multi-label edges:
  // UML multiplicity, ER cardinality, mid-edge notes). Its relative geometry.x
  // in [-1,1] maps to fraction t=(x+1)/2 along the edge; geometry.offset is an
  // absolute pixel nudge. Without this the cell baked as a degenerate 1x1 box at
  // the wrong spot, silently losing the label. Returns true if it handled the cell.
  function emitEdgeChildLabel(graph, cell, state, style, origin, scale, paint, notices, resolved, label) {
    if (label === '') return false;
    var model = graph && typeof graph.getModel === 'function' ? graph.getModel() : null;
    if (!model || typeof model.isEdge !== 'function') return false;
    var parentCell = typeof model.getParent === 'function' ? model.getParent(cell)
      : (cell.parent != null ? model.cells[cell.parent] : null);
    if (!parentCell || !model.isEdge(parentCell)) return false;
    var pst = graph.view && typeof graph.view.getState === 'function'
      ? graph.view.getState(parentCell) : null;
    if (!pst || !pst.absolutePoints || pst.absolutePoints.length < 2) return false;
    var geo = cell.geometry || {};
    var t = (typeof geo.x === 'number' && geo.relative) ? (geo.x + 1) / 2 : 0.5;
    var pt = polylinePointAt(pst.absolutePoints, t);
    var offx = geo.offset && Number.isFinite(geo.offset.x) ? geo.offset.x : 0;
    var offy = geo.offset && Number.isFinite(geo.offset.y) ? geo.offset.y : 0;
    // mxGraphView.getPoint: relative geometry.y is the PERPENDICULAR
    // offset from the edge at that arc position (dragging a label off the
    // line stores it here) -- dropping it printed the label ON the line.
    var gy = (geo.relative && Number.isFinite(geo.y)) ? geo.y : 0;
    if (gy !== 0 && pst.absolutePoints.length >= 2) {
      var seg = segmentAt(pst.absolutePoints, t);
      if (seg.len > 0) {
        offx += (seg.dy / seg.len) * gy;
        offy -= (seg.dx / seg.len) * gy;
      }
    }
    // mxGraphView.getPoint: x = pt.x + (nx*gy + offsetX) * scale — offsets are
    // MODEL units, so in contract (model) space they are added AFTER the
    // view→model division, never divided by the scale themselves.
    var cxw = (pt.x - origin.x) / scale + offx;
    var cyw = (pt.y - origin.y) / scale + offy;
    var fs = number(style.fontSize, 12);
    var lw = Math.max(24, String(label).length * fs * 0.65);
    var lh = Math.max(fs * 1.4, String(label).split('\n').length * fs * 1.25);
    // mxUtils.getAlignmentAsPoint: verticalAlign=top hangs the label fully
    // BELOW the anchor (dy=0), bottom fully ABOVE (dy=-1), middle centers
    // (dy=-0.5) — previously every valign was treated as middle.
    var vA = alignV(style.verticalAlign || 'middle');
    var elY = vA === 'top' ? cyw : vA === 'bottom' ? cyw - lh : cyw - lh / 2;
    // getAlignmentAsPoint horizontally too: align=left anchors the label's
    // LEFT edge at the point, right its right edge (was always centered).
    var elX = style.align === 'left' ? cxw :
      style.align === 'right' ? cxw - lw : cxw - lw / 2;
    var elBox = { x: elX, y: elY, w: lw, h: lh };
    var nodes = labelNodes(graph, cell, state, style, elBox, label, notices, resolved);
    // mxShape.getTextRotation: a rotation= style on the label child rotates
    // the rendered text about the label center; it was silently dropped.
    var elRot = number(style.rotation, 0);
    if (elRot) {
      nodes = nodes.map(function (n) {
        if (!n || n.kind !== 'svg') return n;
        var inner = (typeof Buffer !== 'undefined' && Buffer.from)
          ? Buffer.from(n.source, 'base64').toString('utf8')
          : decodeUtf8B64(n.source);
        var open = inner.indexOf('>');
        var close = inner.lastIndexOf('</svg>');
        if (open < 0 || close < 0) return n;
        var wrapped = inner.slice(0, open + 1) +
          '<g transform="rotate(' + fmt(elRot) + ' ' + fmt(n.box.w / 2) + ' ' +
          fmt(n.box.h / 2) + ')">' + inner.slice(open + 1, close) + '</g>' +
          inner.slice(close);
        return { kind: 'svg', box: n.box, aspect: n.aspect,
          format: n.format, source: base64(wrapped) };
      });
    }
    nodes.forEach(function (n) { paint.push(n); });
    return true;
  }

  function degradation(kind, detail, cellId) {
    return { kind: kind, detail: { detail: detail, cellId: String(cellId || '') } };
  }

  // Notice severity taxonomy — the single, tested source of truth for how the
  // Native Print dialog gates the Print button. Keyed by the same `kind` string
  // the UI receives from BOTH sources: the exporter's own bake notices and the
  // host/engine wire notices (proto.cpp NoticeKind). Three severities:
  //   'silent'      — a faithful render with nothing to review: NOT shown,
  //                   never blocks Print. The engine may still emit it on the
  //                   wire for audit; the dialog simply does not surface it.
  //   'info'        — shown for traceability, NEVER blocks Print.
  //   'degradation' — shown with an acknowledge checkbox; blocks Print until ticked.
  // The goal is WYSIWYG full-fidelity output without friction: a faithful
  // render (or an outcome the owner has accepted by design) must not nag the
  // operator for an acknowledgment on every print. Anything representing a real
  // fidelity loss the operator should consciously approve stays a degradation.
  var NOTICE_SILENT = {
    // Host SUCCESS notice: the SVG rasterized faithfully via the external
    // backend (carries backend identity, e.g. "resvg 0.47"). On the Win32 host
    // the design fonts are guaranteed (see the rasterizer's reverted font-guard
    // note), so a successful resvg render is trusted WYSIWYG. Per owner
    // directive a faithful print shows NO warning — this notice is not
    // surfaced. The FAILURE path (StubbedSvgArtwork) stays a loud degradation.
    SvgArtworkRasterized: true
  };
  var NOTICE_INFO = {
    // Engine/host clip notice. Per owner ruling the print keeps TRUE 1:1 size
    // and the sheet shows exactly what it can hold (never a silent scale); a
    // diagram larger than the paper is expected to be edge-clipped, so this is
    // an informational note, not a per-print approval gate.
    HardwareMarginClip: true,
    // Additive forward-compatible version skew (peer/schema minor ahead).
    SchemaMinorAhead: true,
    ProtoMinorAhead: true,
    // rgba text color alpha is dropped to hex in the contract (print is opaque
    // by design). The text still appears; only the transparency is lost. This
    // is cosmetic and does not warrant a blocking acknowledgment gate.
    RichApproximateAlpha: true
  };

  function noticeSeverity(kind) {
    if (NOTICE_SILENT[kind] === true) return 'silent';
    return NOTICE_INFO[kind] === true ? 'info' : 'degradation';
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
    // Manual UTF-8 fallback (used only when TextEncoder is missing — modern
    // browsers and Node always have it). Lone / mis-paired surrogates are
    // replaced with U+FFFD so the output is always valid UTF-8; otherwise
    // a stray 0xD800-0xDFFF would silently encode as invalid 3-byte
    // sequences that resvg / base64 consumers would mis-decode.
    var out = [];
    var REPL = [0xef, 0xbf, 0xbd];                    // U+FFFD as UTF-8
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) { out.push(c); continue; }
      if (c < 0x800) {
        out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
        continue;
      }
      if (c >= 0xd800 && c <= 0xdbff) {
        // High surrogate: must be followed by a low surrogate.
        var c2 = (i + 1 < str.length) ? str.charCodeAt(i + 1) : 0;
        if (c2 >= 0xdc00 && c2 <= 0xdfff) {
          ++i;
          var cp = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
          out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
            0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        } else {
          out.push(REPL[0], REPL[1], REPL[2]);        // lone high surrogate
        }
        continue;
      }
      if (c >= 0xdc00 && c <= 0xdfff) {
        out.push(REPL[0], REPL[1], REPL[2]);          // lone low surrogate
        continue;
      }
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return out;
  }

  function base64FromBytes(b) {
    var s = '';
    for (var i = 0; i < b.length; i += 3) {
      var n = (b[i] << 16) | ((i + 1 < b.length ? b[i + 1] : 0) << 8) |
        (i + 2 < b.length ? b[i + 2] : 0);
      s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] +
        (i + 1 < b.length ? B64[(n >> 6) & 63] : '=') +
        (i + 2 < b.length ? B64[n & 63] : '=');
    }
    return s;
  }

  function base64(str) {
    return base64FromBytes(utf8Bytes(str));
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

  // Numeric SVG/CSS length -> px. drawio's label editor emits px-sized HTML;
  // SVG foreignObject attributes are unitless user units. Percent values depend
  // on the parent viewport and are intentionally left to the caller's fallback.
  function cssLengthPx(v, fallback) {
    if (v == null || v === '') return fallback;
    var s = String(v).trim().toLowerCase();
    if (s.indexOf('%') >= 0) return fallback;
    var n = parseFloat(s);
    if (!Number.isFinite(n)) return fallback;
    if (s.indexOf('pt') >= 0) return n * 96 / 72;
    if (s.indexOf('cm') >= 0) return n * 96 / 2.54;
    if (s.indexOf('mm') >= 0) return n * 96 / 25.4;
    if (s.indexOf('in') >= 0) return n * 96;
    return n;
  }

  // Scale an #rrggbb toward black (factor<1) — the shade browsers use for the
  // dark edges of a 3D bevel border.
  function shadeHex(hex, factor) {
    var h = String(hex).replace('#', '');
    if (h.length !== 6) return hex;
    var ch = function (i) {
      var v = Math.max(0, Math.min(255,
        Math.round(parseInt(h.substr(i, 2), 16) * factor)));
      return v.toString(16).padStart(2, '0');
    };
    return '#' + ch(0) + ch(2) + ch(4);
  }

  // 3D bevel (groove/ridge/inset/outset): the visible look is two-tone — the
  // border colour on the "lit" edges and a darkened shade on the "shadowed"
  // edges. inset/groove: top+left shadowed; outset/ridge: top+left lit. This
  // is the faithful flat-SVG rendering of the bevel direction.
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
      // `format`+`data` are always returned for base64 image data URIs so the
      // SVG path (resvg) can embed any backend-supported format. The native
      // engine image path still only accepts PNG, so non-PNG keeps
      // `unsupportedFormat` set for that (unchanged) caller.
      if (fmt === 'png') return { format: 'png', data: data };
      return { format: fmt, data: data, unsupportedFormat: fmt };  // jpeg/gif/svg+xml/...
    }
    // draw.io sometimes emits data:image/xxx,<base64> without the ';base64' marker.
    // Detect by checking that the data consists only of base64 alphabet characters.
    var m2 = /^data:image\/([a-z0-9.+-]+),([A-Za-z0-9+/=]+)$/i.exec(src);
    if (m2) {
      var imgFmt = m2[1].toLowerCase();
      var imgData = m2[2];
      if (imgFmt === 'png') return { format: 'png', data: imgData };
      return { format: imgFmt, data: imgData, unsupportedFormat: imgFmt };
    }
    if (/^data:image\//i.test(src)) return { unsupportedFormat: 'non-base64' };
    return { externalUrl: src };               // http(s)/relative URL
  }

  // Formats the external SVG rasterizer (resvg 0.47) embeds from a data URI:
  // PNG/JPEG/GIF rasters and nested SVG. Anything outside this set (webp/bmp,
  // non-base64, external URL) stays loudly noticed instead of risking a silent
  // blank in the print.
  var EMBEDDABLE_IMG_MIME = {
    png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg',
    gif: 'image/gif', 'svg+xml': 'image/svg+xml'
  };
  function embeddableImageMime(parsed) {
    return (parsed && parsed.data && parsed.format &&
      EMBEDDABLE_IMG_MIME[parsed.format]) || null;
  }

  function isImageCell(style) {
    return style.shape === 'image' ||
      (typeof style.image === 'string' && style.image !== '');
  }

  // mxImageShape clip semantics: the `clipPath` style (drawio's Crop Image
  // UI writes `inset(T% R% B% L%[ round RR%])`) and `rounded=1` (which
  // appends/synthesizes the round clause from getArcSize) crop the drawn
  // image. Returns null when no crop applies (with a loud notice for
  // unsupported clip forms), or { defs, attr } to wrap the SVG <image>.
  var imgClipCounter = 0;
  function imageClipDecor(style, box, notices, cellId) {
    var r = boolish(style.rounded) ? roundedRectRadius(style, box.w, box.h) : 0;
    var clip = typeof style.clipPath === 'string' && style.clipPath !== ''
      ? String(style.clipPath) : null;
    if (r > 0) {
      var roundVal = ' round ' + (r * 100 / Math.min(box.w, box.h)) + '%';
      if (clip != null && clip.substring(0, 5) === 'inset' && clip.indexOf('round') < 0) {
        clip = clip.replace(')', roundVal + ')');
      } else if (clip == null) {
        clip = 'inset(0% 0% 0% 0%' + roundVal + ')';
      }
    }
    if (clip == null) return null;
    var m = /^inset\(\s*([^\s)]+)(?:\s+([^\s)]+))?(?:\s+([^\s)]+))?(?:\s+([^\s)]+))?\s*(?:round\s+([^\s)]+)\s*)?\)$/i
      .exec(clip.trim());
    if (!m) {
      // circle()/ellipse()/polygon() crops have no headless port yet:
      // print the FULL image with a loud notice, never a silent wrong crop.
      if (notices) {
        notices.push(degradation('ExporterUnsupportedImage',
          'image clipPath "' + clip + '" is not applied (printed uncropped).', cellId));
      }
      return null;
    }
    var len = function (v, ref) {
      if (v == null) return 0;
      var n = parseFloat(v);
      if (!Number.isFinite(n)) return 0;
      return /%$/.test(v) ? n / 100 * ref : n;
    };
    // CSS inset(): 1-4 values per margin shorthand order T R B L.
    var t = len(m[1], box.h);
    var rr = len(m[2] != null ? m[2] : m[1], box.w);
    var b = len(m[3] != null ? m[3] : m[1], box.h);
    var l = len(m[4] != null ? m[4] : (m[2] != null ? m[2] : m[1]), box.w);
    var rad = m[5] != null ? len(m[5], Math.min(box.w, box.h)) : 0;
    var cw = Math.max(0, box.w - l - rr);
    var ch = Math.max(0, box.h - t - b);
    var id = 'imgclip' + (imgClipCounter++);
    return {
      defs: '<clipPath id="' + id + '"><rect x="' + fmt(l) + '" y="' + fmt(t) +
        '" width="' + fmt(cw) + '" height="' + fmt(ch) +
        (rad > 0 ? '" rx="' + fmt(rad) + '" ry="' + fmt(rad) : '') + '"/></clipPath>',
      attr: ' clip-path="url(#' + id + ')"'
    };
  }

  function imageNode(style, box, parsed, notices, cellId, aspectOverride) {
    if (style && style.shape === 'icon') {
      var pad = Math.max(4, Math.min(box.w, box.h) * 0.16);
      box = {
        x: box.x + pad,
        y: box.y + pad,
        w: Math.max(1, box.w - pad * 2),
        h: Math.max(1, box.h - pad * 2)
      };
    }
    var fh = boolish(style.imageFlipH) || boolish(style.flipH);
    var fv = boolish(style.imageFlipV) || boolish(style.flipV);
    // mxSvgCanvas2D.image opacity = s.alpha * s.fillAlpha (mxSvgCanvas2D.js:
    // 1480-1483): the cell opacity TIMES fillOpacity. opacity(style,'fillOpacity')
    // composes both (was 'opacity', dropping fillOpacity on images).
    var op = opacity(style, 'fillOpacity');
    var clipDecor = imageClipDecor(style, box, notices, cellId);
    // aspectOverride forces preserveAspectRatio (e.g. mxLabel.paintImage passes
    // aspect=false → 'none'/stretch, regardless of imageAspect).
    var fit = aspectOverride || (String(style.imageAspect) === '0' ? 'none' : 'xMidYMid meet');
    if (op < 1 || clipDecor) {
      // kind:image has no opacity field in the frozen contract; route through an
      // svg <image opacity> so a translucent image (style opacity<100) prints
      // faithfully instead of fully opaque.
      var sx = fh ? -1 : 1, sy = fv ? -1 : 1;
      var tf = (fh || fv) ? ' transform="translate(' + fmt(fh ? box.w : 0) + ' ' +
        fmt(fv ? box.h : 0) + ') scale(' + sx + ',' + sy + ')"' : '';
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ' +
        'width="' + fmt(box.w) + '" height="' + fmt(box.h) + '">' +
        (clipDecor ? '<defs>' + clipDecor.defs + '</defs>' : '') +
        '<image x="0" y="0" width="' + fmt(box.w) + '" height="' + fmt(box.h) +
        '" preserveAspectRatio="' + fit + '"' +
        (op < 1 ? ' opacity="' + fmt(op) + '"' : '') + tf +
        (clipDecor ? clipDecor.attr : '') +
        ' xlink:href="data:image/png;base64,' + parsed.data + '"/></svg>';
      return { kind: 'svg', box: box, source: base64(svg), aspect: 'preserve' };
    }
    return {
      kind: 'image',
      box: box,
      format: 'png',
      data: parsed.data,
      aspect: fit === 'none' ? 'fill' : 'preserve',
      flipH: fh,
      flipV: fv
    };
  }

  // A non-PNG but rasterizer-embeddable image (JPEG/GIF/SVG, embedded or a
  // fetched external one) -> a `kind:"svg"` node whose source is a tiny SVG
  // wrapping the data URI as <image>. Built from the BYTES, not the live DOM,
  // so it works headless and never carries an unresolved external href. resvg
  // decodes the format (verified). aspect mirrors drawio's imageAspect.
  function dataUriImageSvgNode(mime, data, box, style, notices, cellId, aspectOverride, rotationDeg) {
    if (style && style.shape === 'icon') {
      var pad = Math.max(4, Math.min(box.w, box.h) * 0.16);
      box = {
        x: box.x + pad,
        y: box.y + pad,
        w: Math.max(1, box.w - pad * 2),
        h: Math.max(1, box.h - pad * 2)
      };
    }
    var fit = aspectOverride || (String(style && style.imageAspect) === '0'
      ? 'none' : 'xMidYMid meet');
    var clipDecor2 = imageClipDecor(style || {}, box, notices, cellId);
    // Image opacity = alpha * fillAlpha (mxSvgCanvas2D.image). The PNG path
    // carries it on the kind:image node / svg wrapper; this SVG-wrapped path
    // (JPEG/GIF/SVG payloads) dropped opacity entirely → translucent non-PNG
    // images printed fully opaque.
    var duOp = style ? opacity(style, 'fillOpacity') : 1;
    var img = '<image x="0" y="0" width="' + fmt(box.w) + '" height="' + fmt(box.h) +
      '" preserveAspectRatio="' + fit + '"' +
      (duOp < 1 ? ' opacity="' + fmt(duOp) + '"' : '') +
      (clipDecor2 ? clipDecor2.attr : '') + ' xlink:href="data:' + mime +
      ';base64,' + data + '"/>';
    // mxShape.updateTransform applies flips to every image regardless of
    // format; the PNG path carries flipH/flipV on the contract node, but
    // this SVG-wrapped path (JPEG/GIF/SVG payloads) dropped them silently.
    if (style && (boolish(style.flipH) || boolish(style.flipV))) {
      img = '<g transform="translate(' +
        fmt(boolish(style.flipH) ? box.w : 0) + ' ' +
        fmt(boolish(style.flipV) ? box.h : 0) + ') scale(' +
        (boolish(style.flipH) ? -1 : 1) + ' ' +
        (boolish(style.flipV) ? -1 : 1) + ')">' + img + '</g>';
    }
    // mxShape.updateTransform rotates EVERY image by the cell rotation,
    // independent of format; the PNG path carries this via a rotate() wrapper,
    // but this SVG-wrapped path (JPEG/GIF/SVG payloads) dropped rotation
    // silently -- a rotated non-PNG image printed axis-aligned with the wrong
    // AABB. Mirror the PNG rotated path: expand the viewport to the rotated
    // axis-aligned bbox, rotate the content about its centre, and centre the
    // expanded node box on the cell-box centre.
    var duRot = number(rotationDeg, 0);
    var vpW = box.w, vpH = box.h;
    var nodeBox = box;
    if (duRot) {
      var duTheta = duRot * Math.PI / 180;
      var duCosT = Math.abs(Math.cos(duTheta));
      var duSinT = Math.abs(Math.sin(duTheta));
      vpW = box.w * duCosT + box.h * duSinT;
      vpH = box.w * duSinT + box.h * duCosT;
      var duOffX = (vpW - box.w) / 2;
      var duOffY = (vpH - box.h) / 2;
      img = '<g transform="rotate(' + fmt(duRot) + ' ' + fmt(vpW / 2) + ' ' +
        fmt(vpH / 2) + ') translate(' + fmt(duOffX) + ' ' + fmt(duOffY) + ')">' +
        img + '</g>';
      nodeBox = { x: box.x + box.w / 2 - vpW / 2,
        y: box.y + box.h / 2 - vpH / 2, w: vpW, h: vpH };
    }
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" ' +
      'xmlns:xlink="http://www.w3.org/1999/xlink" width="' + fmt(vpW) +
      '" height="' + fmt(vpH) + '">' +
      (clipDecor2 ? '<defs>' + clipDecor2.defs + '</defs>' : '') + img + '</svg>';
    return { kind: 'svg', box: nodeBox, source: base64(svg), aspect: 'preserve' };
  }

  // Re-encode an ALREADY-LOADED <img> element's pixels to a PNG data URI via an
  // offscreen canvas. Owner-authorised canvas use (2026-05-24) for embedding
  // external label images so the print is WYSIWYG. Synchronous — the element is
  // already displayed. Returns null if tainted (cross-origin, no CORS) or no
  // canvas (Node), and the caller stays loud.
  function imgElementToPngDataUri(el) {
    try {
      var d = root.document;
      if (!d || !d.createElement || !el) return null;
      var w = el.naturalWidth || el.width, h = el.naturalHeight || el.height;
      if (!w || !h) return null;
      var c = d.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(el, 0, 0, w, h);
      return c.toDataURL('image/png');     // throws if the canvas is tainted
    } catch (e) { return null; }
  }

  // Load an external image URL and re-encode its rendered pixels to a PNG data
  // URI via an offscreen canvas. Per the owner's explicit decision (2026-05-24)
  // this canvas read is AUTHORISED — for embedding external image artwork only,
  // so the print is WYSIWYG — and is the fallback when fetch() is CORS-blocked.
  // (A truly cross-origin image with no CORS headers still taints the canvas,
  // so toDataURL throws -> resolves null -> the caller stays loud. Browser-only;
  // returns null where Image/canvas are absent, e.g. the Node tests.)
  function urlToPngViaCanvas(url) {
    return new Promise(function (resolve) {
      try {
        var d = root.document;
        if (typeof root.Image !== 'function' || !d || !d.createElement) {
          return resolve(null);
        }
        var im = new root.Image();
        im.crossOrigin = 'anonymous';   // request CORS so the canvas isn't tainted
        im.onload = function () {
          try {
            var w = im.naturalWidth || im.width, h = im.naturalHeight || im.height;
            if (!w || !h) return resolve(null);
            var c = d.createElement('canvas');
            c.width = w; c.height = h;
            c.getContext('2d').drawImage(im, 0, 0, w, h);
            resolve(c.toDataURL('image/png'));   // throws if canvas is tainted
          } catch (e) { resolve(null); }
        };
        im.onerror = function () { resolve(null); };
        im.src = url;
      } catch (e) { resolve(null); }
    });
  }

  // A URL whose bytes must be FETCHED to embed (as opposed to an inline data:
  // URI, handled by the transcode path). Covers http(s), protocol-relative
  // (//host/x), root-relative (/x) AND document-relative (img/clipart/x.png —
  // e.g. drawio's BUNDLED clipart); the browser's fetch() resolves them against
  // the page origin. NB previously only http(s) matched, so relative/bundled
  // images were never collected for embedding → they printed as a placeholder
  // box + a spurious ExporterUnsupportedImage degradation (a real warning AND a
  // fidelity loss). Now they embed their real pixels like any other image.
  function externalUrl(s) {
    if (typeof s !== 'string' || s === '') return null;
    if (/^data:/i.test(s)) return null;          // inline data URI — not fetched
    return s;                                     // http(s)/relative/root-relative
  }

  // Is this image source already in a form the engine/resvg embeds directly?
  function isEmbeddableSrc(src) {
    return !!embeddableImageMime(parseImage(src));
  }

  // Does this image source need bake-time resolution to become embeddable?
  //   'url'       -> external http(s): fetch / proxy / canvas to get the bytes.
  //   'transcode' -> a data URI in a format resvg can't draw (webp/bmp/tiff/…):
  //                  the BROWSER can decode it, so canvas re-encodes it to PNG.
  //   null        -> already embeddable (png/jpeg/gif/svg) or not an image.
  function imageSrcNeedsResolve(src) {
    if (typeof src !== 'string' || src === '') return null;
    if (externalUrl(src)) return 'url';
    var p = parseImage(src);
    if (p && p.data && !embeddableImageMime(p)) return 'transcode';
    return null;
  }

  // Collect image sources referenced inside a label's live DOM that need
  // resolution: inline <img src> and CSS background-image url(). Browser-only.
  function collectLabelImageUrls(node, urls) {
    if (!node || node.nodeType !== 1) return;
    if (String(node.tagName || '').toLowerCase() === 'img') {
      var s = node.getAttribute && node.getAttribute('src');
      if (imageSrcNeedsResolve(s)) urls[s] = true;
    }
    try {
      var cs = root.getComputedStyle ? root.getComputedStyle(node) : null;
      var bgi = cs && cs.backgroundImage;
      if (bgi && /url\(/i.test(bgi)) {
        var m = /url\(\s*["']?([^"')]+)["']?\s*\)/i.exec(bgi);
        if (m && imageSrcNeedsResolve(m[1])) urls[m[1]] = true;
      }
    } catch (e) { /* computed style unavailable */ }
    for (var i = 0; node.childNodes && i < node.childNodes.length; i++) {
      collectLabelImageUrls(node.childNodes[i], urls);
    }
  }

  // Collect image URLs embedded in stencil command trees. This is deliberately
  // structural: the headless bake already owns parsed stencil XML, so no browser DOM
  // is needed. Follow include-shape references too because their artwork is painted
  // into the parent stencil SVG.
  function collectStencilImageUrls(shapeNode, urls, seen) {
    if (!shapeNode || !shapeNode.children) return;
    seen = seen || [];
    if (seen.indexOf(shapeNode) >= 0) return;
    seen.push(shapeNode);
    for (var i = 0; i < shapeNode.children.length; i++) {
      var child = shapeNode.children[i];
      if (!child) continue;
      if (child.name === 'image' && child.attrs && imageSrcNeedsResolve(child.attrs.src)) {
        urls[child.attrs.src] = true;
      } else if (child.name === 'include-shape' && child.attrs && child.attrs.name) {
        var included = _stencilRegistry && _stencilRegistry.get(child.attrs.name.toLowerCase());
        if (included) collectStencilImageUrls(included, urls, seen);
      }
      collectStencilImageUrls(child, urls, seen);
    }
  }

  function inlineStencilNode(shapeName) {
    if (typeof shapeName !== 'string' || shapeName.indexOf('stencil(') !== 0 ||
        shapeName.charAt(shapeName.length - 1) !== ')') return null;
    try {
      var b64 = shapeName.slice(8, -1);
      var xmlDecoded = (typeof Buffer !== 'undefined')
        ? Buffer.from(b64, 'base64').toString('utf8') : decodeUtf8B64(b64);
      var parsed = parseXml(xmlDecoded);
      if (parsed && parsed.name === 'shape') return parsed;
      for (var i = 0; parsed && parsed.children && i < parsed.children.length; i++) {
        if (parsed.children[i].name === 'shape') return parsed.children[i];
      }
      return parsed;
    } catch (e) { return null; }
  }

  // Resolve EVERY image the diagram references that isn't already embeddable —
  // external http(s) (image cells, inline <img>, CSS url() backgrounds) AND
  // data URIs in formats resvg can't draw (webp/bmp/…) — into an embeddable
  // data URI so the print shows the real pixels. Everything resolves IN
  // PARALLEL (Promise.all); each source tries, in order of cost/reliability:
  //   1. fetch() the bytes directly (cache hit; same-origin / CORS images);
  //   2. fetch() via drawio's same-origin proxy (PROXY_URL) — defeats CORS,
  //      since the SERVER fetches it and serves it from our origin;
  //   3. canvas re-encode (owner-authorised) — also TRANSCODES any browser-
  //      decodable format (webp/bmp/…) to PNG.
  // Whatever bytes we obtain are then guaranteed embeddable (PNG transcode if
  // needed). A source no path can read/decode is left out -> the caller stays
  // loud + placeholder (never a silent wrong). Async + additive: the sync
  // buildResult path is unchanged without a map; the whole batch is awaited
  // once, then the bake runs — no per-image sync stalls.
  function embedExternalImages(graph, fetchImpl, canvasImpl, proxyBase) {
    var f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    var canvas = canvasImpl || urlToPngViaCanvas;
    var proxy = (proxyBase !== undefined) ? proxyBase
      : (root && typeof root.PROXY_URL === 'string' ? root.PROXY_URL : null);
    var out = {};
    if (!graph || typeof graph.getModel !== 'function') {
      return Promise.resolve(out);
    }
    var model = graph.getModel();
    var view = graph.view;
    var urls = {};
    collectCellsInZOrder(model).forEach(function (cell) {
      if (!cell) return;
      var style = (typeof graph.getCellStyle === 'function' &&
        graph.getCellStyle(cell)) || {};
      if (imageSrcNeedsResolve(style.image)) urls[style.image] = true;
      var shapeName = style.shape || '';
      var stencilNode = inlineStencilNode(shapeName) ||
        (_stencilRegistry && _stencilRegistry.get(shapeName));
      if (stencilNode) collectStencilImageUrls(stencilNode, urls);
      var state = (view && typeof view.getState === 'function')
        ? view.getState(cell) : null;
      var tnode = state && state.text && state.text.node;
      if (tnode) collectLabelImageUrls(tnode, urls);
    });
    var toDataUri = function (blob) {
      var type = (blob && blob.type) || 'image/png';
      return blob.arrayBuffer().then(function (ab) {
        return 'data:' + type + ';base64,' + base64FromBytes(new Uint8Array(ab));
      });
    };
    var fetchToDataUri = function (target) {
      if (!f) return Promise.resolve(null);
      return Promise.resolve().then(function () { return f(target); })
        .then(function (r) { return (r && r.ok) ? r.blob() : null; })
        .then(function (blob) { return blob ? toDataUri(blob) : null; })
        .catch(function () { return null; });
    };
    var viaProxy = function (url) {
      if (!proxy) return Promise.resolve(null);
      var pu = proxy + (proxy.indexOf('?') >= 0 ? '&' : '?') +
        'url=' + encodeURIComponent(url);
      return fetchToDataUri(pu);
    };
    // Whatever data URI we end up with must be engine-embeddable; if it's a
    // format resvg can't draw (webp/bmp/…), canvas re-encodes it to PNG.
    var ensureEmbeddable = function (du) {
      if (!du) return Promise.resolve(null);
      return isEmbeddableSrc(du) ? Promise.resolve(du)
        : Promise.resolve(canvas(du));
    };
    return Promise.all(Object.keys(urls).map(function (src) {
      var bytes = externalUrl(src)
        ? fetchToDataUri(src).then(function (du) { return du || viaProxy(src); })
        : Promise.resolve(src);            // a non-embeddable data URI we hold
      return bytes
        .then(function (du) { return du ? ensureEmbeddable(du) : canvas(src); })
        .then(function (du) { if (du) out[src] = du; })
        .catch(function () { /* unreadable/undecodable -> stays a loud notice */ });
    })).then(function () { return out; });
  }

  // `paper`, when supplied, is the SELECTED stock's size in px at 96/in
  // ({ wPx, hPx }). The contract page then equals the chosen paper so the
  // diagram prints 1:1 with the extra paper as whitespace (larger paper does
  // NOT scale the diagram up). The single tile == one physical sheet; content
  // beyond it is clipped by the engine, which raises a loud notice. When no
  // paper is given the legacy diagram-bounds page is kept (back-compat).
  // Depth-first traversal of the mxGraph tree, yielding cells in the same
  // back-to-front order the canvas paints them in. Layers are children of
  // root; cells inside a layer are children of the layer; group children
  // sit under their group, painted ON TOP of the group's body (matching
  // mxGraph's own cell-state validation order). This is the load-bearing
  // ordering for WYSIWYG with overlapping shapes / changed z-order.
  function collectCellsInZOrder(model) {
    if (!model || typeof model.getRoot !== 'function' ||
        typeof model.getChildAt !== 'function' ||
        typeof model.getChildCount !== 'function') {
      // Headless / minimal fixtures: preserve legacy behaviour. The browser
      // path always has these methods (mxGraphModel) so the live print uses
      // true z-order; this fallback only fires in Node tests / harnesses.
      var out = [];
      var dict = (model && model.cells) || {};
      Object.keys(dict).forEach(function (id) { out.push(dict[id]); });
      return out;
    }
    var root = model.getRoot();
    if (root == null) return [];
    var out = [];
    (function walk(parent) {
      var n = model.getChildCount(parent);
      for (var i = 0; i < n; i++) {
        var child = model.getChildAt(parent, i);
        if (child == null) continue;
        out.push(child);     // parent body BEFORE its descendants (z-order)
        walk(child);
      }
    })(root);
    return out;
  }

  function buildResult(graph, paper, opts) {
    // Reset per-contract generated SVG ids so repeated bakes of identical input
    // remain byte-for-byte deterministic even when HTML labels contain flattened
    // foreignObject clip paths.
    richClipCounter = 0;
    imgClipCounter = 0;
    // Native print renders every shape from its stencil geometry with zero
    // browser dependency — there is no live-DOM / rendered-SVG path. The
    // WYSIWYG guarantee holds by construction (faithful re-derivation or a loud
    // notice), enforced by structural invariants in the browser-free harness.
    var model = graph.getModel();
    var view = graph.view;
    var paint = [];
    var notices = [];
    // Optional url -> dataURI map from embedExternalImages() so external image
    // cells print their actual pixels instead of a placeholder notice.
    var resolved = (opts && opts.resolvedImages) || null;
    var scale = (view && view.scale) ? view.scale : 1;
    var bounds = graph.getGraphBounds();
    // Origin = the PAGE origin (model 0,0) in scaled-view coords, i.e.
    // view.translate*scale — NOT the content bounding box. Using bounds.x/y
    // normalised the diagram flush to the paper's top-left corner, dropping the
    // margin the author left between the page edge and the first shape (the
    // "output shifted up-and-left one block" report). Anchoring to the page
    // origin makes every cell keep its on-page position, so the margin prints
    // exactly as drawn.
    var page = (paper && paper.wPx > 0 && paper.hPx > 0)
      ? { w: Math.max(1, Math.round(paper.wPx)),
          h: Math.max(1, Math.round(paper.hPx)) }
      : { w: Math.max(1, Math.ceil((bounds ? bounds.width : 1) / scale)),
          h: Math.max(1, Math.ceil((bounds ? bounds.height : 1) / scale)) };
    var origin;
    if (view && view.translate && (view.translate.x || view.translate.y)) {
      origin = { x: view.translate.x * scale, y: view.translate.y * scale };
    } else if (paper && paper.explicit && bounds && bounds.width > 0) {
      // The AUTHOR fixed the page size (File > Page Setup), so cells keep
      // their on-page position even headless (mxPrintPreview semantics):
      // the origin is the PAGE-GRID cell containing the content, never the
      // content corner. floor() generalises to content drawn on a far grid
      // cell — the editor shows it on that page, and the print shows the
      // same sheet with the same in-page margins.
      var pgw = page.w * scale;
      var pgh = page.h * scale;
      origin = {
        x: pgw * Math.floor(bounds.x / pgw),
        y: pgh * Math.floor(bounds.y / pgh)
      };
    } else {
      // Auto-fit page (no explicit dims): bounds-anchoring is faithful.
      origin = {
        x: bounds && bounds.width > 0 ? bounds.x : 0,
        y: bounds && bounds.height > 0 ? bounds.y : 0
      };
    }

    // Page background colour (File > Page Setup) prints behind all content as a
    // full-page filled rect. Skipped for white (paper is already white) / none.
    var pgBg = paper && paper.background;
    if (isPaintable(pgBg) && hex(pgBg).toLowerCase() !== '#ffffff') {
      paint.push({ kind: 'path', d: rectPath(0, 0, page.w, page.h),
        fill: solid(pgBg, 1), stroke: null });
    }

    // WYSIWYG paint order = mxGraph z-order. The model's `cells` dict is keyed
    // by id (creation order); "Send to Back" / "Bring to Front" reorder a
    // cell's parent.children[] WITHOUT changing the dict. Iterating the dict
    // would silently print overlapping shapes in the wrong order — a C1
    // violation. Walk root → layers → descendants depth-first so the paint
    // list matches what the canvas draws back-to-front, exactly. The
    // dict-fallback path stays for headless fixtures / harnesses that do not
    // expose getRoot/getChildAt.
    var orderedCells = collectCellsInZOrder(model);
    // A cell prints only if it AND every ancestor (incl. its layer) is visible
    // (mxCell.visible). Hidden layers / cells must not appear in the print.
    var cellsById = (model && model.cells) || {};
    function cellVisible(c) {
      var self = c, hops = 0;
      while (c && hops++ < 1000) {
        if (c.visible === false) return false;
        // A collapsed cell renders itself but hides its DESCENDANTS.
        if (c.collapsed === true && c !== self) return false;
        var pid = c.parent && c.parent.id != null ? c.parent.id : c.parent;
        c = (pid != null) ? cellsById[pid] : null;
      }
      return true;
    }
    orderedCells.forEach(function (cell) {
      if (cell == null || (!model.isVertex(cell) && !model.isEdge(cell))) return;
      if (!cellVisible(cell)) return;
      var state = view.getState(cell);
      if (state == null) return;
      var isEdgeCell = model.isEdge(cell);
      var style = resolveThemeDefaults(
        graph.getCellStyle(cell) || state.style || {}, graph, !isEdgeCell, cell);

      if (isEdgeCell) {
        emitEdge(graph, cell, state, style, origin, scale, paint, notices, resolved);
        return;
      }
      emitVertex(graph, cell, state, style, origin, scale, paint, notices, resolved);
    });

    // LOUD-OR-FAITHFUL: the v1 contract carries gradient stops + type but
    // NO direction (p0/p1 for linear, center/focus/radius for radial).
    // Gradient cells that take the structural-fill path (emitVertex's bbox +
    // fillOf) emit
    // `kind:"path"` with `fill.type == "linear"|"radial"` — the engine's
    // host renders these always-horizontal (linear) or always-centered
    // (radial), regardless of drawio's gradientDirection. That is the
    // silent-divergence class C1 forbids on fallback paths. Scan the paint
    // list here and emit ONE loud notice per cell that emitted a gradient
    // in a fallback path; the operator sees the gap, never a silent wrong
    // direction.
    scanGradientFallbacks(paint, notices);

    return {
      contract: {
        schema: { major: 1, minor: 0 },
        meta: { bakePath: 'native-print' },
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

  function scanGradientFallbacks(paint, notices) {
    var seen = false;
    for (var i = 0; i < paint.length; i++) {
      var n = paint[i];
      if (!n || n.kind !== 'path') continue;       // svg nodes carry direction inline
      var f = n.fill, s = n.stroke;
      var hasGrad =
        (f && (f.type === 'linear' || f.type === 'radial')) ||
        (s && s.paint && (s.paint.type === 'linear' || s.paint.type === 'radial'));
      if (hasGrad) { seen = true; break; }
    }
    if (seen) {
      notices.push(degradation('GradientDirectionApprox',
        'one or more gradient fills/strokes were emitted via the headless ' +
        'fallback path; the v1 contract does not carry gradient direction, ' +
        'so the host renders linear gradients left-to-right and radial ' +
        'gradients box-centered regardless of drawio gradientDirection. ' +
        'The live (in-browser) path is unaffected — it ships the literal ' +
        'rendered SVG.',
        ''));
    }
  }

  function emitVertex(graph, cell, state, style, origin, scale, paint, notices, resolved) {
    var box = scaledBox(state, origin, scale);
    var label = plainLabel(graph, cell);

    // C1: a handful of genuinely-rare visual style properties are not yet
    // rendered (text drop-shadow, indicator sub-shapes/icons, RTL text). Emit a
    // LOUD notice when one is actually set so it is never a SILENT divergence.
    if (boolish(style.textShadow)) {
      notices.push(degradation('ExporterUnsupportedShape',
        'textShadow is not rendered (text drawn without its drop shadow).', cell.id));
    }
    if (isPaintable(style.indicatorShape) || style.indicatorShape ||
        (typeof style.indicatorImage === 'string' && style.indicatorImage !== '')) {
      notices.push(degradation('ExporterUnsupportedShape',
        'indicator shape/image "' + (style.indicatorShape || style.indicatorImage) +
        '" is not rendered.', cell.id));
    }
    var tdir = String(style.textDirection || '').toLowerCase();
    // mxText.getAutoDirection (mxText.js): textDirection=auto resolves to RTL
    // ONLY when the FIRST strong directional character is RTL (tmp[0] > 'z') —
    // mixed content whose first strong char is Latin stays LTR. The headless
    // renderer lays out LTR, so an auto-RTL label must be loud, never silent —
    // same posture as an explicit rtl. Same regex + first-char test as drawio.
    var autoRtl = false;
    if (tdir === 'auto') {
      var strongCh = /[A-Za-z\u05d0-\u065f\u066a-\u06ef\u06fa-\u07ff\ufb1d-\ufdff\ufe70-\ufefc]/.exec(String(label || ''));
      autoRtl = strongCh != null && strongCh[0] > 'z';
    }
    if (tdir === 'rtl' || autoRtl) {
      notices.push(degradation('ExporterUnsupportedShape',
        'right-to-left textDirection is not applied to the label.', cell.id));
    }
    if (/^vertical-/.test(String(style.textDirection || '').toLowerCase())) {
      // mxText renders vertical-lr/vertical-rl writing modes; the headless
      // label renderer lays out horizontally — keep it LOUD, never silent.
      notices.push(degradation('ExporterUnsupportedShape',
        'vertical textDirection "' + style.textDirection +
        '" is not applied to the label (printed horizontal).', cell.id));
    }
    // ExtendedShape (shape=ext) symbol0..n sub-shapes (Shapes.js:2240-2308)
    // are not rendered — the double-rect body still bakes faithfully, but a
    // configured symbol must never vanish silently.
    if (style.shape === 'ext') {
      var extSyms = Object.keys(style).filter(function (k) {
        return /^symbol\d+$/.test(k) && style[k];
      });
      if (extSyms.length) {
        notices.push(degradation('ExporterUnsupportedShape',
          'ext symbol sub-shape(s) ' + extSyms.map(function (k) {
            return k + '=' + style[k];
          }).join(', ') + ' are not rendered.', cell.id));
      }
    }
    // UmlLifeline participant= names another registered shape to paint as the
    // header (Shapes.js:2533-2551). builtinShapeSvg resolves it through the
    // builtin/shapePath dispatchers; when neither knows the shape the default
    // header rect is printed instead — LOUD, never silent.
    if (style.shape === 'umlLifeline' && style.participant &&
        style.participant !== 'umlLifeline') {
      var llpStyle = Object.assign({}, style, { shape: style.participant });
      if (builtinShapeSvg(llpStyle, 10, 10) == null &&
          shapePath(llpStyle, 0, 0, 10, 10) == null) {
        notices.push(degradation('ExporterUnsupportedShape',
          'umlLifeline participant "' + style.participant +
          '" is not rendered (default header rectangle printed).', cell.id));
      }
    }
    // LOUD-OR-FAITHFUL for rounded corners: polygon shapes round faithfully
    // via roundedPoly (mxShape.addPoints port); the few curve/multi-part
    // shapes in ROUNDED_NOT_YET would print square corners on rounded=1 —
    // never silently. (Rectangles round via roundedRectPath; ellipse/curved
    // shapes have no corners to round.)
    if (boolish(style.rounded) && ROUNDED_NOT_YET[style.shape]) {
      notices.push(degradation('ExporterUnsupportedShape',
        'rounded corners on "' + style.shape + '" are printed with square ' +
        'corners (rounded-polygon rendering not yet implemented for this shape).',
        cell.id));
    }

    // Edge child-label cell (multi-label edge): position along the parent edge.
    if (emitEdgeChildLabel(graph, cell, state, style, origin, scale, paint, notices, resolved, label)) {
      return;
    }
    // Degenerate geometry, faithful to the editor: NEGATIVE extents paint
    // nothing in drawio (invalid SVG rect attributes are ignored), a ZERO
    // extent paints a hairline along the surviving dimension. The old
    // Math.max(1,...) clamp silently inflated both into a 1px outlined box.
    // (Edge child labels above are exempt: they carry 0x0 geometry by design
    // and are laid out by the label renderer.)
    if (!(state.width > 0 && state.height > 0)) {
      if (state.width < 0 || state.height < 0) {
        return;
      }
      var degenStroke = strokeOf(style);
      var dgx = (state.x - origin.x) / scale;
      var dgy = (state.y - origin.y) / scale;
      if (degenStroke && (state.width > 0 || state.height > 0)) {
        paint.push({
          kind: 'path',
          d: 'M ' + fmt(dgx) + ' ' + fmt(dgy) + ' L ' +
            fmt(dgx + state.width / scale) + ' ' + fmt(dgy + state.height / scale),
          fill: null,
          stroke: degenStroke
        });
      }
      // The LABEL still renders in drawio (mxText ignores the degenerate
      // body) — e.g. a labelled horizontal divider line. Dropping it here
      // was a silent text loss.
      if (label !== '') {
        labelNodes(graph, cell, state, style,
          { x: dgx, y: dgy, w: Math.max(0, state.width / scale),
            h: Math.max(0, state.height / scale) },
          label, notices, resolved)
          .forEach(function (n) { paint.push(n); });
      }
      return;
    }

    // mxLabel with an image: a background rect + a SMALL icon (imageWidth/
    // imageHeight, positioned by imageAlign/imageVerticalAlign per
    // mxLabel.getImageBounds) + the text label. Treating shape=label;image= as
    // a plain image cell would fill the whole cell with the stretched image and
    // drop the background/text layout — a silent divergence — so handle it here.
    if (style.shape === 'label' &&
        typeof style.image === 'string' && style.image !== '') {
      var lblR = boolish(style.rounded) ? roundedRectRadius(style, box.w, box.h) : 0;
      var liw = number(style.imageWidth, 24), lih = number(style.imageHeight, 24);
      var lsp = number(style.spacing, 2) + 5;            // mxLabel: spacing + 5
      var lia = style.imageAlign || 'left', liv = style.imageVerticalAlign || 'middle';
      var liBox = {
        x: box.x + (lia === 'center' ? (box.w - liw) / 2 : lia === 'right' ? box.w - liw - lsp : lsp),
        y: box.y + (liv === 'top' ? lsp : liv === 'bottom' ? box.h - lih - lsp : (box.h - lih) / 2),
        w: liw, h: lih
      };
      var lImgSrc = (resolved && resolved[style.image]) || style.image;
      var lImg = parseImage(lImgSrc);
      var lMime = embeddableImageMime(lImg);
      // Rotated mxLabel+image: the per-node path below cannot carry rotation,
      // so a rotated label-with-icon printed axis-aligned with NO notice (the
      // generic shape path rotates; this branch returned early). Compose the
      // background + icon + label into ONE rotated SVG, exactly like the
      // generic rotated-shape path, so the whole label rotates as a unit.
      var lblRotDeg = number(style.rotation, 0);
      if (lblRotDeg) {
        var lblTheta = lblRotDeg * Math.PI / 180;
        var lblCosT = Math.abs(Math.cos(lblTheta)), lblSinT = Math.abs(Math.sin(lblTheta));
        var lblExpW = box.w * lblCosT + box.h * lblSinT;
        var lblExpH = box.w * lblSinT + box.h * lblCosT;
        var lblOffX = (lblExpW - box.w) / 2, lblOffY = (lblExpH - box.h) / 2;
        var lblRcx = lblExpW / 2, lblRcy = lblExpH / 2;
        var lblDefs = '', lblGradId = '';
        if (isPaintable(style.gradientColor) && isPaintable(style.fillColor)) {
          lblGradId = 'lg' + String(cell.id || '').replace(/[^a-z0-9]/gi, '');
          lblDefs = '<defs>' + linearGradDef(lblGradId, hex(style.fillColor),
            hex(style.gradientColor), style.gradientDirection) + '</defs>';
        }
        var lblBgD = lblR > 0 ? roundedRectPath(lblOffX, lblOffY, box.w, box.h, lblR)
                              : rectPath(lblOffX, lblOffY, box.w, box.h);
        var lblBgEl = '<path d="' + lblBgD + '"' + fillSvgAttr(style, lblGradId) +
          strokeSvgAttrs(style) + '/>';
        var lblIconX = lblOffX + (liBox.x - box.x), lblIconY = lblOffY + (liBox.y - box.y);
        var lblIconEl;
        if ((lImg && lImg.format === 'png') || lMime) {
          var lblHref = (lImg && lImg.format === 'png')
            ? 'data:image/png;base64,' + lImg.data
            : 'data:' + lMime + ';base64,' + lImg.data;
          var lblImgOp = opacity(style, 'fillOpacity');
          // mxLabel stretches the icon (preserveAspectRatio="none") + honors flips.
          var lblFh = boolish(style.imageFlipH) || boolish(style.flipH);
          var lblFv = boolish(style.imageFlipV) || boolish(style.flipV);
          var lblFlipTf = (lblFh || lblFv)
            ? ' transform="translate(' + fmt(lblFh ? 2 * lblIconX + liw : 0) + ' ' +
              fmt(lblFv ? 2 * lblIconY + lih : 0) + ') scale(' + (lblFh ? -1 : 1) + ',' +
              (lblFv ? -1 : 1) + ')"'
            : '';
          lblIconEl = '<image x="' + fmt(lblIconX) + '" y="' + fmt(lblIconY) + '" width="' +
            fmt(liw) + '" height="' + fmt(lih) + '" preserveAspectRatio="none"' +
            (lblImgOp < 1 ? ' opacity="' + fmt(lblImgOp) + '"' : '') + lblFlipTf +
            ' xlink:href="' + lblHref + '"/>';
        } else {
          notices.push(degradation('ExporterUnsupportedImage',
            'label image could not be embedded — placeholder box printed.', cell.id));
          lblIconEl = '<rect x="' + fmt(lblIconX) + '" y="' + fmt(lblIconY) + '" width="' +
            fmt(liw) + '" height="' + fmt(lih) + '" fill="none"' + strokeSvgAttrs(style) + '/>';
        }
        var lblTextEl = label !== ''
          ? rotatedLabelEls(graph, cell, style, lblOffX, lblOffY, box.w, box.h, label, notices, resolved)
          : '';
        var lblInner = '<g transform="rotate(' + fmt(lblRotDeg) + ' ' + fmt(lblRcx) + ' ' +
          fmt(lblRcy) + ')">' + lblBgEl + lblIconEl + lblTextEl + '</g>';
        var lblSvgStr = '<svg xmlns="http://www.w3.org/2000/svg" ' +
          'xmlns:xlink="http://www.w3.org/1999/xlink" width="' + fmt(lblExpW) +
          '" height="' + fmt(lblExpH) + '">' + lblDefs + lblInner + '</svg>';
        paint.push({
          kind: 'svg',
          box: { x: box.x + box.w / 2 - lblExpW / 2, y: box.y + box.h / 2 - lblExpH / 2,
                 w: lblExpW, h: lblExpH },
          source: base64(lblSvgStr),
          aspect: 'preserve'
        });
        return;
      }
      paint.push({ kind: 'path', fill: fillOf(style), stroke: strokeOf(style),
        d: lblR > 0 ? roundedRectPath(box.x, box.y, box.w, box.h, lblR)
                    : rectPath(box.x, box.y, box.w, box.h) });
      // mxLabel.paintImage calls c.image(...aspect=false...) — the icon is
      // STRETCHED to the icon box (preserveAspectRatio="none"), NOT letterboxed,
      // regardless of imageAspect (mxLabel.js:131-139).
      if (lImg && lImg.format === 'png') paint.push(imageNode(style, liBox, lImg, notices, cell.id, 'none'));
      else if (lMime) paint.push(dataUriImageSvgNode(lMime, lImg.data, liBox, style, notices, cell.id, 'none'));
      else {
        notices.push(degradation('ExporterUnsupportedImage',
          'label image could not be embedded — placeholder box printed.', cell.id));
        paint.push({ kind: 'path', d: rectPath(liBox.x, liBox.y, liBox.w, liBox.h),
          fill: null, stroke: strokeOf(style) });
      }
      if (label !== '') {
        labelNodes(graph, cell, state, style, box, label, notices, resolved)
          .forEach(function (n) { paint.push(n); });
      }
      return;
    }

    if (isImageCell(style)) {
      // mxImageShape draws an imageBackground fill (+ imageBorder stroke) behind
      // the image when set; prepend it before the image itself.
      if (isPaintable(style.imageBackground)) {
        var ibR = boolish(style.rounded) ? roundedRectRadius(style, box.w, box.h) : 0;
        paint.push({ kind: 'path',
          d: ibR > 0 ? roundedRectPath(box.x, box.y, box.w, box.h, ibR)
                     : rectPath(box.x, box.y, box.w, box.h),
          fill: solid(style.imageBackground, opacity(style, 'fillOpacity')),
          stroke: isPaintable(style.imageBorder)
            ? { paint: solid(style.imageBorder, opacity(style, 'strokeOpacity')),
                width: Math.max(0.1, number(style.strokeWidth, 1)), cap: 'butt', join: 'miter',
                miterLimit: 10, dash: null }
            : null });
      }
      // An external URL pre-resolved to a data URI (embedExternalImages) prints
      // its real pixels instead of a placeholder.
      var imgSrc = (resolved && typeof style.image === 'string' &&
        resolved[style.image]) || style.image;
      var img = parseImage(imgSrc);
      var mime = embeddableImageMime(img);
      var imageBox = box;
      if (style.shape === 'icon') {
        paint.push({
          kind: 'path',
          d: roundedRectPath(box.x, box.y, box.w, box.h, Math.min(box.w, box.h) * 0.1),
          fill: fillOf(style),
          stroke: strokeOf(style)
        });
        var iconPad = Math.max(4, Math.min(box.w, box.h) * 0.16);
        imageBox = {
          x: box.x + iconPad,
          y: box.y + iconPad,
          w: Math.max(1, box.w - iconPad * 2),
          h: Math.max(1, box.h - iconPad * 2)
        };
      }
      if (img && img.format === 'png') {
        var imgRotDeg = number(style.rotation, 0);
        if (imgRotDeg) {
          // Rotated PNG: wrap in an SVG so the rotation transform is carried
          // faithfully (kind:'image' has no rotation field in the schema).
          var imgTheta = imgRotDeg * Math.PI / 180;
          var imgCosT = Math.abs(Math.cos(imgTheta));
          var imgSinT = Math.abs(Math.sin(imgTheta));
          var imgExpW = imageBox.w * imgCosT + imageBox.h * imgSinT;
          var imgExpH = imageBox.w * imgSinT + imageBox.h * imgCosT;
          var imgOffX = (imgExpW - imageBox.w) / 2;
          var imgOffY = (imgExpH - imageBox.h) / 2;
          var imgRcx = imgExpW / 2;
          var imgRcy = imgExpH / 2;
          var imgFit = String(style.imageAspect) === '0' ? 'none' : 'xMidYMid meet';
          var imgFlipSx = (boolish(style.imageFlipH) || boolish(style.flipH)) ? -1 : 1;
          var imgFlipSy = (boolish(style.imageFlipV) || boolish(style.flipV)) ? -1 : 1;
          var imgFlipTx = imgFlipSx === -1 ? imageBox.w : 0;
          var imgFlipTy = imgFlipSy === -1 ? imageBox.h : 0;
          var imgFlipAttr = (imgFlipSx !== 1 || imgFlipSy !== 1)
            ? ' transform="translate(' + fmt(imgFlipTx) + ' ' + fmt(imgFlipTy) +
              ') scale(' + imgFlipSx + ',' + imgFlipSy + ')"'
            : '';
          // Image opacity = alpha * fillAlpha (mxSvgCanvas2D.image); the
          // non-rotated path uses 'fillOpacity' too. Reading bare 'opacity'
          // here silently dropped fillOpacity on rotated PNG images.
          var imgRotOp = opacity(style, 'fillOpacity');
          var imgEl = '<image x="' + fmt(imgOffX) + '" y="' + fmt(imgOffY) + '"' +
            ' width="' + fmt(imageBox.w) + '" height="' + fmt(imageBox.h) + '"' +
            ' preserveAspectRatio="' + imgFit + '"' +
            (imgRotOp < 1 ? ' opacity="' + fmt(imgRotOp) + '"' : '') +
            imgFlipAttr +
            ' xlink:href="data:image/png;base64,' + img.data + '"/>';
          var imgRotGroup = '<g transform="rotate(' + fmt(imgRotDeg) + ' ' +
            fmt(imgRcx) + ' ' + fmt(imgRcy) + ')">' + imgEl + '</g>';
          var imgSvgStr = '<svg xmlns="http://www.w3.org/2000/svg"' +
            ' xmlns:xlink="http://www.w3.org/1999/xlink"' +
            ' width="' + fmt(imgExpW) + '" height="' + fmt(imgExpH) + '">' +
            imgRotGroup + '</svg>';
          paint.push({
            kind: 'svg',
            box: { x: imageBox.x + imageBox.w / 2 - imgExpW / 2, y: imageBox.y + imageBox.h / 2 - imgExpH / 2,
                   w: imgExpW, h: imgExpH },
            source: base64(imgSvgStr),
            aspect: 'preserve'
          });
        } else {
          paint.push(imageNode(style, box, img, notices, cell.id));  // faithful — WYSIWYG
        }
      } else if (mime) {
        // Any rasterizer-embeddable format (JPEG/GIF/SVG, embedded or fetched)
        // -> build the SVG <image> from the bytes (no live-DOM dependency, so
        // it's faithful headless AND in-browser). No notice.
        paint.push(dataUriImageSvgNode(mime, img.data, box, style, notices,
          cell.id, undefined, number(style.rotation, 0)));
      } else {
        // Genuinely cannot embed faithfully (external URL that could not be
        // fetched — cross-origin without CORS, 404, offline; non-base64; or a
        // format no backend renders): loud, SPECIFIC notice + placeholder.
        var why = img && img.unsupportedFormat
          ? 'image format "' + img.unsupportedFormat + '" cannot be embedded'
          : img && img.externalUrl
            ? 'external image URL could not be fetched for embedding'
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
      // mxImageShape strokes imageBorder ON TOP of the image whenever it is set
      // (mxImageShape.js:201-216), independent of imageBackground. Previously the
      // border was emitted only inside the imageBackground branch, so an image
      // cell with imageBorder but no imageBackground printed with no border.
      if (isPaintable(style.imageBorder)) {
        var ibTop = boolish(style.rounded) ? roundedRectRadius(style, box.w, box.h) : 0;
        paint.push({ kind: 'path',
          d: ibTop > 0 ? roundedRectPath(box.x, box.y, box.w, box.h, ibTop)
                       : rectPath(box.x, box.y, box.w, box.h),
          fill: null,
          stroke: { paint: solid(style.imageBorder, opacity(style, 'strokeOpacity')),
            width: Math.max(0.1, number(style.strokeWidth, 1)), cap: 'butt', join: 'miter',
            miterLimit: 10, dash: null } });
      }
      if (label !== '') {
        // Place the label at its ACTUAL bounds (mxText.bounds honors
        // verticalLabelPosition), NOT the full cell box. Otherwise an icon's
        // label (verticalLabelPosition=bottom) — and especially its resolved
        // labelBackgroundColor box — is painted OVER the image, hiding it (the
        // "gear icon not present" bug). Falls back to the cell box if unknown.
        // Internal label box, inset per the shape's getLabelMargins/Bounds
        // (cube depth band, datastore disk stack, callout tail recess, process
        // bars, cylinder/note2/document/manualInput/folder header bands).
        var lb = applyLabelMargins(box, style);
        var tb = state.text && state.text.bounds;
        if (tb && tb.width > 0 && tb.height > 0 &&
            isFinite(tb.x) && isFinite(tb.y)) {
          lb = { x: (tb.x - origin.x) / scale - SVG_PAD,
                 y: (tb.y - origin.y) / scale - SVG_PAD,
                 w: tb.width / scale + 2 * SVG_PAD,
                 h: tb.height / scale + 2 * SVG_PAD };
        } else if (style.verticalLabelPosition === 'bottom' || style.shape === 'icon') {
          lb = { x: box.x, y: box.y + box.h, w: box.w, h: Math.max(16, number(style.fontSize, 12) * 1.5) };
        } else if (style.verticalLabelPosition === 'top') {
          var topH = Math.max(16, number(style.fontSize, 12) * 1.5);
          lb = { x: box.x, y: box.y - topH, w: box.w, h: topH };
        }
        labelNodes(graph, cell, state, style, lb, label, notices, resolved)
          .forEach(function (n) { paint.push(n); });
      }
      return;
    }

    // drawio's `text`/`html` shapes (e.g. the "Paragraph of Text" element,
    // and object values that parse as HTML labels) paint no separate body —
    // they are label-only objects. Emitting a bbox path here is both invisible
    // (fill/stroke are none) and wrongly raised an ExporterUnsupportedShape
    // notice. Skip the body; just lay out the label.
    // `transparent` paints NOTHING (TransparentShape fills NONE and never
    // strokes, Shapes.js:1933-1940) and `link` as a VERTEX paints nothing
    // (LinkShape only defines paintEdgeShape; mxShape's default
    // paintBackground/paintForeground are no-ops) — both previously baked
    // invented ink (a rect / an S-curve). Faithful = no body, label only.
    if (style.shape !== 'text' && style.shape !== 'html' &&
        style.shape !== 'curvedText' && style.shape !== 'transparent' &&
        style.shape !== 'link') {

      // --- Stencil registry lookup (covers all mxgraph.* shapes and inline stencil shapes) ---
      var stencilName = style.shape || '';
      var stencilNode = null;

      if (stencilName.indexOf('stencil(') === 0 && stencilName.charAt(stencilName.length - 1) === ')') {
        // Inline base64-encoded stencil XML
        try {
          var b64 = stencilName.slice(8, -1);
          var xmlDecoded = '';
          if (typeof Buffer !== 'undefined') {
            xmlDecoded = Buffer.from(b64, 'base64').toString('utf8');
          } else {
            // Browser fallback (should not be reached in Node.js context)
            xmlDecoded = decodeUtf8B64(b64);
          }
          var inlineParsed = parseXml(xmlDecoded);
          if (inlineParsed && inlineParsed.name === 'shape') {
            stencilNode = inlineParsed;
          } else if (inlineParsed && inlineParsed.children && inlineParsed.children.length > 0) {
            // The XML might have the <shape> as a child
            for (var sc = 0; sc < inlineParsed.children.length; sc++) {
              if (inlineParsed.children[sc].name === 'shape') {
                stencilNode = inlineParsed.children[sc];
                break;
              }
            }
          }
          if (!stencilNode && inlineParsed) stencilNode = inlineParsed; // use whatever we got
        } catch (e) {
          notices.push(degradation('ExporterUnsupportedShape',
            'inline stencil parse error: ' + e.message, cell.id));
        }
      } else if (stencilName && _stencilRegistry) {
        stencilNode = _stencilRegistry.get(stencilName) || null;
      }

      var hasStencil = (_stencilRegistry && _stencilRegistry.has(stencilName)) ||
        (typeof mxStencilRegistry !== 'undefined' && mxStencilRegistry.getStencil(stencilName) != null);

      if (stencilNode || (hasStencil && !_stencilRegistry)) {
        if (!stencilNode) {
          paint.push({
            kind: 'path',
            d: rectPath(box.x, box.y, box.w, box.h),
            fill: fillOf(style),
            stroke: strokeOf(style)
          });
          return;
        }
        var stencilSvg = stencilToSvg(stencilNode, box.w, box.h, style, notices, resolved);
        if (stencilSvg) {
          // shadow=1 is canvas-level in drawio (every fill/stroke duplicated
          // recolored + offset UNDER the shape, mxSvgCanvas2D createShadow)
          // and applies to stencils too — it was silently dropped here.
          if (boolish(style.shadow)) {
            var shadowS = shadowParams(style);
            var innerShadowS = stencilSvg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
            paint.push(paddedSvgShapeNode(
              '<g opacity="' + fmt(shadowS.alpha) + '">' +
              shadowRecolorSvg(innerShadowS, hex(shadowS.color)) + '</g>',
              { x: box.x + shadowS.dx, y: box.y + shadowS.dy, w: box.w, h: box.h },
              style));
          }
          // sketch=1 (roughjs hand-drawn texture + hachure/dots fills) has no
          // headless port on the stencil branch: LOUD, never a silent clean
          // print of a sketch-styled diagram.
          if (boolish(style.sketch)) {
            notices.push(degradation('ExporterUnsupportedShape',
              'sketch=1 hand-drawn texture is not applied to stencil "' +
              String(stencilName || style.shape) + '" (printed clean).', cell.id));
          }
          var rotDegS = number(style.rotation, 0);
          if (rotDegS) {
            // Rotated stencil: expand viewport to axis-aligned bbox, rotate content and label
            var thetaS = rotDegS * Math.PI / 180;
            var cosThetaS = Math.abs(Math.cos(thetaS));
            var sinThetaS = Math.abs(Math.sin(thetaS));
            var expWS = box.w * cosThetaS + box.h * sinThetaS;
            var expHS = box.w * sinThetaS + box.h * cosThetaS;
            var offXS = (expWS - box.w) / 2;
            var offYS = (expHS - box.h) / 2;
            var rcxS = expWS / 2;
            var rcyS = expHS / 2;
            // Re-render the stencil at (offX, offY) offset — re-generate with offset box
            // Since stencilToSvg renders starting at (0,0), we wrap in a translate group
            var textElS = rotatedLabelEls(graph, cell, style, offXS, offYS, box.w, box.h, label, notices, resolved);
            // Extract inner content from stencil SVG (between <svg...> and </svg>).
            // stencilToSvg already includes <defs> with gradient inside innerS — do not add a second.
            var innerS = stencilSvg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
            var innerSWithOffset = '<g transform="translate(' + fmt(offXS) + ' ' + fmt(offYS) + ')">' + innerS + '</g>';
            var rotGroupS = '<g transform="rotate(' + fmt(rotDegS) + ' ' + fmt(rcxS) + ' ' + fmt(rcyS) + ')">' +
              innerSWithOffset + textElS + '</g>';
            var svgStrS = '<svg xmlns="http://www.w3.org/2000/svg" width="' + fmt(expWS) +
              '" height="' + fmt(expHS) + '">' + rotGroupS + '</svg>';
            var svgCxS = box.x + box.w / 2;
            var svgCyS = box.y + box.h / 2;
            paint.push({
              kind: 'svg',
              box: { x: svgCxS - expWS / 2, y: svgCyS - expHS / 2, w: expWS, h: expHS },
              source: base64(svgStrS),
              aspect: 'preserve'
            });
          } else {
            // Non-rotated stencil: emit kind:'svg' + separate text node
            paint.push({
              kind: 'svg',
              box: box,
              source: base64(stencilSvg),
              aspect: 'preserve'
            });
            if (label !== '') {
              // External label bands + labelWidth: one shared exact port
              // (externalLabelBox) so stencils match the generic path.
              labelNodes(graph, cell, state, style, externalLabelBox(style, box),
                label, notices, resolved)
                .forEach(function (n) { paint.push(n); });
            }
          }
          return;
        }
        // stencilToSvg returned null → notice already pushed; fall through to shapePath
      }
      // --- End stencil lookup ---

      // --- Built-in multi-element shapes (registered in Shapes.js, not stencil XML) ---
      var builtinContent = builtinShapeSvg(style, box.w, box.h);
      if (builtinContent !== null && style.shape === 'table') {
        builtinContent += tableGridLines(graph, cell, style, box.w, box.h);
      }
      if (builtinContent !== null) {
        // direction= (N/S/E/W) rotates a multi-element shape like drawio's
        // getShapeRotation (+90 S, +180 W, +270 N); N/S also invert the paint
        // bounds. Bake it into the content (keeping the box.w x box.h viewport)
        // so the rotation/plain branches and label positioning below are
        // unchanged. Previously direction was silently ignored for these shapes.
        var dirBI = String(style.direction || 'east').toLowerCase();
        var dirDegBI = dirBI === 'south' ? 90 : dirBI === 'west' ? 180 : dirBI === 'north' ? 270 : 0;
        if (dirDegBI) {
          var dirInvBI = (dirBI === 'north' || dirBI === 'south');
          var pwBI0 = dirInvBI ? box.h : box.w, phBI0 = dirInvBI ? box.w : box.h;
          var rawBI = dirInvBI ? builtinShapeSvg(style, pwBI0, phBI0) : builtinContent;
          // Compose flip + direction exactly like mxSvgCanvas2D.rotate: flags
          // swapped for N/S, mirror+negate-theta for a single-axis flip, content
          // centred then rotated about the box centre. Labels stay unflipped.
          var cxBI = box.w / 2, cyBI = box.h / 2;
          var fHB = boolish(style.flipH), fVB = boolish(style.flipV);
          if (dirInvBI) { var tB = fHB; fHB = fVB; fVB = tB; }
          builtinContent = '<g transform="' +
            flipRotatePrefix(dirDegBI, fHB, fVB, cxBI, cyBI) + 'translate(' +
            fmt(cxBI - pwBI0 / 2) + ' ' + fmt(cyBI - phBI0 / 2) + ')">' +
            rawBI + '</g>';
        } else {
          builtinContent = flipWrapSvg(builtinContent, box.w, box.h, style);
        }
        // shadow=1: paint the offset shadow copy FIRST (mxShape paints shadows
        // under the shape). The copy is the builtin content re-colored to the
        // shadow color at the shadow alpha, offset (2,3) in page space —
        // mxSvgCanvas2D.createShadow prepends its translate to the node
        // transform, so the offset does NOT rotate with the shape. Previously
        // shadow=1 was silently dropped on this branch.
        // sketch=1 fills (hachure/dots/cross-hatch) render faithfully only
        // on the generic single-path branch (sketchFillSvg); on this
        // multi-element branch the texture was silently dropped -> LOUD.
        if (boolish(style.sketch)) {
          notices.push(degradation('ExporterUnsupportedShape',
            'sketch=1 hand-drawn texture is not applied to shape "' +
            String(style.shape) + '" (printed clean).', cell.id));
        }
        var shadowBI = boolish(style.shadow) ? shadowParams(style) : null;
        var shadowContentBI = shadowBI
          ? '<g opacity="' + fmt(shadowBI.alpha) + '">' +
            shadowRecolorSvg(builtinContent, hex(shadowBI.color)) + '</g>'
          : null;
        // mermaidBlockArrow with dirs=x,y paints its four tips nodePadding
        // beyond the cell box (Shapes.js:6732-6741) — give the viewport that
        // headroom so they are not clipped.
        var extraPadBI = style.shape === 'mermaidBlockArrow'
          ? Math.max(0, number(style.nodePadding, 8)) : 0;
        var rotDegBI = number(style.rotation, 0);
        if (rotDegBI) {
          var thetaBI = rotDegBI * Math.PI / 180;
          var expWBI = box.w * Math.abs(Math.cos(thetaBI)) + box.h * Math.abs(Math.sin(thetaBI));
          var expHBI = box.w * Math.abs(Math.sin(thetaBI)) + box.h * Math.abs(Math.cos(thetaBI));
          var offXBI = (expWBI - box.w) / 2;
          var offYBI = (expHBI - box.h) / 2;
          var rcxBI = expWBI / 2, rcyBI = expHBI / 2;
          if (shadowContentBI) {
            var shRotGroupBI = '<g transform="rotate(' + fmt(rotDegBI) + ' ' + fmt(rcxBI) + ' ' + fmt(rcyBI) + ')">' +
              '<g transform="translate(' + fmt(offXBI) + ' ' + fmt(offYBI) + ')">' + shadowContentBI + '</g></g>';
            paint.push({
              kind: 'svg',
              box: { x: box.x + box.w / 2 - expWBI / 2 + shadowBI.dx,
                     y: box.y + box.h / 2 - expHBI / 2 + shadowBI.dy, w: expWBI, h: expHBI },
              source: base64('<svg xmlns="http://www.w3.org/2000/svg" width="' + fmt(expWBI) +
                '" height="' + fmt(expHBI) + '">' + shRotGroupBI + '</svg>'),
              aspect: 'preserve'
            });
          }
          var textElBI = rotatedLabelEls(graph, cell, style, offXBI, offYBI, box.w, box.h, label, notices, resolved);
          var innerBI = '<g transform="translate(' + fmt(offXBI) + ' ' + fmt(offYBI) + ')">' + builtinContent + '</g>';
          var rotGroupBI = '<g transform="rotate(' + fmt(rotDegBI) + ' ' + fmt(rcxBI) + ' ' + fmt(rcyBI) + ')">' + innerBI + textElBI + '</g>';
          var svgStrBI = '<svg xmlns="http://www.w3.org/2000/svg" width="' + fmt(expWBI) + '" height="' + fmt(expHBI) + '">' + rotGroupBI + '</svg>';
          paint.push({
            kind: 'svg',
            box: { x: box.x + box.w / 2 - expWBI / 2, y: box.y + box.h / 2 - expHBI / 2, w: expWBI, h: expHBI },
            source: base64(svgStrBI),
            aspect: 'preserve'
          });
        } else {
          // Pad the viewport by strokeWidth/2 so the shape's outer border is not
          // half-clipped (which makes it thinner than the interior lines).
          if (shadowContentBI) {
            paint.push(paddedSvgShapeNode(shadowContentBI,
              { x: box.x + shadowBI.dx, y: box.y + shadowBI.dy, w: box.w, h: box.h },
              style, extraPadBI));
          }
          paint.push(paddedSvgShapeNode(builtinContent, box, style, extraPadBI));
          if (label !== '') {
            // External label bands + labelWidth: one shared exact port
            // (externalLabelBox) so builtins match the generic path.
            var lblBoxBI = externalLabelBox(style, box);
            // Internal label: inset per getLabelMargins/getLabelBounds (process
            // bars, etc.). table/umlFrame/umlLifeline override explicitly below.
            if (lblBoxBI === box) lblBoxBI = applyLabelMargins(box, style);
            if (style.shape === 'table') {
              var tableHeadBI = Math.min(Math.max(0, number(style.startSize, 40)), box.h);
              if (tableHeadBI > 0) lblBoxBI = { x: box.x, y: box.y, w: box.w, h: tableHeadBI };
            }
            if (style.shape === 'umlFrame') {
              // UmlFrame.getLabelMargins: the label lives in the title pentagon
              // (top-left width x height box, defaults 60x30).
              lblBoxBI = {
                x: box.x, y: box.y,
                w: Math.min(box.w, Math.max(10, number(style.width, 60))),
                h: Math.min(box.h, Math.max(15, number(style.height, 30)))
              };
            }
            if (style.shape === 'umlLifeline') {
              // UmlLifeline.getLabelBounds: the label lives in the header box
              // (size tall, default 40), not centered over the whole stem.
              lblBoxBI = {
                x: box.x, y: box.y, w: box.w,
                h: Math.max(0, Math.min(box.h, number(style.size, 40)))
              };
            }
            labelNodes(graph, cell, state, style, lblBoxBI, label, notices, resolved)
              .forEach(function (n) { paint.push(n); });
          }
        }
        return;
      }

      // Note shape (folded-corner sticky note). Handle before shapePath, which
      // would flatten the dog-ear to a plain rectangle. note2 (NoteShape2,
      // Shapes.js) paints identically to note — only its label margins differ.
      if (style.shape === 'note' || style.shape === 'note2') {
        if (boolish(style.shadow)) {
          var nsp = shadowParams(style);
          paint.push(paddedSvgShapeNode(noteInner(style, box.w, box.h, nsp.color, nsp.alpha),
            { x: box.x + nsp.dx, y: box.y + nsp.dy, w: box.w, h: box.h }, { strokeColor: 'none' }));
        }
        paint.push(paddedSvgShapeNode(noteInner(style, box.w, box.h, null, null), box, style));
        if (label !== '') {
          // note2 with boundedLbl insets the label below the fold (getLabelMargins);
          // external labels (labelPosition/verticalLabelPosition) are not inset.
          var noteExt = externalLabelBox(style, box);
          var noteLb = (noteExt === box) ? applyLabelMargins(box, style) : noteExt;
          paint.push(labelTextNode(graph, cell, state, style, noteLb, label, notices, resolved));
        }
        return;
      }

      // Cube with shaded faces: only when darkOpacity/darkOpacity2 is set (the
      // plain cube keeps its single-path shapePath render). Mirrors noteInner.
      if (style.shape === 'cube' &&
          (number(style.darkOpacity, 0) !== 0 || number(style.darkOpacity2, 0) !== 0)) {
        if (boolish(style.shadow)) {
          var csp = shadowParams(style);
          paint.push(paddedSvgShapeNode(cubeInner(style, box.w, box.h, csp.color, csp.alpha),
            { x: box.x + csp.dx, y: box.y + csp.dy, w: box.w, h: box.h }, { strokeColor: 'none' }));
        }
        paint.push(paddedSvgShapeNode(cubeInner(style, box.w, box.h, null, null), box, style));
        if (label !== '') {
          // The default General-sidebar cube carries boundedLbl=1 → inset the
          // label by `size` (left+top) per CubeShape.getLabelMargins. External
          // labels (labelPosition/verticalLabelPosition) are not inset.
          var cubeExt = externalLabelBox(style, box);
          var cubeLb = (cubeExt === box) ? applyLabelMargins(box, style) : cubeExt;
          paint.push(labelTextNode(graph, cell, state, style, cubeLb, label, notices, resolved));
        }
        return;
      }

      // Swimlane (mxSwimlane): the HEADER is filled with fillColor and the BODY
      // with swimlaneFillColor (default none = transparent) — previously the
      // whole shape was filled with fillColor, silently filling the body. The
      // separator line honors swimlaneLine (default on) / separatorColor. The
      // title sits in the header. (Rotated swimlanes fall through to the generic
      // path, which is an extremely rare combination.)
      if (style.shape === 'swimlane' && !number(style.rotation, 0)) {
        // direction= rotates the whole swimlane in drawio (mxShape.
        // getShapeRotation); the structural header/body/divider emission here
        // is not rotatable. LOUD notice, never silent (the lane prints in its
        // default east orientation). horizontal=0 — the common way to get a
        // vertical lane — IS handled below.
        var swDir = String(style.direction || 'east').toLowerCase();
        if (swDir !== 'east') {
          notices.push(degradation('ExporterUnsupportedShape',
            'swimlane direction="' + swDir + '" is not rotated (printed in the ' +
            'default east orientation; use horizontal=0 for vertical lanes).', cell.id));
        }
        var swH = String(style.horizontal) !== '0';
        var swSz = Math.min(Math.max(0, number(style.startSize, 40)), swH ? box.h : box.w);
        var swStroke = strokeOf(style);
        var swFill = fillOf(style);                 // header fill (null if none)
        var swLane = isPaintable(style.swimlaneFillColor)
          ? solid(style.swimlaneFillColor, opacity(style, 'fillOpacity')) : null;
        var swHead = String(style.swimlaneHead) !== '0';   // default 1
        var swBody = String(style.swimlaneBody) !== '0';   // default 1
        var swR = boolish(style.rounded) ? roundedRectRadius(style, box.w, box.h) : 0;
        var bx = box.x, by = box.y, bw = box.w, bh = box.h;
        // flipH/flipV mirror the swimlane geometry within its box (header moves
        // to the opposite side), exactly like mxShape.updateTransform; the
        // label text stays upright but follows the flipped header
        // (mxSwimlane.getLabelBounds). Previously silently ignored.
        // stencilFlipH/V only apply when a stencil exists (mxShape.js:1410-1415).
        var swFH = boolish(style.flipH);
        var swFV = boolish(style.flipV);
        var swFlipBox = function (b) {
          return (swFH || swFV) ? {
            x: swFH ? 2 * bx + bw - b.x - b.w : b.x,
            y: swFV ? 2 * by + bh - b.y - b.h : b.y, w: b.w, h: b.h } : b;
        };
        // Shadow (mxShape.configureCanvas setShadow applies to swimlanes too,
        // mxShape.js:1037-1039). drawio's createShadow duplicates every painted
        // element offset + recolored at shadowAlpha; emit the lane silhouette
        // (header-fill region + outer outline + divider) as ONE group-opacity
        // SVG so overlapping strokes don't double-darken, rendered UNDER the
        // shape. Previously dropped silently (the table subclass shadowed; this
        // branch did not).
        if (boolish(style.shadow)) {
          var swSp = shadowParams(style);
          var swSgw = Math.max(0.1, number(style.strokeWidth, 1));
          var swShColor = hex(swSp.color);
          var swShParts = '';
          // The header-fill region and divider must follow flipH/flipV exactly
          // like the real geometry (swFlipBox), or under flipV / a flipped
          // vertical lane the shadow's dark header band shows on the wrong side.
          // Local (box-relative) header offset + divider position, flip-aware:
          var swShHx = swH ? 0 : (swFH ? bw - swSz : 0);
          var swShHy = swH ? (swFV ? bh - swSz : 0) : 0;
          var swShDiv = swH ? (swFV ? bh - swSz : swSz) : (swFH ? bw - swSz : swSz);
          if (swFill) {
            swShParts += '<rect x="' + fmt(swShHx) + '" y="' + fmt(swShHy) +
              '" width="' + fmt(swH ? bw : swSz) + '" height="' + fmt(swH ? swSz : bh) +
              '" fill="' + swShColor + '" stroke="none"/>';
          }
          swShParts += swR > 0
            ? '<rect x="0" y="0" width="' + fmt(bw) + '" height="' + fmt(bh) +
              '" rx="' + fmt(swR) + '" ry="' + fmt(swR) + '" fill="none" stroke="' +
              swShColor + '" stroke-width="' + fmt(swSgw) + '"/>'
            : '<rect x="0" y="0" width="' + fmt(bw) + '" height="' + fmt(bh) +
              '" fill="none" stroke="' + swShColor + '" stroke-width="' + fmt(swSgw) + '"/>';
          if (String(style.swimlaneLine) !== '0') {
            swShParts += '<path d="' + (swH
              ? 'M 0 ' + fmt(swShDiv) + ' L ' + fmt(bw) + ' ' + fmt(swShDiv)
              : 'M ' + fmt(swShDiv) + ' 0 L ' + fmt(swShDiv) + ' ' + fmt(bh)) +
              '" stroke="' + swShColor + '" stroke-width="' + fmt(swSgw) + '" fill="none"/>';
          }
          paint.push(paddedSvgShapeNode('<g opacity="' + fmt(swSp.alpha) + '">' +
            swShParts + '</g>', { x: bx + swSp.dx, y: by + swSp.dy, w: bw, h: bh }, style));
        }
        var swStart = paint.length;
        // header fill (faithful gradient when gradientColor is set)
        if (swFill) {
          // Gradient headers come back as kind:'svg' (skipped by the path-flip
          // loop below) so their box is pre-flipped here; solid headers come
          // back as kind:'path' and are flipped by the loop like the rest.
          var swHB0 = swH ? { x: bx, y: by, w: bw, h: swSz }
                          : { x: bx, y: by, w: swSz, h: bh };
          var swHB = isPaintable(style.gradientColor) ? swFlipBox(swHB0) : swHB0;
          // mirroring also mirrors the gradient axis
          var swGD = style.gradientDirection;
          if (swFH && (swGD === 'east' || swGD === 'west')) swGD = swGD === 'east' ? 'west' : 'east';
          if (swFV && (swGD == null || swGD === 'south' || swGD === 'north')) {
            swGD = (swGD === 'north') ? 'south' : 'north';
          }
          var swHN = regionFillNode(swGD === style.gradientDirection ? style
            : Object.assign({}, style, { gradientDirection: swGD }), swHB);
          if (swHN) paint.push(swHN);
        }
        // body fill (swimlaneFillColor; default none = transparent)
        if (swLane) {
          paint.push({ kind: 'path', fill: swLane, stroke: null,
            d: swH ? rectPath(bx, by + swSz, bw, bh - swSz)
                   : rectPath(bx + swSz, by, bw - swSz, bh) });
        }
        // Border: drawio strokes the header on 3 sides (gated swimlaneHead) and
        // the body on 3 sides (gated swimlaneBody); together they form the outer
        // box. Rounded swimlanes use a single rounded outer border.
        if (swStroke) {
          if (swR > 0) {
            paint.push({ kind: 'path', fill: null, stroke: swStroke,
              d: roundedRectPath(bx, by, bw, bh, swR) });
          } else {
            if (swHead) {
              paint.push({ kind: 'path', fill: null, stroke: swStroke,
                d: swH ? 'M ' + p(bx, by + swSz) + ' L ' + p(bx, by) + ' L ' + p(bx + bw, by) + ' L ' + p(bx + bw, by + swSz)
                       : 'M ' + p(bx + swSz, by) + ' L ' + p(bx, by) + ' L ' + p(bx, by + bh) + ' L ' + p(bx + swSz, by + bh) });
            }
            if (swBody) {
              paint.push({ kind: 'path', fill: null, stroke: swStroke,
                d: swH ? 'M ' + p(bx, by + swSz) + ' L ' + p(bx, by + bh) + ' L ' + p(bx + bw, by + bh) + ' L ' + p(bx + bw, by + swSz)
                       : 'M ' + p(bx + swSz, by) + ' L ' + p(bx + bw, by) + ' L ' + p(bx + bw, by + bh) + ' L ' + p(bx + swSz, by + bh) });
            }
          }
        }
        // Divider line between header and body (drawio mxSwimlane.paintDivider):
        // drawn in the STROKE colour, solid, gated on swimlaneLine (default on).
        if (String(style.swimlaneLine) !== '0' && swStroke) {
          paint.push({ kind: 'path', fill: null, stroke: swStroke,
            d: swH ? ('M ' + p(bx, by + swSz) + ' L ' + p(bx + bw, by + swSz))
                   : ('M ' + p(bx + swSz, by) + ' L ' + p(bx + swSz, by + bh)) });
        }
        // Separator (drawio mxSwimlane.paintSeparator): a SEPARATE dashed line in
        // separatorColor at the far edge of the body, only when set. The divider
        // bug previously used separatorColor for the divider and dropped this.
        if (isPaintable(style.separatorColor)) {
          var sepStroke = {
            paint: solid(style.separatorColor, opacity(style, 'strokeOpacity')),
            width: Math.max(0.1, number(style.strokeWidth, 1)),
            cap: 'butt', join: 'miter', miterLimit: 10,
            dash: dashPattern({ dashPattern: '3 3', strokeWidth: style.strokeWidth, fixDash: style.fixDash })
          };
          paint.push({ kind: 'path', fill: null, stroke: sepStroke,
            d: swH ? ('M ' + p(bx + bw, by + swSz) + ' L ' + p(bx + bw, by + bh))
                   : ('M ' + p(bx + swSz, by) + ' L ' + p(bx + bw, by)) });
        }
        // Mirror the geometry path nodes about the box centre for flipH/flipV.
        // (The header-fill svg node was already emitted at its flipped box.)
        if (swFH || swFV) {
          for (var swI = swStart; swI < paint.length; swI++) {
            if (paint[swI].kind === 'path') {
              paint[swI].d = flipPathD(paint[swI].d, bx + bw / 2, by + bh / 2, swFH, swFV);
            }
          }
        }
        // Glass highlight over the HEADER region only (mxSwimlane.paintVertexShape
        // -> paintGlassEffect(c, 0, 0, w, start, r), mxSwimlane.js:267-270).
        // Previously dropped silently (the table subclass painted it; this branch
        // did not).
        if (boolish(style.glass) && isPaintable(style.fillColor)) {
          var swGB = swFlipBox(swH ? { x: bx, y: by, w: bw, h: swSz }
                                    : { x: bx, y: by, w: swSz, h: bh });
          paint.push(paddedSvgShapeNode(glassOverlaySvg(style, swGB.w, swGB.h),
            swGB, style));
        }
        if (label !== '') {
          var swLB = swFlipBox(swH ? { x: bx, y: by, w: bw, h: swSz }
                                    : { x: bx, y: by, w: swSz, h: bh });
          labelNodes(graph, cell, state, style, swLB, label, notices, resolved)
            .forEach(function (n) { paint.push(n); });
        }
        return;
      }

      // flipH/flipV mirror the shape geometry; direction (N/S/E/W) rotates it
      // like drawio's getShapeRotation() (+90 south, +180 west, +270 north),
      // with the paint bounds inverted for N/S (mxShape.isPaintBoundsInverted).
      // The label stays upright (drawio flips/direction-rotates the SHAPE only).
      // outlinePath builds the fully-transformed outline for a given cell box,
      // matching c.rotate(getShapeRotation, flipH, flipV, cx, cy): draw in the
      // (inverted) paint bounds, mirror, then rotate — all about the centre.
      // stencilFlipH/V only apply when a stencil exists (mxShape.js:1410-1415);
      // this is the non-stencil path, so they are ignored like drawio does.
      var flipH_ = boolish(style.flipH);
      var flipV_ = boolish(style.flipV);
      var dir = String(style.direction || 'east').toLowerCase();
      var dirDeg = dir === 'south' ? 90 : dir === 'west' ? 180 : dir === 'north' ? 270 : 0;
      var dirInv = (dir === 'north' || dir === 'south');
      function outlinePath(ox, oy, w, h) {
        var ccx = ox + w / 2, ccy = oy + h / 2;
        var pw = dirInv ? h : w, ph = dirInv ? w : h;
        var pd = shapePath(style, ccx - pw / 2, ccy - ph / 2, pw, ph);
        if (!pd) return null;
        // Replicate mxShape.updateTransform (flipH/flipV are SWAPPED for N/S —
        // mxShape.js:1417) + mxSvgCanvas2D.rotate's composition
        // (mxSvgCanvas2D.js:1342-1366): both flips => theta+180 & no mirror;
        // a single-axis flip => append the mirror AND negate theta. The
        // transform list is "mirror rotate(theta)", so a point is rotated FIRST
        // then mirrored. (Reduces to the old flip-then-rotate for flip-only,
        // direction-only, both-flips, and E/W; only N/S + one-axis flip differs.)
        var fH = flipH_, fV = flipV_;
        if (dirInv) { var ft = fH; fH = fV; fV = ft; }
        var theta = dirDeg;
        if (fH && fV) { theta = (theta + 180) % 360; fH = false; fV = false; }
        else if (fH !== fV) { theta = (360 - theta) % 360; }
        if (theta) pd = rotatePathD(pd, ccx, ccy, theta);
        if (fH || fV) pd = flipPathD(pd, ccx, ccy, fH, fV);
        return pd;
      }
      var d = outlinePath(box.x, box.y, box.w, box.h);
      if (!d) {
        d = rectPath(box.x, box.y, box.w, box.h);
        notices.push(degradation('ExporterUnsupportedShape',
          'Unsupported shape "' + style.shape + '" exported as bounding box.', cell.id));
      }

      // Rotated shape: construct a kind:'svg' node so both the shape
      // outline AND the label rotate together around the cell centre. This is
      // WYSIWYG.
      // The SVG viewport is expanded to the axis-aligned bounding box of the
      // rotated rectangle so strokes near the corners are not clipped.
      var rotDeg = number(style.rotation, 0);
      if (rotDeg) {
        var theta = rotDeg * Math.PI / 180;
        var cosT = Math.abs(Math.cos(theta));
        var sinT = Math.abs(Math.sin(theta));
        var expW = box.w * cosT + box.h * sinT;
        var expH = box.w * sinT + box.h * cosT;
        // Shape offset inside the expanded SVG viewport
        var offX = (expW - box.w) / 2;
        var offY = (expH - box.h) / 2;
        // Rotation centre = midpoint of expanded viewport
        var rcx = expW / 2;
        var rcy = expH / 2;
        // outlinePath bakes flip + direction into the path; the outer rotate()
        // below adds the style rotation. The label is rotated by the style
        // rotation only (direction/flip never rotate the label).
        var relD = outlinePath(offX, offY, box.w, box.h) ||
                   rectPath(offX, offY, box.w, box.h);
        // Linear gradient defs (left-to-right in rotated frame; more accurate
        // than the path fallback since direction rotates with the shape).
        var defs = '';
        var gradId = '';
        if (isPaintable(style.gradientColor)) {
          gradId = 'g' + String(cell.id || '').replace(/[^a-z0-9]/gi, '');
          defs = '<defs>' + linearGradDef(gradId, hex(style.fillColor), hex(style.gradientColor), rotateGradDir(style.gradientDirection, dirDeg)) + '</defs>';
        }
        var pathEl = '<path d="' + relD + '"' +
          fillSvgAttr(style, gradId) + strokeSvgAttrs(style) + '/>';
        // Shadow under the shape: the rotated silhouette, offset by (dx,dy) in
        // SCREEN space (translate OUTSIDE the rotate, applied last), at the
        // shadow alpha. The non-rotated path emits this separately; the rotated
        // early-return skipped it, dropping shadows on rotated shapes silently.
        var rotShadowEl = '';
        if (boolish(style.shadow)) {
          var rsp = shadowParams(style);
          var rShFill = isPaintable(style.fillColor) ? hex(rsp.color) : 'none';
          var rShStroke = isPaintable(style.strokeColor) ? hex(rsp.color) : 'none';
          var rShSw = Math.max(0.1, number(style.strokeWidth, 1));
          rotShadowEl = '<g opacity="' + fmt(rsp.alpha) + '" transform="translate(' +
            fmt(rsp.dx) + ' ' + fmt(rsp.dy) + ')"><g transform="rotate(' + fmt(rotDeg) +
            ' ' + fmt(rcx) + ' ' + fmt(rcy) + ')"><path d="' + relD + '" fill="' + rShFill +
            '" stroke="' + rShStroke + '"' +
            (rShStroke !== 'none' ? ' stroke-width="' + fmt(rShSw) + '"' : '') +
            '/></g></g>';
        }
        // Glass highlight over the shape (rotates with it), for the same family
        // the non-rotated path glasses (rect/label, ellipse, rhombus). Skipped
        // by the rotated early-return before — silently dropped.
        var rotGlassEl = '';
        var rGlassShape = style.shape;
        var rGlassRectFamily = !rGlassShape || rGlassShape === 'rectangle' || rGlassShape === 'label';
        var rGlassOk = rGlassRectFamily || rGlassShape === 'ellipse' ||
          rGlassShape === 'rhombus' || rGlassShape === 'diamond';
        if (boolish(style.glass) && rGlassOk && isPaintable(style.fillColor)) {
          rotGlassEl = '<g transform="translate(' + fmt(offX) + ' ' + fmt(offY) + ')">' +
            glassOverlaySvg(style, box.w, box.h, rGlassRectFamily ? undefined : rGlassShape) +
            '</g>';
        }
        var textEl = rotatedLabelEls(graph, cell, style, offX, offY, box.w, box.h, label, notices, resolved);
        var inner = rotShadowEl +
          '<g transform="rotate(' + fmt(rotDeg) + ' ' + fmt(rcx) + ' ' + fmt(rcy) + ')">' +
          pathEl + rotGlassEl + textEl + '</g>';
        var svgStr = '<svg xmlns="http://www.w3.org/2000/svg" ' +
          'width="' + fmt(expW) + '" height="' + fmt(expH) + '">' +
          defs + inner + '</svg>';
        var svgCx = box.x + box.w / 2;
        var svgCy = box.y + box.h / 2;
        paint.push({
          kind: 'svg',
          box: { x: svgCx - expW / 2, y: svgCy - expH / 2, w: expW, h: expH },
          source: base64(svgStr),
          aspect: 'preserve'
        });
        return;  // label is embedded in the SVG; no separate text node needed
      }

      if (boolish(style.shadow)) {
        var gsp = shadowParams(style);
        paint.push({
          kind: 'path',
          d: outlinePath(box.x + gsp.dx, box.y + gsp.dy, box.w, box.h) ||
             rectPath(box.x + gsp.dx, box.y + gsp.dy, box.w, box.h),
          fill: solid(gsp.color, gsp.alpha),
          stroke: null
        });
      }

      // Sketch fills (hachure/cross-hatch/dots): emit as kind:'svg' with an inline
      // hatch/dot pattern so the texture is preserved rather than silently collapsed
      // to solid fill.
      if (boolish(style.sketch) && isPaintable(style.fillColor)) {
        var skFs = style.fillStyle || 'hachure';
        if (skFs === 'hachure' || skFs === 'cross-hatch' || skFs === 'dots') {
          var skRelD = outlinePath(0, 0, box.w, box.h) || rectPath(0, 0, box.w, box.h);
          paint.push(paddedSvgShapeNode(sketchFillSvg(style, skRelD, box.w, box.h),
            { x: box.x, y: box.y, w: box.w, h: box.h }, style));
        } else {
          paint.push({ kind: 'path', d: d, fill: fillOf(style), stroke: strokeOf(style) });
        }
      // Gradient cells must carry direction inline (v1 contract has no direction
      // field in the structural fill object). Emit kind:'svg' with an embedded linearGradient
      // so the C++ engine renders the correct direction via resvg.
      } else if (isPaintable(style.gradientColor)) {
        var ggid = 'g' + String(cell.id || '').replace(/[^a-z0-9]/gi, '');
        var gdefs = '<defs>' + linearGradDef(ggid, hex(style.fillColor),
          hex(style.gradientColor), rotateGradDir(style.gradientDirection, dirDeg)) + '</defs>';
        var relD = outlinePath(0, 0, box.w, box.h) || rectPath(0, 0, box.w, box.h);
        var gInner = gdefs + '<path d="' + relD + '"' + fillSvgAttr(style, ggid) + strokeSvgAttrs(style) + '/>';
        paint.push(paddedSvgShapeNode(gInner, { x: box.x, y: box.y, w: box.w, h: box.h }, style));
      } else {
        paint.push({
          kind: 'path',
          d: d,
          fill: fillOf(style),
          stroke: strokeOf(style)
        });
      }
      // Glass highlight overlay (drawio glass=1), painted over the shape body.
      // drawio paints glass ONLY for shapes whose paintVertexShape/paintForeground
      // calls paintGlassEffect: the mxRectangleShape family (plain rectangle here),
      // mxEllipse, and mxRhombus (Shapes.js:2184/2115). Every other generic-path
      // shape (triangle/hexagon/cloud/cylinder/actor/card/step/…) never glasses,
      // so emitting it there would be a silent over-render. ellipse/rhombus use
      // their silhouette-matching glass path.
      // mxRectangleShape family (rectangle + the default 'label' shape, which
      // extends it) glasses rectangular; mxEllipse/mxRhombus glass with their
      // own silhouette. No other generic-path shape calls paintGlassEffect.
      var glassShape = style.shape;
      var glassRectFamily = !glassShape || glassShape === 'rectangle' || glassShape === 'label';
      var glassOk = glassRectFamily ||
        glassShape === 'ellipse' || glassShape === 'rhombus' || glassShape === 'diamond';
      if (glassRectFamily) glassShape = undefined; // rectangular glass path
      if (boolish(style.glass) && glassOk && isPaintable(style.fillColor)) {
        paint.push(paddedSvgShapeNode(glassOverlaySvg(style, box.w, box.h, glassShape),
          { x: box.x, y: box.y, w: box.w, h: box.h }, { strokeColor: 'none' }));
      }
    }

    // Swimlane labels live in the header area only (mxSwimlane.getLabelBounds).
    // Constrain the label box to avoid centering over the whole swimlane height.
    var swimLabelBx = box;
    if (style.shape === 'swimlane') {
      var swimIsH = String(style.horizontal) !== '0';
      var swimSz = Math.min(Math.max(0, number(style.startSize, 40)), swimIsH ? box.h : box.w);
      swimLabelBx = swimIsH
        ? { x: box.x, y: box.y, w: box.w, h: swimSz }
        : { x: box.x, y: box.y, w: swimSz, h: box.h };
    } else if (style.shape === 'table') {
      var tableHeader = Math.min(Math.max(0, number(style.startSize, 40)), box.h);
      if (tableHeader > 0) swimLabelBx = { x: box.x, y: box.y, w: box.w, h: tableHeader };
    } else {
      // labelPosition / verticalLabelPosition place the label OUTSIDE the shape
      // (drawio). The plain-shape path previously ignored them, painting the
      // label over the shape — a silent positional divergence. (Stencils/icons
      // handle this on their own paths.)
      var extLB = externalLabelBox(style, box);
      // Internal label: inset per the shape's getLabelMargins/getLabelBounds
      // (datastore disk stack, callout tail recess, process bars, cylinder/
      // note2/document/manualInput/folder bands). External labels are unaffected.
      swimLabelBx = (extLB === box) ? applyLabelMargins(box, style) : extLB;
    }
    if (label !== '') {
      labelNodes(graph, cell, state, style, swimLabelBx, label, notices, resolved)
        .forEach(function (n) { paint.push(n); });
    }
  }

  // Headless path for mxgraph.arrows2.wedgeArrowDashed2 edges.
  // Transcribed from mxShapeArrowsWedgeArrowDashed2.prototype.paintEdgeShape (mxArrows.js).
  // Returns a multi-subpath SVG `d` string (stroke-only), or null if degenerate.
  function wedgeArrowDashed2Path(style, points) {
    var startWidth = Math.max(0, number(style.startWidth, 20));
    var stepSize = Math.max(0, number(style.stepSize, 10));
    var p0 = points[0], pe = points[points.length - 1];
    var dx = pe.x - p0.x, dy = pe.y - p0.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist === 0 || stepSize === 0) return null;
    var nx = dx * startWidth / dist, ny = dy * startWidth / dist;
    var steps = Math.floor(dist / stepSize);
    if (steps === 0) return null;
    var pcx = p0.x, pcy = p0.y;
    var parts = [];
    for (var i = 0; i <= steps; i++) {
      var cnx, cny;
      if (i === steps) {
        cnx = nx * (steps - i * 0.98) / steps;
        cny = ny * (steps - i * 0.98) / steps;
      } else {
        cnx = nx * (steps - i) / steps;
        cny = ny * (steps - i) / steps;
      }
      parts.push('M ' + p(pcx + cny, pcy - cnx) + ' L ' + p(pcx - cny, pcy + cnx));
      pcx += dx / steps; pcy += dy / steps;
    }
    return parts.join(' ');
  }

  // Headless path for flexArrow edges (FlexArrowShape extending mxArrowConnector).
  // Transcribed from mxArrowConnector.prototype.paintEdgeShape + paintMarker (mxArrowConnector.js)
  // and FlexArrowShape (Shapes.js). Returns a closed SVG `d` string, or null if degenerate.
  function flexArrowPath(style, points) {
    var sw = Math.max(1, number(style.strokeWidth, 1));
    // FlexArrowShape widths (Shapes.js)
    var edgeWidth = number(style.width, 10) + Math.max(0, sw - 1);
    var startAW = (edgeWidth + number(style.startWidth, 20)) + sw; // +sw from paintEdgeShape
    var endAW = (edgeWidth + number(style.endWidth, 20)) + sw;
    // startSize/endSize: mxArrowConnector.prototype.apply → ARROW_SIZE/5 * 3 = 18
    var startSz = number(style.startSize, 6) * 3 + sw;
    var endSz = number(style.endSize, 6) * 3 + sw;
    var spacing = sw / 2; // arrowSpacing(0) + strokeWidth/2
    var mrkStart = style.startArrow && style.startArrow !== 'none';
    var mrkEnd = style.endArrow && style.endArrow !== 'none';
    var pts = points;
    var pe = pts[pts.length - 1];
    var dx = pts[1].x - pts[0].x, dy = pts[1].y - pts[0].y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist === 0) return null;
    var nx = dx / dist, ny = dy / dist;
    var nx1 = nx, ny1 = ny;

    var pathCmds = [], fnCmds = [];

    function paintMarker(ptX, ptY, pnx, pny, size, arrowW, edgeW, sp, isFirst) {
      var wAR = edgeW / arrowW;
      var ox = edgeW * pny / 2, oy = -edgeW * pnx / 2;
      var sX = (sp + size) * pnx, sY = (sp + size) * pny;
      pathCmds.push((isFirst ? 'M' : 'L') + ' ' + p(ptX - ox + sX, ptY - oy + sY));
      pathCmds.push('L ' + p(ptX - ox / wAR + sX, ptY - oy / wAR + sY));
      pathCmds.push('L ' + p(ptX + sp * pnx, ptY + sp * pny));
      pathCmds.push('L ' + p(ptX + ox / wAR + sX, ptY + oy / wAR + sY));
      pathCmds.push('L ' + p(ptX + ox + sX, ptY + oy + sY));
    }

    var orthx = edgeWidth * ny, orthy = -edgeWidth * nx;
    if (mrkStart) {
      paintMarker(pts[0].x, pts[0].y, nx, ny, startSz, startAW, edgeWidth, spacing, true);
    } else {
      pathCmds.push('M ' + p(pts[0].x - orthx / 2 + spacing * nx, pts[0].y - orthy / 2 + spacing * ny));
      pathCmds.push('L ' + p(pts[0].x + orthx / 2 + spacing * nx, pts[0].y + orthy / 2 + spacing * ny));
      fnCmds.push('L ' + p(pts[0].x - orthx / 2 + spacing * nx, pts[0].y - orthy / 2 + spacing * ny));
    }

    // mxUtils.relativeCcw (mxUtils.js:3694): which way the bend turns (-1/0/1).
    function relCcw(x1, y1, x2, y2, px, py) {
      x2 -= x1; y2 -= y1; px -= x1; py -= y1;
      var ccw = px * y2 - py * x2;
      if (ccw === 0) {
        ccw = px * x2 + py * y2;
        if (ccw > 0) { px -= x2; py -= y2; ccw = px * x2 + py * y2; if (ccw < 0) ccw = 0; }
      }
      return ccw < 0 ? -1 : (ccw > 0 ? 1 : 0);
    }
    var isRounded = boolish(style.rounded);
    // Waypoints (handles >2-point edges faithfully). Rounded bends are quad
    // curves (mxArrowConnector.js:245-303) — previously every bend was mitred,
    // a silent divergence on the SHIPPED default flexArrow (rounded=1).
    for (var i = 0; i < pts.length - 2; i++) {
      var pos = relCcw(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, pts[i + 2].x, pts[i + 2].y);
      var dx1 = pts[i + 2].x - pts[i + 1].x, dy1 = pts[i + 2].y - pts[i + 1].y;
      var dist1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
      if (dist1 !== 0) {
        nx1 = dx1 / dist1; ny1 = dy1 / dist1;
        var tmp1 = nx * nx1 + ny * ny1;
        var tmp = Math.max(Math.sqrt((tmp1 + 1) / 2), 0.04);
        var nx2 = (nx + nx1), ny2 = (ny + ny1);
        var dist2 = Math.sqrt(nx2 * nx2 + ny2 * ny2);
        if (dist2 !== 0) {
          nx2 /= dist2; ny2 /= dist2;
          // angleFactor: rounded non-straight bends use a stroke-width-aware
          // minimum (mxArrowConnector.js:244-245), else the mitre factor.
          var swF = Math.max(tmp, Math.min(sw / 200 + 0.04, 0.35));
          var aF = (pos !== 0 && isRounded) ? Math.max(0.1, swF) : Math.max(tmp, 0.06);
          var outX = pts[i + 1].x + ny2 * edgeWidth / 2 / aF;
          var outY = pts[i + 1].y - nx2 * edgeWidth / 2 / aF;
          var inX = pts[i + 1].x - ny2 * edgeWidth / 2 / aF;
          var inY = pts[i + 1].y + nx2 * edgeWidth / 2 / aF;
          if (pos === 0 || !isRounded) {
            pathCmds.push('L ' + p(outX, outY));
            (function (x, y) { fnCmds.push('L ' + p(x, y)); })(inX, inY);
          } else if (pos === -1) {
            // outer side curves; inner side is a straight join.
            pathCmds.push('L ' + p(inX + ny * edgeWidth, inY - nx * edgeWidth));
            pathCmds.push('Q ' + p(outX, outY) + ' ' + p(inX + ny1 * edgeWidth, inY - nx1 * edgeWidth));
            (function (x, y) { fnCmds.push('L ' + p(x, y)); })(inX, inY);
          } else {
            // inner side curves (replayed reversed): push quad THEN line so the
            // reversal yields lineTo(c2) then quadTo(control=in, c1).
            pathCmds.push('L ' + p(outX, outY));
            (function (x, y) {
              fnCmds.push('Q ' + p(x, y) + ' ' + p(outX - ny * edgeWidth, outY + nx * edgeWidth));
              fnCmds.push('L ' + p(outX - ny1 * edgeWidth, outY + nx1 * edgeWidth));
            })(inX, inY);
          }
          nx = nx1; ny = ny1;
        }
      }
    }

    orthx = edgeWidth * ny1; orthy = -edgeWidth * nx1;
    if (mrkEnd) {
      paintMarker(pe.x, pe.y, -nx, -ny, endSz, endAW, edgeWidth, spacing, false);
    } else {
      pathCmds.push('L ' + p(pe.x - spacing * nx1 + orthx / 2, pe.y - spacing * ny1 + orthy / 2));
      pathCmds.push('L ' + p(pe.x - spacing * nx1 - orthx / 2, pe.y - spacing * ny1 - orthy / 2));
    }

    for (var j = fnCmds.length - 1; j >= 0; j--) pathCmds.push(fnCmds[j]);
    pathCmds.push('Z');
    return pathCmds.join(' ');
  }

  function emitEdge(graph, cell, state, style, origin, scale, paint, notices, resolved) {
    // Native print re-derives the connector from its routed points (waypoints,
    // curved/orthogonal routing, arrowheads) below — there is no live-SVG path.
    var raw = state.absolutePoints || [];
    var points = [];
    for (var i = 0; i < raw.length; i++) {
      if (raw[i]) {
        var px = (raw[i].x - origin.x) / scale, py = (raw[i].y - origin.y) / scale;
        // Drop consecutive duplicate points. The headless parser can emit a
        // doubled source/target endpoint (e.g. [src,src,tgt,tgt]); a zero-length
        // final segment makes arrowPath() return null and the arrowhead is
        // silently dropped (WYSIWYG: drawio draws the classic arrow). Deduping
        // carries no geometry loss and restores correct arrow direction.
        var prev = points[points.length - 1];
        if (!prev || prev.x !== px || prev.y !== py) points.push({ x: px, y: py });
      }
    }
    if (points.length < 2) return;
    // Isometric edge routing (30deg isometric segments, mxEdgeStyle.Isometric-
    // Connector) is not replicated headless — the edge routes straight. Never
    // silent: emit a loud notice so the operator knows the route diverges.
    if (style.edgeStyle === 'isometricEdgeStyle' || style.edgeStyle === 'isometricVConnector') {
      notices.push(degradation('ExporterUnsupportedShape',
        'isometric edge routing not replicated — exported as a straight connector', cell.id));
    }
    // Line jumps (jumpStyle=arc/gap/sharp at edge crossings) are drawn by
    // the editor but not re-derived headless: the printed edges cross as
    // plain lines. Loud, never silent (C1).
    if (style.jumpStyle != null && String(style.jumpStyle) !== 'none') {
      notices.push(degradation('ExporterUnsupportedShape',
        'jumpStyle=' + style.jumpStyle + ' line jumps are not rendered — crossings print as plain lines', cell.id));
    }
    // perimeterSpacing now lives where mxGraph applies it: the headless
    // router (drawio-parser terminalPoint) GROWS the perimeter bounds
    // before intersecting, floating ends only. The old endpoint nudge here
    // double-spaced routed edges, mis-spaced diagonal approaches, and
    // wrongly spaced FIXED exitX/exitY anchors.
    var stroke = strokeOf(style) || strokeOf({ strokeColor: '#000000', strokeWidth: 1 });

    // JS-registered edge shapes: exact headless transcription from source.
    if (style.shape === 'mxgraph.arrows2.wedgeArrowDashed2') {
      var wd2 = wedgeArrowDashed2Path(style, points);
      if (wd2) {
        // mxShape.paint honors shadow=1 for the whole connector band; the band
        // is a filled/stroked path, so its shadow is an offset COPY of the same
        // path painted in the shadow colour (Graph.js #000000@0.25, offset 2,3),
        // drawn first. Was silently dropped (early return, no shadow, no notice).
        if (boolish(style.shadow)) {
          var wd2sp = shadowParams(style);
          var wd2Shadow = wedgeArrowDashed2Path(style, points.map(function (pt) {
            return { x: pt.x + wd2sp.dx, y: pt.y + wd2sp.dy };
          }));
          if (wd2Shadow) {
            paint.push({ kind: 'path', d: wd2Shadow,
              fill: solid(wd2sp.color, wd2sp.alpha),
              stroke: { paint: solid(wd2sp.color, wd2sp.alpha), width: stroke.width,
                cap: stroke.cap, join: stroke.join, miterLimit: stroke.miterLimit } });
          }
        }
        paint.push({ kind: 'path', d: wd2, fill: null, stroke: stroke });
        var wd2Label = plainLabel(graph, cell);
        if (wd2Label !== '') {
          var wd2Box = edgeLabelBox(state, style, origin, scale, wd2Label);
          labelNodes(graph, cell, state, style, wd2Box, wd2Label, notices, resolved)
            .forEach(function (n) { paint.push(n); });
        }
        return;
      }
    }
    if (style.shape === 'flexArrow') {
      var fap = flexArrowPath(style, points);
      if (fap) {
        // shadow=1: offset filled copy of the arrow band, painted first
        // (mxShape.paint isShadow). Was silently dropped on early return.
        if (boolish(style.shadow)) {
          var fasp = shadowParams(style);
          var faShadow = flexArrowPath(style, points.map(function (pt) {
            return { x: pt.x + fasp.dx, y: pt.y + fasp.dy };
          }));
          if (faShadow) {
            paint.push({ kind: 'path', d: faShadow,
              fill: solid(fasp.color, fasp.alpha),
              stroke: { paint: solid(fasp.color, fasp.alpha), width: stroke.width,
                cap: stroke.cap, join: stroke.join, miterLimit: stroke.miterLimit } });
          }
        }
        paint.push({ kind: 'path', d: fap, fill: fillOf(style), stroke: stroke });
        var faLabel = plainLabel(graph, cell);
        if (faLabel !== '') {
          var faBox = edgeLabelBox(state, style, origin, scale, faLabel);
          labelNodes(graph, cell, state, style, faBox, faLabel, notices, resolved)
            .forEach(function (n) { paint.push(n); });
        }
        return;
      }
    }

    if (style.shape && style.shape !== 'connector') {
      notices.push(degradation('ExporterUnsupportedShape',
        'Custom edge shape "' + style.shape + '" exported as straight-line fallback.', cell.id));
    }
    var arrowFill = stroke.paint || solid('#000000', 1);
    // Marker size is the per-end endSize/startSize style value (mxConnector.js
    // :107-108), default mxConstants.DEFAULT_MARKERSIZE = 6 — the drawn marker
    // length is then (size + strokeWidth) inside edgeMarkerNode (mxMarker.js).
    // Was a strokeWidth-derived heuristic (max(7, sw*5)).
    var endSize = number(style.endSize, 6);
    var startSize = number(style.startSize, 6);
    // drawio endFill/startFill default to filled (1); '0' => hollow outline.
    var endFilled = String(style.endFill) !== '0';
    var startFilled = String(style.startFill) !== '0';
    // drawio fills each marker with end/startFillColor (default = the edge
    // stroke). Previously the arrowhead always used the stroke colour, so a
    // differently-coloured arrowhead printed in the wrong colour.
    var endArrowFill = isPaintable(style.endFillColor)
      ? solid(style.endFillColor, opacity(style, 'strokeOpacity')) : arrowFill;
    var startArrowFill = isPaintable(style.startFillColor)
      ? solid(style.startFillColor, opacity(style, 'strokeOpacity')) : arrowFill;
    // Markers are computed BEFORE the line because the mxMarker factories
    // recede the endpoint (pe) — the polyline must stop behind the marker,
    // not bisect it (visible on endFill=0 hollow markers).
    var endRes = null, startRes = null;
    if (style.endArrow && style.endArrow !== 'none') {
      endRes = edgeMarkerNode(style.endArrow, points[points.length - 2],
        points[points.length - 1], endSize, stroke, endArrowFill, cell.id,
        notices, endFilled, false);
    }
    if (style.startArrow && style.startArrow !== 'none') {
      startRes = edgeMarkerNode(style.startArrow, points[1], points[0],
        startSize, stroke, startArrowFill, cell.id, notices, startFilled, true);
    }
    var linePts = points.slice();
    if (startRes && startRes.pe) linePts[0] = startRes.pe;
    if (endRes && endRes.pe) linePts[linePts.length - 1] = endRes.pe;
    var lineD = edgePath(linePts, boolish(style.rounded), boolish(style.curved),
      number(style.arcSize, 20) / 2, boolish(style.bezier));
    if (boolish(style.shadow) && stroke) {
      // mxConnector.paintEdgeShape: the LINE paints with the shadow, the
      // markers explicitly without (c.setShadow(false) before them).
      // shadow=1 edges previously printed with no shadow and no notice.
      var esp = shadowParams(style);
      var eShadowPts = linePts.map(function (pt) {
        return { x: pt.x + esp.dx, y: pt.y + esp.dy };
      });
      paint.push({
        kind: 'path',
        d: edgePath(eShadowPts, boolish(style.rounded), boolish(style.curved),
          number(style.arcSize, 20) / 2, boolish(style.bezier)),
        fill: null,
        stroke: {
          paint: solid(esp.color, esp.alpha),
          width: stroke.width, cap: stroke.cap, join: stroke.join,
          miterLimit: stroke.miterLimit, dash: stroke.dash
        }
      });
    }
    paint.push({
      kind: 'path',
      d: lineD,
      fill: null,
      stroke: stroke
    });
    // drawio paints the source marker first, then the target marker, both
    // after the line (mxConnector.paintEdgeShape).
    if (startRes) startRes.nodes.forEach(function (n) { if (n) paint.push(n); });
    if (endRes) endRes.nodes.forEach(function (n) { if (n) paint.push(n); });

    var label = plainLabel(graph, cell);
    if (label !== '') {
      var elBox = edgeLabelBox(state, style, origin, scale, label);
      labelNodes(graph, cell, state, style, elBox, label, notices, resolved)
        .forEach(function (n) { paint.push(n); });
    }
  }

  function buildContract(graph) {
    return buildResult(graph).contract;
  }

  var api = { buildContract: buildContract, buildResult: buildResult,
    noticeSeverity: noticeSeverity, embedExternalImages: embedExternalImages,
    _embedImageHrefs: embedImageHrefs,
    // Revision marker so it is trivial to confirm in the browser console which
    // build of this file is actually loaded: run `NativePrintExporter.__rev`.
    __rev: 'rich-text-headless-2026-06-03',
    registerStencils: function(registry) { _stencilRegistry = registry; } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.NativePrintExporter = api;
})(typeof window !== 'undefined' ? window : globalThis);
