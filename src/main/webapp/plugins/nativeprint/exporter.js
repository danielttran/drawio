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
    if (!deg) return gd;
    var ang = { east: 0, south: 90, west: 180, north: 270 };
    var inv = { 0: 'east', 90: 'south', 180: 'west', 270: 'north' };
    var base = ang[String(gd || 'south').toLowerCase()];
    if (base == null) return gd;
    return inv[((base + deg) % 360 + 360) % 360];
  }

  // Build a <linearGradient> definition string with correct direction.
  function linearGradDef(id, c1, c2, dir) {
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
  function stencilToSvg(shapeNode, cellW, cellH, style, notices, resolved) {
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

    // Step 3: Compute initial stroke width
    var sw_px;
    if (!stencilStrokeWidthAttr || stencilStrokeWidthAttr === 'inherit') {
      sw_px = number(style.strokeWidth, 1);
    } else {
      sw_px = parseFloat(stencilStrokeWidthAttr) * su;
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
      fontColor: style.fontColor || '#000000',
      fontSize: number(style.fontSize, 11),
      fontFamily: style.fontFamily || 'Arial',
      fontStyle: number(style.fontStyle, 0)
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

    // Gradient support: if gradientColor is paintable, we'll emit a linearGradient
    var gradId = null;
    var gradDef = '';
    if (isPaintable(state.fillColor) && isPaintable(style.gradientColor)) {
      gradId = stableGradId(state.fillColor, style.gradientColor);
      gradDef = linearGradDef(gradId, hex(state.fillColor), hex(style.gradientColor), style.gradientDirection);
    }

    // Helper: fill SVG attr using current state
    function stateFillAttr() {
      if (!isPaintable(state.fillColor)) return ' fill="none"';
      if (gradId) return ' fill="url(#' + gradId + ')"';
      var c = hex(state.fillColor);
      var a = state.alpha;
      return ' fill="' + c + '"' + (a < 1 ? ' fill-opacity="' + fmt(a) + '"' : '');
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
      if (state.alpha < 1) s += ' stroke-opacity="' + fmt(state.alpha) + '"';
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
    function walkPath(pathNode) {
      // Bezier corner-rounding for <path rounded="1">.
      // Algorithm mirrors mxShape.prototype.addPoints(): quadratic Bezier at each corner.
      if (pathNode.attrs.rounded === '1') {
        var arcSizePx = (parseFloat(pathNode.attrs.arcsize) || 10) * su;
        var rpts = [], rclosed = false;
        for (var rci = 0; rci < pathNode.children.length; rci++) {
          var rcc = pathNode.children[rci];
          if (rcc.name === 'move' || rcc.name === 'line') {
            rpts.push({ x: tx(parseFloat(rcc.attrs.x) || 0), y: ty(parseFloat(rcc.attrs.y) || 0) });
          } else if (rcc.name === 'close') {
            rclosed = true;
          } else {
            rpts = null; break; // curve/arc/quad present — fall through to regular parse
          }
        }
        if (rpts && rpts.length >= 2) {
          var rn = rpts.length;
          function rpt(ri) { return rclosed ? rpts[((ri % rn) + rn) % rn] : rpts[Math.max(0, Math.min(rn - 1, ri))]; }
          var rp = ['M ' + fmt(rpts[0].x) + ' ' + fmt(rpts[0].y)];
          for (var rj = (rclosed ? 0 : 1); rj < (rclosed ? rn : rn - 1); rj++) {
            var rv = rpt(rj - 1), rc = rpt(rj), rne = rpt(rj + 1);
            var dpx = rv.x - rc.x, dpy = rv.y - rc.y;
            var dnx = rne.x - rc.x, dny = rne.y - rc.y;
            var dp = Math.sqrt(dpx * dpx + dpy * dpy) || 1;
            var dn = Math.sqrt(dnx * dnx + dny * dny) || 1;
            var r = Math.min(arcSizePx, dp / 2, dn / 2);
            rp.push('L ' + fmt(rc.x + dpx / dp * r) + ' ' + fmt(rc.y + dpy / dp * r) +
              ' Q ' + fmt(rc.x) + ' ' + fmt(rc.y) +
              ' ' + fmt(rc.x + dnx / dn * r) + ' ' + fmt(rc.y + dny / dn * r));
          }
          if (!rclosed) rp.push('L ' + fmt(rpts[rn - 1].x) + ' ' + fmt(rpts[rn - 1].y));
          if (rclosed)  rp.push('Z');
          return rp.join(' ');
        }
        // Mixed path (curve/arc/quad with rounded="1") — fall through to regular parse.
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
              fontStyle: state.fontStyle
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
              // Recompute gradient if fill color changed
              if (isPaintable(state.fillColor) && isPaintable(style.gradientColor) && !gradId) {
                gradId = stableGradId(state.fillColor, style.gradientColor);
                gradDef = linearGradDef(gradId, hex(state.fillColor), hex(style.gradientColor), style.gradientDirection);
              }
            }
            break;
          case 'strokecolor':
            state.strokeColor = resolveStencilColor(a.color, a.default, state.strokeColor);
            break;
          case 'fillcolor':
            state.fillColor = resolveStencilColor(a.color, a.default, state.fillColor);
            // Update gradient if fill changed
            if (isPaintable(state.fillColor) && isPaintable(style.gradientColor)) {
              gradId = stableGradId(state.fillColor, style.gradientColor);
              gradDef = linearGradDef(gradId, hex(state.fillColor), hex(style.gradientColor), style.gradientDirection);
            }
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
            state.dashPattern = a.pattern;
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
          case 'strokealpha':
            // Both fill/stroke alpha map to global alpha in mxGraph stencil engine
            state.alpha = clamp01(parseFloat(a.alpha) || 1);
            break;
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
              var imgPar = a.aspect === 'fixed' ? 'xMidYMid meet' : 'none';
              elems.push('<image href="' + embeddedImgSrc + '"' +
                ' x="' + fmt(tx(parseFloat(a.x) || 0)) + '"' +
                ' y="' + fmt(ty(parseFloat(a.y) || 0)) + '"' +
                ' width="' + fmt(trx(parseFloat(a.w) || 0)) + '"' +
                ' height="' + fmt(try_(parseFloat(a.h) || 0)) + '"' +
                ' preserveAspectRatio="' + imgPar + '"/>');
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
            // stencilToSvg() creates fresh state/elems — parent state is never mutated.
            var isSvg = stencilToSvg(isNode, isW * sw, isH * sh, style, notices, resolved);
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
              var tAnchor = a.align === 'left' ? 'start' : a.align === 'right' ? 'end' : 'middle';
              var tBase = a.valign === 'top' ? 'hanging' : a.valign === 'bottom' ? 'auto' : 'central';
              var tFs = (parseFloat(a.fontsize) || state.fontSize || 11) * su;
              var tFf = a.fontfamily || state.fontFamily || 'Arial';
              var tFc = state.fontColor || '#000000';
              elems.push('<text x="' + fmt(ttx) + '" y="' + fmt(tty) + '"' +
                ' text-anchor="' + tAnchor + '" dominant-baseline="' + tBase + '"' +
                ' font-family="' + escXml(tFf) + '" font-size="' + fmt(tFs) + '"' +
                ' fill="' + tFc + '">' + escXml(tStr) + '</text>');
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

    // Step 12: Flip transforms — must use cw/ch (the dimension-swapped space the path was built in)
    var innerContent = elems.join('');
    if (boolish(style.flipH) || boolish(style.stencilFlipH)) {
      innerContent = '<g transform="scale(-1,1) translate(' + fmt(-cw) + ',0)">' + innerContent + '</g>';
    }
    if (boolish(style.flipV) || boolish(style.stencilFlipV)) {
      innerContent = '<g transform="scale(1,-1) translate(0,' + fmt(-ch) + ')">' + innerContent + '</g>';
    }

    // Step 3 (direction rotation): map the cw×ch path space onto the cellW×cellH display viewport.
    // For north/south: path was built in (cw=cellH, ch=cellW) space; rotate to fit (cellW×cellH).
    // translate(0,cellH)  rotate(-90) maps  [0..cw]×[0..ch] → [0..cellW]×[0..cellH]  (no clipping)
    // translate(cellW,0)  rotate(+90) maps  [0..cw]×[0..ch] → [0..cellW]×[0..cellH]  (no clipping)
    if (dir === 'north') {
      innerContent = '<g transform="translate(0,' + fmt(cellH) + ') rotate(-90)">' + innerContent + '</g>';
    } else if (dir === 'south') {
      innerContent = '<g transform="translate(' + fmt(cellW) + ',0) rotate(90)">' + innerContent + '</g>';
    } else if (dir === 'west') {
      var dcx3 = cellW / 2, dcy3 = cellH / 2;
      innerContent = '<g transform="rotate(180 ' + fmt(dcx3) + ' ' + fmt(dcy3) + ')">' + innerContent + '</g>';
    }

    // Step 13: Assemble final SVG
    var defsStr = gradDef ? '<defs>' + gradDef + '</defs>' : '';
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
      for (var bi = 0; bi < blocks.length; bi++) {
        var b = blocks[bi];
        var wrappedLines = wrapSvgText(b.text, b.size, availW, isWrap);
        for (var li = 0; li < wrappedLines.length; li++) {
          rows.push({
            text: wrappedLines[li],
            size: b.size,
            lineH: b.size * 1.22,
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
            if (textWidthPx(words[wi], bk.size) > availW) {
              return false;
            }
          }
        }
      } else {
        for (var rj = 0; rj < rows.length; rj++) {
          if (textWidthPx(rows[rj].text, rows[rj].size) > availW) {
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
    // In the browser, getCellStyle DELETES keys whose value is "none", so an
    // explicit strokeColor=none / fillColor=none would be re-forced to a theme
    // default below (e.g. a black border on a borderless note). Recover the
    // author's explicit "none" from the raw style string so it stays unpainted.
    // (Headless parser keeps "none", so graph.getModel().getStyle is absent and
    // this is a no-op there.)
    try {
      var rawStyleStr = (graph && graph.getModel && typeof graph.getModel().getStyle === 'function')
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
    // Supply drawio's stylesheet defaults when absent (styles/default.xml
    // defaultVertex: fillColor="default", strokeColor="default", fontColor="default";
    // defaultEdge: strokeColor="default", fontColor="default").
    // On the live path getCellStyle already merges these; on the headless path
    // getCellStyle returns only the raw cell style, so we fill them in.
    if (!('strokeColor' in out)) set('strokeColor', fg);
    if (!('fontColor' in out)) set('fontColor', fg);
    if (isVertex && !('fillColor' in out)) set('fillColor', bg);
    if (!isVertex && !('endArrow' in out)) set('endArrow', 'classic');
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
      var inner = '<defs>' + linearGradDef(gid, hex(style.fillColor),
        hex(style.gradientColor), style.gradientDirection) + '</defs>' +
        '<rect x="0" y="0" width="' + fmt(rbox.w) + '" height="' + fmt(rbox.h) +
        '" fill="url(#' + gid + ')"/>';
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
    if (isPaintable(style.gradientColor) && gradId) return ' fill="url(#' + gradId + ')"';
    var c = hex(style.fillColor);
    var a = opacity(style, 'fillOpacity');
    return ' fill="' + c + '"' + (a < 1 ? ' fill-opacity="' + fmt(a) + '"' : '');
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
    // Non-HTML labels are literal text: a '<' must not trigger rich HTML parsing.
    if (isHtmlLabelStyle(style) && String(src == null ? '' : src).indexOf('<') >= 0) {
      var rich = renderRichLabel(src, style, { w: w, h: h }, resolved, notices, cell && cell.id);
      if (!rich || rich.body === '') return '';
      var v = textDefaultValign(style);
      if (style.overflow === 'fill' || style.overflow === 'width') v = 'top';
      var rlpads = labelPads(style);
      var off = v === 'middle' ? (h - rich.height) / 2 : v === 'bottom' ? h - rich.height - rlpads.b : rlpads.t;
      off = Math.max(0, off);
      return '<g transform="translate(' + fmt(ox + rlpads.l) + ' ' + fmt(oy + off) + ')">' +
        rich.body + '</g>';
    }
    return label !== '' ? textSvgStr(label, ox + w / 2, oy + h / 2, style) : '';
  }

  function decodeHtmlEntities(s) {
    return String(s == null ? '' : s)
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&#(\d+);/g, function(_, n) { return String.fromCharCode(+n); })
      .replace(/&#x([0-9a-fA-F]+);/g, function(_, h) {
        return String.fromCharCode(parseInt(h, 16));
      });
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
    var lp = style && style.labelPosition;
    var vlp = style && style.verticalLabelPosition;
    var horiz = lp && lp !== 'center';
    var vert = vlp && vlp !== 'middle';
    if (!horiz && !vert) return box;
    var bx = box.x, by = box.y, bw = box.w, bh = box.h;
    if (vert) {
      var bandH = Math.max(16, number(style.fontSize, 12) * 1.5);
      if (vlp === 'bottom') { by = box.y + box.h; bh = bandH; }
      else if (vlp === 'top') { by = box.y - bandH; bh = bandH; }
    }
    if (horiz) {
      var sideW = Math.max(box.w, number(style.fontSize, 12) * 8);
      if (lp === 'right') { bx = box.x + box.w; bw = sideW; }
      else if (lp === 'left') { bx = box.x - sideW; bw = sideW; }
    }
    return { x: bx, y: by, w: bw, h: bh };
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
    if (plain || s.indexOf('<') < 0) {
      return String(s).split('\n').map(function (line) {
        return { text: line, size: Math.max(1, number(style.fontSize, 12)),
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
  function glyphEmWidth(ch) {
    if (ch === ' ') return 0.28;
    if ('iIl.,:;|!\'`'.indexOf(ch) >= 0) return 0.26;
    if ('jftr()[]{}/\\'.indexOf(ch) >= 0) return 0.33;
    if ('mMW'.indexOf(ch) >= 0) return 0.87;
    if (ch === 'w') return 0.72;
    if (ch >= 'A' && ch <= 'Z') return 0.70;
    if (ch >= '0' && ch <= '9') return 0.56;
    return 0.52; // typical lowercase / default
  }
  function textWidthPx(str, size) {
    var t = String(str == null ? '' : str), sum = 0;
    for (var i = 0; i < t.length; i++) sum += glyphEmWidth(t.charAt(i));
    return sum * size;
  }

  function wrapSvgText(text, size, width, wrap) {
    var rawLines = String(text == null ? '' : text).split('\n');
    if (!wrap) return rawLines;
    var maxW = Math.max(1, width);
    var lines = [];
    rawLines.forEach(function (raw) {
      var words = raw.split(/\s+/).filter(function (w) { return w !== ''; });
      if (!words.length) { lines.push(''); return; }
      var line = '';
      words.forEach(function (word) {
        if (!line) { line = word; return; }
        if (textWidthPx(line + ' ' + word, size) <= maxW) line += ' ' + word;
        else { lines.push(line); line = word; }
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

  var LIST_INDENT_PX = 24;   // left indent added per nested list level
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
      st.vshift = st.vshift + (tag === 'sup' ? -0.5 : 0.25) * st.size;
      st.size = st.size * 0.75;
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
      if (va === 'super') st.vshift += -0.5 * st.size;
      else if (va === 'sub') st.vshift += 0.25 * st.size;
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
  function headingPx(tag, baseSize) {
    var f = { h1: 2, h2: 1.5, h3: 1.17, h4: 1, h5: 0.83, h6: 0.67 };
    return Math.max(baseSize, baseSize * (f[tag] || 1));
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
    function process(node, st, align, indent, pre, listDepth) {
      var kids = node.childNodes || [];
      for (var i = 0; i < kids.length; i++) {
        var ch = kids[i];
        if (ch.nodeType === 3) {
          var tv = ch.nodeValue;
          if (tv == null) continue;
          if (!pre && tv.trim() === '') {
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
        if (tag === 'table') {
          cur = null;
          out.push(buildTableEntry(ch, st, align, resolved, notices, cellId));
          continue;
        }
        if (tag === 'ul' || tag === 'ol') {
          cur = null;
          processList(ch, st, align, indent, pre, listDepth, tag === 'ol');
          continue;
        }
        if (RICH_BLOCK_TAGS[tag]) {
          cur = null;
          var bst = applyElStyle(st, ch);
          if (tag.charAt(0) === 'h' && tag.length === 2) { bst.weight = 700; bst.size = headingPx(tag, st.size); }
          var bAlign = inlineAlign(ch) || align;
          var bIndent = indent + (tag === 'blockquote' ? LIST_INDENT_PX : 0);
          var bPre = pre || tag === 'pre';
          var before = out.length;
          process(ch, bst, bAlign, bIndent, bPre, listDepth);
          if (out.length === before) out.push(emptyPara(bAlign, bIndent, bst.size));
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
          cells.push({
            blocks: buildRichModel(cell, cst, calign, resolved, notices, cellId),
            align: calign
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
  function spaceWidthPx(size) { return glyphEmWidth(' ') * size; }
  function tokenWidth(tk) {
    if (tk.img) return tk.img.w;
    var w = textWidthPx(tk.text, tk.st.size);
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
      var lead = /^\s/.test(t);
      var trail = /\s$/.test(t);
      var words = t.replace(/\s+/g, ' ').trim().split(' ').filter(function (w) { return w !== ''; });
      words.forEach(function (w, idx) {
        var sp = (idx === 0) ? (pendingSpace || lead) : true;
        tokens.push({ text: w, st: fr.st, space: sp && tokens.length > 0 });
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
          var sp = (tk.space && curRow.length) ? spaceWidthPx(tk.st.size) : 0;
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
        row.forEach(function (tk, i) {
          if (tk.img) { if (tk.img.h > imgMax) imgMax = tk.img.h; }
          else if (tk.st.size > maxSize) maxSize = tk.st.size;
          rowW += tokenWidth(tk) + ((tk.space && i > 0) ? spaceWidthPx(tk.st.size) : 0);
        });
        // Baseline = distance from the line-box top. An inline image sits ON the
        // baseline (CSS-default `vertical-align:baseline`) with its whole height
        // ABOVE it, so the baseline must clear the tallest image — otherwise a
        // tall image's top (baseline - img.h) goes negative and overlaps the
        // line above. Text-only rows are unchanged: ascent = size*0.92,
        // lineH = size*1.2.
        var ascent = Math.max(maxSize * RICH_ASCENT, imgMax);
        var lineH = ascent + maxSize * (RICH_LINE_FACTOR - RICH_ASCENT);
        var baseline = y + ascent;
        var align = alignH(entry.align || defAlign);
        var x0 = indent + (align === 'right' ? (avail - rowW)
          : align === 'center' ? (avail - rowW) / 2 : 0);
        if (x0 < indent) x0 = indent;
        var x = x0;
        var bgRects = [], texts = [];
        row.forEach(function (tk, i) {
          var sp = (tk.space && i > 0) ? spaceWidthPx(tk.st.size) : 0;
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
      y += size * 1.2;
    }
    function emitTable(entry) {
      var rows = entry.rows || [];
      if (!rows.length) return;
      var ncols = 0;
      rows.forEach(function (r) { if (r.length > ncols) ncols = r.length; });
      if (ncols === 0) return;
      var colW = width / ncols;
      var cellPad = 3;
      var y0 = y;
      rows.forEach(function (row) {
        var rowH = 0;
        var laid = [];
        for (var c = 0; c < ncols; c++) {
          var cell = row[c];
          if (!cell) { laid.push(null); continue; }
          var inner = layoutBlocks(cell.blocks, Math.max(1, colW - cellPad * 2),
            wrap, cell.align);
          laid.push(inner);
          if (inner.height + cellPad * 2 > rowH) rowH = inner.height + cellPad * 2;
        }
        if (rowH <= 0) rowH = (entry.size || 12) * RICH_LINE_FACTOR + cellPad * 2;
        for (var c2 = 0; c2 < ncols; c2++) {
          var cx = c2 * colW;
          if (entry.border) {
            parts.push('<rect x="' + fmt(cx) + '" y="' + fmt(y) +
              '" width="' + fmt(colW) + '" height="' + fmt(rowH) +
              '" fill="none" stroke="' + (entry.color || '#000000') +
              '" stroke-width="1"/>');
          }
          if (laid[c2]) {
            parts.push('<g transform="translate(' + fmt(cx + cellPad) + ' ' +
              fmt(y + cellPad) + ')">' + laid[c2].svg + '</g>');
          }
        }
        y += rowH;
      });
      void y0;
    }
    entries.forEach(function (entry) {
      if (entry.kind === 'rule') emitRule(entry);
      else if (entry.kind === 'table') emitTable(entry);
      else emitPara(entry);
    });
    return { svg: parts.join(''), height: y };
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
    return { body: laid.svg, height: laid.height, pad: rpads.l, contentW: contentW };
  }

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
    if (rich) {
      var richEls = '';
      if (rich.body !== '') {
        var oy = v === 'middle' ? (lh - rich.height) / 2 :
          v === 'bottom' ? lh - rich.height - pb : pt;
        oy = Math.max(0, oy);
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
      var richSvg = '<svg xmlns="http://www.w3.org/2000/svg"' +
        ' xmlns:xlink="http://www.w3.org/1999/xlink" width="' + fmt(box.w) +
        '" height="' + fmt(box.h) + '"><defs><clipPath id="' + clipId +
        '"><rect x="0" y="0" width="' + fmt(box.w) + '" height="' + fmt(box.h) +
        '"/></clipPath></defs><g clip-path="url(#' + clipId + ')"' + gOpacityAttr + '>' + richEls +
        '</g></svg>';
      return { kind: 'svg', box: box, source: base64(richSvg), aspect: 'preserve' };
    }

    // Non-HTML labels are literal text: render verbatim (no tag stripping), so
    // e.g. "List<String>" keeps its angle brackets exactly as drawio shows them.
    var blocks = htmlTextBlocks(src, style, !labelIsHtml);
    var usableW = Math.max(1, box.w - pl - pr);
    var rows = [];
    blocks.forEach(function (b) {
      if (b.rule) {
        rows.push({ rule: true, size: 0, weight: 400, lineH: b.size, gap: b.gap });
        return;
      }
      wrapSvgText(b.text, b.size, usableW, style.whiteSpace === 'wrap').forEach(function (line) {
        rows.push({ text: line, size: b.size, weight: b.weight,
          lineH: b.size * 1.22, gap: b.gap, align: b.align,
          underline: !!b.underline });
      });
    });
    if (!rows.length) rows.push({ text: String(label || ''), size: 12, weight: 400, lineH: 14, gap: 0 });
    var totalH = rows.reduce(function (sum, r, i) {
      return sum + r.lineH + (i === 0 ? 0 : r.gap);
    }, 0);
    var y = v === 'middle' ? (box.h - totalH) / 2 :
      v === 'bottom' ? box.h - totalH - pb : pt;
    y = Math.max(0, y);
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
          '" x2="' + fmt(box.w - pr) + '" y2="' + fmt(ry) +
          '" stroke="' + color + '" stroke-width="1"/>';
      }
      var rowH = alignH(r.align || h);
      var anchor = rowH === 'right' ? 'end' : rowH === 'center' ? 'middle' : 'start';
      var x = rowH === 'right' ? box.w - pr : rowH === 'center' ? box.w / 2 : pl;
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

    if (String(style.horizontal) === '0') {
      var cx = box.w / 2, cy = box.h / 2;
      textEls = '<g transform="rotate(-90 ' + fmt(cx) + ' ' + fmt(cy) + ')">' +
        '<text x="' + fmt(cx) + '" y="' + fmt(cy) +
        '" font-family="' + escXml(family) + ', Arial, sans-serif"' +
        ' font-size="' + fmt(Math.max(1, number(style.fontSize, 12))) +
        '" font-weight="' + (((fst & 1) ? 700 : 400)) + '"' +
        ((fst & 2) ? ' font-style="italic"' : '') +
        (decoration.length ? ' text-decoration="' + decoration.join(' ') + '"' : '') +
        ' fill="' + color +
        '" text-anchor="middle" dominant-baseline="central" xml:space="preserve">' +
        escXml(String(label || stripHtml(raw))) + '</text></g>';
    }

    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + fmt(box.w) +
      '" height="' + fmt(box.h) + '"><defs><clipPath id="' + clipId +
      '"><rect x="0" y="0" width="' + fmt(box.w) + '" height="' + fmt(box.h) +
      '"/></clipPath></defs><g clip-path="url(#' + clipId + ')"' + gOpacityAttr + '>' + textEls +
      '</g></svg>';
    return { kind: 'svg', box: box, source: base64(svg), aspect: 'preserve' };
  }

  function labelTextNode(graph, cell, state, style, box, label, notices, resolved) {
    // Native print is headless-only: every label is built as an SVG text node
    // (which also fades correctly when drawio's textOpacity<100), with no
    // contract-schema change. (state is retained in the signature for call-site
    // stability but is not needed by the SVG label builder.)
    return textSvgNode(graph, cell, style, box, label, notices, resolved);
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
    return {
      color: (style && isPaintable(style.shadowColor)) ? style.shadowColor : '#808080',
      alpha: number(style && style.shadowOpacity, 1),
      dx: number(style && style.shadowOffsetX, 2),
      dy: number(style && style.shadowOffsetY, 3)
    };
  }

  // drawio glass effect (mxShape.paintGlassEffect): a white highlight over the
  // top ~40% of the shape, filled with a south gradient fading 0.9 -> 0.1 alpha.
  // Previously dropped silently. Returns the inner SVG content for a box-sized
  // overlay node (no own stroke). Coordinates are box-relative (0..w, 0..h).
  function glassOverlaySvg(style, w, h) {
    var sw = Math.ceil(number(style.strokeWidth, 1) / 2);
    var size = 0.4;
    var rounded = boolish(style.rounded);
    var arc = (rounded ? roundedRectRadius(style, w, h) : 0) + 2 * sw;
    var d = rounded
      ? 'M ' + p(-sw + arc, -sw) + ' Q ' + p(-sw, -sw) + ' ' + p(-sw, -sw + arc) +
        ' L ' + p(-sw, h * size) + ' Q ' + p(w * 0.5, h * 0.7) + ' ' + p(w + sw, h * size) +
        ' L ' + p(w + sw, -sw + arc) + ' Q ' + p(w + sw, -sw) + ' ' + p(w + sw - arc, -sw) + ' Z'
      : 'M ' + p(-sw, -sw) + ' L ' + p(-sw, h * size) + ' Q ' + p(w * 0.5, h * 0.7) + ' ' +
        p(w + sw, h * size) + ' L ' + p(w + sw, -sw) + ' Z';
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

  function cylinderPath(x, y, w, h) {
    // drawio mxCylinder.getCylinderSize: min(maxHeight=40, h/5) — width-
    // independent. Was min(0.18h, 0.28w), giving the wrong cap proportion.
    var e = Math.min(40, h / 5);
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

  // doubleEllipse: outer ellipse + inner ellipse (concentric, inset by margin each side)
  function doubleEllipsePath(x, y, w, h) {
    var margin = Math.min(w, h) * 0.1 + 2;
    return ellipsePath(x, y, w, h) + ' ' +
      ellipsePath(x + margin, y + margin, w - 2 * margin, h - 2 * margin);
  }

  // actor: head (top circle) + body (trapezoid from shoulders down)
  function actorPath(x, y, w, h) {
    var headR = Math.min(w / 4, h / 4);
    var headCx = x + w / 2, headCy = y + headR;
    // Head circle as ellipse path
    var head = ellipsePath(headCx - headR, headCy - headR, headR * 2, headR * 2);
    // Body: trapezoid below the head
    var shoulderY = headCy + headR;
    var bodyH = h - shoulderY + y;
    var halfW = w / 2;
    var halfBodyW = halfW * 0.8;
    var body = 'M ' + p(x + w / 2 - halfBodyW, shoulderY) +
      ' L ' + p(x + w / 2 + halfBodyW, shoulderY) +
      ' L ' + p(x + w, y + h) +
      ' L ' + p(x, y + h) + ' Z';
    return head + ' ' + body;
  }

  // swimlane: rectangle with a header bar + divider line.
  // horizontal=1 (default): header at top, divider is horizontal at y=startSize.
  // horizontal=0: header on the left, divider is vertical at x=startSize.
  function swimlanePath(style, x, y, w, h) {
    var isHoriz = String(style.horizontal) !== '0';
    var startSize = Math.min(Math.max(0, number(style.startSize, 30)), isHoriz ? h : w);
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

  function calloutPath(x, y, w, h) {
    var r = Math.min(w, h) * 0.12;
    var tailX = x + w * 0.34, tailY = y + h;
    var tailTipX = x + w * 0.22, tailTipY = y + h + Math.max(8, h * 0.22);
    var tailX2 = x + w * 0.50;
    return 'M ' + p(x + r, y) + ' L ' + p(x + w - r, y) +
      ' A ' + fmt(r) + ' ' + fmt(r) + ' 0 0 1 ' + p(x + w, y + r) +
      ' L ' + p(x + w, y + h - r) +
      ' A ' + fmt(r) + ' ' + fmt(r) + ' 0 0 1 ' + p(x + w - r, y + h) +
      ' L ' + p(tailX2, y + h) + ' L ' + p(tailTipX, tailTipY) +
      ' L ' + p(tailX, tailY) + ' L ' + p(x + r, y + h) +
      ' A ' + fmt(r) + ' ' + fmt(r) + ' 0 0 1 ' + p(x, y + h - r) +
      ' L ' + p(x, y + r) +
      ' A ' + fmt(r) + ' ' + fmt(r) + ' 0 0 1 ' + p(x + r, y) + ' Z';
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

  function datastorePath(x, y, w, h) {
    var dy = Math.min(h / 2, Math.round(h / 8));
    return 'M ' + p(x, y + dy) + ' C ' + p(x, y + 2 * dy) + ' ' + p(x + w, y + 2 * dy) + ' ' + p(x + w, y + dy) +
      ' L ' + p(x + w, y + h - dy) + ' C ' + p(x + w, y + h) + ' ' + p(x, y + h) + ' ' + p(x, y + h - dy) + ' Z' +
      ' M ' + p(x, y + dy) + ' C ' + p(x, y - dy / 3) + ' ' + p(x + w, y - dy / 3) + ' ' + p(x + w, y + dy);
  }

  function manualInputPath(x, y, w, h, sIn) {
    var s = (sIn == null) ? Math.min(h, 30) : sIn; // drawio ManualInputShape size default 30
    // top edge slopes from (0,s) up to (w,0).
    return 'M ' + p(x, y + h) + ' L ' + p(x, y + s) + ' L ' + p(x + w, y) + ' L ' + p(x + w, y + h) + ' Z';
  }

  function internalStoragePath(x, y, w, h, dxIn, dyIn) {
    var dx = (dxIn == null) ? Math.min(w, 20) : Math.min(w, dxIn); // drawio dx default 20
    var dy = (dyIn == null) ? Math.min(h, 20) : Math.min(h, dyIn); // drawio dy default 20
    return rectPath(x, y, w, h) + ' M ' + p(x + dx, y) + ' L ' + p(x + dx, y + h) +
      ' M ' + p(x, y + dy) + ' L ' + p(x + w, y + dy);
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

  function singleArrowPath(x, y, w, h) {
    var aw = Math.min(h * 0.35, w * 0.3), as = Math.min(w * 0.25, w);
    return 'M ' + p(x, y + h / 2 - aw) + ' L ' + p(x + w - as, y + h / 2 - aw) +
      ' L ' + p(x + w - as, y) + ' L ' + p(x + w, y + h / 2) +
      ' L ' + p(x + w - as, y + h) + ' L ' + p(x + w - as, y + h / 2 + aw) +
      ' L ' + p(x, y + h / 2 + aw) + ' Z';
  }

  function doubleArrowPath(x, y, w, h) {
    var aw = Math.min(h * 0.35, w * 0.25), as = Math.min(w * 0.22, w / 2);
    return 'M ' + p(x, y + h / 2) + ' L ' + p(x + as, y) + ' L ' + p(x + as, y + h / 2 - aw) +
      ' L ' + p(x + w - as, y + h / 2 - aw) + ' L ' + p(x + w - as, y) +
      ' L ' + p(x + w, y + h / 2) + ' L ' + p(x + w - as, y + h) +
      ' L ' + p(x + w - as, y + h / 2 + aw) + ' L ' + p(x + as, y + h / 2 + aw) +
      ' L ' + p(x + as, y + h) + ' Z';
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
    if (shape === 'rhombus' || shape === 'diamond') return rhombusPath(x, y, w, h);
    if (shape === 'triangle') return trianglePath(x, y, w, h);
    if (shape === 'cylinder') return cylinderPath(x, y, w, h);
    if (shape === 'cloud') return cloudPath(x, y, w, h);
    if (shape === 'hexagon') return hexagonPath(x, y, w, h, shapeSize(style, w, 0.25, 1, 20, w * 0.5));
    if (shape === 'doubleEllipse') return doubleEllipsePath(x, y, w, h);
    if (shape === 'actor') return actorPath(x, y, w, h);
    if (shape === 'swimlane') return swimlanePath(style, x, y, w, h);
    if (shape === 'line') return linePath(x, y, w, h);
    if (shape === 'arrow') return arrowShapePath(x, y, w, h);
    if (shape === 'arrowConnector') return arrowConnectorPath(x, y, w, h);
    if (shape === 'connector' || shape === 'tableLine' || shape === 'wire' || shape === 'filledEdge' || shape === 'pipe') return connectorPath(x, y, w, h);
    if (shape === 'isoRectangle') return isoRectanglePath(x, y, w, h);
    if (shape === 'isoCube' || shape === 'isoCube2') return isoCubePath(x, y, w, h);
    if (shape === 'datastore' || shape === 'dataStore') return datastorePath(x, y, w, h);
    if (shape === 'dataStorage') return dataStoragePath(x, y, w, h, shapeSize(style, w, 0.1, 1, 20, w));
    if (shape === 'document') return documentPath(x, y, w, h, h * Math.max(0, Math.min(1, number(style.size, 0.3))));
    if (shape === 'trapezoid') return trapezoidPath(x, y, w, h, shapeSize(style, w, 0.2, 0.5, 20, w * 0.5));
    if (shape === 'manualInput') return manualInputPath(x, y, w, h, Math.min(h, number(style.size, 30)));
    if (shape === 'internalStorage') return internalStoragePath(x, y, w, h, number(style.dx, 20), number(style.dy, 20));
    if (shape === 'offPageConnector') return offPageConnectorPath(x, y, w, h, h * Math.max(0, Math.min(1, number(style.size, 0.375))));
    if (shape === 'singleArrow' || shape === 'flexArrow' || shape === 'mermaidBlockArrow') return singleArrowPath(x, y, w, h);
    if (shape === 'doubleArrow') return doubleArrowPath(x, y, w, h);
    if (shape === 'cross') return crossPath(x, y, w, h, Math.min(w, h) * Math.max(0, Math.min(1, number(style.size, 0.2))));
    if (shape === 'display') return displayPath(x, y, w, h, Math.max(0, number(style.size, 0.25)) * w);
    if (shape === 'delay') return delayPath(x, y, w, h);
    if (shape === 'loopLimit') return loopLimitPath(x, y, w, h, Math.min(w / 2, Math.min(h, number(style.size, 20))));
    if (shape === 'parallelogram') return parallelogramPath(x, y, w, h, shapeSize(style, w, 0.2, 1, 20, w));
    if (shape === 'step') return stepPath(x, y, w, h, shapeSize(style, w, 0.2, 1, 20, w));
    if (shape === 'callout') return calloutPath(x, y, w, h);
    if (shape === 'tape') return tapePath(x, y, w, h, h * Math.max(0, Math.min(1, number(style.size, 0.4))));
    if (shape === 'card') return cardPath(x, y, w, h, Math.max(0, Math.min(w, Math.min(h, number(style.size, 30)))));
    if (shape === 'cube') return cubePath(x, y, w, h, Math.max(0, Math.min(w, Math.min(h, number(style.size, 20)))));
    if (shape === 'note' || shape === 'note2') return rectPath(x, y, w, h);
    if (shape === 'cylinder2' || shape === 'cylinder3') return cylinderPath(x, y, w, h);
    if (shape === 'umlState') return roundedRectPath(x, y, w, h, Math.min(w, h) * 0.12);
    if (shape === 'transparent') return rectPath(x, y, w, h);
    if (shape === 'plus') return crossPath(x, y, w, h);
    if (shape === 'ext' || shape === 'message' || shape === 'umlFrame') return rectPath(x, y, w, h);
    if (shape === 'umlBoundary' || shape === 'umlEntity' || shape === 'umlControl' || shape === 'lollipop' || shape === 'waypoint') return ellipsePath(x, y, w, h);
    if (shape === 'umlDestroy') return 'M ' + p(x, y) + ' L ' + p(x + w, y + h) + ' M ' + p(x + w, y) + ' L ' + p(x, y + h);
    if (shape === 'umlLifeline') return rectPath(x, y, w, h) + ' M ' + p(x + w / 2, y + h * 0.25) + ' L ' + p(x + w / 2, y + h);
    if (shape === 'requires' || shape === 'requiredInterface' || shape === 'providedRequiredInterface') return ellipsePath(x, y, w, h);
    if (shape === 'module') return rectPath(x, y, w, h);
    if (shape === 'startState') return ellipsePath(x, y, w, h);
    if (shape === 'link') return 'M ' + p(x, y + h / 2) + ' C ' + p(x + w / 3, y) + ' ' + p(x + 2 * w / 3, y + h) + ' ' + p(x + w, y + h / 2);
    if (shape === 'curlyBracket') return 'M ' + p(x + w, y) + ' C ' + p(x, y) + ' ' + p(x + w, y + h / 2) + ' ' + p(x, y + h / 2) + ' C ' + p(x + w, y + h / 2) + ' ' + p(x, y + h) + ' ' + p(x + w, y + h);
    if (shape === 'parallelMarker') return 'M ' + p(x + w * 0.25, y) + ' L ' + p(x + w * 0.25, y + h) + ' M ' + p(x + w * 0.75, y) + ' L ' + p(x + w * 0.75, y + h);
    if (shape === 'corner') return 'M ' + p(x, y) + ' L ' + p(x, y + h) + ' L ' + p(x + w, y + h);
    if (shape === 'crossbar') return 'M ' + p(x, y + h / 2) + ' L ' + p(x + w, y + h / 2) + ' M ' + p(x + w / 2, y) + ' L ' + p(x + w / 2, y + h);
    if (shape === 'tee') return 'M ' + p(x, y) + ' L ' + p(x + w, y) + ' M ' + p(x + w / 2, y) + ' L ' + p(x + w / 2, y + h);
    if (shape === 'or' || shape === 'xor' || shape === 'orEllipse' || shape === 'sumEllipse' || shape === 'lineEllipse') return ellipsePath(x, y, w, h);
    if (shape === 'sortShape') return rhombusPath(x, y, w, h) + ' M ' + p(x, y + h / 2) + ' L ' + p(x + w, y + h / 2);
    if (shape === 'collate') return 'M ' + p(x, y) + ' L ' + p(x + w, y) + ' L ' + p(x + w / 2, y + h / 2) + ' Z M ' + p(x, y + h) + ' L ' + p(x + w, y + h) + ' L ' + p(x + w / 2, y + h / 2) + ' Z';
    if (shape === 'dimension') return rectPath(x, y, w, h);
    if (shape === 'tapeData') return tapePath(x, y, w, h);
    if (shape === 'gitTag') return 'M ' + p(x, y) + ' L ' + p(x + w * 0.78, y) + ' L ' + p(x + w, y + h / 2) + ' L ' + p(x + w * 0.78, y + h) + ' L ' + p(x, y + h) + ' Z';
    if (shape === 'gitMergeCommit' || shape === 'gitCherryPick' || shape === 'mindmapBang' || shape === 'ishikawaHead' || shape === 'mermaidOdd') return ellipsePath(x, y, w, h);
    if (shape === 'zigzag') {
      var zz = 'M ' + p(x, y + h);
      var steps = 16;
      for (var zi = 1; zi <= steps; zi++) {
        zz += ' L ' + p(x + w * zi / steps, y + (zi % 2 ? 0 : h));
      }
      return zz;
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
    var header = Math.min(h, Math.max(0, number(style.startSize, 30)));
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
  function paddedSvgShapeNode(content, box, style) {
    var sw = Math.max(0.1, number(style.strokeWidth, 1));
    var pad = sw / 2;
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
    var s = Math.max(0, Math.min(w / 2, Math.min(h / 2, number(style.size, 15))));
    var penta = 'M 0 0 L ' + fmt(w - s) + ' 0 L ' + fmt(w) + ' ' + fmt(s) +
      ' L ' + fmt(w) + ' ' + fmt(h) + ' L 0 ' + fmt(h) + ' Z';
    var fold = 'M ' + fmt(w - s) + ' 0 L ' + fmt(w - s) + ' ' + fmt(s) +
      ' L ' + fmt(w) + ' ' + fmt(s) + ' Z';
    var content;
    if (fillOverride) {
      content = '<path d="' + penta + '" fill="' + fillOverride + '"' +
        (opacityOverride != null ? ' fill-opacity="' + fmt(opacityOverride) + '"' : '') +
        ' stroke="none"/>';
    } else {
      var fillC = isPaintable(style.fillColor) ? hex(style.fillColor) : '#ffffff';
      var defs = '', fillAttr;
      if (isPaintable(style.gradientColor)) {
        defs = '<defs>' + linearGradDef('ngrad', fillC, hex(style.gradientColor), style.gradientDirection) + '</defs>';
        fillAttr = ' fill="url(#ngrad)"';
      } else {
        fillAttr = ' fill="' + fillC + '"';
      }
      content = defs + '<path d="' + penta + '"' + fillAttr + strokeSvgAttrs(style) + '/>' +
        '<path d="' + fold + '" fill="' + shadeHex(fillC, 0.9) + '" stroke="none"/>';
    }
    var dir = style.direction || 'east';
    var deg = dir === 'west' ? 180 : dir === 'north' ? 270 : dir === 'south' ? 90 : 0;
    if (deg) content = '<g transform="rotate(' + fmt(deg) + ' ' + fmt(w / 2) + ' ' + fmt(h / 2) + ')">' + content + '</g>';
    return content;
  }

  function builtinShapeSvg(style, w, h) {
    var shape = style.shape;
    var fill = fillSvgAttr(style, '');
    var strk = strokeSvgAttrs(style);
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
      // Rectangle + two vertical inset lines — ProcessShape, Shapes.js (default size=0.1)
      var pInset = Math.round(w * Math.max(0, Math.min(1, number(style.size, 0.1))));
      return '<rect x="0" y="0" width="' + fmt(w) + '" height="' + fmt(h) + '"' + fill + strk + '/>' +
        '<line x1="' + fmt(pInset) + '" y1="0" x2="' + fmt(pInset) + '" y2="' + fmt(h) + '" fill="none"' + strk + '/>' +
        '<line x1="' + fmt(w - pInset) + '" y1="0" x2="' + fmt(w - pInset) + '" y2="' + fmt(h) + '" fill="none"' + strk + '/>';
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
      // Rectangle background + diamond stroke overlay — AssociativeEntity, Shapes.js
      return '<rect x="0" y="0" width="' + fmt(w) + '" height="' + fmt(h) + '"' + fill + strk + '/>' +
        '<path d="M ' + fmt(w / 2) + ' 0 L ' + fmt(w) + ' ' + fmt(h / 2) +
        ' L ' + fmt(w / 2) + ' ' + fmt(h) + ' L 0 ' + fmt(h / 2) + ' Z" fill="none"' + strk + '/>';
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
      // Full rect + header separator line — TableShape (swimlane-like), Shapes.js
      var tStart = Math.min(h, Math.max(0, number(style.startSize, 30)));
      var tLine = (tStart > 0 && tStart < h)
        ? '<line x1="0" y1="' + fmt(tStart) + '" x2="' + fmt(w) + '" y2="' + fmt(tStart) + '" fill="none"' + strk + '/>'
        : '';
      return '<rect x="0" y="0" width="' + fmt(w) + '" height="' + fmt(h) + '"' + fill + strk + '/>' + tLine;
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

  function edgePath(points, rounded, curved, radius) {
    if (curved && points.length === 4) {
      return 'M ' + p(points[0].x, points[0].y) + ' C ' +
        p(points[1].x, points[1].y) + ' ' +
        p(points[2].x, points[2].y) + ' ' +
        p(points[3].x, points[3].y);
    }
    if (!rounded || points.length < 3) {
      var d = 'M ' + p(points[0].x, points[0].y);
      for (var i = 1; i < points.length; i++) d += ' L ' + p(points[i].x, points[i].y);
      return d;
    }
    // drawio mxPolyline rounds corners with arcSize = (style arcSize ||
    // LINE_ARCSIZE=20) / 2 = 10 by default. Was a hardcoded 8.
    var radius = radius > 0 ? radius : 10;
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

  function openArrowPath(from, to, size) {
    var dx = to.x - from.x, dy = to.y - from.y;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len <= 0.001) return null;
    var ux = dx / len, uy = dy / len;
    var px = -uy, py = ux;
    var base = { x: to.x - ux * size, y: to.y - uy * size };
    return 'M ' + p(base.x + px * size * 0.45, base.y + py * size * 0.45) +
      ' L ' + p(to.x, to.y) +
      ' L ' + p(base.x - px * size * 0.45, base.y - py * size * 0.45);
  }

  // Faithful headless edge-marker renderer. drawio has ~30 arrowhead types; the
  // re-derivation path (headless fallback) previously drew EVERY non-open marker
  // as a classic filled triangle with NO notice — a silent WYSIWYG divergence
  // (C1) for diamond/oval/box/circle/ER/etc. This renders the common ones
  // faithfully and emits a LOUD notice for the genuinely-unsupported ones
  // (drawing the closest approximation so the operator still sees a marker).
  // Returns a paint node ({kind:'path', d, fill, stroke}) or null.
  function edgeMarkerNode(type, from, to, size, stroke, arrowFill, cellId, notices, filled) {
    var dx = to.x - from.x, dy = to.y - from.y;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len <= 0.001) return null;
    var ux = dx / len, uy = dy / len, px = -uy, py = ux;
    var base = { x: to.x - ux * size, y: to.y - uy * size };
    var t = String(type).replace(/Thin$/, '');
    // drawio endFill/startFill: a filled marker (classic/block/diamond/oval/box)
    // is fillAndStroke when filled, but a plain stroked OUTLINE (transparent
    // inside) when endFill/startFill=0. Previously always filled -> a hollow
    // arrowhead silently printed solid. `filled` defaults true (endFill!='0').
    var fillIf = (filled === false) ? null : arrowFill;
    var strokeIf = (filled === false) ? stroke : null;
    // Open V (stroked, not filled).
    if (t === 'open' || t === 'openAsync') {
      return { kind: 'path', d: openArrowPath(from, to, size), fill: null, stroke: stroke };
    }
    // Filled triangle: classic (notched back) and block (flat back). We render
    // both as a flat-back triangle — visually equivalent at print marker sizes.
    if (t === 'classic' || t === 'block' || t === '') {
      return { kind: 'path', d: arrowPath(from, to, size), fill: fillIf, stroke: strokeIf };
    }
    // Filled rhombus.
    if (t === 'diamond') {
      var dm = { x: to.x - ux * size * 0.5, y: to.y - uy * size * 0.5 };
      var dd = 'M ' + p(to.x, to.y) +
        ' L ' + p(dm.x + px * size * 0.5, dm.y + py * size * 0.5) +
        ' L ' + p(base.x, base.y) +
        ' L ' + p(dm.x - px * size * 0.5, dm.y - py * size * 0.5) + ' Z';
      return { kind: 'path', d: dd, fill: fillIf, stroke: strokeIf };
    }
    // Circle/ellipse, centered half a marker back from the tip. circle = hollow.
    if (t === 'oval' || t === 'circle' || t === 'circlePlus') {
      var c = { x: to.x - ux * size * 0.5, y: to.y - uy * size * 0.5 }, r = size * 0.5;
      var cd = 'M ' + p(c.x - r, c.y) +
        ' A ' + fmt(r) + ' ' + fmt(r) + ' 0 1 0 ' + fmt(c.x + r) + ' ' + fmt(c.y) +
        ' A ' + fmt(r) + ' ' + fmt(r) + ' 0 1 0 ' + fmt(c.x - r) + ' ' + fmt(c.y) + ' Z';
      var hollow = (t === 'circle' || t === 'circlePlus' || filled === false);
      var node = { kind: 'path', d: cd, fill: hollow ? null : arrowFill,
        stroke: hollow ? stroke : null };
      if (t === 'circlePlus') {
        // notice: the plus glyph is not rendered, only the circle outline.
        if (Array.isArray(notices)) notices.push(degradation('ExporterUnsupportedShape',
          'edge marker "' + type + '" rendered as circle (plus omitted)', cellId));
      }
      return node;
    }
    // Filled square.
    if (t === 'box') {
      var bd = 'M ' + p(to.x + px * size * 0.45, to.y + py * size * 0.45) +
        ' L ' + p(to.x - px * size * 0.45, to.y - py * size * 0.45) +
        ' L ' + p(base.x - px * size * 0.45, base.y - py * size * 0.45) +
        ' L ' + p(base.x + px * size * 0.45, base.y + py * size * 0.45) + ' Z';
      return { kind: 'path', d: bd, fill: fillIf, stroke: strokeIf };
    }
    // Stroked-line markers (dash, cross) and the ER crow's-foot family are
    // rendered faithfully here, matching drawio's mxMarker formulas exactly
    // (Q = unitX*(size+sw+1), Ca = unitY*(size+sw+1); unit vector points at the
    // tip). These are pure stroked lines/feet — no edge-line recession — so a
    // multi-segment stencil is returned as an array of stroked path nodes.
    var sw = (stroke && stroke.width) || 1;
    var g = size + sw + 1;
    var qx = ux * g, qy = uy * g;      // Q  (x-projection) and Ca (y-projection)
    function line(x0, y0, x1, y1) {
      return { kind: 'path', d: 'M ' + p(x0, y0) + ' L ' + p(x1, y1),
        fill: null, stroke: stroke };
    }
    function poly3(x0, y0, x1, y1, x2, y2) {
      return { kind: 'path', d: 'M ' + p(x0, y0) + ' L ' + p(x1, y1) +
        ' L ' + p(x2, y2), fill: null, stroke: stroke };
    }
    if (t === 'dash') {
      return line(to.x - qx / 2 - qy / 2, to.y - qy / 2 + qx / 2,
        to.x + qy / 2 - 3 * qx / 2, to.y - 3 * qy / 2 - qx / 2);
    }
    if (t === 'cross') {
      return [
        line(to.x - qx / 2 - qy / 2, to.y - qy / 2 + qx / 2,
          to.x + qy / 2 - 3 * qx / 2, to.y - 3 * qy / 2 - qx / 2),
        line(to.x - qx / 2 + qy / 2, to.y - qy / 2 - qx / 2,
          to.x - qy / 2 - 3 * qx / 2, to.y - 3 * qy / 2 + qx / 2)
      ];
    }
    if (t === 'ERone') {
      return line(to.x - qx / 2 - qy / 2, to.y - qy / 2 + qx / 2,
        to.x - qx / 2 + qy / 2, to.y - qy / 2 - qx / 2);
    }
    if (t === 'ERmany') {
      return poly3(to.x + qy / 2, to.y - qx / 2, to.x - qx, to.y - qy,
        to.x - qy / 2, to.y + qx / 2);
    }
    if (t === 'ERmandOne') {
      return [
        line(to.x - qx / 2 - qy / 2, to.y - qy / 2 + qx / 2,
          to.x - qx / 2 + qy / 2, to.y - qy / 2 - qx / 2),
        line(to.x - qx - qy / 2, to.y - qy + qx / 2,
          to.x - qx + qy / 2, to.y - qy - qx / 2)
      ];
    }
    if (t === 'ERoneToMany') {
      return [
        line(to.x - qx - qy / 2, to.y - qy + qx / 2,
          to.x - qx + qy / 2, to.y - qy - qx / 2),
        poly3(to.x + qy / 2, to.y - qx / 2, to.x - qx, to.y - qy,
          to.x - qy / 2, to.y + qx / 2)
      ];
    }
    // Genuinely unsupported (async half-arrow, ER zero-to-* with endpoint
    // recession, halfCircle curve, sysML glyphs, …): loud notice + classic-
    // triangle placeholder so the edge still terminates visibly. NEVER a
    // silent wrong marker.
    if (Array.isArray(notices)) notices.push(degradation('ExporterUnsupportedShape',
      'edge marker "' + type + '" approximated as a classic arrowhead', cellId));
    return { kind: 'path', d: arrowPath(from, to, size), fill: arrowFill, stroke: null };
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
      // support textContent extraction reliably headlessly).
      s = s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
           .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
           .replace(/&#(\d+);/g, function(_, n) { return String.fromCharCode(+n); })
           .replace(/&#x([0-9a-fA-F]+);/g, function(_, h) { return String.fromCharCode(parseInt(h, 16)); });
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
    return {
      x: (x - origin.x) / scale - width / 2,
      y: (y - origin.y) / scale - (style.verticalAlign === 'bottom' ? height + 2 : height / 2),
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
    var cxw = (pt.x + offx - origin.x) / scale;
    var cyw = (pt.y + offy - origin.y) / scale;
    var fs = number(style.fontSize, 12);
    var lw = Math.max(24, String(label).length * fs * 0.65);
    var lh = Math.max(fs * 1.4, String(label).split('\n').length * fs * 1.25);
    var elBox = { x: cxw - lw / 2, y: cyw - lh / 2, w: lw, h: lh };
    var bg = labelBoxNode(style, elBox);
    if (bg) paint.push(bg);
    paint.push(labelTextNode(graph, cell, state, style, elBox, label, notices, resolved));
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

  function imageNode(style, box, parsed) {
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
    var op = opacity(style, 'opacity');
    if (op < 1) {
      // kind:image has no opacity field in the frozen contract; route through an
      // svg <image opacity> so a translucent image (style opacity<100) prints
      // faithfully instead of fully opaque.
      var fit = String(style.imageAspect) === '0' ? 'none' : 'xMidYMid meet';
      var sx = fh ? -1 : 1, sy = fv ? -1 : 1;
      var tf = (fh || fv) ? ' transform="translate(' + fmt(fh ? box.w : 0) + ' ' +
        fmt(fv ? box.h : 0) + ') scale(' + sx + ',' + sy + ')"' : '';
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ' +
        'width="' + fmt(box.w) + '" height="' + fmt(box.h) + '">' +
        '<image x="0" y="0" width="' + fmt(box.w) + '" height="' + fmt(box.h) +
        '" preserveAspectRatio="' + fit + '" opacity="' + fmt(op) + '"' + tf +
        ' xlink:href="data:image/png;base64,' + parsed.data + '"/></svg>';
      return { kind: 'svg', box: box, source: base64(svg), aspect: 'preserve' };
    }
    return {
      kind: 'image',
      box: box,
      format: 'png',
      data: parsed.data,
      aspect: String(style.imageAspect) === '0' ? 'fill' : 'preserve',
      flipH: fh,
      flipV: fv
    };
  }

  // A non-PNG but rasterizer-embeddable image (JPEG/GIF/SVG, embedded or a
  // fetched external one) -> a `kind:"svg"` node whose source is a tiny SVG
  // wrapping the data URI as <image>. Built from the BYTES, not the live DOM,
  // so it works headless and never carries an unresolved external href. resvg
  // decodes the format (verified). aspect mirrors drawio's imageAspect.
  function dataUriImageSvgNode(mime, data, box, style) {
    if (style && style.shape === 'icon') {
      var pad = Math.max(4, Math.min(box.w, box.h) * 0.16);
      box = {
        x: box.x + pad,
        y: box.y + pad,
        w: Math.max(1, box.w - pad * 2),
        h: Math.max(1, box.h - pad * 2)
      };
    }
    var fit = String(style && style.imageAspect) === '0'
      ? 'none' : 'xMidYMid meet';
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" ' +
      'xmlns:xlink="http://www.w3.org/1999/xlink" width="' + fmt(box.w) +
      '" height="' + fmt(box.h) + '">' +
      '<image x="0" y="0" width="' + fmt(box.w) + '" height="' + fmt(box.h) +
      '" preserveAspectRatio="' + fit + '" xlink:href="data:' + mime +
      ';base64,' + data + '"/></svg>';
    return { kind: 'svg', box: box, source: base64(svg), aspect: 'preserve' };
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
    // exactly as drawn. Headless fixtures with no live view fall back to bounds.
    var origin;
    if (view && view.translate && (view.translate.x || view.translate.y)) {
      origin = { x: view.translate.x * scale, y: view.translate.y * scale };
    } else {
      origin = {
        x: bounds && bounds.width > 0 ? bounds.x : 0,
        y: bounds && bounds.height > 0 ? bounds.y : 0
      };
    }
    var page = (paper && paper.wPx > 0 && paper.hPx > 0)
      ? { w: Math.max(1, Math.round(paper.wPx)),
          h: Math.max(1, Math.round(paper.hPx)) }
      : { w: Math.max(1, Math.ceil((bounds ? bounds.width : 1) / scale)),
          h: Math.max(1, Math.ceil((bounds ? bounds.height : 1) / scale)) };

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
    if (String(style.textDirection || '').toLowerCase() === 'rtl') {
      notices.push(degradation('ExporterUnsupportedShape',
        'right-to-left textDirection is not applied to the label.', cell.id));
    }

    // Edge child-label cell (multi-label edge): position along the parent edge.
    if (emitEdgeChildLabel(graph, cell, state, style, origin, scale, paint, notices, resolved, label)) {
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
      paint.push({ kind: 'path', fill: fillOf(style), stroke: strokeOf(style),
        d: lblR > 0 ? roundedRectPath(box.x, box.y, box.w, box.h, lblR)
                    : rectPath(box.x, box.y, box.w, box.h) });
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
      if (lImg && lImg.format === 'png') paint.push(imageNode(style, liBox, lImg));
      else if (lMime) paint.push(dataUriImageSvgNode(lMime, lImg.data, liBox, style));
      else {
        notices.push(degradation('ExporterUnsupportedImage',
          'label image could not be embedded — placeholder box printed.', cell.id));
        paint.push({ kind: 'path', d: rectPath(liBox.x, liBox.y, liBox.w, liBox.h),
          fill: null, stroke: strokeOf(style) });
      }
      if (label !== '') {
        var lblBxN = labelBoxNode(style, box);
        if (lblBxN) paint.push(lblBxN);
        paint.push(labelTextNode(graph, cell, state, style, box, label, notices, resolved));
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
          var imgRotOp = opacity(style, 'opacity');
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
          paint.push(imageNode(style, box, img));      // faithful — WYSIWYG
        }
      } else if (mime) {
        // Any rasterizer-embeddable format (JPEG/GIF/SVG, embedded or fetched)
        // -> build the SVG <image> from the bytes (no live-DOM dependency, so
        // it's faithful headless AND in-browser). No notice.
        paint.push(dataUriImageSvgNode(mime, img.data, box, style));
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
      if (label !== '') {
        // Place the label at its ACTUAL bounds (mxText.bounds honors
        // verticalLabelPosition), NOT the full cell box. Otherwise an icon's
        // label (verticalLabelPosition=bottom) — and especially its resolved
        // labelBackgroundColor box — is painted OVER the image, hiding it (the
        // "gear icon not present" bug). Falls back to the cell box if unknown.
        var lb = box;
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
        var ilb = labelBoxNode(style, lb);
        if (ilb) paint.push(ilb);
        paint.push(labelTextNode(graph, cell, state, style, lb, label, notices, resolved));
      }
      return;
    }

    // drawio's `text`/`html` shapes (e.g. the "Paragraph of Text" element,
    // and object values that parse as HTML labels) paint no separate body —
    // they are label-only objects. Emitting a bbox path here is both invisible
    // (fill/stroke are none) and wrongly raised an ExporterUnsupportedShape
    // notice. Skip the body; just lay out the label.
    if (style.shape !== 'text' && style.shape !== 'html' && style.shape !== 'curvedText') {

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
              // For non-rotated stencils, emit label as separate text node centered on cell
              var lblBoxS = box;
              // Check for external label position overrides
              var lposS = style.labelPosition, vlposS = style.verticalLabelPosition;
              var lblW = style.labelWidth ? parseFloat(style.labelWidth) : null;
              if (lposS === 'left') {
                var lw = lblW || box.w;
                lblBoxS = { x: box.x - lw, y: box.y, w: lw, h: box.h };
              } else if (lposS === 'right') {
                var lw = lblW || box.w;
                lblBoxS = { x: box.x + box.w, y: box.y, w: lw, h: box.h };
              } else if (lblW) {
                lblBoxS = { x: box.x, y: box.y, w: lblW, h: box.h };
              }
              if (vlposS === 'top') {
                lblBoxS = { x: lblBoxS.x, y: box.y - box.h, w: lblBoxS.w, h: box.h };
              } else if (vlposS === 'bottom') {
                lblBoxS = { x: lblBoxS.x, y: box.y + box.h, w: lblBoxS.w, h: box.h };
              }
              var slb = labelBoxNode(style, lblBoxS);
              if (slb) paint.push(slb);
              paint.push(labelTextNode(graph, cell, state, style, lblBoxS, label, notices, resolved));
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
          builtinContent = '<g transform="rotate(' + fmt(dirDegBI) + ' ' +
            fmt(box.w / 2) + ' ' + fmt(box.h / 2) + ') translate(' +
            fmt((box.w - pwBI0) / 2) + ' ' + fmt((box.h - phBI0) / 2) + ')">' +
            rawBI + '</g>';
        }
        var rotDegBI = number(style.rotation, 0);
        if (rotDegBI) {
          var thetaBI = rotDegBI * Math.PI / 180;
          var expWBI = box.w * Math.abs(Math.cos(thetaBI)) + box.h * Math.abs(Math.sin(thetaBI));
          var expHBI = box.w * Math.abs(Math.sin(thetaBI)) + box.h * Math.abs(Math.cos(thetaBI));
          var offXBI = (expWBI - box.w) / 2;
          var offYBI = (expHBI - box.h) / 2;
          var rcxBI = expWBI / 2, rcyBI = expHBI / 2;
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
          paint.push(paddedSvgShapeNode(builtinContent, box, style));
          if (label !== '') {
            var lblBoxBI = box;
            var lposBI = style.labelPosition, vlposBI = style.verticalLabelPosition;
            var lblWBI = style.labelWidth ? parseFloat(style.labelWidth) : null;
            if (lposBI === 'left') {
              var lwBI = lblWBI || box.w;
              lblBoxBI = { x: box.x - lwBI, y: box.y, w: lwBI, h: box.h };
            } else if (lposBI === 'right') {
              var lwBI = lblWBI || box.w;
              lblBoxBI = { x: box.x + box.w, y: box.y, w: lwBI, h: box.h };
            } else if (lblWBI) {
              lblBoxBI = { x: box.x, y: box.y, w: lblWBI, h: box.h };
            }
            if (vlposBI === 'top') {
              lblBoxBI = { x: lblBoxBI.x, y: box.y - box.h, w: lblBoxBI.w, h: box.h };
            } else if (vlposBI === 'bottom') {
              lblBoxBI = { x: lblBoxBI.x, y: box.y + box.h, w: lblBoxBI.w, h: box.h };
            }
            if (style.shape === 'table') {
              var tableHeadBI = Math.min(Math.max(0, number(style.startSize, 30)), box.h);
              if (tableHeadBI > 0) lblBoxBI = { x: box.x, y: box.y, w: box.w, h: tableHeadBI };
            }
            var blbBI = labelBoxNode(style, lblBoxBI);
            if (blbBI) paint.push(blbBI);
            paint.push(labelTextNode(graph, cell, state, style, lblBoxBI, label, notices, resolved));
          }
        }
        return;
      }

      // Note shape (folded-corner sticky note). Handle before shapePath, which
      // would flatten the dog-ear to a plain rectangle.
      if (style.shape === 'note') {
        if (boolish(style.shadow)) {
          var nsp = shadowParams(style);
          paint.push(paddedSvgShapeNode(noteInner(style, box.w, box.h, nsp.color, nsp.alpha),
            { x: box.x + nsp.dx, y: box.y + nsp.dy, w: box.w, h: box.h }, { strokeColor: 'none' }));
        }
        paint.push(paddedSvgShapeNode(noteInner(style, box.w, box.h, null, null), box, style));
        if (label !== '') {
          paint.push(labelTextNode(graph, cell, state, style, box, label, notices, resolved));
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
        var swH = String(style.horizontal) !== '0';
        var swSz = Math.min(Math.max(0, number(style.startSize, 30)), swH ? box.h : box.w);
        var swStroke = strokeOf(style);
        var swFill = fillOf(style);                 // header fill (null if none)
        var swLane = isPaintable(style.swimlaneFillColor)
          ? solid(style.swimlaneFillColor, opacity(style, 'fillOpacity')) : null;
        var swHead = String(style.swimlaneHead) !== '0';   // default 1
        var swBody = String(style.swimlaneBody) !== '0';   // default 1
        var swR = boolish(style.rounded) ? roundedRectRadius(style, box.w, box.h) : 0;
        var bx = box.x, by = box.y, bw = box.w, bh = box.h;
        // header fill (faithful gradient when gradientColor is set)
        if (swFill) {
          var swHB = swH ? { x: bx, y: by, w: bw, h: swSz }
                         : { x: bx, y: by, w: swSz, h: bh };
          var swHN = regionFillNode(style, swHB);
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
        if (label !== '') {
          var swLB = swH ? { x: bx, y: by, w: bw, h: swSz }
                         : { x: bx, y: by, w: swSz, h: bh };
          var swLBn = labelBoxNode(style, swLB);
          if (swLBn) paint.push(swLBn);
          paint.push(labelTextNode(graph, cell, state, style, swLB, label, notices, resolved));
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
      var flipH_ = boolish(style.flipH) || boolish(style.stencilFlipH);
      var flipV_ = boolish(style.flipV) || boolish(style.stencilFlipV);
      var dir = String(style.direction || 'east').toLowerCase();
      var dirDeg = dir === 'south' ? 90 : dir === 'west' ? 180 : dir === 'north' ? 270 : 0;
      var dirInv = (dir === 'north' || dir === 'south');
      function outlinePath(ox, oy, w, h) {
        var ccx = ox + w / 2, ccy = oy + h / 2;
        var pw = dirInv ? h : w, ph = dirInv ? w : h;
        var pd = shapePath(style, ccx - pw / 2, ccy - ph / 2, pw, ph);
        if (!pd) return null;
        if (flipH_ || flipV_) pd = flipPathD(pd, ccx, ccy, flipH_, flipV_);
        if (dirDeg) pd = rotatePathD(pd, ccx, ccy, dirDeg);
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
        var textEl = rotatedLabelEls(graph, cell, style, offX, offY, box.w, box.h, label, notices, resolved);
        var inner = '<g transform="rotate(' + fmt(rotDeg) + ' ' + fmt(rcx) + ' ' + fmt(rcy) + ')">' +
          pathEl + textEl + '</g>';
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
      if (boolish(style.glass)) {
        paint.push(paddedSvgShapeNode(glassOverlaySvg(style, box.w, box.h),
          { x: box.x, y: box.y, w: box.w, h: box.h }, { strokeColor: 'none' }));
      }
    }

    // Swimlane labels live in the header area only (mxSwimlane.getLabelBounds).
    // Constrain the label box to avoid centering over the whole swimlane height.
    var swimLabelBx = box;
    if (style.shape === 'swimlane') {
      var swimIsH = String(style.horizontal) !== '0';
      var swimSz = Math.min(Math.max(0, number(style.startSize, 30)), swimIsH ? box.h : box.w);
      swimLabelBx = swimIsH
        ? { x: box.x, y: box.y, w: box.w, h: swimSz }
        : { x: box.x, y: box.y, w: swimSz, h: box.h };
    } else if (style.shape === 'table') {
      var tableHeader = Math.min(Math.max(0, number(style.startSize, 30)), box.h);
      if (tableHeader > 0) swimLabelBx = { x: box.x, y: box.y, w: box.w, h: tableHeader };
    } else {
      // labelPosition / verticalLabelPosition place the label OUTSIDE the shape
      // (drawio). The plain-shape path previously ignored them, painting the
      // label over the shape — a silent positional divergence. (Stencils/icons
      // handle this on their own paths.)
      swimLabelBx = externalLabelBox(style, box);
    }
    if (label !== '') {
      var vlb = labelBoxNode(style, swimLabelBx);
      if (vlb) paint.push(vlb);
      paint.push(labelTextNode(graph, cell, state, style, swimLabelBx, label, notices, resolved));
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

    // Waypoints (handles >2-point edges faithfully)
    for (var i = 0; i < pts.length - 2; i++) {
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
          var aF = Math.max(tmp, 0.06);
          var outX = pts[i + 1].x + ny2 * edgeWidth / 2 / aF;
          var outY = pts[i + 1].y - nx2 * edgeWidth / 2 / aF;
          var inX = pts[i + 1].x - ny2 * edgeWidth / 2 / aF;
          var inY = pts[i + 1].y + nx2 * edgeWidth / 2 / aF;
          pathCmds.push('L ' + p(outX, outY));
          (function (x, y) { fnCmds.push('L ' + p(x, y)); })(inX, inY);
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
    // perimeterSpacing (+ source/targetPerimeterSpacing) creates a gap between
    // the shape edge and the connector endpoints (drawio grows the perimeter by
    // the spacing). Pull each endpoint inward along the edge by that amount so
    // the gap appears, instead of the line touching the shape. Was ignored.
    var perimBase = number(style.perimeterSpacing, 0);
    var srcSp = perimBase + number(style.sourcePerimeterSpacing, 0);
    var tgtSp = perimBase + number(style.targetPerimeterSpacing, 0);
    var nudge = function (from, toward, dist) {
      var dx = toward.x - from.x, dy = toward.y - from.y;
      var len = Math.sqrt(dx * dx + dy * dy);
      if (len <= 0.001 || dist <= 0) return from;
      return { x: from.x + dx / len * dist, y: from.y + dy / len * dist };
    };
    if (srcSp > 0) points[0] = nudge(points[0], points[1], srcSp);
    if (tgtSp > 0) points[points.length - 1] = nudge(points[points.length - 1], points[points.length - 2], tgtSp);
    var stroke = strokeOf(style) || strokeOf({ strokeColor: '#000000', strokeWidth: 1 });

    // JS-registered edge shapes: exact headless transcription from source.
    if (style.shape === 'mxgraph.arrows2.wedgeArrowDashed2') {
      var wd2 = wedgeArrowDashed2Path(style, points);
      if (wd2) {
        paint.push({ kind: 'path', d: wd2, fill: null, stroke: stroke });
        var wd2Label = plainLabel(graph, cell);
        if (wd2Label !== '') {
          var wd2Box = edgeLabelBox(state, style, origin, scale, wd2Label);
          var wd2lb = labelBoxNode(style, wd2Box);
          if (wd2lb) paint.push(wd2lb);
          paint.push(labelTextNode(graph, cell, state, style, wd2Box, wd2Label, notices, resolved));
        }
        return;
      }
    }
    if (style.shape === 'flexArrow') {
      var fap = flexArrowPath(style, points);
      if (fap) {
        paint.push({ kind: 'path', d: fap, fill: fillOf(style), stroke: stroke });
        var faLabel = plainLabel(graph, cell);
        if (faLabel !== '') {
          var faBox = edgeLabelBox(state, style, origin, scale, faLabel);
          var falb = labelBoxNode(style, faBox);
          if (falb) paint.push(falb);
          paint.push(labelTextNode(graph, cell, state, style, faBox, faLabel, notices, resolved));
        }
        return;
      }
    }

    if (style.shape && style.shape !== 'connector') {
      notices.push(degradation('ExporterUnsupportedShape',
        'Custom edge shape "' + style.shape + '" exported as straight-line fallback.', cell.id));
    }
    paint.push({
      kind: 'path',
      d: edgePath(points, boolish(style.rounded), boolish(style.curved), number(style.arcSize, 20) / 2),
      fill: null,
      stroke: stroke
    });

    var arrowFill = stroke.paint || solid('#000000', 1);
    var arrowSize = Math.max(7, stroke.width * 5);
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
    if (style.endArrow && style.endArrow !== 'none') {
      var endNode = edgeMarkerNode(style.endArrow, points[points.length - 2],
        points[points.length - 1], arrowSize, stroke, endArrowFill, cell.id, notices, endFilled);
      if (Array.isArray(endNode)) endNode.forEach(function(n) { if (n) paint.push(n); });
      else if (endNode) paint.push(endNode);
    }
    if (style.startArrow && style.startArrow !== 'none') {
      var startNode = edgeMarkerNode(style.startArrow, points[1], points[0],
        arrowSize, stroke, startArrowFill, cell.id, notices, startFilled);
      if (Array.isArray(startNode)) startNode.forEach(function(n) { if (n) paint.push(n); });
      else if (startNode) paint.push(startNode);
    }

    var label = plainLabel(graph, cell);
    if (label !== '') {
      var elBox = edgeLabelBox(state, style, origin, scale, label);
      var elb = labelBoxNode(style, elBox);
      if (elb) paint.push(elb);
      paint.push(labelTextNode(graph, cell, state, style, elBox, label, notices, resolved));
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
