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
  function stencilToSvg(shapeNode, cellW, cellH, style, notices) {
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
            state.strokeColor = a.color || state.strokeColor;
            break;
          case 'fillcolor':
            state.fillColor = a.color || state.fillColor;
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
            state.fontColor = a.color || state.fontColor;
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

          // image: emit inline if src is already a data URI; otherwise loud notice.
          // Uses break (not return) so subsequent siblings (fillstroke etc.) still run.
          case 'image': {
            var imgSrc = a.src || '';
            if (imgSrc.indexOf('data:') === 0) {
              var imgPar = a.aspect === 'fixed' ? 'xMidYMid meet' : 'none';
              elems.push('<image href="' + imgSrc + '"' +
                ' x="' + fmt(tx(parseFloat(a.x) || 0)) + '"' +
                ' y="' + fmt(ty(parseFloat(a.y) || 0)) + '"' +
                ' width="' + fmt(trx(parseFloat(a.w) || 0)) + '"' +
                ' height="' + fmt(try_(parseFloat(a.h) || 0)) + '"' +
                ' preserveAspectRatio="' + imgPar + '"/>');
            } else {
              if (Array.isArray(notices)) notices.push(degradation('ExporterUnsupportedStencilFeature',
                'stencil uses <image> with external URL (cannot embed headlessly)', ''));
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
            var isSvg = stencilToSvg(isNode, isW * sw, isH * sh, style, notices);
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
  function resolveCssColorFns(s, dark) {
    if (typeof s !== 'string') return s;
    if (s.indexOf('light-dark(') < 0 && s.indexOf('var(') < 0) return s;
    var matchEnd = function (str, openIdx) {        // index of matching ')'
      var depth = 0;
      for (var i = openIdx; i < str.length; i++) {
        var ch = str.charAt(i);
        if (ch === '(') depth++;
        else if (ch === ')' && --depth === 0) return i;
      }
      return -1;
    };
    var splitTop = function (a) {                    // split on top-level commas
      var parts = [], depth = 0, cur = '';
      for (var i = 0; i < a.length; i++) {
        var ch = a.charAt(i);
        if (ch === '(') depth++; else if (ch === ')') depth--;
        if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; }
        else cur += ch;
      }
      parts.push(cur);
      return parts;
    };
    for (var guard = 0; guard < 500; guard++) {
      var m = /light-dark\(|var\(/i.exec(s);
      if (!m) break;
      var open = s.indexOf('(', m.index);
      var close = matchEnd(s, open);
      if (close < 0) break;                          // malformed — leave as-is
      var parts = splitTop(s.slice(open + 1, close)).map(function (p) { return p.trim(); });
      var repl = /^light-dark/i.test(m[0])
        ? (dark ? (parts[1] || parts[0]) : parts[0])  // active side
        : parts.slice(1).join(',').trim();            // var() -> its fallback
      s = s.slice(0, m.index) + (repl || '') + s.slice(close + 1);
    }
    return s;
  }

  // isVertex flag distinguishes the default-style sets from styles/default.xml:
  // defaultVertex has fillColor="default", strokeColor="default", fontColor="default";
  // defaultEdge has strokeColor="default", fontColor="default" (no fill).
  // The live path: getCellStyle merges the mxStylesheet defaults so these keys
  // are always present. The headless path: getCellStyle returns only the raw cell
  // style → no defaults. Supply them here so headless and live are consistent.
  function resolveThemeDefaults(style, graph, isVertex) {
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

  // --- SVG-string helpers for headless rotated-shape nodes ---
  // Used by emitVertex when style.rotation≠0 and there is no live DOM.
  // Produces kind:'svg' so shape + label rotate together (matches svgCellNode).

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

  // Generate an inline SVG with hatch/dot fill for sketch=1 shapes in mode B.
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

    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + fmt(w) + '" height="' + fmt(h) + '">' +
      '<defs><clipPath id="sk"><path d="' + relD + '"/></clipPath></defs>' +
      '<g clip-path="url(#sk)">' + content + '</g>' +
      '<path d="' + relD + '" fill="none"' + strokeSvgAttrs(style) + '/>' +
      '</svg>';
  }

  function textSvgStr(label, cx, cy, style) {
    if (!label) return '';
    var fs = Math.max(1, number(style.fontSize, 11));
    var ff = style.fontFamily || 'Arial';
    var fc = style.fontColor || '#000000';
    var fsVal = number(style.fontStyle, 0);
    var isBold = !!(fsVal & 1);
    var isItalic = !!(fsVal & 2);
    var attrs = ' text-anchor="middle" dominant-baseline="central"' +
      ' font-family="' + escXml(ff) + '" font-size="' + fmt(fs) + '"' +
      ' fill="' + fc + '"' +
      (isBold ? ' font-weight="bold"' : '') +
      (isItalic ? ' font-style="italic"' : '');
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

  function textDefaultAlign(style) {
    return alignH(style.align || (style.shape === 'text' ? 'left' : 'center'));
  }

  function textDefaultValign(style) {
    return alignV(style.verticalAlign || (style.shape === 'text' ? 'top' : 'middle'));
  }

  function htmlTextBlocks(raw, style) {
    var s = String(raw == null ? '' : raw);
    if (s.indexOf('<') < 0) {
      return String(s).split('\n').map(function (line) {
        return { text: line, size: Math.max(1, number(style.fontSize, 12)),
          weight: ((parseInt(style.fontStyle || 0, 10) || 0) & 1) ? 700 : 400,
          gap: 0 };
      });
    }

    var blocks = [];
    var re = /<(h[1-6]|p|div|li)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
    var m;
    while ((m = re.exec(s))) {
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

  function wrapSvgText(text, size, width, wrap) {
    var rawLines = String(text == null ? '' : text).split('\n');
    if (!wrap) return rawLines;
    var maxChars = Math.max(1, Math.floor(Math.max(1, width) / (size * 0.55)));
    var lines = [];
    rawLines.forEach(function (raw) {
      var words = raw.split(/\s+/).filter(function (w) { return w !== ''; });
      if (!words.length) { lines.push(''); return; }
      var line = '';
      words.forEach(function (word) {
        if (!line) { line = word; return; }
        if ((line + ' ' + word).length <= maxChars) line += ' ' + word;
        else { lines.push(line); line = word; }
      });
      if (line) lines.push(line);
    });
    return lines;
  }

  function textSvgNode(graph, cell, style, box, label) {
    var raw = graph && typeof graph.getLabel === 'function' ? graph.getLabel(cell) : label;
    var blocks = htmlTextBlocks(raw != null ? raw : label, style);
    var fst = parseInt(style.fontStyle || 0, 10) || 0;
    var family = style.fontFamily || 'Arial';
    var color = isPaintable(style.fontColor) ? hex(style.fontColor) : '#000000';
    var h = textDefaultAlign(style);
    var v = textDefaultValign(style);
    var pad = style.shape === 'text' ? 0 : 2;
    var usableW = Math.max(1, box.w - pad * 2);
    var rows = [];
    blocks.forEach(function (b) {
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
      v === 'bottom' ? box.h - totalH : 0;
    y = Math.max(0, y);
    var decoration = [];
    if (fst & 4) decoration.push('underline');
    if (fst & 8) decoration.push('line-through');
    var textEls = rows.map(function (r, i) {
      y += (i === 0 ? 0 : r.gap);
      var ty = y;
      y += r.lineH;
      var rowH = alignH(r.align || h);
      var anchor = rowH === 'right' ? 'end' : rowH === 'center' ? 'middle' : 'start';
      var x = rowH === 'right' ? box.w - pad : rowH === 'center' ? box.w / 2 : pad;
      var rowDec = decoration.slice();
      if (r.underline && rowDec.indexOf('underline') < 0) rowDec.push('underline');
      return '<text x="' + fmt(x) + '" y="' + fmt(ty) +
        '" font-family="' + escXml(family) + ', Arial, sans-serif"' +
        ' font-size="' + fmt(r.size) + '" font-weight="' + r.weight + '"' +
        ((fst & 2) ? ' font-style="italic"' : '') +
        (rowDec.length ? ' text-decoration="' + rowDec.join(' ') + '"' : '') +
        ' fill="' + color + '" text-anchor="' + anchor +
        '" dominant-baseline="text-before-edge" xml:space="preserve">' +
        escXml(r.text) + '</text>';
    }).join('');

    if (style.horizontal === '0') {
      var cx = box.w / 2, cy = box.h / 2;
      textEls = '<g transform="rotate(-90 ' + fmt(cx) + ' ' + fmt(cy) + ')">' +
        '<text x="' + fmt(cx) + '" y="' + fmt(cy) +
        '" font-family="' + escXml(family) + ', Arial, sans-serif"' +
        ' font-size="' + fmt(Math.max(1, number(style.fontSize, 12))) +
        '" font-weight="' + (((fst & 1) ? 700 : 400)) + '"' +
        ((fst & 2) ? ' font-style="italic"' : '') +
        ' fill="' + color +
        '" text-anchor="middle" dominant-baseline="central" xml:space="preserve">' +
        escXml(String(label || stripHtml(raw))) + '</text></g>';
    }

    var clipId = 'txt' + String(cell && cell.id || Math.random()).replace(/[^a-z0-9]/gi, '');
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + fmt(box.w) +
      '" height="' + fmt(box.h) + '"><defs><clipPath id="' + clipId +
      '"><rect x="0" y="0" width="' + fmt(box.w) + '" height="' + fmt(box.h) +
      '"/></clipPath></defs><g clip-path="url(#' + clipId + ')">' + textEls +
      '</g></svg>';
    return { kind: 'svg', box: box, source: base64(svg), aspect: 'preserve' };
  }

  function labelTextNode(graph, cell, state, style, box, label, notices, mode) {
    return mode === 'B'
      ? textSvgNode(graph, cell, style, box, label)
      : textNode(graph, cell, state, style, box, label, notices);
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
    var isHoriz = style.horizontal !== '0';
    var startSize = Math.min(Math.max(0, number(style.startSize, 30)), isHoriz ? h : w);
    var body = boolish(style.rounded)
      ? roundedRectPath(x, y, w, h, Math.min(w, h) * number(style.arcSize, 10) / 100)
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
  function hexagonPath(x, y, w, h) {
    var dx = w / 4;
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

  function shapePath(style, x, y, w, h) {
    var shape = style.shape || 'rectangle';
    if (shape === 'ellipse') return ellipsePath(x, y, w, h);
    if (shape === 'rhombus' || shape === 'diamond') return rhombusPath(x, y, w, h);
    if (shape === 'triangle') return trianglePath(x, y, w, h, style.direction);
    if (shape === 'cylinder') return cylinderPath(x, y, w, h);
    if (shape === 'cloud') return cloudPath(x, y, w, h);
    if (shape === 'hexagon') return hexagonPath(x, y, w, h);
    if (shape === 'doubleEllipse') return doubleEllipsePath(x, y, w, h);
    if (shape === 'actor') return actorPath(x, y, w, h);
    if (shape === 'swimlane') return swimlanePath(style, x, y, w, h);
    if (shape === 'line') return linePath(x, y, w, h);
    if (shape === 'arrow') return arrowShapePath(x, y, w, h);
    if (shape === 'arrowConnector') return arrowConnectorPath(x, y, w, h);
    if (shape === 'connector') return connectorPath(x, y, w, h);
    if (shape === 'note') return rectPath(x, y, w, h);
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
        ? roundedRectPath(x, y, w, h, Math.min(w, h) * 0.12)
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
    if (shape === 'process') {
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

  function edgePath(points, rounded, curved) {
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

  // base64 (UTF-8) -> string. Browser-only (atob/TextDecoder); only reached on
  // the live path where svgCellNode produced a node, so the globals exist.
  function decodeUtf8B64(b64) {
    var bin = root.atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return (typeof root.TextDecoder === 'function')
      ? new root.TextDecoder().decode(bytes) : bin;
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
        if (!d) {
          // transformPath returns null for malformed/unsupported path data
          // (unknown command letter, missing argument, etc). Silently
          // dropping the primitive would lose part of the shape — violates
          // C1. Loud notice so the operator knows a fragment of geometry
          // was skipped; the rest of the shape stays faithful.
          if (Array.isArray(notices)) {
            notices.push(degradation('ExporterUnsupportedShape',
              'drawio-rendered SVG primitive carried path data the bake ' +
              'could not normalize (tag=' + tag + '); fragment skipped, ' +
              'remaining geometry kept faithful',
              cell.id));
          }
          continue;
        }
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
        // Only emit the notice when getComputedStyle is unavailable — when the
        // shim provides it (Path B headless), the detached parse is faithful for
        // draw.io's HTML label vocabulary (all properties set explicitly via
        // inline styles, semantic tags, and font attributes; no CSS cascade).
        if (typeof root.getComputedStyle !== 'function') {
          if (Array.isArray(notices)) notices.push(degradation('RichApproximate', 'rich text live DOM not available; using detached parser', cell.id));
        }
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
        if (Array.isArray(notices)) notices.push(degradation('RichApproximateAlpha', 'rgba text color alpha dropped for rich text run (print is opaque)', cell.id));
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

  // --- CSS background-image -> faithful flat SVG ---------------------------
  // A CSS gradient transcribes losslessly to an SVG <linearGradient>/
  // <radialGradient> (resvg renders both, incl. inline <defs> — verified), and
  // a data-URI url() embeds as <image> (PNG/JPEG/GIF/SVG). Only genuinely
  // non-embeddable content (external http URL, or exotic forms like conic /
  // image-set / paint()) stays loudly noticed. This removes the blanket
  // "background-image not transcribed" warning for the faithfully-reproducible
  // cases.
  function splitTopLevel(str, sep) {
    var out = [], depth = 0, cur = '';
    for (var i = 0; i < str.length; i++) {
      var ch = str[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === sep && depth === 0) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map(function (s) { return s.trim(); })
      .filter(function (s) { return s !== ''; });
  }

  // CSS gradient angle (deg, clockwise from "to top") -> objectBoundingBox
  // gradient-line endpoints. 0=to top, 90=to right, 180=to bottom.
  function gradientLineFromAngle(deg) {
    var t = ((deg % 360) + 360) % 360 * Math.PI / 180;
    var s = Math.sin(t), c = Math.cos(t);
    return { x1: fmt(0.5 - 0.5 * s), y1: fmt(0.5 + 0.5 * c),
      x2: fmt(0.5 + 0.5 * s), y2: fmt(0.5 - 0.5 * c) };
  }

  var SIDE_ANGLE = { 'top': 0, 'right': 90, 'bottom': 180, 'left': 270,
    'top right': 45, 'right top': 45, 'bottom right': 135, 'right bottom': 135,
    'bottom left': 225, 'left bottom': 225, 'top left': 315, 'left top': 315 };
  var bgGradSeq = 0;

  function cssGradientDefAndFill(bgi) {
    var m = /^(?:repeating-)?(linear|radial)-gradient\(([\s\S]*)\)$/i.exec(bgi.trim());
    if (!m) return null;
    var kind = m[1].toLowerCase();
    var args = splitTopLevel(m[2], ',');
    if (args.length < 2) return null;
    var angle = 180;   // CSS default direction = to bottom
    // A leading non-color token is a direction (linear) or shape/size/position
    // descriptor (radial, approximated as centered).
    var firstColorish = colorParts(args[0].replace(/\s+-?[\d.]+%\s*$/, ''));
    if (!firstColorish || firstColorish.none) {
      var dm = /^(-?[\d.]+)deg$/i.exec(args[0]);
      if (dm) angle = parseFloat(dm[1]);
      else if (/^to\s+/i.test(args[0])) {
        var side = args[0].replace(/^to\s+/i, '').trim().toLowerCase()
          .replace(/\s+/g, ' ');
        if (SIDE_ANGLE[side] != null) angle = SIDE_ANGLE[side];
      }
      args = args.slice(1);
    }
    if (args.length < 2) return null;
    var stops = [];
    for (var i = 0; i < args.length; i++) {
      var pm = /^([\s\S]+?)\s+(-?[\d.]+)%$/.exec(args[i].trim());
      var color = pm ? pm[1] : args[i].trim();
      var pos = pm ? clamp01(parseFloat(pm[2]) / 100) : null;
      var cp = colorParts(color);
      if (!cp || cp.none) return null;   // a stop we can't represent -> bail
      stops.push({ cp: cp, pos: pos });
    }
    if (stops.length < 2) return null;
    for (var k = 0; k < stops.length; k++) {
      if (stops[k].pos == null) stops[k].pos = k / (stops.length - 1);
    }
    var stopSvg = stops.map(function (s) {
      return '<stop offset="' + fmt(s.pos) + '" stop-color="' + s.cp.hex + '"' +
        (s.cp.alpha < 1 ? ' stop-opacity="' + fmt(s.cp.alpha) + '"' : '') + '/>';
    }).join('');
    var id = 'lblbg' + (++bgGradSeq);
    if (kind === 'linear') {
      var L = gradientLineFromAngle(angle);
      return { id: id, def: '<linearGradient id="' + id + '" x1="' + L.x1 +
        '" y1="' + L.y1 + '" x2="' + L.x2 + '" y2="' + L.y2 + '">' +
        stopSvg + '</linearGradient>' };
    }
    return { id: id, def: '<radialGradient id="' + id +
      '" cx="0.5" cy="0.5" r="0.5">' + stopSvg + '</radialGradient>' };
  }

  function backgroundImageSvg(cs, rect, noticeOnce, resolved) {
    if (!cs || !rect || (!rect.width && !rect.height)) return '';
    var bgi = cs.backgroundImage;
    if (!bgi || bgi === 'none' || bgi === '') return '';
    var box = 'x="' + fmt(rect.left) + '" y="' + fmt(rect.top) + '" width="' +
      fmt(rect.width) + '" height="' + fmt(rect.height) + '"';
    if (/gradient\(/i.test(bgi)) {
      var g = cssGradientDefAndFill(bgi);
      if (g) {
        return '<defs>' + g.def + '</defs><rect ' + box +
          ' fill="url(#' + g.id + ')"/>';
      }
      if (typeof noticeOnce === 'function') {
        noticeOnce('RichUnsupported',
          'HTML-label CSS background gradient uses a form the bake cannot ' +
          'transcribe (e.g. conic / multi-position); printed without it');
      }
      return '';
    }
    var um = /url\(\s*["']?([^"')]+)["']?\s*\)/i.exec(bgi);
    if (um) {
      var parsed = parseImage(um[1]);
      var mime = embeddableImageMime(parsed);
      // Direct data URI, or an external URL pre-fetched/proxied into one.
      var href = mime ? ('data:' + mime + ';base64,' + parsed.data)
        : (resolved && resolved[um[1]]) || null;
      if (href) {
        return '<image ' + box + ' preserveAspectRatio="none" xlink:href="' +
          href + '"/>';
      }
      if (typeof noticeOnce === 'function') {
        noticeOnce('RichUnsupported',
          'HTML-label CSS background-image references ' +
          (parsed && parsed.externalUrl ? 'an external URL that could not be fetched' :
            'unembeddable content') + '; printed without it');
      }
      return '';
    }
    if (typeof noticeOnce === 'function') {
      noticeOnce('RichUnsupported',
        'HTML-label CSS background-image form is not transcribable; ' +
        'printed without it');
    }
    return '';
  }

  // --- CSS borders on HTML-label elements -> faithful flat SVG -------------
  // resvg renders <rect>/<line> with stroke + dasharray exactly, so a CSS
  // border transcribes losslessly (no flatten-to-one-side approximation):
  //   * uniform border (all sides share style/width/color) -> one stroked
  //     <rect> (clean mitred corners);
  //   * per-side differences (left=red / right=blue, mixed widths/styles) ->
  //     each visible side as its own stroked <line> at the band centre, so the
  //     per-side look prints exactly;
  //   * solid -> plain; dashed/dotted -> dasharray; double -> two 1/3 strokes
  //     with the 1/3 gap;
  //   * none/hidden/zero-width/transparent side -> nothing.
  // Only the 3D bevel styles (groove/ridge/inset/outset) have no flat-SVG
  // equivalent (they need the browser's computed light/dark edge shades);
  // those render as a solid edge of the border colour and stay loudly noticed
  // (a genuine approximation, per C1).
  var BEVEL_STYLES = { groove: true, ridge: true, inset: true, outset: true };

  function borderDash(style, w) {
    if (style === 'dashed') {
      return Math.max(2, Math.round(w * 3)) + ',' + Math.max(1, Math.round(w * 1.5));
    }
    if (style === 'dotted') {
      return Math.max(1, Math.round(w)) + ',' + Math.max(1, Math.round(w * 2));
    }
    return null;
  }

  function borderStrokeAttrs(cp, width, dash) {
    return ' fill="none" stroke="' + cp.hex + '" stroke-width="' + fmt(width) +
      '"' + (cp.alpha < 1 ? ' stroke-opacity="' + fmt(cp.alpha) + '"' : '') +
      (dash ? ' stroke-dasharray="' + dash + '"' : '');
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
  function bevelSideColor(nx, ny, e) {
    var topLeft = (nx > 0 || ny > 0);                 // inward normal R/Down
    var raised = (e.style === 'outset' || e.style === 'ridge');
    var lit = (topLeft === raised);                   // lit edge keeps colour
    return lit ? e.cp : { hex: shadeHex(e.cp.hex, 0.5), alpha: e.cp.alpha };
  }

  // One side as a stroked <line>, offset inward (nx,ny = inward unit normal)
  // to the centre of its border band. `double` -> two thin parallel strokes;
  // 3D bevels -> a per-side shaded solid edge.
  function borderSide(ax, ay, bx, by, nx, ny, e) {
    var line = function (off, width, dash, cp) {
      return '<line x1="' + fmt(ax + nx * off) + '" y1="' + fmt(ay + ny * off) +
        '" x2="' + fmt(bx + nx * off) + '" y2="' + fmt(by + ny * off) + '"' +
        borderStrokeAttrs(cp || e.cp, width, dash) + '/>';
    };
    if (e.style === 'double') {
      var t = e.w / 3;
      return line(t / 2, t, null) + line(e.w - t / 2, t, null);
    }
    if (BEVEL_STYLES[e.style]) {
      return line(e.w / 2, e.w, null, bevelSideColor(nx, ny, e));
    }
    return line(e.w / 2, e.w, borderDash(e.style, e.w));
  }

  function borderRect(cs, rect, noticeOnce) {
    if (!cs || !rect || (!rect.width && !rect.height)) return '';
    var names = ['Top', 'Right', 'Bottom', 'Left'];
    var spec = names.map(function (s) {
      var style = (cs['border' + s + 'Style'] || cs.borderStyle || 'none')
        .toLowerCase();
      var w = parseFloat(cs['border' + s + 'Width'] || cs.borderWidth || '0');
      var cp = colorParts(cs['border' + s + 'Color'] || cs.borderColor || '');
      var visible = style !== 'none' && style !== 'hidden' &&
        Number.isFinite(w) && w > 0 && cp && !cp.none && cp.alpha !== 0;
      return { style: style, w: visible ? w : 0,
        cp: (cp && !cp.none) ? cp : { hex: '#000000', alpha: 1 },
        visible: visible };
    });
    if (!spec.some(function (e) { return e.visible; })) return '';

    var s0 = spec[0];
    // Bevel styles are intrinsically two-tone, so they always take the
    // per-side path (a single <rect> can't carry the light/dark split).
    var uniform = !spec.some(function (e) { return BEVEL_STYLES[e.style]; }) &&
      spec.every(function (e) { return e.visible; }) &&
      spec.every(function (e) {
        return e.style === s0.style && e.w === s0.w &&
          e.cp.hex === s0.cp.hex && e.cp.alpha === s0.cp.alpha;
      });

    var L = rect.left, T = rect.top,
        Rt = rect.left + rect.width, Bt = rect.top + rect.height;

    if (uniform) {
      var rectStroke = function (inset, sw, dash) {
        return '<rect x="' + fmt(L + inset) + '" y="' + fmt(T + inset) +
          '" width="' + fmt(Math.max(0, rect.width - 2 * inset)) +
          '" height="' + fmt(Math.max(0, rect.height - 2 * inset)) + '"' +
          borderStrokeAttrs(s0.cp, sw, dash) + '/>';
      };
      if (s0.style === 'double') {
        var td = s0.w / 3;
        return rectStroke(td / 2, td, null) + rectStroke(s0.w - td / 2, td, null);
      }
      return rectStroke(s0.w / 2, s0.w, borderDash(s0.style, s0.w));
    }

    // Per-side: one stroked line per visible side (butt caps; for typical thin
    // borders the <=w corner gap is sub-visual and the per-side colours print
    // exactly). Bevel styles render two-tone via bevelSideColor.
    var out = '';
    if (spec[0].visible) out += borderSide(L, T, Rt, T, 0, 1, spec[0]);
    if (spec[1].visible) out += borderSide(Rt, T, Rt, Bt, -1, 0, spec[1]);
    if (spec[2].visible) out += borderSide(L, Bt, Rt, Bt, 0, -1, spec[2]);
    if (spec[3].visible) out += borderSide(L, T, L, Bt, 1, 0, spec[3]);
    return out;
  }

  function pushListMarkerApprox(notices, detail, cellId) {
    if (!Array.isArray(notices)) return;
    notices.push(degradation('SvgListMarkerApprox', detail, cellId));
  }

  function textRunSvg(run) {
    var R = run, f = R.f;
    if (f.fill == null) return '';
    var cx = R.rect.left + R.rect.width / 2, cy = R.rect.top + R.rect.height / 2;
    // Default (horizontal) placement: client rects are line-box tall; the
    // browser centres glyphs in the line box (half-leading). Anchor the em-box
    // top there so vertical placement matches the screen exactly.
    var tx = R.rect.left;
    var ty = R.rect.top + Math.max(0, (R.rect.height - f.size) / 2);
    var anchor = R.anchor || 'start';
    // Vertical label (mxText horizontal=false renders rotated): drawio lays the
    // word boxes in a column but the transcribed glyphs are horizontal → they
    // overflow. Each word's client rect is the ALREADY-rotated box (narrow ×
    // word-length). Centre the horizontal glyph run on that box centre, then
    // rotate -90 about the same centre, so the word fills its box symmetrically.
    // (Anchoring at rect.left and rotating about the centre offset each word by
    // ~half its length, so neighbouring words collided — the overlap bug.)
    if (R.rotate) {
      tx = cx; anchor = 'middle'; ty = cy - f.size / 2;
    }
    var t = '<text x="' + fmt(tx) + '" y="' + fmt(ty) +
      '" font-family="' + xmlEsc(f.fam) + '" font-size="' + fmt(f.size) +
      '" font-weight="' + f.weight + '"' +
      (f.italic ? ' font-style="italic"' : '') +
      (f.decoration ? ' text-decoration="' + f.decoration + '"' : '') +
      (f.letterSpacing != null
        ? ' letter-spacing="' + fmt(f.letterSpacing) + '"' : '') +
      ' fill="' + f.fill + '"' +
      (f.fillOpacity < 1 ? ' fill-opacity="' + fmt(f.fillOpacity) + '"' : '') +
      ' text-anchor="' + anchor +
      '" dominant-baseline="text-before-edge"' +
      ' xml:space="preserve">' + xmlEsc(R.text) + '</text>';
    if (R.rotate) {
      return '<g transform="rotate(' + fmt(R.rotate) + ' ' + fmt(cx) + ' ' +
        fmt(cy) + ')">' + t + '</g>';
    }
    return t;
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
  function transcribeForeignObjects(fos, M, cellId, notices, resolved, runRotation) {
    var bg = [], runs = [];
    // Accumulate the TEXT runs' measured SCREEN bbox so the caller can grow the
    // node box to fit an external label (verticalLabelPosition=bottom/top) that
    // would otherwise be clipped by the svg viewBox. Only the actual glyph runs
    // are measured — NOT raw element rects, since drawio's transparent label
    // wrapper reports a container-sized rect that would explode the box.
    var sxMin = Infinity, syMin = Infinity, sxMax = -Infinity, syMax = -Infinity;
    var acc = function (rc) {
      if (!rc) return;
      if (rc.left < sxMin) sxMin = rc.left;
      if (rc.top < syMin) syMin = rc.top;
      if (rc.left + rc.width > sxMax) sxMax = rc.left + rc.width;
      if (rc.top + rc.height > syMax) syMax = rc.top + rc.height;
    };
    var measurable = root && typeof root.getComputedStyle === 'function';
    // Per-cell notice dedup. A label with N nested divs all carrying the
    // same unsupported CSS feature would otherwise emit N identical
    // notices; we want one per cell + kind so the operator UI is not
    // spammed. Closure captures the notices array; each helper checks
    // before pushing.
    var firedHere = {};
    function noticeOnce(kind, detail) {
      var key = kind + '\0' + detail;
      if (firedHere[key]) return;
      firedHere[key] = true;
      if (Array.isArray(notices)) {
        notices.push(degradation(kind, detail, cellId));
      }
    }
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
      // Outermost element background = drawio label background. Also
      // transcribes a CSS border (if any) and flags a CSS
      // background-image as loud-noticed.
      var rootEl = null;
      for (var c = 0; fo.childNodes && c < fo.childNodes.length; c++) {
        if (fo.childNodes[c].nodeType === 1) { rootEl = fo.childNodes[c]; break; }
      }
      if (rootEl) {
        var rcs = root.getComputedStyle(rootEl);
        var rr = rootEl.getBoundingClientRect();
        bg.push(bgRect(rcs, rr));               // CSS paint order: color,
        bg.push(backgroundImageSvg(rcs, rr, noticeOnce, resolved));  // then image,
        bg.push(borderRect(rcs, rr, noticeOnce));          // then border.
      }
      var walk = function (n) {
        if (!n) return;
        if (n.nodeType === 1) {
          var ecs = root.getComputedStyle(n);
          if (n !== rootEl) {
            var er = n.getBoundingClientRect();
            bg.push(bgRect(ecs, er));
            bg.push(backgroundImageSvg(ecs, er, noticeOnce, resolved));
            bg.push(borderRect(ecs, er, noticeOnce));
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
              // Genuinely unknown list-style-type (e.g. georgian / armenian /
              // a CJK system): we substitute a bullet, which IS a divergence
              // from the real marker -> stays loudly noticed (C1). Standard
              // CSS list types are all covered by listMarker() above.
              glyph = '•';
              pushListMarkerApprox(notices,
                'list-style-type "' + lt + '" has no standard glyph; ' +
                'rendered as a bullet', cellId);
            }
            // Known marker glyph/number is exact. For list-style-position:
            // outside the CSS spec itself defines the marker-box position as
            // UA-approximated, so right-anchoring the glyph at the measured
            // first-content position is a faithful rendering — no notice.
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
          // Inline images (<img>) in HTML labels: a common drawio pattern
          // is "icon + text" inside a label. Previously silently dropped.
          // Transcribe inline PNG data URIs as <image> at the rendered
          // position; loudly notice anything else (external URL, JPEG, ...).
          if (String(n.tagName || '').toLowerCase() === 'img') {
            var src = n.getAttribute && n.getAttribute('src');
            var ir = n.getBoundingClientRect();
            var parsed = parseImage(src);
            var mime = embeddableImageMime(parsed);
            var imgHref = (mime && parsed)
              ? 'data:' + mime + ';base64,' + parsed.data
              : (resolved && src && resolved[src])          // pre-fetched/proxied
                || (ir && ir.width && ir.height ? imgElementToPngDataUri(n) : null);
            if (imgHref && ir && ir.width && ir.height) {
              // Embeddable data URI (PNG/JPEG/GIF/SVG) OR an external/loaded
              // <img> re-encoded via canvas (owner-authorised) -> faithful,
              // no notice.
              bg.push('<image x="' + fmt(ir.left) + '" y="' + fmt(ir.top) +
                '" width="' + fmt(ir.width) + '" height="' + fmt(ir.height) +
                '" preserveAspectRatio="none" xlink:href="' + imgHref + '"/>');
            } else {
              noticeOnce('RichUnsupported',
                'inline <img> in HTML label cannot be embedded (' +
                (parsed && parsed.externalUrl
                  ? 'external URL, and its pixels are not readable (cross-origin, no CORS)'
                  : parsed && parsed.unsupportedFormat
                    ? 'format=' + parsed.unsupportedFormat
                    : 'unreadable src') +
                '); printed without the image');
            }
            // <img> has no children; skip the recursive descent that
            // would just visit its empty text content.
            return;
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
            acc(rc);
            runs.push({ rect: { left: rc.left, top: rc.top,
              width: rc.width, height: rc.height }, text: m[0], f: f });
          }
        }
      };
      walk(fo);
    }
    if (!runs.length && !bg.some(function (x) { return x !== ''; })) {
      return { html: '', bbox: null };
    }
    var body = bg.join('');
    if (runRotation) { for (var ri2 = 0; ri2 < runs.length; ri2++) runs[ri2].rotate = runRotation; }
    for (var j = 0; j < runs.length; j++) body += textRunSvg(runs[j]);
    return {
      html: '<g transform="matrix(' + fmt(M.a) + ' ' + fmt(M.b) + ' ' +
        fmt(M.c) + ' ' + fmt(M.d) + ' ' + fmt(M.e) + ' ' + fmt(M.f) + ')">' +
        body + '</g>',
      bbox: (sxMax > sxMin && syMax > syMin)
        ? { minX: sxMin, minY: syMin, maxX: sxMax, maxY: syMax } : null
    };
  }

  // Build the contract `svg` node carrying the cell's literal rendered SVG.
  // Returns null (caller falls back) when there is no live DOM / serializer.
  var SVG_PAD = 2;   // contract px around the cell for stroke/marker overflow
  function svgCellNode(graph, cell, state, origin, scale, notices, resolved) {
    if (!state || !state.shape || !state.shape.node) return null;
    var shapeNode = state.shape.node;
    var doc = (shapeNode.ownerDocument) || root.document || null;
    var shapeStr = serializeEl(shapeNode);
    if (!shapeStr) return null;
    // LOUD-OR-FAITHFUL: resvg / tiny-skia render SMIL animation elements
    // as a static frame-0 snapshot with NO error or notice — a silent
    // divergence for any animated stencil. Detect at bake time and
    // surface a loud AnimatedSvgFrozen notice naming the cell so the
    // operator knows the print will be still even though the canvas was
    // moving. Covers every SMIL element with the silent-freeze
    // signature: <animate>, <animateTransform>, <animateMotion>,
    // <animateColor> (deprecated but supported), <set>, <discard>.
    if (Array.isArray(notices) &&
        /<(?:animate(?:Transform|Motion|Color)?|set|discard)[\s/>]/i.test(shapeStr)) {
      notices.push(degradation('AnimatedSvgFrozen',
        'SVG animation element found in this cell; the print rasterizer ' +
        'cannot animate ink and will render the initial frame only',
        cell && cell.id));
    }
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
    // Grow vb to the shape's ACTUAL rendered bounds (same scaled-view coords as
    // state). getBBox() includes child transforms — so rotated shapes (e.g.
    // associativeEntity rotation=-45) and wide arrow heads (flexArrow, wedge
    // arrows with large startWidth/endWidth) and stroke/marker overflow are no
    // longer cropped by a box sized to the unrotated geometry / bare endpoints.
    try {
      if (shapeNode && typeof shapeNode.getBBox === 'function') {
        var gb = shapeNode.getBBox();
        if (gb && gb.width > 0 && gb.height > 0 && isFinite(gb.x) && isFinite(gb.y)) {
          var gx = Math.min(vb.x, gb.x), gy = Math.min(vb.y, gb.y);
          vb = { x: gx, y: gy,
            w: Math.max(vb.x + vb.w, gb.x + gb.width) - gx,
            h: Math.max(vb.y + vb.h, gb.y + gb.height) - gy };
        }
      }
    } catch (e) { /* getBBox unavailable (headless harness) — keep geometry vb */ }
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
    // SVG-native text serializes in VIEW coords → it belongs INSIDE the
    // view→local group. Transcribed HTML labels are measured in SCREEN coords
    // and M maps screen→svg-local directly → they belong at the SVG ROOT. A
    // cell has one or the other; keep them separate so the screen-space label
    // is NOT also put through the view→local group (that double-applies the
    // mapping and the text lands outside the box → clipped/invisible: the
    // "labels missing in print" bug).
    var inlineLabel = textStr || '';
    var foLabel = '';
    var foLocal = null;                  // label bounds in svg-local units
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
      var M = mMul(Mtr, Sinv);
      // Vertical label (mxText horizontal=false → drawio renders it rotated,
      // e.g. a horizontal=0 swimlane's title): rotate each glyph-run -90° in
      // place so the column of words reads vertically instead of overflowing.
      var runRot = (state.style && String(state.style.horizontal) === '0' &&
        !number(state.style.rotation, 0)) ? -90 : 0;
      var fo = transcribeForeignObjects(fos, M, cell && cell.id, notices, resolved, runRot);
      foLabel = fo.html;
      inlineLabel = '';                 // the HTML label replaces any svg text
      if (fo.bbox) {                    // map screen bbox corners -> svg-local
        var cs = [[fo.bbox.minX, fo.bbox.minY], [fo.bbox.maxX, fo.bbox.minY],
          [fo.bbox.minX, fo.bbox.maxY], [fo.bbox.maxX, fo.bbox.maxY]];
        var lx = Infinity, ly = Infinity, lX = -Infinity, lY = -Infinity;
        for (var ci = 0; ci < 4; ci++) {
          var qx = M.a * cs[ci][0] + M.c * cs[ci][1] + M.e;
          var qy = M.b * cs[ci][0] + M.d * cs[ci][1] + M.f;
          if (qx < lx) lx = qx; if (qy < ly) ly = qy;
          if (qx > lX) lX = qx; if (qy > lY) lY = qy;
        }
        foLocal = { x: lx, y: ly, w: lX - lx, h: lY - ly };
      }
    }

    // Grow the node box so an EXTERNAL label (verticalLabelPosition=bottom/top,
    // or any overflow) is not clipped by the svg viewBox. Shift content + box
    // origin when the label extends above/left of the shape.
    var shiftX = 0, shiftY = 0;
    if (foLocal) {
      var minX = Math.min(0, foLocal.x), minY = Math.min(0, foLocal.y);
      var maxX = Math.max(box.w, foLocal.x + foLocal.w);
      var maxY = Math.max(box.h, foLocal.y + foLocal.h);
      if (minX < -0.01 || minY < -0.01 || maxX > box.w + 0.01 || maxY > box.h + 0.01) {
        shiftX = -minX; shiftY = -minY;
        box = { x: box.x - shiftX, y: box.y - shiftY,
          w: maxX - minX, h: maxY - minY };
      }
    }

    // Rotated cell (style.rotation): the harvested SHAPE carries its rotation
    // inline, but the transcribed label is laid out axis-aligned (getClientRects
    // loses glyph rotation) → it printed horizontal over a rotated shape. Rotate
    // the label group by the cell's rotation around the cell-geometry center so
    // it follows the shape (EXPERIMENTAL — approximate for centered labels).
    var rot = number(state.style && state.style.rotation, 0);
    if (rot && foLabel) {                 // rotated cell: rotate label about the
      var rcx = SVG_PAD + (state.x + state.width / 2 - vb.x) / scale;  // cell center
      var rcy = SVG_PAD + (state.y + state.height / 2 - vb.y) / scale;
      foLabel = '<g transform="rotate(' + fmt(rot) + ' ' + fmt(rcx) + ' ' +
        fmt(rcy) + ')">' + foLabel + '</g>';
    }

    // view coords -> svg-local: translate(pad) scale(1/s) translate(-vb)
    var tr = 'translate(' + fmt(SVG_PAD) + ' ' + fmt(SVG_PAD) + ') scale(' +
      fmt(1 / scale) + ') translate(' + fmt(-vb.x) + ' ' + fmt(-vb.y) + ')';
    var inner = '<g transform="' + tr + '">' + shapeStr + inlineLabel + '</g>' + foLabel;
    if (shiftX || shiftY) {
      inner = '<g transform="translate(' + fmt(shiftX) + ' ' + fmt(shiftY) + ')">' +
        inner + '</g>';
    }
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" ' +
      'xmlns:xlink="http://www.w3.org/1999/xlink" width="' + fmt(box.w) +
      '" height="' + fmt(box.h) + '">' +
      (defs.length ? '<defs>' + defs.join('') + '</defs>' : '') +
      inner + '</svg>';

    // Resolve theme CSS (light-dark()/var()) so resvg renders real colors, not
    // black. Active-theme side per isDark() (STRICT WYSIWYG — never forced).
    // Also give bare font-families a generic fallback: drawio's default is
    // "Helvetica", which isn't installed on Windows, so resvg falls back to its
    // SERIF default (text printed serif). Appending a sans-serif generic makes
    // resvg pick a sans face (Arial), matching the editor's Helvetica/Arial.
    return { kind: 'svg', box: box,
      source: base64(addFontFallback(resolveCssColorFns(svg, isDark()))),
      aspect: 'preserve' };
  }

  // Append a sans-serif generic to drawio's default font so resvg doesn't fall
  // back to serif for the (uninstalled-on-Windows) "Helvetica" family.
  function addFontFallback(s) {
    if (typeof s !== 'string') return s;
    return s.replace(/font-family="Helvetica"/g,
      'font-family="Helvetica, Arial, sans-serif"');
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
    // 'A' = legacy (uses live browser DOM via svgCellNode); 'B' = unattended
    // (headless fallback only, no svgCellNode). Default 'A' for backwards compat;
    // bake.mjs always passes 'B'.
    var mode = (opts && opts.mode) || 'A';
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

    // WYSIWYG paint order = mxGraph z-order. The model's `cells` dict is keyed
    // by id (creation order); "Send to Back" / "Bring to Front" reorder a
    // cell's parent.children[] WITHOUT changing the dict. Iterating the dict
    // would silently print overlapping shapes in the wrong order — a C1
    // violation. Walk root → layers → descendants depth-first so the paint
    // list matches what the canvas draws back-to-front, exactly. The
    // dict-fallback path stays for headless fixtures / harnesses that do not
    // expose getRoot/getChildAt.
    var orderedCells = collectCellsInZOrder(model);
    orderedCells.forEach(function (cell) {
      if (cell == null || (!model.isVertex(cell) && !model.isEdge(cell))) return;
      var state = view.getState(cell);
      if (state == null) return;
      var isEdgeCell = model.isEdge(cell);
      var style = resolveThemeDefaults(
        graph.getCellStyle(cell) || state.style || {}, graph, !isEdgeCell);

      if (isEdgeCell) {
        emitEdge(graph, cell, state, style, origin, scale, paint, notices, resolved, mode);
        return;
      }
      emitVertex(graph, cell, state, style, origin, scale, paint, notices, resolved, mode);
    });

    // LOUD-OR-FAITHFUL: the v1 contract carries gradient stops + type but
    // NO direction (p0/p1 for linear, center/focus/radius for radial). The
    // live path emits `kind:"svg"` whose source SVG keeps direction inline,
    // so resvg renders it correctly. The headless / harvest fallback paths
    // (emitVertex's bbox + fillOf; harvestShape via elementPaint) emit
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
        meta: { bakePath: mode },
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

  function emitVertex(graph, cell, state, style, origin, scale, paint, notices, resolved, mode) {
    var box = scaledBox(state, origin, scale);
    var label = plainLabel(graph, cell);

    if (isImageCell(style)) {
      // PRIMARY (live path): transcribe drawio's literal rendered SVG so the
      // image rect, label position and (tight) label background come out exactly
      // as drawn — the manual composition below sized the image to the whole
      // cell (icon too large), placed an oversized label-bg box (it overran a
      // neighbour shape) and mis-placed the label. Embed the external <image>
      // href first (resvg can't fetch relative/cross-origin URLs). Falls through
      // to the manual path headless / if transcription fails.
      // Mode B: skip svgCellNode entirely — force headless fallback path.
      var isvg = (mode === 'B') ? null : svgCellNode(graph, cell, state, origin, scale, notices, resolved);
      if (isvg && isvg.kind === 'svg') {
        try {
          var dec = decodeUtf8B64(isvg.source);
          var emb = embedImageHrefs(dec, resolved, style);
          if (emb !== dec) isvg.source = base64(emb);
        } catch (e) { /* keep transcribed source as-is */ }
        paint.push(isvg);
        return;
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
          var imgEl = '<image x="' + fmt(imgOffX) + '" y="' + fmt(imgOffY) + '"' +
            ' width="' + fmt(imageBox.w) + '" height="' + fmt(imageBox.h) + '"' +
            ' preserveAspectRatio="' + imgFit + '"' +
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
        paint.push(labelTextNode(graph, cell, state, style, lb, label, notices, mode));
      }
      return;
    }

    // TRUE-WYSIWYG primary: emit the cell's literal rendered SVG (shape +
    // label together) so EVERY object type prints exactly as drawn, text
    // included. Falls through only with no live DOM (headless) or if
    // serialization fails.
    // Mode B: skip svgCellNode — force headless fallback path.
    var svgNode = (mode === 'B') ? null : svgCellNode(graph, cell, state, origin, scale, notices, resolved);
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
        paint.push(labelTextNode(graph, cell, state, style, box, label, notices, mode));
      }
      return;
    }

    // drawio's `text` shape (e.g. the "Paragraph of Text" element) paints no
    // body — it is a label-only object. Emitting a bbox path here is both
    // invisible (fill/stroke are none) and wrongly raised an
    // ExporterUnsupportedShape notice. Skip the body; just lay out the label.
    if (style.shape !== 'text') {

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

      if (stencilNode) {
        var stencilSvg = stencilToSvg(stencilNode, box.w, box.h, style, notices);
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
            var textElS = label !== '' ? textSvgStr(label, rcxS, rcyS, style) : '';
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
              paint.push(labelTextNode(graph, cell, state, style, lblBoxS, label, notices, mode));
            }
          }
          return;
        }
        // stencilToSvg returned null → notice already pushed; fall through to shapePath
      }
      // --- End stencil lookup ---

      // --- Built-in multi-element shapes (registered in Shapes.js, not stencil XML) ---
      var builtinContent = builtinShapeSvg(style, box.w, box.h);
      if (builtinContent !== null) {
        var rotDegBI = number(style.rotation, 0);
        if (rotDegBI) {
          var thetaBI = rotDegBI * Math.PI / 180;
          var expWBI = box.w * Math.abs(Math.cos(thetaBI)) + box.h * Math.abs(Math.sin(thetaBI));
          var expHBI = box.w * Math.abs(Math.sin(thetaBI)) + box.h * Math.abs(Math.cos(thetaBI));
          var offXBI = (expWBI - box.w) / 2;
          var offYBI = (expHBI - box.h) / 2;
          var rcxBI = expWBI / 2, rcyBI = expHBI / 2;
          var textElBI = label !== '' ? textSvgStr(label, rcxBI, rcyBI, style) : '';
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
          var svgStrBI = '<svg xmlns="http://www.w3.org/2000/svg" width="' + fmt(box.w) + '" height="' + fmt(box.h) + '">' + builtinContent + '</svg>';
          paint.push({ kind: 'svg', box: box, source: base64(svgStrBI), aspect: 'preserve' });
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
            paint.push(labelTextNode(graph, cell, state, style, lblBoxBI, label, notices, mode));
          }
        }
        return;
      }

      var d = shapePath(style, box.x, box.y, box.w, box.h);
      if (!d) {
        d = rectPath(box.x, box.y, box.w, box.h);
        notices.push(degradation('ExporterUnsupportedShape',
          'Unsupported shape "' + style.shape + '" exported as bounding box.', cell.id));
      }

      // Rotated shape (headless): construct a kind:'svg' node so both the shape
      // outline AND the label rotate together around the cell centre. This is
      // WYSIWYG — it matches what svgCellNode emits on the live-DOM path.
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
        var relD = shapePath(style, offX, offY, box.w, box.h) ||
                   rectPath(offX, offY, box.w, box.h);
        // Linear gradient defs (left-to-right in rotated frame; more accurate
        // than the path fallback since direction rotates with the shape).
        var defs = '';
        var gradId = '';
        if (isPaintable(style.gradientColor)) {
          gradId = 'g' + String(cell.id || '').replace(/[^a-z0-9]/gi, '');
          defs = '<defs>' + linearGradDef(gradId, hex(style.fillColor), hex(style.gradientColor), style.gradientDirection) + '</defs>';
        }
        var pathEl = '<path d="' + relD + '"' +
          fillSvgAttr(style, gradId) + strokeSvgAttrs(style) + '/>';
        var textEl = label !== '' ? textSvgStr(label, rcx, rcy, style) : '';
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
        paint.push({
          kind: 'path',
          d: shapePath(style, box.x + 4, box.y + 4, box.w, box.h) ||
             rectPath(box.x + 4, box.y + 4, box.w, box.h),
          fill: solid('#000000', 0.18),
          stroke: null
        });
      }

      // Sketch fills (hachure/cross-hatch/dots): emit as kind:'svg' with an inline
      // hatch/dot pattern so the texture is preserved rather than silently collapsed
      // to solid fill. Applies whenever we reach the headless fallback (svgCellNode
      // returned null) — mode B always, mode A only when live DOM is unavailable.
      if (boolish(style.sketch) && isPaintable(style.fillColor)) {
        var skFs = style.fillStyle || 'hachure';
        if (skFs === 'hachure' || skFs === 'cross-hatch' || skFs === 'dots') {
          var skRelD = shapePath(style, 0, 0, box.w, box.h) || rectPath(0, 0, box.w, box.h);
          paint.push({ kind: 'svg', box: { x: box.x, y: box.y, w: box.w, h: box.h },
            source: base64(sketchFillSvg(style, skRelD, box.w, box.h)), aspect: 'preserve' });
        } else {
          paint.push({ kind: 'path', d: d, fill: fillOf(style), stroke: strokeOf(style) });
        }
      // In mode B, gradient cells must carry direction inline (v1 contract has no direction
      // field in the structural fill object). Emit kind:'svg' with an embedded linearGradient
      // so the C++ engine renders the correct direction via resvg.
      } else if (mode === 'B' && isPaintable(style.gradientColor)) {
        var ggid = 'g' + String(cell.id || '').replace(/[^a-z0-9]/gi, '');
        var gdefs = '<defs>' + linearGradDef(ggid, hex(style.fillColor),
          hex(style.gradientColor), style.gradientDirection) + '</defs>';
        var relD = shapePath(style, 0, 0, box.w, box.h) || rectPath(0, 0, box.w, box.h);
        var gsvg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + fmt(box.w) +
          '" height="' + fmt(box.h) + '">' + gdefs +
          '<path d="' + relD + '"' + fillSvgAttr(style, ggid) + strokeSvgAttrs(style) + '/></svg>';
        paint.push({ kind: 'svg', box: { x: box.x, y: box.y, w: box.w, h: box.h },
          source: base64(gsvg), aspect: 'preserve' });
      } else {
        paint.push({
          kind: 'path',
          d: d,
          fill: fillOf(style),
          stroke: strokeOf(style)
        });
      }
    }

    // Swimlane labels live in the header area only (mxSwimlane.getLabelBounds).
    // Constrain the label box to avoid centering over the whole swimlane height.
    var swimLabelBx = box;
    if (style.shape === 'swimlane') {
      var swimIsH = style.horizontal !== '0';
      var swimSz = Math.min(Math.max(0, number(style.startSize, 30)), swimIsH ? box.h : box.w);
      swimLabelBx = swimIsH
        ? { x: box.x, y: box.y, w: box.w, h: swimSz }
        : { x: box.x, y: box.y, w: swimSz, h: box.h };
    } else if (style.shape === 'table') {
      var tableHeader = Math.min(Math.max(0, number(style.startSize, 30)), box.h);
      if (tableHeader > 0) swimLabelBx = { x: box.x, y: box.y, w: box.w, h: tableHeader };
    }
    if (label !== '') {
      var vlb = labelBoxNode(style, swimLabelBx);
      if (vlb) paint.push(vlb);
      paint.push(labelTextNode(graph, cell, state, style, swimLabelBx, label, notices, mode));
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

  function emitEdge(graph, cell, state, style, origin, scale, paint, notices, resolved, mode) {
    // TRUE-WYSIWYG primary: the edge's literal rendered SVG (connector +
    // markers + label exactly as drawn). Falls through only headless.
    var svgNode = svgCellNode(graph, cell, state, origin, scale, notices, resolved);
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
        paint.push(labelTextNode(graph, cell, state, style, hlBox, hl, notices, mode));
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
          paint.push(labelTextNode(graph, cell, state, style, wd2Box, wd2Label, notices, mode));
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
          paint.push(labelTextNode(graph, cell, state, style, faBox, faLabel, notices, mode));
        }
        return;
      }
    }

    if (style.shape) {
      notices.push(degradation('ExporterUnsupportedShape',
        'Custom edge shape "' + style.shape + '" exported as straight-line fallback.', cell.id));
    }
    paint.push({
      kind: 'path',
      d: edgePath(points, boolish(style.rounded), boolish(style.curved)),
      fill: null,
      stroke: stroke
    });

    var arrowFill = stroke.paint || solid('#000000', 1);
    var arrowSize = Math.max(7, stroke.width * 5);
    if (style.endArrow && style.endArrow !== 'none') {
      var end = style.endArrow === 'open'
        ? openArrowPath(points[points.length - 2], points[points.length - 1], arrowSize)
        : arrowPath(points[points.length - 2], points[points.length - 1], arrowSize);
      if (end) paint.push({ kind: 'path', d: end,
        fill: style.endArrow === 'open' ? null : arrowFill,
        stroke: style.endArrow === 'open' ? stroke : null });
    }
    if (style.startArrow && style.startArrow !== 'none') {
      var start = style.startArrow === 'open'
        ? openArrowPath(points[1], points[0], arrowSize)
        : arrowPath(points[1], points[0], arrowSize);
      if (start) paint.push({ kind: 'path', d: start,
        fill: style.startArrow === 'open' ? null : arrowFill,
        stroke: style.startArrow === 'open' ? stroke : null });
    }

    var label = plainLabel(graph, cell);
    if (label !== '') {
      var elBox = edgeLabelBox(state, style, origin, scale, label);
      var elb = labelBoxNode(style, elBox);
      if (elb) paint.push(elb);
      paint.push(labelTextNode(graph, cell, state, style, elBox, label, notices, mode));
    }
  }

  function buildContract(graph) {
    return buildResult(graph).contract;
  }

  var api = { buildContract: buildContract, buildResult: buildResult,
    noticeSeverity: noticeSeverity, embedExternalImages: embedExternalImages,
    _embedImageHrefs: embedImageHrefs,
    registerStencils: function(registry) { _stencilRegistry = registry; } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.NativePrintExporter = api;
})(typeof window !== 'undefined' ? window : globalThis);
