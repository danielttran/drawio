# Native Print Path B — Gap Bridge Plan

> **Status**: Advisor-reviewed and signed off (three rounds). Zero deferrals — all gaps
> have complete implementation plans.
>
> **Scope**: Close every loud-refusal blocking notice in the headless (Path B) print bake
> so that well-formed draw.io diagrams reach the C++ print engine with zero
> operator-visible degradation notices.

---

## Background

Path B (headless, Node.js bake) currently emits blocking notices in these categories:

| Notice kind | Fires when |
|-------------|-----------|
| `ExporterUnsupportedImage` | `style.image` is an external URL with no pre-fetched data URI |
| `ExporterUnsupportedShape` | Named shape not in `shapePath()` or stencil registry |
| `ExporterUnsupportedStencilFeature` | Stencil uses `<image>`, `<include-shape>`, `<text>`, or `<path rounded="1">` |

Two additional non-blocking notices are also addressed:

| Notice kind | Fires when |
|-------------|-----------|
| `GradientDirectionApprox` | Gradient cell produces `kind:'path'` — v1 contract has no direction field |
| `RichApproximate` | rgba text color alpha is dropped (hex colors only in contract) |

Gaps are ordered by real-world impact on diagrams using the bundled stencil library.

---

## Gap A — `GradientDirectionApprox` ★ HIGHEST PRIORITY

### Why it fires

`scanGradientFallbacks()` (`exporter.js` lines 3100–3121) fires once per page when any
`kind:'path'` node in the paint list has a gradient fill. Non-rotated cells with gradients
reach `paint.push({ kind:'path', fill:fillOf(style) })` at line 3437; `fillOf()` returns
structural gradient stops with **no direction**. The C++ engine renders all such gradients
left-to-right regardless of the diagram's `gradientDirection` style property.

**Additionally, three other locations silently diverge** — they hardcode
`x1="0" y1="0" x2="1" y2="0"` (always east/left-to-right) regardless of `style.gradientDirection`:
- `stencilToSvg()` lines 122, 336, 351 — stencil shapes (already `kind:'svg'`, not caught
  by `scanGradientFallbacks`, but still geometrically wrong)
- `emitVertex()` line 3413 — rotated non-stencil shapes (also `kind:'svg'`, same issue)

`style.gradientDirection` is **never read** anywhere in `exporter.js` today.

### Implementation — ~60 lines in `exporter.js`

**Step 1**: Add two helpers near the top of the exporter module:

```js
function gradientVector(dir) {
  // Valid values: 'south' (default), 'north', 'east', 'west', 'none'.
  // 'none' and unset both mean top-to-bottom (south) — draw.io default.
  switch ((dir || 'south').toLowerCase()) {
    case 'north': return { x1:0, y1:1, x2:0, y2:0 };
    case 'east':  return { x1:0, y1:0, x2:1, y2:0 };
    case 'west':  return { x1:1, y1:0, x2:0, y2:0 };
    default:      return { x1:0, y1:0, x2:0, y2:1 }; // south / none
  }
}
function linearGradDef(id, c1, c2, dir) {
  var v = gradientVector(dir);
  return '<linearGradient id="' + id + '" x1="' + v.x1 + '" y1="' + v.y1 +
    '" x2="' + v.x2 + '" y2="' + v.y2 + '" gradientUnits="objectBoundingBox">' +
    '<stop offset="0" stop-color="' + c1 + '"/>' +
    '<stop offset="1" stop-color="' + c2 + '"/>' +
    '</linearGradient>';
}
```

**Step 2**: Replace the four hardcoded `<linearGradient ... x1="0" y1="0" x2="1" y2="0">`
strings at lines 122, 336, 351, and 3413 with calls to
`linearGradDef(id, hex(fillColor), hex(gradColor), style.gradientDirection)`.

**Step 3**: In `emitVertex()` at lines 3437–3442, add a mode-B gradient branch **before**
the existing `paint.push({ kind:'path', ... })`. The path `d` at this point is in absolute
page coordinates (from `shapePath(style, box.x, box.y, ...)` at line 3380). For the inline
SVG, recompute with box-relative origin via `shapePath(style, 0, 0, box.w, box.h)` —
identical pattern to the rotated-cell branch at line 3405:

```js
if (mode === 'B' && isPaintable(style.gradientColor)) {
  var gid = 'g' + String(cell.id || '').replace(/[^a-z0-9]/gi, '');
  var defs = '<defs>' + linearGradDef(gid, hex(style.fillColor),
    hex(style.gradientColor), style.gradientDirection) + '</defs>';
  var relD = shapePath(style, 0, 0, box.w, box.h) || rectPath(0, 0, box.w, box.h);
  var svgStr = '<svg xmlns="http://www.w3.org/2000/svg" width="' + fmt(box.w) +
    '" height="' + fmt(box.h) + '">' + defs +
    '<path d="' + relD + '"' + fillSvgAttr(style, gid) + strokeSvgAttrs(style) + '/></svg>';
  paint.push({ kind:'svg', box:{ x:box.x, y:box.y, w:box.w, h:box.h },
    source: base64(svgStr), aspect: 'preserve' });
  return;
}
// existing kind:'path' fallback unchanged (runs for mode A)
paint.push({ kind: 'path', d: d, fill: fillOf(style), stroke: strokeOf(style) });
```

**Result**: `GradientDirectionApprox` notice eliminated (no more `kind:'path'` gradient
nodes in mode B). Stencil and rotated-shape gradient direction also silently corrected.

---

## Gap 1 — `ExporterUnsupportedImage`: External image URLs

### What fires it

`emitVertex()` (`exporter.js` line ~3210): `style.image` is an `http(s)://` URL and
`opts.resolvedImages` has no pre-fetched data URI for it.

### Known sub-gap (not bridged here)

External images embedded inside HTML labels (`<img src="https://...">`) are not bridged
here because `transcribeForeignObjects()` is skipped in mode B entirely. See Known
Remaining Limitations.

### Option A — Browser dialog: ~10 lines in `nativeprint.js`

`embedExternalImages()` (`exporter.js` lines 2911–2968) walks cells for external
`style.image` URLs, `fetch()`es each, converts to data URIs, and returns a `resolvedImages`
map. `buildResult()` already accepts and uses this map via `opts.resolvedImages`.

The browser dialog already calls `embedExternalImages()` for mode A (line ~396) using
an async Promise chain. Add the same call for mode B — same pattern, same resolved-image
map. No structural change needed: the dialog flow is already async for mode A.

**Caveat**: WebP/BMP `style.image` sources need canvas re-encode (not available headlessly).
These will still emit `ExporterUnsupportedImage`. Documented known limitation.

### Option B — Standalone `bake.mjs`: ~60 lines + 24 caller updates

`bake()` is currently synchronous. Making it async requires updating all 24 call sites in
`bake.test.mjs` from `bake(xml)` to `await bake(xml)` — an intentional API break that
must be clearly documented.

Implementation:
1. Make `bake(xml, opts)` async
2. After `buildGraph()`, walk cell styles for external `style.image` URLs (no DOM needed)
3. `fetch()` each (injectable `fetchFn` parameter for tests), convert to data URIs
4. Pass as `opts.resolvedImages` to `buildResult()`

**Recommendation**: **A first** (immediate, 10 lines); **B** when standalone bake is needed.

---

## Gap 5 — `ExporterUnsupportedStencilFeature`: `<text>` in stencil

### What fires it

`stencilToSvg()` walkNodes `case 'text':` (~line 411) — raises notice and returns false.

### Prevalence (grep-verified)

**32 of 202 bundled stencil files** use `<text>` — Cisco (`switches.xml`, `routers.xml`,
`misc.xml`, `wireless.xml`), AWS groups, PID valves/instruments, iOS7 icons, AWS2 compute.

Representative samples:
```xml
<text str="Si" x="15.5" y="20.5" valign="middle" align="center"/>
<text str="15" align="center" valign="middle" x="50" y="50"/>
```

Attributes found in bundled corpus: `str`, `x`, `y`, `valign`, `align` only.
No `vertical`, `clip`, `bold`, `italic`, `underline`, `fontsize`, or `fontfamily` found —
those are in the stencil spec but unused in the bundled library.

### Implementation — ~30 lines in `exporter.js`

Replace `case 'text':` at line ~411 with SVG `<text>` emission.
`state.fontSize` and `state.fontFamily` are initialised from the cell's style at
`stencilToSvg()` entry (lines 100–114) and are correct at evaluation time.
`su` (uniform stencil scale) is in scope. `dominant-baseline` is supported in resvg
(confirmed: exporter already emits it at line 726 via `textSvgStr()`).

```js
case 'text': {
  var str = a.str || '';
  if (!str) return false;
  var ttx = tx(parseFloat(a.x) || 0);
  var tty = ty(parseFloat(a.y) || 0);
  var anchor = a.align === 'left' ? 'start' : a.align === 'right' ? 'end' : 'middle';
  var baseline = a.valign === 'top' ? 'hanging' : a.valign === 'bottom' ? 'auto' : 'central';
  var fs = parseFloat(a.fontsize) || state.fontSize || 11;
  var ff = a.fontfamily || state.fontFamily || 'Arial';
  var fc = state.fontColor || '#000000';
  var tattrs = ' text-anchor="' + anchor + '" dominant-baseline="' + baseline + '"' +
    ' font-family="' + escXml(ff) + '" font-size="' + fmt(fs * su) + '" fill="' + fc + '"';
  elems.push('<text x="' + fmt(ttx) + '" y="' + fmt(tty) + '"' + tattrs + '>' +
    escXml(str) + '</text>');
  return false;
}
```

Note: pushes directly to `elems` (line 226 — the correct shared accumulator), not
to `currentPath`. Stencil `<text>` is decorative geometry, not a paint command.

---

## Gap 4 — `ExporterUnsupportedStencilFeature`: `<path rounded="1">`

### What fires it

`walkPath()` (`exporter.js` lines 168–175): detects `rounded="1"` on a `<path>` element
and raises `ExporterUnsupportedStencilFeature`.

### Algorithm (reverse-engineered from `mxShape.prototype.addPoints()`)

Quadratic Bezier corner rounding with **fixed radius in stencil coordinate units** read
from `pathNode.attrs.arcsize`. For each interior corner (prev → cur → next):
1. `r = min(arcSizePx, dist_prev/2, dist_next/2)` — clamped to half-segment to prevent overshoot
2. inset_toward_prev = `cur + normalize(prev − cur) * r`
3. inset_toward_next = `cur + normalize(next − cur) * r`
4. Emit: `L inset_toward_prev  Q cur.x cur.y  inset_toward_next`

For **closed paths**: treat as cyclic — first and last corners are also rounded.
For **open paths**: first and last points are unchanged (emit final `L` to endpoint).
Mixed paths (containing `<curve>`, `<arc>`, `<quad>`): fall through to regular parsing without rounding.

### Implementation — ~80 lines in `walkPath()` (`exporter.js` lines 167–217)

`walkPath()` returns an SVG path string. `su`, `sw`, `sh`, `tx()`, `ty()` are all in scope
from the enclosing `stencilToSvg()`. `arcSize` is in stencil units — multiply by `su` to
convert to SVG pixels.

Replace the early-return block at lines 168–175:

```js
if (pathNode.attrs.rounded === '1') {
  // arcSize is in stencil coordinate units; su converts to SVG pixel space
  var arcSizePx = (parseFloat(pathNode.attrs.arcsize) || 10) * su;
  var rpts = [], closed = false;
  for (var ci = 0; ci < pathNode.children.length; ci++) {
    var cc = pathNode.children[ci];
    if (cc.name === 'move' || cc.name === 'line') {
      rpts.push({ x: tx(parseFloat(cc.attrs.x)||0), y: ty(parseFloat(cc.attrs.y)||0) });
    } else if (cc.name === 'close') {
      closed = true;
    } else {
      rpts = null; break; // curve/arc/quad present — fall through to regular parse
    }
  }
  if (rpts && rpts.length >= 2) {
    var rn = rpts.length;
    function rpt(i) { return closed ? rpts[((i%rn)+rn)%rn] : rpts[Math.max(0,Math.min(rn-1,i))]; }
    var rp = ['M ' + fmt(rpts[0].x) + ' ' + fmt(rpts[0].y)];
    for (var rj = (closed ? 0 : 1); rj < (closed ? rn : rn-1); rj++) {
      var rv = rpt(rj-1), rc = rpt(rj), rx2 = rpt(rj+1);
      var dpx = rv.x-rc.x, dpy = rv.y-rc.y, dp = Math.sqrt(dpx*dpx+dpy*dpy)||1;
      var dnx = rx2.x-rc.x, dny = rx2.y-rc.y, dn = Math.sqrt(dnx*dnx+dny*dny)||1;
      var r = Math.min(arcSizePx, dp/2, dn/2);
      rp.push('L ' + fmt(rc.x+dpx/dp*r) + ' ' + fmt(rc.y+dpy/dp*r) +
        ' Q ' + fmt(rc.x) + ' ' + fmt(rc.y) +
        ' ' + fmt(rc.x+dnx/dn*r) + ' ' + fmt(rc.y+dny/dn*r));
    }
    if (!closed) rp.push('L ' + fmt(rpts[rn-1].x) + ' ' + fmt(rpts[rn-1].y));
    if (closed)  rp.push('Z');
    return rp.join(' ');
  }
  // mixed path (curve/arc/quad + rounded="1") — fall through to regular parsing below
}
// existing: var parts = []; ... for loop ... return parts.join(' ')
```

---

## Gap 3 — `ExporterUnsupportedStencilFeature`: `<include-shape>` composition

### What fires it

`walkNodes()` (`exporter.js` lines 403–408): detects `include-shape` and raises
`ExporterUnsupportedStencilFeature`.

### How it works in draw.io (`mxStencil.js` lines 950–962)

`<include-shape name="mxgraph.aws.ec2" x="5" y="5" w="40" h="40"/>` looks up the named
stencil in the registry then renders it at the given `(x, y, w, h)` bounding box in the
parent's coordinate space. The sub-stencil's own `<shape w h>` bounds are ignored —
it is stretched to fill the given box exactly.

### Key facts

- `_stencilRegistry` is a module-level variable (line 14) accessible from `walkNodes()`
  as a closure variable — no parameter threading needed.
- `elems` (line 226) is the correct accumulator to push to — not `svgParts` (which doesn't exist).
- There is no `flushPath()` helper — `currentPath` is consumed by paint commands inline.
  The recursive `stencilToSvg()` call creates its own fresh `elems` and `currentPath`;
  parent state is never mutated.
- `stencilToSvg()` never emits nested `<svg>` elements, so a regex extraction of inner
  content is safe.

### Implementation — ~50 lines in `walkNodes()` (`exporter.js` lines 403–408)

Replace `case 'include-shape':` at lines 403–408:

```js
case 'include-shape': {
  var subName = (a.name || '').toLowerCase();
  var subX = parseFloat(a.x) || 0;
  var subY = parseFloat(a.y) || 0;
  var subW = parseFloat(a.w) || 0;
  var subH = parseFloat(a.h) || 0;
  if (!subName || subW <= 0 || subH <= 0) return false;

  var subNode = _stencilRegistry && _stencilRegistry.get(subName);
  if (!subNode) {
    if (Array.isArray(notices)) notices.push(degradation('ExporterUnsupportedStencilFeature',
      'include-shape "' + subName + '" not found in stencil registry', ''));
    return false;
  }

  // Recursively render sub-stencil. subW/subH are in parent stencil units;
  // sw/sh scale to SVG pixels. stencilToSvg() creates fresh elems/currentPath.
  var subSvgStr = stencilToSvg(subNode, subW * sw, subH * sh, style, notices);
  if (!subSvgStr) return false;

  // stencilToSvg() always returns a single <svg> root with no nested <svg> elements.
  var m = /^<svg[^>]*>([\s\S]*)<\/svg>\s*$/.exec(subSvgStr);
  var subInner = m ? m[1] : '';
  if (subInner) {
    elems.push('<g transform="translate(' + fmt(tx(subX)) + ',' + fmt(ty(subY)) + ')">' +
      subInner + '</g>');
  }
  return false;
}
```

**State isolation**: `stencilToSvg()` builds a fresh `state`, `elems`, and `currentPath`
each invocation — parent state is never mutated.

**`<defs>` inside `<g>`**: if the sub-stencil has a gradient, its `<defs>` ends up inside
the `<g transform>`. This is valid SVG — resvg resolves `<defs>` from within any ancestor.

---

## Gap 2 — `ExporterUnsupportedStencilFeature`: `<image>` inside stencil XML

### What fires it

`stencilToSvg()` walkNodes `case 'image':` (~line 399) — raises notice and returns false.

### Prevalence

Zero bundled stencil files use `<image>`. Gap affects only custom/user stencils.

### Implementation — ~20 lines in `exporter.js`

Replace `case 'image':` at line ~399. If `a.src` is already a data URI, emit it directly.
External URL `src`: keep the existing loud notice (no headless fetch path for stencil images).

```js
case 'image': {
  var isrc = a.src || '';
  if (isrc.indexOf('data:') === 0) {
    // Already embedded — emit directly
    var pr = a.preserveAspectRatio ||
      (a.aspect === 'fixed' ? 'xMidYMid meet' : 'none');
    elems.push('<image href="' + isrc + '" x="' + fmt(tx(parseFloat(a.x)||0)) +
      '" y="' + fmt(ty(parseFloat(a.y)||0)) +
      '" width="' + fmt(trx(parseFloat(a.w)||0)) +
      '" height="' + fmt(try_(parseFloat(a.h)||0)) +
      '" preserveAspectRatio="' + pr + '"/>');
    return false;
  }
  // External URL — cannot fetch headlessly; keep loud notice
  if (Array.isArray(notices)) notices.push(degradation('ExporterUnsupportedStencilFeature',
    'stencil uses <image> with external URL (cannot embed headlessly)', ''));
  return false;
}
```

---

## Gap B — `RichApproximate`: rgba text color

### Status

**Line 1589** (no `getComputedStyle`): does **not** fire in mode B — `shimGetComputedStyle`
is injected at `bake.mjs` line 39. Already closed.

**Line 1632** (rgba text color alpha): fires when a rich-text run uses `rgba(...)` CSS color.
Alpha is dropped to hex. This is cosmetic — print output is opaque by design. Downgrade from
`degradation()` to an info-level notice. Mechanism: use the `info()` helper if it exists,
or replace `degradation('RichApproximate', ...)` at line 1632 with a notice that carries
`severity: 'info'` and update `severityOf()` to classify it as `'info'` rather than
`'degradation'`.

**Effort**: ~10 lines.

---

## Implementation Order

| # | Gap | File | Effort | Impact |
|---|-----|------|--------|--------|
| 1 | Gap A: gradient direction | `exporter.js` | ~60 lines | Closes most pervasive notice |
| 2 | Gap 1A: image pre-fetch (browser dialog) | `nativeprint.js` | ~10 lines | Closes image URL notices in UI |
| 3 | Gap 5: stencil `<text>` | `exporter.js` | ~30 lines | Closes 32 Cisco/AWS/PID stencil files |
| 4 | Gap 4: stencil `<path rounded="1">` | `exporter.js` | ~80 lines | Spec-complete stencil path rendering |
| 5 | Gap 3: stencil `<include-shape>` | `exporter.js` | ~50 lines | Spec-complete stencil composition |
| 6 | Gap 1B: async bake + headless image fetch | `bake.mjs` + `bake.test.mjs` | ~60 lines + 24 caller updates | Standalone bake image URLs |
| 7 | Gap B: rgba notice severity downgrade | `exporter.js` | ~10 lines | rgba text becomes non-blocking |
| 8 | Gap 2: stencil `<image>` data-URI | `exporter.js` | ~20 lines | Custom stencils with embedded images |

---

## Files to Change

| File | Changes |
|------|---------|
| `src/main/webapp/plugins/nativeprint/exporter.js` | Gaps A, 5, 4, 3, 2, B — all exporter changes |
| `src/main/webapp/plugins/nativeprint.js` | Gap 1A — wire `embedExternalImages()` for mode B |
| `tools/native-print-bake/bake.mjs` | Gap 1B — `async bake()`, image URL collection + fetch |
| `tools/native-print-bake/bake.test.mjs` | Gap 1B — 24 callers → `await bake()`; C4 zero-notice assertions |

---

## Known Remaining Limitations

These are structural constraints, not implementation gaps. No fix is possible without
violating the no-browser / no-schema-change constraints.

| Limitation | Root cause | Signal |
|------------|-----------|--------|
| WebP/BMP image transcode | No canvas headlessly; owner carve-out allows canvas for embed only | `ExporterUnsupportedImage` |
| HTML label `<img src>` in mode B | `transcribeForeignObjects()` skipped in mode B (no live DOM) | Image absent from label output |
| Word-wrap in HTML labels | No font metrics available headlessly | Text may overflow cell bounds |
| CJK/RTL text metrics | Estimated character widths; no shaping engine | Approximate layout |
| Stencil `<include-shape>` sub-stencil `<defs>` | `<defs>` inside `<g>` (Phase 1 approach); valid SVG, resvg resolves it | None — visual result correct |

---

## Verification Protocol

After each gap is implemented and before committing:

```sh
# All tests must pass — 0 failures
node --test tools/native-print-bake/bake.test.mjs

# All 17 fixture files, structural checks 1–16 — 0 failures
node tools/native-print-bake/wysiwyg-compare.mjs --all
```

A gap bridge is **not complete** until:
- C4 tests confirm zero blocking notices for all fixture files
- wysiwyg-compare confirms 0 failures on all 17 files
- Golden contracts are regenerated where the output changes
