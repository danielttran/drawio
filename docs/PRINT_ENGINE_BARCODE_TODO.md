# Print Engine — Barcode SDK Adapter (TODO #4)

**Audience:** the engineer/agent integrating the external enLabel barcode SDK.
**Companion to:** `docs/PRINT_ENGINE_SVG_TODO.md` (the resvg pattern this
work mirrors exactly), `docs/PRINT_ENGINE_ACCURACY_TODO.md` §0 ground
rules, and `docs/PRINT_ENGINE_SPEC_v1.1.md` §3.3 / §3.4 / §4.6 /
`docs/PRINT_ENGINE_SPEC_v2.0.md` §3.1 / §3.3 (the loud-stub posture
this lifts).

This is a **plan, not committed code.** It is here because the barcode
primitive has been the largest "spec-deferred external" item in
`docs/SPEC_COVERAGE.md` for the entire engine lifetime; SVG TODO #2
shipped while barcode stayed a stub, and the owner has indicated they
want every primitive to ship a real backend without a re-architecture.
The plan exists so that when the enLabel SDK arrives the integration
is a copy-paste of the resvg pattern — no new design decisions.

The exact wording of the lifted-stub posture and any new
`DegradationNotice` shape MUST be confirmed by the spec owner before
this is implemented (same gate as SVG §6).

---

## 0. Why this mirrors SVG TODO #2

The barcode primitive has the same shape as the SVG primitive:

| Property | SVG | Barcode |
|---|---|---|
| External dependency | resvg (Rust crate) | enLabel SDK (third-party) |
| Lives behind | Hand-owned C ABI | Hand-owned C ABI (proposed) |
| Loaded at runtime | `LoadLibraryW` of `svg_rasterizer.dll` | `LoadLibraryW` of `barcode_renderer.dll` |
| Engine knowledge | Zero (opaque bytes only) | Zero (opaque symbology + value strings) |
| Host fallback | Loud crosshatch stub + `StubbedSvgArtwork` | Loud crosshatch stub + `StubbedBarcode` |
| Success notice (new) | `SvgArtworkRasterized` carrying backend id | `BarcodeRendered` carrying SDK id (proposed) |
| Pixel contract | Straight RGBA8 R,G,B,A top-down | Same |
| Loader | `SvgRasterizerDll` in `host/svg_rasterizer.cpp` | `BarcodeRendererDll` in `host/barcode_renderer.cpp` (proposed) |
| Swap acceptance | Fake-shim cdylib + Catch2 test | Same pattern |

The architectural payoff is the same as SVG: swapping a barcode backend
(e.g. enLabel → Zint, or enLabel v1 → v2) is a DLL drop. No C++
recompile, no engine library change, no contract schema change.

## 1. Proposed C ABI (`host/barcode_renderer_abi.h`)

```c
#define SPE_BC_ABI_VERSION 1

typedef enum {
  SPE_BC_OK = 0,
  SPE_BC_ERR_BAD_ARGS = -1,
  SPE_BC_ERR_UNSUPPORTED_SYMBOLOGY = -2,
  SPE_BC_ERR_VALUE_REJECTED = -3,    /* unencodable for this symbology */
  SPE_BC_ERR_BUFFER_TOO_SMALL = -4,
  SPE_BC_ERR_INTERNAL = -5
} spe_bc_status;

int32_t spe_bc_abi_version(void);

size_t spe_bc_backend_id(char* name_buf, size_t name_buf_len);

/* PASS 1 (measure): given (symbology, value, target box, dpi) compute the
 * RGBA output dimensions/length. */
int32_t spe_bc_measure(const char* symbology,
                       const uint8_t* value, size_t value_len,
                       uint32_t target_w_px, uint32_t target_h_px,
                       double dpi,
                       uint32_t* out_w, uint32_t* out_h,
                       size_t* out_byte_len);

/* PASS 2 (render): fill caller-owned RGBA buffer per the pinned pixel
 * contract (straight RGBA8, R,G,B,A, top-down, stride = w*4). On a loud
 * failure an optional UTF-8 message is written to err_buf. */
int32_t spe_bc_render(const char* symbology,
                      const uint8_t* value, size_t value_len,
                      uint32_t target_w_px, uint32_t target_h_px,
                      double dpi,
                      uint8_t* out_pixels, size_t out_pixels_len,
                      char* err_buf, size_t err_buf_len);
```

**Purity rule** (mirror of SVG §1): the header expresses only "symbology +
value + target + DPI → RGBA pixels". No enLabel-isms. A future Zint or
ZXing-backed shim must implement this header unchanged.

**Memory rule:** caller-allocates (two-call measure-then-fill); nothing
freed across the ABI.

**Panic rule:** every export wraps `catch_unwind`; a panic returns
`SPE_BC_ERR_INTERNAL`, never UB across the C boundary.

**Determinism:** same (symbology, value, w, h, dpi) → byte-identical RGBA
for the **vector** half (1D/2D code modules). Module count, quiet zone,
and module aspect ratio are deterministic; the human-readable text below
the code may use the backend's font stack and therefore is host-recorded
in `jobLog` rather than claimed byte-equal.

## 2. The contract-side shape (no schema change)

The engine already encodes barcodes via:

```
{ "kind": "barcode",
  "box": { "x":<num>, "y":<num>, "w":<num >0>, "h":<num >0> },
  "symbology": "<string>",
  "valueType": "static|merge",
  ... }
```

This stays. The engine still emits an `EmittedKind::Barcode` command with
`label` (the value string) and `style_signature == "stub-barcode-crosshatch"`.
The HOST swaps the crosshatch draw for a backend call (same shape as the
SVG branch swap in `draw_trace`).

## 3. Where it slots into `draw_trace`

```cpp
} else if (c.kind == EmittedKind::Barcode) {
  // 1. Try the backend.
  if (barcode_renderer != nullptr && barcode_renderer->available()) {
    auto rr = barcode_renderer->render(
        c.barcode_symbology, c.label, target_w, target_h, g.GetDpiX());
    if (rr.ok()) {
      // composite RGBA -> premul BGRA -> DrawImage  (exactly the SVG path)
      push_notice_unique(result.notices, DegradationNotice{
          DegradationNoticeType::BarcodeRendered,
          current_page_id,
          "barcode rendered via external backend: " + barcode_renderer->backend_id(),
          c.barcode_symbology, c.label});
      // (carries symbology + resolved value verbatim for traceability)
      continue;
    }
  }
  // 2. Loud crosshatch fallback (existing behavior) — engine's
  //    StubbedBarcode notice already fired upstream.
}
```

The **HOST** owns the conversion from straight RGBA → premul BGRA, same
as SVG.

## 4. The Rust shim crate (proposed: enLabel-backed)

Mirror `host/svg-rasterizer/`: separate Cargo project under
`host/barcode-renderer/`, `crate-type = ["cdylib"]`, panic-safe at the
boundary, FFI-bound to the enLabel SDK (or whatever the chosen backend
ships).

If enLabel ships only as a C/C++ SDK (likely), the shim layer is a thin
C wrapper exporting the four `spe_bc_*` symbols — no Rust at all. The
ABI is the same; only the implementation language differs.

## 5. Notice taxonomy (the spec-owner escalation)

The new notice type (`BarcodeRendered`) needs spec-owner approval before
landing, exactly like `SvgArtworkRasterized` did. Until then:

- Keep the engine's `StubbedBarcode` notice unchanged (same posture).
- Add `BarcodeRendered` as additive — operator sees both notices on
  success. The owner can later flip the engine notice off in a single
  edit to `renderer.cpp`.

## 6. Phased plan

1. **[ESCALATE]** spec-owner approves: (a) the barcode ABI shape (this
   file is the proposal); (b) the new `BarcodeRendered` notice wording;
   (c) the choice of backend (enLabel vs Zint vs ZXing). Same gate as
   SVG §6.
2. Author the ABI header `host/barcode_renderer_abi.h` and the
   `IBarcodeRenderer` / `BarcodeRendererDll` loader in
   `host/barcode_renderer.{hpp,cpp}` — copy-paste of the SVG loader with
   `spe_bc_*` symbol names.
3. Author the fake-shim `host/test_support/fake_barcode_renderer.c` and
   the WIN32-gated swap-acceptance test
   `tests/barcode_renderer_abi_tests.cpp` — copy of the SVG test pattern.
4. Wire the host's `EmittedKind::Barcode` branch in
   `host/win32_services.cpp` to call the backend; preserve the
   crosshatch fallback. Plumb `IBarcodeRenderer*` through `draw_trace`
   the same way `ISvgRasterizer*` is plumbed (one Win32Services member,
   shared between `render_preview` and `print` so INV-5 holds).
5. Add the cross-platform pixel-determinism Catch2 test
   `tests/barcode_pixel_determinism_tests.cpp` — exact mirror of
   `tests/svg_pixel_determinism_tests.cpp`. Loads the backend via
   dlopen/LoadLibrary; asserts byte-identical RGBA for a fixed
   (symbology, value, w, h, dpi).
6. Record backend identity in `jobLog.barcodeRenderer` (mirror of
   `jobLog.svgRasterizer`).

## Definition of done

1. A barcode in a diagram prints as real machine-readable artwork (not
   crosshatch) when `barcode_renderer.dll` is present next to
   `print_engine_host.exe`.
2. The output is scan-verified for at least Code 128, Code 39, QR, and
   Data Matrix at typical print sizes by HIL-10 (a new case appended to
   `docs/HIL_TEST_PLAN.md`).
3. Missing/incompatible backend ⇒ loud `StubbedBarcode` fallback, never
   a silent blank.
4. The fake-shim swap test passes with no C++ change — proving the ABI
   is backend-agnostic (enLabel → Zint swap is a DLL drop).
5. Engine library still names no barcode backend (INV-1; architecture
   test green).
6. `ctest` green; barcode golden suite green in CI.
