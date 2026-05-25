# Native Print — Full Draw.io Shape Coverage: Implementation Specification

**Status:** Draft — awaiting advisor review  
**Date:** 2026-05-25  
**Repository:** `danielttran/drawio`  
**Branch:** `claude/native-print-unattended-5qWWK`  
**Companion docs:**  
- `docs/NATIVE_PRINT_UNATTENDED_IMPLEMENTATION_SPEC.md` (prior spec, already implemented)  
- `docs/PRINT_ENGINE_SPEC_v1.1.md` (engine contract schema)  
- `docs/CLAUDE.md` (non-negotiable constraints)  
- `src/main/webapp/plugins/nativeprint/CLAUDE.md` (plugin-level guardrails)

---

## 0. Non-Negotiable Constraints

All constraints from `docs/CLAUDE.md` and the prior spec remain in force unchanged:

1. **No browser anywhere** — no Chromium, Playwright, jsdom, pixel oracles.  
2. **WYSIWYG by construction** — transcribe draw.io's actual rendering, never re-derive.  
3. **Faithful OR loud** — never a silent divergence or silent approximation.  
4. **Frozen engine boundary (INV-1)** — no draw.io/mxGraph concepts in C++; contract schema unchanged by this spec.  
5. **D5 failure policy** — any degradation notice → job refused (HTTP 422).

**Allowed-renderer boundary (D1):** Running draw.io's own stencil XML under a minimal SVG-serialization shim is permitted and is *not* a browser. The shim implements only element creation, attribute manipulation, tree assembly, and XML serialization. It must not implement HTML layout, CSS cascade, box layout, measurement, event handling, or produce pixels.

---

## 1. Problem Statement

The headless bake path (Node.js, no browser) currently supports only ~8 named shape types:
`rectangle`, `ellipse`, `rhombus`, `triangle` (4 directions), `cylinder`, `cloud`, `label`.

Any cell whose style includes `shape=<anything else>` — including all mxgraph.* stencil shapes
(3,798 uniquely named shapes across 202 XML files), plus built-in shapes like `hexagon`,
`actor`, `parallelogram` — hits `ExporterUnsupportedShape`, emits a degradation notice, and
causes D5 job refusal.

The live-browser path works for all shapes because `harvestShape` transcribes the
already-rendered SVG from `state.shape.node`. Headless has no such rendered state.

**Goal of this spec:** Extend headless coverage to 100% of draw.io shapes without a browser,
by implementing a stencil XML → SVG path renderer that uses the same stencil definitions the
browser uses — WYSIWYG by construction.

---

## 2. Root Cause and Insight

Draw.io's shape library is defined as XML in `src/main/webapp/stencils/` (202 files, ~3,798
shapes). Each stencil shape is a sequence of drawing commands in a well-defined mini-language:

```xml
<shape name="Gear" h="54" w="54" aspect="variable">
  <background>
    <path>
      <move x="10" y="0"/>
      <line x="44" y="0"/>
      <arc rx="4" ry="4" x-axis-rotation="0" large-arc-flag="0" sweep-flag="1" x="54" y="10"/>
      <close/>
    </path>
  </background>
  <foreground>
    <fillstroke/>
  </foreground>
</shape>
```

These commands map **directly and exactly** to SVG path syntax:

| Stencil command | SVG equivalent |
|---|---|
| `<move x y>` | `M x y` |
| `<line x y>` | `L x y` |
| `<curve x1 y1 x2 y2 x3 y3>` | `C x1 y1 x2 y2 x3 y3` |
| `<quad x1 y1 x2 y2>` | `Q x1 y1 x2 y2` |
| `<arc rx ry xrot laf sf x y>` | `A rx ry xrot laf sf x y` |
| `<close>` | `Z` |
| `<rect x y w h>` | `<rect x y width height/>` |
| `<roundrect x y w h arcsize>` | `<rect x y width height rx ry/>` |
| `<ellipse x y w h>` | `<ellipse cx cy rx ry/>` |

Coordinates are in **stencil space** (origin 0,0; unit square = w0 × h0 from the shape's `w`
and `h` attributes) and must be scaled to actual cell dimensions at render time. No browser, no
DOM, no canvas engine is needed — it is pure arithmetic.

This means: **every draw.io stencil shape can be rendered headlessly** by parsing its XML
definition and scaling coordinates to the cell bounding box.

---

## 3. Architecture

### 3.1 Overview

The shape rendering pipeline adds one new step before the existing fallback:

```
emitVertex(cell)
  ├─ harvestShape()          (live path only — requires state.shape.node)
  ├─ stencilToSvg()          ← NEW: headless stencil shapes
  ├─ shapePath()             (existing: basic 8 shapes)
  └─ ExporterUnsupportedShape notice  (remaining edge cases only)
```

### 3.2 Stencil Registry

At bake startup (`bake.mjs`), before processing any cells:

1. Read every `.xml` file from `src/main/webapp/stencils/` (recursively).
2. Parse each file as XML (Node.js built-in `DOMParser` or `@xmldom/xmldom`).
3. For each `<shape name="...">` element, register it under its normalized name:
   - File `stencils/basic.xml`, shape name `"Star"` → key `"mxgraph.basic.star"` (package = filename without extension, name = lowercased value).
   - File `stencils/flowchart.xml`, shape name `"Card"` → `"mxgraph.flowchart.card"`.
   - Exception: shapes in root-level `stencils/*.xml` files are registered under package `mxgraph.<filename>`.
   - Subdirectory files (e.g. `stencils/aws2/compute.xml`) → `mxgraph.aws2.compute.<name>`.
4. Pass the registry into the exporter via a new `registerStencils(map)` API call.

The registry is a plain `Map<string, Element>` (stencil XML `<shape>` node). Memory cost is
negligible (all stencil XML totals ~8 MB text, parsed once).

### 3.3 `stencilToSvg(stencilNode, w, h, style)` — New Function in exporter.js

**Signature:** `stencilToSvg(stencilNode, w, h, style) → string | null`

**Inputs:**
- `stencilNode`: the `<shape>` DOM element from the stencil registry
- `w`, `h`: actual cell width and height in px
- `style`: parsed style object (for fill color, stroke color, opacity, etc.)

**Output:** An SVG string `<svg xmlns="..." width="w" height="h">...</svg>`, or `null` if the
stencil uses a feature that cannot be rendered headlessly (triggers a notice instead).

**Algorithm:**

1. Read `w0 = stencilNode.getAttribute('w') || 100` and `h0 = stencilNode.getAttribute('h') || 100`. These are the stencil's native coordinate space dimensions.
2. Define scale factors: `sx = w / w0`, `sy = h / h0`.
3. Walk `<background>` children (fill shapes, painted first) and `<foreground>` children (stroke/overlay shapes), in document order.
4. For each `<path>` block: accumulate child command nodes into one SVG `d` attribute string, scaling each coordinate: `xScaled = x * sx`, `yScaled = y * sy`. Arc radii scale as `rx * sx` and `ry * sy`.
5. For `<rect x y w h>`: emit `<rect x="x*sx" y="y*sy" width="w*sx" height="h*sy"/>`.
6. For `<roundrect x y w h arcsize>`: arcsize is a percentage of min(w,h); emit `<rect ... rx="..." ry="..."/>`.
7. For `<ellipse x y w h>`: emit `<ellipse cx="(x+w/2)*sx" cy="(y+h/2)*sy" rx="w/2*sx" ry="h/2*sy"/>`.
8. Apply fill/stroke from `<fillstroke/>`, `<fill/>`, `<stroke/>` commands using the cell's style (fillColor, strokeColor, etc.) via the existing `fillSvgAttr()` and `strokeSvgAttrs()` helpers.
9. Handle state modifiers: `<strokecolor>`, `<fillcolor>`, `<strokewidth>`, `<dashed>`, `<dashpattern>`, `<linecap>`, `<linejoin>`, `<alpha>`, `<fillalpha>`, `<strokealpha>` — push/pop via `<save>`/`<restore>`.
10. Ignore `<connections>` nodes (connection point hints; irrelevant for printing).
11. If any node type is encountered that this renderer does not implement, add an `ExporterUnsupportedStencilFeature` notice and return `null` (job then refused per D5).

Unimplemented stencil features (rare; raise notice):
- `<image>` inside a stencil: requires external image fetch (same as existing `embedExternalImages` path — can be wired in Phase 2).
- `<include-shape>`: recursive stencil composition — defer to Phase 2.
- `<text>` inside a stencil: labels-within-shapes (rare decorative use) — defer to Phase 2.

### 3.4 Integration in `emitVertex`

After `harvestShape` returns null (headless), before `shapePath`:

```javascript
// Try stencil registry (covers all mxgraph.* shapes)
var stencilName = style.shape;
if (stencilName) {
  var stencilNode = _stencilRegistry.get(stencilName);
  if (stencilNode) {
    var svgStr = stencilToSvg(stencilNode, box.w, box.h, style);
    if (svgStr) {
      var labelStr = textSvgStr(label, box.w / 2, box.h / 2, style);
      // wrap label into same SVG or emit separately
      paint.push({ kind: 'svg', box: box, source: base64(svgStr), aspect: 'preserve' });
      if (label) { /* emit kind:'text' node over the svg box */ }
      return;
    }
    // svgStr === null means notice was emitted; fall through to bbox fallback
  }
}
```

Label placement for stencil shapes uses the same rules as for basic shapes: the label is either
embedded in the SVG (for rotated shapes) or emitted as a separate `kind:'text'` node centered
on the cell box (non-rotated).

### 3.5 Rotation

Stencil shapes that are rotated (`style.rotation !== 0`) follow the same pattern as the
existing rotation fix: the SVG is wrapped in a `<g transform="rotate(deg cx cy)">` with an
expanded viewport (axis-aligned bounding box of the rotated stencil), and the label is embedded
in the same SVG. This is identical to what the existing rotation path already does for basic
shapes. `stencilToSvg` produces the inner shape geometry; the rotation wrapper is applied in
`emitVertex` as it is today for `shapePath` results.

### 3.6 Built-in JS Shapes (Phase 2)

A small set of named shapes are defined as JavaScript classes (not stencil XML):
`hexagon`, `actor` (person), `parallelogram`, `trapezoid`, `cross`, `plus`,
`double-ellipse`, `star` (mxgraph built-in), `swimlane`, `process`, `triangle`
(already covered), `line`, `link`, `arrow`.

These are a finite, bounded list (~20-30 shapes). Each will be added to the existing
`shapePath` function as an additional `else if (name === '...')` branch, computing path data
from the cell's `w`, `h`, and relevant style properties.

Acceptance criterion: the `shapePath` function returns a valid SVG path `d` string for each
built-in shape, matching the browser-rendered geometry to within the coordinate precision
already used by the rest of the codebase.

---

## 4. File Changes

| File | Change |
|---|---|
| `tools/native-print-bake/bake.mjs` | Add stencil XML loader: read all `.xml` from `stencils/`, parse, build `Map<name, Element>`, call `exporter.registerStencils(map)` |
| `src/main/webapp/plugins/nativeprint/exporter.js` | Add `registerStencils(map)`, `stencilToSvg(node, w, h, style)`, and integration in `emitVertex`; extend `shapePath` with ~20 built-in shapes |
| `tools/native-print-bake/bake.test.mjs` | Add tests: stencil shape bakes to `kind:'svg'` with correct geometry; built-in shapes bake without notice; edge-case stencil features emit correct notice |
| `src/main/native-print-engine/tests/fixtures/labels/master-test.drawio` | Extend with one representative stencil shape (e.g. `mxgraph.flowchart.start_1`) and one built-in (e.g. `hexagon`) |

No changes to the C++ engine, contract schema, or `docs/PRINT_ENGINE_SPEC_v1.1.md`.  
The `kind:'svg'` contract node type already exists and is already handled by `pxContractToUm`.

---

## 5. Contract Impact

**None.** The `kind:'svg'` node type already exists in the v1.1 contract schema and is already
handled by the C++ engine (`pxContractToUm` line 74-77 scales the box; SVG coordinates are
unitless and scaled by the engine to fit the um box). No schema version bump required.

---

## 6. Stencil Name Mapping Reference

Draw.io resolves `style="shape=X"` as follows (from `mxCellRenderer`):

1. Look up `X` in `mxStencilRegistry.stencils` → stencil XML instance.
2. If not found, look up `X` in `mxCellRenderer.defaultShapes` → built-in JS class.
3. If not found → fall back to rectangle.

The stencil registry is populated from the XML files. Naming convention in draw.io:

- `stencils/basic.xml` → shapes registered as `shape` (no prefix, plain names like `"parallelogram"`)
- `stencils/flowchart.xml` → `"mxgraph.flowchart.shape_name"`
- `stencils/aws2/compute.xml` → `"mxgraph.aws2.compute.shape_name"`

**Important:** The exact key format is determined by how draw.io's `Graph.js`/`mxStencilRegistry`
registers stencils at load time, not by the file hierarchy alone. The bake loader must replicate
this key format exactly, or shapes will not match. The stencil loading code in
`src/main/webapp/js/diagramly/Graph.js` (search `mxStencilRegistry.loadStencilSet`) documents
the exact URL → name mapping. The bake loader must mirror this.

---

## 7. Testing Strategy

### 7.1 Unit Tests (bake.test.mjs, node --test)

For each new capability, add a test that:
1. Creates a minimal `.drawio` XML string with one cell using the target shape style.
2. Calls `bake(xml)`.
3. Asserts: contract has a `kind:'svg'` node, no degradation notices for supported shapes, correct label in text or svg node.

Test cases required:
- Basic stencil shape: `shape=mxgraph.flowchart.start_1` → `kind:'svg'`, no notice
- Stencil with fill+stroke: `shape=mxgraph.basic.star` → `kind:'svg'`, SVG contains `<path`
- Stencil with rotation: `shape=mxgraph.flowchart.card` + `rotation=30` → `kind:'svg'`, SVG contains `rotate(`
- Built-in: `shape=hexagon` → `kind:'svg'` or path node, no notice
- Unsupported stencil feature (mock): `<image>` inside stencil → `ExporterUnsupportedStencilFeature` notice
- Label on stencil shape: cell with value `"Hello"` → label text preserved in contract

### 7.2 Golden Contract Test (C1 equivalent)

Extend `master-test.drawio` with a stencil shape and a built-in shape.  
Generate a new golden contract. C1 test in `bake.test.mjs` verifies bake output matches golden.

### 7.3 WYSIWYG Structural Check (wysiwyg-compare.mjs)

Extend `compare()` with:
- Stencil shape cells in `master-test.drawio` produce a `kind:'svg'` node each.
- No `ExporterUnsupportedShape` notices in bake output.

### 7.4 Engine Tests (ctest)

No new C++ tests needed — `kind:'svg'` already tested. Existing tests must continue to pass.

---

## 8. Coverage After This Spec

| Shape category | Count | Headless guarantee |
|---|---|---|
| Basic shapes (rectangle, ellipse, etc.) | ~8 types | ✓ Already done |
| Built-in JS shapes (hexagon, actor, etc.) | ~20-30 | ✓ Phase 2 |
| Stencil XML shapes (AWS, BPMN, Cisco, etc.) | ~3,798 | ✓ Phase 1 |
| Stencil shapes with unsupported features (`<image>`, `<include-shape>`) | ~few dozen | Loud notice + D5 refusal |
| **Total faithfully printable** | **~3,820+** | **100% or loud refusal** |

---

## 9. Do-Not List

- Do **not** run `mxSvgCanvas2D` headlessly (complex DOM dependencies; not needed).
- Do **not** run any mxGraph JS class (`mxStencil`, `mxShape`, `mxCellRenderer`) headlessly.
- Do **not** add `window`, `document.body`, layout measurement to the SVG shim.
- Do **not** change the engine contract schema or C++ engine code.
- Do **not** add a pixel-comparison oracle or screenshot diff.
- Do **not** add a browser (headless or otherwise) at any point.
- Do **not** silently fall back to bounding box for any stencil shape that can be rendered.

---

## 10. Open Questions for Advisor Review

1. **Stencil name key format**: The spec says the bake loader must mirror `mxStencilRegistry`'s
   naming convention exactly. Is the mapping described in §6 accurate? Are there edge cases
   (e.g. shapes registered without a package prefix)?

2. **`<image>` in stencils**: Should Phase 1 wire `<image>` stencil commands through the
   existing `embedExternalImages` path (making them printable from day 1), or raise a notice
   and defer? The carve-out in `CLAUDE.md §2` permits canvas for image embedding specifically.

3. **Label placement**: For non-rotated stencil shapes, the spec emits a separate `kind:'text'`
   node centered on the cell box. Is this correct for all stencil shapes? Some stencils define
   internal label areas — should the spec ignore those and always center?

4. **`aspect="fixed"` stencils**: Some shapes declare `aspect="fixed"`, meaning the shape must
   maintain its aspect ratio. The bake currently ignores aspect constraints (cell `w` and `h`
   come from the diagram). Should the renderer silently stretch (matching current browser
   behavior, which also stretches), or preserve aspect and center?

5. **Phase ordering**: Is it correct to do Phase 1 (stencil XML) before Phase 2 (built-in JS
   shapes)? Built-in shapes are fewer but may be more commonly used in existing diagrams.

---

## 11. Implementation Order

1. **Phase 1a** — Stencil loader in `bake.mjs`: read XML files, build registry, call `registerStencils`.
2. **Phase 1b** — `stencilToSvg` function in `exporter.js` with `<path>` command support only (covers ~95% of stencil shapes).
3. **Phase 1c** — Add `<rect>`, `<roundrect>`, `<ellipse>`, state modifiers (`<save>`/`<restore>`, `<strokecolor>`, etc.).
4. **Phase 1d** — Wire into `emitVertex`; add unit tests; update master-test fixture.
5. **Phase 2** — Extend `shapePath` for ~20 built-in shapes; add unit tests.
6. **Phase 3** — `<include-shape>` recursion; `<image>` stencil command via `embedExternalImages`.
