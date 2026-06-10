/*
 * svg_rasterizer_abi.h  --  HAND-OWNED C ABI for the embedded-SVG rasterizer.
 *
 * This header is the ENTIRE abstraction. Any rasterizer backend (the resvg
 * cdylib today, a librsvg+cairo cdylib tomorrow) is a separate shared library
 * that implements exactly these symbols. Swapping backends is swapping the DLL
 * filename -- no C++ recompile, no header change, no pipeline change.
 *
 * PURITY RULE: this header expresses only "SVG bytes + target + DPI -> RGBA
 * pixels". It must never leak a backend concept (no usvg tree, no resvg
 * options, no fontdb, no cairo surface). Every symbol must be implementable by
 * a cairo-backed shim unchanged. If it can't, the symbol is wrong.
 *
 * MEMORY RULE: nothing is ever freed across this ABI. The caller allocates
 * every output buffer (two-call measure-then-fill pattern). The backend never
 * returns a pointer the caller must free.
 *
 * PANIC RULE: no exception or Rust panic may cross this boundary. The backend
 * wraps every export (catch_unwind / panic=abort) and returns a status code.
 */
#ifndef PRINT_ENGINE_HOST_SVG_RASTERIZER_ABI_H
#define PRINT_ENGINE_HOST_SVG_RASTERIZER_ABI_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Bump only on an incompatible ABI change. The loader refuses any DLL whose
 * spe_svg_abi_version() != this value and falls back to the loud SVG stub. */
#define SPE_SVG_ABI_VERSION 1

/* Status codes. 0 == success; negatives are loud failures the host maps to a
 * typed DegradationNotice / decode error. The SVG is never silently dropped. */
typedef enum {
  SPE_SVG_OK = 0,
  SPE_SVG_ERR_BAD_ARGS = -1,     /* null/zero inputs, nonsensical target    */
  SPE_SVG_ERR_PARSE = -2,        /* not parseable as SVG                    */
  SPE_SVG_ERR_UNSUPPORTED = -3,  /* foreignObject/script/animation/etc.     */
  SPE_SVG_ERR_BUFFER_TOO_SMALL = -4, /* out buffer < measured byte length   */
  SPE_SVG_ERR_INTERNAL = -5      /* caught panic / backend internal failure */
} spe_svg_status;

/*
 * PIXEL CONTRACT -- pinned here as law; any backend MUST match it exactly:
 *   - format        : RGBA8888, 4 bytes per pixel
 *   - byte order    : out[0]=R, out[1]=G, out[2]=B, out[3]=A
 *   - alpha         : STRAIGHT (non-premultiplied)
 *   - row stride    : width * 4 (tightly packed, no row padding)
 *   - orientation   : top-down (row 0 is the top scanline)
 *   - buffer length : out_w * out_h * 4
 * The HOST (not the backend) converts straight RGBA -> premultiplied BGRA for
 * GDI+ 32bppPARGB. Backends always emit straight RGBA so the conversion lives
 * in exactly one place and any future shim is drop-in.
 *
 * DETERMINISM: identical (svg bytes, target_w, target_h, dpi) MUST yield
 * byte-identical RGBA for vector content (required for INV-5: preview == print
 * pixels). SVG-embedded TEXT is only deterministic given identical resolved
 * fonts; cross-machine text byte-equality is NOT claimed -- the host records
 * the backend name+version (and is expected to record resolved fonts) in the
 * job log for regulated traceability.
 */

/* Returns the ABI version this backend implements. Must be the first symbol
 * the loader resolves; a mismatch is a hard refuse (loud stub fallback). */
int32_t spe_svg_abi_version(void);

/* Optional human-readable backend identity (e.g. "resvg 0.45.0"). Written into
 * caller's buffer, NUL-terminated, truncated if needed. Never fails loudly --
 * identity is informational. Returns the number of bytes written (excluding
 * the NUL), or 0 if name_buf is null/zero. */
size_t spe_svg_backend_id(char* name_buf, size_t name_buf_len);

/* PASS 1 (measure): compute the RGBA output dimensions/length for this SVG at
 * this target box + DPI. No pixels are produced. out_* are written only on
 * SPE_SVG_OK. out_byte_len == (*out_w) * (*out_h) * 4. */
int32_t spe_svg_measure(const uint8_t* svg, size_t svg_len,
                        uint32_t target_w_px, uint32_t target_h_px,
                        double dpi,
                        uint32_t* out_w, uint32_t* out_h,
                        size_t* out_byte_len);

/* PASS 2 (render): fill the caller-owned out_pixels buffer (>= the byte length
 * from spe_svg_measure with the SAME inputs) per the pixel contract above.
 * On a loud failure an optional UTF-8 message is written to err_buf
 * (NUL-terminated, truncated if needed); err_buf may be null. */
int32_t spe_svg_render(const uint8_t* svg, size_t svg_len,
                       uint32_t target_w_px, uint32_t target_h_px,
                       double dpi,
                       uint8_t* out_pixels, size_t out_pixels_len,
                       char* err_buf, size_t err_buf_len);

/* D3 TEXT METRICS — shared by bake measurement and rasterization so both use
 * the same font stack (one shaper, WYSIWYG by construction).
 *
 * Returns SPE_SVG_OK on success, SPE_SVG_ERR_INTERNAL if the font cannot be
 * found or parsed, SPE_SVG_ERR_BAD_ARGS if required args are null/invalid.
 * `out` is written only on SPE_SVG_OK.
 *
 * Callers: the bake uses this to size text boxes (static text); the Win32
 * host uses it to lay out merge/variable text at render time (variable text).
 * Both callers use the same metrics so bake layout == print layout. */
typedef struct {
  float advance_px;     /* total horizontal advance of the run */
  float ascent_px;      /* ascender above baseline (positive)  */
  float descent_px;     /* descender below baseline (positive) */
  float line_height_px; /* ascent + descent + line gap         */
} spe_text_metrics_t;

int32_t spe_text_measure(const char*           family,   /* NUL-terminated */
                         int32_t               weight,   /* 400=normal,700=bold */
                         int32_t               italic,   /* 0=normal, 1=italic  */
                         float                 size_px,  /* device pixels        */
                         const uint8_t*        text,     /* UTF-8 run bytes      */
                         size_t                text_len, /* byte count           */
                         spe_text_metrics_t*   out);

#ifdef __cplusplus
}  /* extern "C" */
#endif

#endif /* PRINT_ENGINE_HOST_SVG_RASTERIZER_ABI_H */
