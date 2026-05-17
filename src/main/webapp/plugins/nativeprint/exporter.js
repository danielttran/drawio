/**
 * Native Print exporter — the "bake" (host integration spec §5).
 *
 * Runs in the drawio renderer where the fully-computed mxGraph view state
 * exists, and serializes the current diagram to a v1.1-schema-valid contract.
 * The engine never sees a diagram, only this finished contract (INV-1).
 *
 * Scope: the agreed NATIVE SHAPE SUBSET — vertices become a rectangle path +
 * a text node; edges become a polyline path. Shapes outside the subset
 * (images, complex stencils, gradients) degrade to their bounding box; this is
 * intentional and expands over time. The contract schema is exact and frozen
 * (see docs/MEMORY.md): the engine loudly rejects any deviation.
 *
 * Pure and dependency-free: takes a graph-like object exposing the public
 * mxGraph API drawio already loads, so it is unit-testable with a fake graph
 * in Node and runs unchanged in the browser.
 */
(function (root) {
  'use strict';

  function solid(color, alpha) {
    return { type: 'solid', color: color, alpha: alpha == null ? 1 : alpha };
  }

  function strokeOf(color, width) {
    return {
      paint: solid(color || '#000000', 1),
      width: width && width > 0 ? width : 1,
      cap: 'butt',
      join: 'miter',
      miterLimit: 10,
      dash: null // KEY is required by the schema; null = solid
    };
  }

  function isPaintable(c) {
    return c && c !== 'none' && c !== 'transparent' && /^#?[0-9a-fA-F]/.test(c);
  }

  function hex(c) {
    if (!c) return '#000000';
    return c.charAt(0) === '#' ? c : '#' + c;
  }

  function rectPath(x, y, w, h) {
    return 'M ' + x + ' ' + y + ' L ' + (x + w) + ' ' + y +
      ' L ' + (x + w) + ' ' + (y + h) + ' L ' + x + ' ' + (y + h) + ' Z';
  }

  function polyPath(pts) {
    var d = 'M ' + pts[0].x + ' ' + pts[0].y;
    for (var i = 1; i < pts.length; i++) d += ' L ' + pts[i].x + ' ' + pts[i].y;
    return d;
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
      // Strip HTML labels to text lines (subset: no rich text).
      s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
      var d = (root.document && root.document.createElement)
        ? root.document.createElement('div') : null;
      if (d) { d.innerHTML = s; s = d.textContent || d.innerText || ''; }
    }
    return s;
  }

  /**
   * @param graph drawio Graph (ui.editor.graph)
   * @returns {object} a v1.1 contract object
   */
  function buildContract(graph) {
    var model = graph.getModel();
    var view = graph.view;
    var paint = [];

    // Bounds across all rendered states -> page size + a single tile. Using
    // the rendered view state is exactly the "fully-computed view" §5 wants.
    // mxCellState coords are in SCALED view space; divide by view.scale so the
    // contract is zoom-independent (otherwise the printed size would track the
    // on-screen zoom level).
    var s = (view && view.scale) ? view.scale : 1;
    var b = graph.getGraphBounds();
    var ox = b && b.width > 0 ? b.x : 0;
    var oy = b && b.height > 0 ? b.y : 0;
    var pw = Math.max(1, Math.ceil((b ? b.width : 1) / s));
    var ph = Math.max(1, Math.ceil((b ? b.height : 1) / s));

    var cells = model.cells || {};
    Object.keys(cells).forEach(function (id) {
      var cell = cells[id];
      if (cell == null || (!model.isVertex(cell) && !model.isEdge(cell))) {
        return;
      }
      var state = view.getState(cell);
      if (state == null) return;
      var style = graph.getCellStyle(cell) || {};

      if (model.isEdge(cell)) {
        var ap = state.absolutePoints || [];
        var pts = [];
        for (var i = 0; i < ap.length; i++) {
          if (ap[i]) pts.push({ x: (ap[i].x - ox) / s, y: (ap[i].y - oy) / s });
        }
        if (pts.length >= 2) {
          paint.push({
            kind: 'path',
            d: polyPath(pts),
            fill: null,
            stroke: strokeOf(hex(style.strokeColor),
              parseFloat(style.strokeWidth) || 1)
          });
        }
        return;
      }

      // Vertex -> rectangle path (subset approximates every shape as its box).
      var x = (state.x - ox) / s, y = (state.y - oy) / s;
      var w = Math.max(1, state.width / s), h = Math.max(1, state.height / s);
      var fill = isPaintable(style.fillColor) ? solid(hex(style.fillColor), 1)
        : null;
      var stroke = isPaintable(style.strokeColor)
        ? strokeOf(hex(style.strokeColor), parseFloat(style.strokeWidth) || 1)
        : strokeOf('#000000', 1);
      paint.push({ kind: 'path', d: rectPath(x, y, w, h), fill: fill,
        stroke: stroke });

      var label = plainLabel(graph, cell);
      if (label !== '') {
        var fs = parseFloat(style.fontSize) || 12;
        paint.push({
          kind: 'text',
          box: { x: x, y: y, w: w, h: h },
          font: {
            family: style.fontFamily || 'Arial',
            sizePx: fs > 0 ? fs : 12,
            weight: (parseInt(style.fontStyle, 10) & 1) ? 700 : 400,
            italic: !!(parseInt(style.fontStyle, 10) & 2),
            color: isPaintable(style.fontColor) ? hex(style.fontColor)
              : '#000000'
          },
          align: { h: alignH(style.align), v: alignV(style.verticalAlign) },
          content: { type: 'static', lines: String(label).split('\n') }
        });
      }
    });

    return {
      schema: { major: 1, minor: 0 },
      document: {
        units: 'px',
        pages: [{
          id: 'page-1',
          size: { w: pw, h: ph },
          tiles: [{ origin: { x: 0, y: 0 }, size: { w: pw, h: ph } }],
          paint: paint
        }]
      }
    };
  }

  var api = { buildContract: buildContract };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.NativePrintExporter = api;
})(typeof window !== 'undefined' ? window : globalThis);
