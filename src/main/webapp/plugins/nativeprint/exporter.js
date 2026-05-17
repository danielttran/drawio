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

  function textNode(style, box, label) {
    var fs = number(style.fontSize, 12);
    return {
      kind: 'text',
      box: box,
      font: {
        family: style.fontFamily || 'Arial',
        sizePx: fs > 0 ? fs : 12,
        weight: (parseInt(style.fontStyle || 0, 10) & 1) ? 700 : 400,
        italic: !!(parseInt(style.fontStyle || 0, 10) & 2),
        color: isPaintable(style.fontColor) ? hex(style.fontColor) : '#000000'
      },
      align: { h: alignH(style.align), v: alignV(style.verticalAlign) },
      content: { type: 'static', lines: String(label).split('\n') }
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

  function buildResult(graph) {
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
    var page = {
      w: Math.max(1, Math.ceil((bounds ? bounds.width : 1) / scale)),
      h: Math.max(1, Math.ceil((bounds ? bounds.height : 1) / scale))
    };

    Object.keys(model.cells || {}).forEach(function (id) {
      var cell = model.cells[id];
      if (cell == null || (!model.isVertex(cell) && !model.isEdge(cell))) return;
      var state = view.getState(cell);
      if (state == null) return;
      var style = graph.getCellStyle(cell) || state.style || {};

      if (model.isEdge(cell)) {
        emitEdge(graph, cell, state, style, origin, scale, paint);
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

    var label = plainLabel(graph, cell);
    if (label !== '') paint.push(textNode(style, box, label));
  }

  function emitEdge(graph, cell, state, style, origin, scale, paint) {
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
      paint.push(textNode(style, edgeLabelBox(state, style, origin, scale, label), label));
    }
  }

  function buildContract(graph) {
    return buildResult(graph).contract;
  }

  var api = { buildContract: buildContract, buildResult: buildResult };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.NativePrintExporter = api;
})(typeof window !== 'undefined' ? window : globalThis);
