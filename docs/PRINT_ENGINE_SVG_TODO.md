# Print Engine — Embedded SVG Rasterizer (TODO #2)

**Audience:** the engineer/agent adding real embedded-SVG rendering.
**Companion to:** `docs/PRINT_ENGINE_ACCURACY_TODO.md` (general accuracy work
order). Read that doc's §0 ground rules first — they apply here unchanged.
**Decision (made):** ship with **resvg** (pure-Rust; no cairo/glib/system
deps), but **architect the boundary so librsvg+cairo can be swapped in later
with zero C++ change**. The swap mechanism is the whole point of this design,
not an afterthought.

---

## 0. Non-negotiables specific to this work

- **INV-1:** the engine library (`include/`, `src/`) must never name `resvg`,
  `rsvg`, `cairo`, `usvg`, or any rasterizer concept — not in code, not in
  comments (the architecture test scans for banned tokens; treat these the same
  way even though they aren't on the list yet). **All rasterizer code lives
  under `host/`.** The engine only ever ferries *opaque SVG bytes*.
- **INV-5:** SVG must be rasterized inside the **shared** `draw_trace()` path
  that both preview and print use, at the **device DPI**, so preview and print
  receive identical pixels. Never rasterize once for preview and differently
  for print.
- **You own the ABI.** Your maintained C++ depends on exactly one artifact you
  wrote — a hand-authored C header. No cbindgen output, no librsvg header, no
  cairo header ever enters your includes, link line, or build graph.
- **Loud degradation, never silent.** A missing/incompatible rasterizer DLL
  falls back to the existing `StubbedSvgArtwork` loud notice — the engine still
  prints everything else. SVG never silently vanishes or mis-renders.
- **SCOPE FENCE — this rasterizer is for embedded `<svg>` artwork shapes
  ONLY.** It is **not** the path for drawio rich-text labels. drawio rich text
  is HTML; drawio's own SVG export wraps HTML labels in `<foreignObject>`, and
  **resvg does not render `foreignObject`** (librsvg's support is also poor).
  Routing HTML labels through this rasterizer yields blank/garbled text. Rich
  text has its own work order: `docs/PRINT_ENGINE_RICHTEXT_TODO.md` (TODO #3).
  If an incoming SVG itself contains `<foreignObject>`, treat it as an
  unsupported feature (loud-degrade per below) — do not pretend it rendered.
- **Unsupported SVG features loud-degrade.** resvg covers a static SVG 1.1/2
  subset: no scripting, no SMIL animation, limited CSS, limited filters, no
  `foreignObject`. When the shim detects/encounters an unsupported feature it
  must report it (status → `DegradationNotice`), never silently drop content.
- Build/test baseline and strict-warning rules: see
  `PRINT_ENGINE_ACCURACY_TODO.md` §0. Keep `ctest` green at every step.

---

## 1. The swap-ability principle (resvg today, librsvg tomorrow)

The abstraction **is the C ABI itself**, not a C++ class wrapping two libs:

- `resvg` and a future `librsvg+cairo` are each a **separate DLL implementing
  the identical hand-owned C header**. They are interchangeable binaries.
- The C++ side has exactly one consumer: an `ISvgRasterizer` interface in
  `host/` with one implementation, `SvgRasterizerDll`, that `LoadLibraryW` +
  `GetProcAddress`-resolves the ABI symbols. Swapping backends = pointing the
  loader at a different DLL filename (build/config switch). **No C++ recompile,
  no ABI change, no pipeline change.**
- **ABI purity rule (this is what preserves swap-ability):** the header must
  express *only* "SVG bytes + target size + DPI → RGBA pixels". It must not
  leak a single resvg-ism (no usvg tree, no resvg options struct, no fontdb
  handle). If a signature can't be satisfied by a librsvg/cairo shim without
  changing the header, the signature is wrong. Review every ABI symbol against
  the question "could a cairo-backed shim implement this unchanged?"

---

## 2. Where it slots into the pipeline

- The contract already carries `svg_source` in `PaintNodeSummary`; today
  `EmittedKind::Svg` is the loud crosshatch stub in `renderer.cpp` /
  `draw_trace()`.
- **Thread the opaque SVG bytes through `EmittedCommand`** exactly the way
  raster-image bytes are now carried into the host sink (the in-progress
  base64/image path in `win32_services.cpp`). This is INV-1-safe: the engine
  moves an opaque string + box; it never names a rasterizer.
- In `draw_trace()`, the `Svg` branch: ask `ISvgRasterizer` to render the bytes
  at `device_box` pixel size and the current device DPI, then composite the
  returned RGBA via GDI+ `DrawImage` into `device_box` (honor aspect, the same
  way the image branch does). Both preview and print reach this same code →
  INV-5 holds.
- Fallback: if no rasterizer is available, keep emitting the existing
  `StubbedSvgArtwork` `DegradationNotice` + crosshatch box.

---

## 3. The ABI seam (described, not coded — keep it minimal)

Hand-authored C header under `host/` (e.g. `host/svg_rasterizer_abi.h`):

- **ABI-version query** — returns an integer the loader checks at load with the
  same loud handshake discipline used for the engine protocol: mismatch ⇒
  refuse the DLL, fall back to the loud stub. Never best-effort.
- **Render** — inputs: SVG byte pointer + length, target width px, target
  height px, DPI. Output: RGBA8 pixels. Use the **caller-allocates** pattern:
  one call returns the required width/height/byte length for a given SVG +
  target; a second call fills a C++-owned buffer. This means **no memory is
  ever freed across the ABI** (eliminates a whole bug class). If you instead
  let the DLL allocate, you MUST also export a matching free and call it — do
  not mix allocators. Prefer caller-allocates.
- **Pixel contract pinned in *your* header:** byte order, and
  premultiplied-vs-straight alpha, and row stride. (resvg emits straight RGBA;
  GDI+ `32bppPARGB` expects premultiplied BGRA — decide which side converts and
  write it in the header as law, so any future shim must match.)
- **Error model:** integer status + optional message buffer; the host maps it
  to a typed `DegradationNotice` / decode-error. **No exceptions or Rust panics
  may cross the ABI** — the Rust shim wraps every export in `catch_unwind` (or
  builds with `panic = "abort"`); a panic unwinding into C++ is UB and is not
  acceptable.
- **Determinism:** same SVG + same target size + same DPI ⇒ byte-identical
  RGBA for **vector** content (required for INV-5). Note SVG-**embedded text**
  is only deterministic given the same resolved fonts — the font set varies per
  machine. For regulated reproducibility either pin/ship the font set the shim
  uses, or record the resolved/substituted fonts in the `jobLog` (ties to §6
  escalation #2). Do not claim cross-machine byte-equality of SVG text.

---

## 4. The resvg shim crate

- Separate Cargo project (e.g. `src/main/native-print-engine/host/svg-rasterizer/`),
  `crate-type = ["cdylib"]`, `#[no_mangle] extern "C"` exports matching *your*
  header exactly, panic-safe at the boundary.
- Internally uses `usvg` + `resvg` (tiny-skia). Font handling: resvg uses a
  `fontdb`; load system fonts so SVG-embedded text resolves. **SVG text uses
  the rasterizer's font stack, NOT the engine's text metrics** — this is a real
  fidelity boundary (see §6 escalation).
- Output DLL is built independently and dropped next to
  `print_engine_host.exe`. Upstream resvg bug-fix flow: bump the crate, rebuild
  the DLL, drop it in; the ABI-version handshake validates it; **C++ is not
  touched.** That is the entire maintenance benefit you asked for.
- CMake/build: the Rust crate is NOT a CMake target dependency of the engine
  (that would re-couple builds). It is built separately (cargo) and treated as
  an optional runtime artifact. It lives under `host/` so the INV-1 scan never
  sees it; add its `target/` to `.gitignore` so the Rust build dir does not
  pollute the C++ tree. Add a CI step that builds it and a C++ test
  that loads the DLL and resolves every ABI symbol + checks the version
  handshake (loud-fail if a symbol is missing — same philosophy as the protocol
  handshake).

---

## 5. The librsvg+cairo swap path (contingency, not built now)

Documented so the ABI is designed correctly for it from day one:

- A second shim DLL implementing the **same** header, backed by librsvg
  (C/GObject API) rendering into a cairo image surface, then handing back RGBA
  in the pinned pixel format.
- Heavier transitive deps (glib/pango/harfbuzz/freetype/gdk-pixbuf) and LGPL —
  the runtime-DLL boundary is exactly what keeps that license obligation
  isolated from your code. The dynamic boundary is load-bearing for licensing,
  not just for decoupling.
- Swap test (acceptance, build now): a trivial **fake** shim DLL that
  implements the ABI and returns a known solid-color buffer. The host must work
  with it unchanged. If the fake-DLL swap requires any C++ edit, the ABI failed
  the purity rule in §1 and must be reworked before shipping resvg.

---

## 6. Escalations (decide with the spec owner before shipping)

1. **Turning the SVG loud-stub into trusted rendering is a regulated
   safety-posture change** (spec set v2.0 §3.1/§3.3 — operator must currently
   acknowledge "SVG STUBBED — not real artwork"). Do not silently treat
   rasterized SVG as fully trusted. Likely resolution: replace with a *softened*
   `DegradationNotice` ("SVG rendered via external rasterizer <name> <version>;
   fonts: <resolved/substituted>") and record the rasterizer name+version in
   the existing `PrintResult.jobLog` for traceability. Spec owner approves the
   exact wording/posture.
2. **SVG-embedded text fidelity** depends on the rasterizer's font stack, not
   the engine's metrics — it can substitute differently than native contract
   text. Decide whether a missing-font inside an SVG raises its own notice.

---

## 7. Phased plan

1. **Resolve §6 escalations** (loud-stub posture; SVG-text font notice). Gates
   shipping, not early dev.
2. **Thread opaque `svg_source` bytes through `EmittedCommand`** (engine,
   INV-1-clean) + tests. SVG still stubs; the data now reaches the host sink.
3. **Author the ABI header + `ISvgRasterizer` + `SvgRasterizerDll` loader** in
   `host/`, with the version handshake and missing-DLL → loud-stub fallback.
   Build the **fake shim DLL** and prove the loader + swap with it (no real
   rasterizer yet).
4. **Build the resvg shim crate**, panic-safe, implementing the header.
5. **Wire into `draw_trace()` Svg branch**; composite RGBA via GDI+ at device
   DPI; preview and print share the path (INV-5).
6. **Determinism + golden-image tests**, ABI-symbol CI check, `jobLog` records
   rasterizer name+version. Hook into the golden harness from
   `PRINT_ENGINE_ACCURACY_TODO.md` §9.

---

## Definition of done

1. An embedded `<svg>` in a diagram prints as real artwork, crisp at the
   printer's device DPI, correctly positioned/scaled in its box.
2. The rasterized RGBA buffer is deterministic for a given SVG+size+DPI+fonts
   and is composited identically into both the preview bitmap and the print DC
   (INV-5: same pixels into both sinks — not byte-identical *printed* output,
   which the driver still halftones).
3. Engine library still contains zero rasterizer concept (INV-1; architecture
   test green).
4. The **fake-shim swap test passes with no C++ change** — proving librsvg can
   later replace resvg by swapping the DLL only.
5. Missing/incompatible DLL ⇒ loud `StubbedSvgArtwork` fallback, never a crash
   or silent omission; Rust panics cannot cross the ABI.
6. Rasterizer name+version recorded in `jobLog`; SVG safety notice per the §6
   spec decision.
7. `ctest` green; SVG golden-image suite green in CI.

Update `docs/MEMORY.md` as milestones land. The frozen contract schema is in
`PRINT_ENGINE_ACCURACY_TODO.md` Appendix A (authoritative).
