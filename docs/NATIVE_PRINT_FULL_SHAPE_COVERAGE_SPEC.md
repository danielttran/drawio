# Native Print — Full Draw.io Shape Coverage: Implementation Specification

**Status:** Revised — advisor review complete (2026-05-25)  
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
3. **Faithful OR loud** — never a silent divergence, never a silent approximation.  
4. **Frozen engine boundary (INV-1)** — no draw.io/mxGraph concepts in C++; contract schema unchanged by this spec.  
5. **D5 failure policy** — any degradation notice → job refused (HTTP 422).

**Allowed-renderer boundary (D1):** Running draw.io's own stencil XML through a pure arithmetic
renderer (no mxGraph runtime, no DOM shim, no browser) is permitted and is *not* a browser.
The renderer implements only coordinate arithmetic, SVG path string assembly, and XML attribute
reading. It must not implement HTML layout, CSS cascade, box layout, measurement, event
handling, or produce pixels. The existing svg-shim (`tools/native-print-bake/svg-shim/`) is
not required for Phase 1 — the stencil renderer is pure math.

---

## 1. Problem Statement

The headless bake path (Node.js, no browser) currently supports only ~8 named shape types:
`rectangle`, `ellipse`, `rhombus`, `triangle` (4 directions), `cylinder`, `cloud`, `label`.

Any cell whose style includes `shape=<anything else>` — including all `mxgraph.*` stencil
shapes (~3,798 uniquely named shapes across 202 XML files), plus built-in shapes like
`hexagon`, `actor`, `parallelogram` — hits `ExporterUnsupportedShape`, emits a degradation
notice, and causes D5 job refusal.

The live-browser path works for all shapes because `harvestShape` transcribes the
already-rendered SVG from `state.shape.node`. Headless has no such rendered state.

**Goal:** Extend headless coverage to 100% of draw.io shapes without a browser by implementing
a stencil XML → SVG renderer that uses the same stencil definitions the browser uses — WYSIWYG
by construction.

---

## 2. Root Cause and Insight

Draw.io's shape library is defined as XML in `src/main/webapp/stencils/` (202 files, ~3,798
shapes). Each stencil shape is a sequence of drawing commands in a well-defined mini-language:

```xml
<shape name="Card" h="60" w="98" aspect="variable" strokewidth="inherit">
  <background>
    <path>
      <move x="19" y="0"/>
      <line x="93" y="0"/>
      <arc rx="5" ry="5" x-axis-rotation="0" large-arc-flag="0" sweep-flag="1" x="98" y="5"/>
      <close/>
    </path>
  </background>
  <foreground>
    <fillstroke/>
  </foreground>
</shape>
```

These commands map to SVG with a coordinate transform. The full command → SVG mapping:

| Stencil command | SVG path token | Notes |
|---|---|---|
| `<move x y>` | `M ox+x*sw oy+y*sh` | Absolute moveto |
| `<line x y>` | `L ox+x*sw oy+y*sh` | Absolute lineto |
| `<curve x1 y1 x2 y2 x3 y3>` | `C` (6 values scaled) | Cubic Bezier |
| `<quad x1 y1 x2 y2>` | `Q` (4 values scaled) | Quadratic Bezier |
| `<arc rx ry xrot laf sf x y>` | `A su*rx su*ry xrot laf sf ox+x*sw oy+y*sh` | Arc; radii scale by uniform factor (see §3.3) |
| `<close>` | `Z` | |
| `<rect x y w h>` | `<rect x="ox+x*sw" y="oy+y*sh" width="w*sw" height="h*sh"/>` | |
| `<roundrect x y w h arcsize>` | `<rect ... rx="r" ry="r"/>` | r = arcsize/100 * min(w*sw, h*sh); if arcsize=0 → r = 10 (mxConstants default) |
| `<ellipse x y w h>` | `<ellipse cx="ox+(x+w/2)*sw" cy="oy+(y+h/2)*sy" rx="w/2*sw" ry="h/2*sh"/>` | Note: stencil x,y is top-left, NOT center |

Where `ox`, `oy`, `sw`, `sh` come from `computeAspect` (see §3.3 step 2). For `aspect="variable"` shapes: `ox=0, oy=0, sw=cellW/w0, sh=cellH/h0`. For `aspect="fixed"` shapes the formula is different — see §3.3 step 2.

---

## 3. Architecture

### 3.1 Overview

The shape rendering pipeline adds one new step before the existing fallback:

```
emitVertex(cell)
  ├─ harvestShape()              (live path only — requires state.shape.node)
  ├─ inlineStencilDecode()       ← NEW: decode stencil(base64...) inline shapes
  ├─ stencilRegistryLookup()     ← NEW: look up mxgraph.* stencil XML shapes
  │    └─ stencilToSvg()         ← NEW: render stencil XML → SVG string
  ├─ shapePath()                 (existing: basic 8 shapes)
  └─ ExporterUnsupportedShape notice  (truly unresolvable shapes only)
```

### 3.2 Stencil Registry — Correct Key Format

**IMPORTANT: The key format is derived from the `<shapes name="...">` XML attribute, NOT from
the file path.** This is how `mxStencilRegistry` (`parseStencilSet` in `Graph.js` line ~11308)
works:

```
key = shapes_element_name_attr.toLowerCase() + "." + shape_name.replace(/ /g, "_").toLowerCase()
```

Examples:
- `stencils/basic.xml` has `<shapes name="mxgraph.basic">` → `"mxgraph.basic.4_point_star"`, `"mxgraph.basic.star"`, etc. (NOT `"mxgraph.basic.4 Point Star"`)
- `stencils/flowchart.xml` has `<shapes name="mxGraph.flowchart">` → lowercased → `"mxgraph.flowchart.card"`, `"mxgraph.flowchart.start_1"`
- `stencils/aws2/compute.xml` has `<shapes name="mxgraph.aws2.compute">` → `"mxgraph.aws2.compute.ec2"`

**Note:** `basic.xml` shapes are `"mxgraph.basic.*"` (not plain names). Plain names like
`"parallelogram"`, `"hexagon"` are built-in JS shapes, not stencil XML shapes.

**Bake loader algorithm** (`bake.mjs`):
1. Recursively read every `.xml` file from `src/main/webapp/stencils/`.
2. Parse each file with `@xmldom/xmldom` (already a project dependency) — Node.js does not have a built-in DOMParser.
3. Read the `name` attribute from the root `<shapes>` element → `packagePrefix = name.toLowerCase()`.
4. For each `<shape name="N">` child: `key = packagePrefix + "." + N.replace(/ /g,"_").toLowerCase()`.
5. Store `Map<key, shapeElement>` — the raw `<shape>` DOM node.
6. Call `exporter.registerStencils(map)` before any bake calls.

Memory cost: all stencil XML is ~8 MB text, parsed once at startup.

### 3.3 `computeAspect` — Coordinate Transform (Critical)

Every coordinate in a stencil must be transformed through `computeAspect` before scaling.
This mirrors `mxStencil.computeAspect` exactly.

**Inputs:** `w0`, `h0` (stencil native dimensions), `cellW`, `cellH` (actual cell px), `aspect` attribute value.

**For `aspect="variable"` (most shapes):**
```
sw = cellW / w0
sh = cellH / h0
ox = 0
oy = 0
```
Arc radii: `rx_scaled = rx * sw`, `ry_scaled = ry * sh`.

**For `aspect="fixed"` (many icon-style shapes like AWS, Azure, etc.):**
```
su = min(cellW / w0, cellH / h0)    // uniform scale
sw = su,  sh = su
ox = (cellW - w0 * su) / 2          // centering offset
oy = (cellH - h0 * su) / 2
```
Arc radii: `rx_scaled = rx * su`, `ry_scaled = ry * su` (same factor for both — preserves circle arcs).

Applying the transform to a coordinate: `xOut = ox + x * sw`, `yOut = oy + y * sh`.

**`direction` style property**: If the cell style has `direction=north` or `direction=south`,
width and height are swapped when computing the aspect transform:
```
if direction == "north" or "south":
    swap(cellW, cellH) when calling computeAspect
    then wrap the resulting SVG in <g transform="rotate(-90, cx, cy)"> or <g transform="rotate(90, cx, cy)">
```
For `direction=north`: rotate −90°, pivot at `(cellW/2, cellH/2)`.  
For `direction=south`: rotate +90°, pivot at `(cellW/2, cellH/2)`.  
For `direction=west`: rotate 180°.  
`direction=east` is the default (no rotation).

### 3.4 `stencilToSvg(shapeNode, cellW, cellH, style)` — Full Algorithm

**Signature:** `stencilToSvg(shapeNode, cellW, cellH, style) → string | null`

Returns an SVG string, or `null` + pushes a notice if an unsupported feature is encountered.

**Step 1 — Read shape metadata:**
```
w0 = parseFloat(shapeNode.getAttribute("w")) || 100
h0 = parseFloat(shapeNode.getAttribute("h")) || 100
aspect = shapeNode.getAttribute("aspect") || "variable"
stencilStrokeWidth = shapeNode.getAttribute("strokewidth")  // may be "inherit" or a number
```

**Step 2 — Compute aspect transform** via §3.3.

**Step 3 — Compute initial stroke width:**
```
if stencilStrokeWidth == "inherit" or null:
    sw_px = cellStyle.strokeWidth (from parsed style, default 1)
else:
    sw_px = parseFloat(stencilStrokeWidth) * min(sw, sh)   // stencil units → px
```

**Step 4 — Initialize render state stack** (for `<save>`/`<restore>`):
```
state = {
  fillColor:    style.fillColor,
  strokeColor:  style.strokeColor,
  strokeWidth:  sw_px,
  dashed:       style.dashed,
  dashPattern:  style.dashPattern,
  lineCap:      style.lineCap || "butt",
  lineJoin:     style.lineJoin || "miter",
  miterLimit:   style.miterLimit || 10,
  alpha:        opacity(style, "opacity"),
  fontColor:    style.fontColor || "#000000",
  fontSize:     style.fontSize || 11,
  fontFamily:   style.fontFamily || "Arial",
  fontStyle:    style.fontStyle || 0,
}
stateStack = []
```

**Step 5 — Walk `<background>` and `<foreground>` nodes in order**, processing sibling nodes:

The walker operates at the child level of `<background>` and `<foreground>`. At this level,
nodes are one of: `<path>`, `<rect>`, `<roundrect>`, `<ellipse>`, `<fillstroke>`, `<fill>`,
`<stroke>`, state-modifier commands, or `<save>`/`<restore>`.

**`<fillstroke>`, `<fill>`, `<stroke>` are siblings of `<path>`, NOT children.** A typical
stencil has: `<path>…commands…</path>` then `<fillstroke/>` as the next sibling. The walker
must maintain a "current path accumulator" that is populated by a `<path>` block and then
consumed by the next `<fillstroke>`/`<fill>`/`<stroke>` sibling.

**Step 6 — Processing `<path>` blocks:**

When the walker encounters a `<path>` node:
1. Check for `rounded` attribute: if `rounded="1"`, the path uses Bezier rounding of polyline points. This is a distinct rendering mode. **Raise `ExporterUnsupportedStencilFeature` notice and return `null`** for Phase 1 (these are rare but visually distinct — cannot be silently approximated as sharp corners).
2. Otherwise: walk child nodes in order and build an SVG `d` string:
   - `<move x y>` → `"M " + fmt(ox+x*sw) + " " + fmt(oy+y*sh)`
   - `<line x y>` → `"L " + fmt(ox+x*sw) + " " + fmt(oy+y*sh)`
   - `<curve x1 y1 x2 y2 x3 y3>` → `"C " + (6 scaled values)`
   - `<quad x1 y1 x2 y2>` → `"Q " + (4 scaled values)`
   - `<arc rx ry xrot laf sf x y>` → `"A " + fmt(rx*su_or_sw) + " " + fmt(ry*su_or_sh) + " " + xrot + " " + laf + " " + sf + " " + fmt(ox+x*sw) + " " + fmt(oy+y*sh)` (arc radii use uniform scale for `aspect="fixed"`, asymmetric for `aspect="variable"`)
   - `<close>` → `"Z"`
3. Store the accumulated `d` string as the current path.

**Step 7 — Processing `<rect>`, `<roundrect>`, `<ellipse>` directly:**

These are self-contained; they become the current path (as SVG element strings, not `d` strings):
- `<rect x y w h>` → `<rect x="ox+x*sw" y="oy+y*sh" width="w*sw" height="h*sh"/>`
- `<roundrect x y w h arcsize>` → compute corner radius `r = (arcsize || mxConstants.RECTANGLE_ROUNDING_FACTOR*100) / 100 * min(w*sw, h*sh)` → `<rect ... rx="r" ry="r"/>`
- `<ellipse x y w h>` → Note: `x`,`y` are the **top-left corner** of the ellipse bounding box: `<ellipse cx="ox+(x+w/2)*sw" cy="oy+(y+h/2)*sh" rx="w/2*sw" ry="h/2*sh"/>`

**Step 8 — Processing paint commands (`<fillstroke>`, `<fill>`, `<stroke>`):**

When the walker encounters a paint command, it takes the current path accumulator and emits an SVG element:
- Determine fill attr: `fillSvgAttr(state)` — uses `state.fillColor` and gradient if present.
- Determine stroke attrs: `strokeSvgAttrs(state)` — uses `state.strokeColor`, `state.strokeWidth`, `state.dashed`, etc.
- For `<fill>`: emit with fill, `stroke="none"`.
- For `<stroke>`: emit with `fill="none"`, stroke attrs.
- For `<fillstroke>`: emit with both fill and stroke attrs.
- Reset the current path accumulator.

**Step 9 — Gradient fill for stencil shapes:**

If `state.fillColor` is paintable AND `style.gradientColor` is paintable, emit a `<linearGradient>` in the SVG `<defs>` block. Reuse the same `<defs>` handling already implemented for the basic-shape rotation path in `emitVertex`. Do not silently drop gradients.

**Step 10 — Processing state modifiers** (all are siblings at the `<background>`/`<foreground>` child level):

| Command | Effect on state |
|---|---|
| `<save>` | Push copy of current state onto `stateStack` |
| `<restore>` | Pop state from `stateStack` |
| `<strokecolor color="...">` | `state.strokeColor = color` |
| `<fillcolor color="...">` | `state.fillColor = color` |
| `<strokewidth width="..." fixed="...">` | `state.strokeWidth = fixed=="1" ? w : w * min(sw,sh)` |
| `<dashed dashed="...">` | `state.dashed = dashed=="1"` |
| `<dashpattern pattern="...">` | `state.dashPattern = pattern` |
| `<linecap cap="...">` | `state.lineCap = cap` (attr name is `cap`) |
| `<linejoin join="...">` | `state.lineJoin = join` (attr name is `join`) |
| `<miterlimit limit="...">` | `state.miterLimit = limit` |
| `<alpha alpha="...">` | `state.alpha = alpha` (note: `fillalpha` and `strokealpha` in stencil XML BOTH map to `alpha` in mxGraph's canvas — there is no separate fill/stroke alpha in the stencil engine) |
| `<fontcolor color="...">` | `state.fontColor = color` (used if `<text>` encountered) |
| `<fontsize size="...">` | `state.fontSize = size * min(sw,sh)` (scaled by aspect) |
| `<fontstyle style="...">` | `state.fontStyle = style` |
| `<fontfamily family="...">` | `state.fontFamily = family` |

**Step 11 — Unsupported commands** (raise notice + return null):

- `<image>`: requires external image embedding — defer to Phase 3.
- `<include-shape>`: recursive stencil composition — defer to Phase 3.
- `<text>`: label-within-shape decorative text — defer to Phase 3.
- `<path rounded="1">`: Bezier-rounded polylines — defer to Phase 3.
- Any unrecognized node type: raise `ExporterUnsupportedStencilFeature` notice and return `null`.

**Step 12 — Flip transforms:**

After building the inner SVG, check cell style:
- `style.flipH == "1"` → wrap inner content in `<g transform="scale(-1,1) translate(-cellW, 0)">`.
- `style.flipV == "1"` → wrap in `<g transform="scale(1,-1) translate(0, -cellH)">`.
- `style.stencilFlipH` / `style.stencilFlipV`: same treatment (stencil-specific override).

**Step 13 — Assemble SVG:**

```xml
<svg xmlns="http://www.w3.org/2000/svg" width="cellW" height="cellH">
  <defs><!-- linearGradient if needed --></defs>
  <!-- direction rotation wrapper if needed -->
  <!-- flip wrapper if needed -->
  <!-- background paths -->
  <!-- foreground paths -->
</svg>
```

### 3.5 Inline Stencil Shapes (`stencil(base64...)`)

Some cells embed their stencil XML inline in the style string:
```
style="shape=stencil(PHNoYXBlIG5hbWU9...)"
```

The value is the base64-encoded stencil XML. These are used by custom shapes and cells
copied between draw.io instances.

**Handling in `emitVertex`** (before registry lookup):
```javascript
var shapeVal = style.shape || "";
if (shapeVal.startsWith("stencil(") && shapeVal.endsWith(")")) {
  var b64 = shapeVal.slice(8, -1);
  var xml = Buffer.from(b64, "base64").toString("utf8");
  var inlineNode = parseStencilXml(xml);  // returns <shape> element
  if (inlineNode) {
    // proceed with stencilToSvg(inlineNode, ...)
  }
}
```

`parseStencilXml` uses the same XML parser used by the stencil loader (`@xmldom/xmldom`).
If parsing fails, raise `ExporterUnsupportedShape` notice.

### 3.6 Label Placement

For non-rotated stencil shapes, emit a separate `kind:'text'` node centered on the cell box.
This matches draw.io's default label placement for stencil shapes (mxShape.getLabelMargins
returns `null` for stencil-based shapes, meaning no inset).

**Style overrides that change label placement** — these must be checked and respected:

| Style property | Effect | Handling |
|---|---|---|
| `labelPosition=left/right` | Label to the left/right of the cell | Adjust text node x position |
| `verticalLabelPosition=top/bottom` | Label above/below the cell | Adjust text node y position |
| `labelWidth` | Override label width | Pass to text node width |
| `align` | Horizontal text alignment | Already handled by existing text rendering |
| `verticalAlign` | Vertical text alignment | Already handled |

If `labelPosition` or `verticalLabelPosition` is present and non-center, the label box shifts
outside the cell bounding box. The existing `edgeLabelBox` / `plainLabel` machinery already
handles this for basic shapes; stencil shapes must follow the same code path.

For rotated stencil shapes (`style.rotation !== 0`), the label is embedded in the SVG exactly
as it is for basic shapes today (see §3.7).

### 3.7 Rotation

Stencil shapes with `style.rotation !== 0` follow the existing rotation pattern:
- Compute expanded viewport: `expW = cellW*|cos θ| + cellH*|sin θ|`, `expH = cellW*|sin θ| + cellH*|cos θ|`.
- `stencilToSvg` produces the inner shape geometry at the original `cellW × cellH` size.
- Wrap inner SVG content in `<g transform="rotate(deg cx cy)">` where `cx = expW/2`, `cy = expH/2`, and the stencil geometry is offset by `((expW-cellW)/2, (expH-cellH)/2)`.
- Embed label in the same SVG via `textSvgStr`.
- Emit single `kind:'svg'` node sized `expW × expH` centered on the cell center point.

### 3.8 Built-in JS Shapes (Phase 2)

A small set of named shapes are defined as JavaScript classes (not stencil XML):
`hexagon`, `doubleEllipse`, `actor` (person), `parallelogram`, `trapezoid`, `cross`, `plus`,
`mxgraph.*` built-in star, `swimlane`, `process`, `arrow`, `line`, `link`.

These are a finite, bounded list (~20-30 shapes). Each will be added to the existing
`shapePath` function as an additional `else if (name === '...')` branch.

Acceptance criterion: `shapePath` returns a valid SVG `d` string for each built-in, matching
the browser-rendered geometry to within the coordinate precision already in use.

---

## 4. File Changes

| File | Change |
|---|---|
| `tools/native-print-bake/bake.mjs` | Add stencil XML loader: read `stencils/` recursively, parse with `@xmldom/xmldom`, build `Map<key, Element>` using correct key formula (§3.2), call `exporter.registerStencils(map)` |
| `src/main/webapp/plugins/nativeprint/exporter.js` | Add `registerStencils(map)`, `computeAspect(w0,h0,cellW,cellH,aspect)`, `stencilToSvg(node,w,h,style)`, inline stencil decoder, and integration in `emitVertex`; extend `shapePath` with ~20 built-in shapes |
| `tools/native-print-bake/bake.test.mjs` | Add tests (see §7) |
| `src/main/native-print-engine/tests/fixtures/labels/master-test.drawio` | Add representative stencil shape + built-in shape |

No changes to the C++ engine, contract schema, or `docs/PRINT_ENGINE_SPEC_v1.1.md`.  
`kind:'svg'` already exists in v1.1 and is already handled by `pxContractToUm`.

---

## 5. Contract Impact

**None.** `kind:'svg'` already exists and is handled by the C++ engine. No schema version bump.

---

## 6. Stencil Name Mapping — Authoritative Reference

Draw.io resolves `style="shape=X"` in this priority order:

1. Check if `X` starts with `"stencil("` → inline base64 XML (§3.5).
2. Look up `X` in `mxStencilRegistry.stencils` → registered stencil XML.
3. Look up `X` in `mxCellRenderer.defaultShapes` → built-in JS class (Phase 2).
4. Fall back to rectangle (current behavior; continues to apply for any remaining gaps).

The key format for step 2, derived from `parseStencilSet` in `Graph.js`:
```
key = xml_shapes_element_name_attr.toLowerCase()
    + "."
    + shape_name_attr.replace(/ /g, "_").toLowerCase()
```

The XML `<shapes name="...">` root attribute is the authoritative package prefix. The file path
is not part of the key. The bake loader reads this attribute to build keys that exactly match
what the browser registers at runtime.

---

## 7. Testing Strategy

### 7.1 Unit Tests (bake.test.mjs, node --test)

For each new capability:
1. Create a minimal `.drawio` XML string with one cell using the target style.
2. Call `bake(xml)`.
3. Assert: correct contract node type, no unexpected notices, label preserved.

Required test cases:

| Test | Style | Expected |
|---|---|---|
| Variable-aspect stencil | `shape=mxgraph.flowchart.start_1` | `kind:'svg'`, no notice |
| Fixed-aspect stencil (centering) | `shape=mxgraph.aws2.general.generic_office_365` (or any `aspect="fixed"`) | `kind:'svg'`, SVG width=height when cell is square |
| Stencil with gradient | `shape=mxgraph.basic.star` + `gradientColor=#ff0000` | `kind:'svg'`, SVG defs contains `linearGradient` |
| Stencil with rotation | `shape=mxgraph.flowchart.card` + `rotation=30` | `kind:'svg'`, SVG contains `rotate(30` |
| Stencil with direction | `shape=mxgraph.flowchart.start_1` + `direction=north` | `kind:'svg'`, SVG contains rotation transform |
| Inline base64 stencil | `shape=stencil(<base64 of simple shape XML>)` | `kind:'svg'`, no notice |
| Unsupported: `<image>` in stencil | mock stencil node with `<image>` child | `ExporterUnsupportedStencilFeature` notice |
| Unsupported: `<path rounded="1">` | mock stencil with `rounded="1"` | `ExporterUnsupportedStencilFeature` notice |
| Built-in hexagon | `shape=hexagon` | no `ExporterUnsupportedShape` notice |
| Label on stencil shape | any stencil + `value="Hello"` | label text present in contract |
| `labelPosition=right` | stencil + `labelPosition=right` | text node x > cell right edge |

### 7.2 Golden Contract Test (C1)

Extend `master-test.drawio` with one stencil shape (variable-aspect), one fixed-aspect stencil,
and one built-in. Regenerate golden. C1 test in `bake.test.mjs` verifies bake output matches.

### 7.3 WYSIWYG Structural Check (wysiwyg-compare.mjs)

Extend `compare()` with:
- Stencil shape cells produce `kind:'svg'` nodes (no `ExporterUnsupportedShape` notices).
- SVG defs contain gradient elements for cells with `gradientColor`.

### 7.4 Engine Tests (ctest)

No new C++ tests needed. Existing tests must pass unchanged.

---

## 8. Coverage After This Spec

| Shape category | Count | Headless guarantee |
|---|---|---|
| Basic shapes (rectangle, ellipse, etc.) | ~8 types | ✓ Already done |
| Built-in JS shapes (hexagon, actor, etc.) | ~20-30 | ✓ Phase 2 |
| Stencil XML — variable-aspect | ~2,500+ | ✓ Phase 1b |
| Stencil XML — fixed-aspect | ~1,200+ | ✓ Phase 1b (computeAspect) |
| Stencil with direction/flip | spread across above | ✓ Phase 1b (§3.3/§3.4 step 12) |
| Inline `stencil(base64...)` shapes | unknown count | ✓ Phase 1a (§3.5) |
| Stencil with `<image>` command | ~few dozen | Loud notice + D5 refusal (Phase 3) |
| Stencil with `<include-shape>` | ~few dozen | Loud notice + D5 refusal (Phase 3) |
| Stencil with `<path rounded="1">` | ~handful | Loud notice + D5 refusal (Phase 3) |
| **Total faithfully printable** | **~3,820+** | **100% or loud refusal** |

---

## 9. Do-Not List

- Do **not** run `mxSvgCanvas2D`, `mxStencil`, `mxShape`, or `mxCellRenderer` headlessly.
- Do **not** add `window`, `document.body`, or layout measurement to the SVG shim.
- Do **not** change the engine contract schema or C++ engine code.
- Do **not** add a pixel-comparison oracle or screenshot diff.
- Do **not** add a browser (headless or otherwise).
- Do **not** silently approximate `aspect="fixed"` centering — compute it exactly (§3.3).
- Do **not** silently drop gradient fills for stencil shapes — emit gradient SVG or notice.
- Do **not** silently approximate `<path rounded="1">` as sharp corners — raise notice.

---

## 10. Implementation Order

1. **Phase 1a** — Stencil loader in `bake.mjs`: read XML, build registry with correct key formula; inline stencil base64 decoder in `emitVertex`.
2. **Phase 1b** — `computeAspect` and `stencilToSvg` in `exporter.js`: `<path>` with `<move>/<line>/<curve>/<quad>/<arc>/<close>`, `<rect>/<roundrect>/<ellipse>`, state modifiers, fill/stroke/fillstroke paint commands, gradient support, direction/flip wrappers. Wire into `emitVertex`.
3. **Phase 1c** — Tests: unit tests per §7.1, golden contract update, wysiwyg-compare extension.
4. **Phase 2** — Extend `shapePath` for ~20 built-in JS shapes; unit tests.
5. **Phase 3** — `<path rounded="1">` Bezier rounding; `<image>` via `embedExternalImages`; `<include-shape>` recursion.

---

## Appendix: Advisor Review Summary (2026-05-25)

The initial draft had 10 defects, all corrected in this revision:

| # | Defect | Fix |
|---|---|---|
| 1 | Key format derived from file path, not `<shapes name="...">` attr | §3.2 rewritten with correct formula |
| 2 | No space→underscore replacement in shape names | Added to §3.2 key formula |
| 3 | `aspect="fixed"` centering offset missing | §3.3 `computeAspect` added |
| 4 | `direction` / `flipH` / `flipV` transforms not mentioned | §3.3 direction handling + §3.4 step 12 |
| 5 | Gradient fills silently dropped | §3.4 step 9 gradient handling added |
| 6 | `<path rounded="1">` silently approximated as sharp | §3.4 step 6: raise notice for rounded paths |
| 7 | Inline `stencil(base64...)` shapes not handled | §3.5 added |
| 8 | `strokewidth="inherit"` initial setup not described | §3.4 step 3 added |
| 9 | `labelPosition`/`verticalLabelPosition` not handled | §3.6 style overrides table added |
| 10 | `<fillstroke>` described as child of `<path>` (wrong — it's a sibling) | §3.4 step 5 clarified with explicit sibling walker model |
