//! resvg-backed implementation of the hand-owned `svg_rasterizer_abi.h`.
//!
//! This crate is the ONLY place a rasterizer is named. It is built as a
//! standalone cdylib (not a CMake dependency), dropped next to
//! `print_engine_host.exe`, and loaded at runtime through the C ABI. Swapping
//! to a librsvg+cairo backend = shipping a different cdylib that implements the
//! same exported symbols; no C++ changes.
//!
//! Invariants honored here (mirror of `svg_rasterizer_abi.h`):
//!  * Pixel contract: STRAIGHT (un-premultiplied) RGBA8, byte order R,G,B,A,
//!    stride = width*4, top-down. tiny-skia gives PREMULTIPLIED RGBA, so we
//!    un-premultiply before returning (the host re-premultiplies to BGRA for
//!    GDI+ -- conversion lives in exactly one place per side).
//!  * Memory: caller-allocates; nothing is freed across the ABI.
//!  * Panics: every export wraps its body in `catch_unwind`; a panic becomes
//!    `SPE_SVG_ERR_INTERNAL`, never an unwind across the C boundary (UB).
//!  * Determinism: same (bytes,w,h,dpi)+fonts => identical RGBA (vector).

use std::os::raw::c_char;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::OnceLock;

// Status codes -- MUST match svg_rasterizer_abi.h exactly.
const SPE_SVG_OK: i32 = 0;
const SPE_SVG_ERR_BAD_ARGS: i32 = -1;
const SPE_SVG_ERR_PARSE: i32 = -2;
const SPE_SVG_ERR_UNSUPPORTED: i32 = -3;
const SPE_SVG_ERR_BUFFER_TOO_SMALL: i32 = -4;
const SPE_SVG_ERR_INTERNAL: i32 = -5;

const SPE_SVG_ABI_VERSION: i32 = 1;

/// System fonts loaded once so SVG-embedded text resolves. Per the ABI doc the
/// host records backend name+version (and is expected to record resolved
/// fonts) for regulated traceability; cross-machine text byte-equality is not
/// claimed.
fn fontdb() -> &'static resvg::usvg::fontdb::Database {
    static DB: OnceLock<resvg::usvg::fontdb::Database> = OnceLock::new();
    DB.get_or_init(|| {
        let mut db = resvg::usvg::fontdb::Database::new();
        db.load_system_fonts();
        db
    })
}

#[no_mangle]
pub extern "C" fn spe_svg_abi_version() -> i32 {
    SPE_SVG_ABI_VERSION
}

#[no_mangle]
pub extern "C" fn spe_svg_backend_id(name_buf: *mut c_char, name_buf_len: usize) -> usize {
    let id = concat!("resvg ", "0.47"); // crate-pinned backend identity
    let res = catch_unwind(|| {
        if name_buf.is_null() || name_buf_len == 0 {
            return 0usize;
        }
        let bytes = id.as_bytes();
        let n = bytes.len().min(name_buf_len - 1);
        unsafe {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), name_buf as *mut u8, n);
            *name_buf.add(n) = 0;
        }
        n
    });
    res.unwrap_or(0)
}

/// PASS 1: dimensions/length only. The rasterized buffer is exactly the
/// caller's target box (the SVG is fit into it preserving aspect, transparent
/// letterbox), so measure is stateless and never parses -- a parse failure
/// surfaces loudly at render. Keeps the ABI stateless (purity/swap rule).
#[no_mangle]
pub extern "C" fn spe_svg_measure(
    _svg: *const u8,
    _svg_len: usize,
    target_w_px: u32,
    target_h_px: u32,
    _dpi: f64,
    out_w: *mut u32,
    out_h: *mut u32,
    out_byte_len: *mut usize,
) -> i32 {
    catch_unwind(|| {
        if out_w.is_null()
            || out_h.is_null()
            || out_byte_len.is_null()
            || target_w_px == 0
            || target_h_px == 0
        {
            return SPE_SVG_ERR_BAD_ARGS;
        }
        unsafe {
            *out_w = target_w_px;
            *out_h = target_h_px;
            *out_byte_len = target_w_px as usize * target_h_px as usize * 4;
        }
        SPE_SVG_OK
    })
    .unwrap_or(SPE_SVG_ERR_INTERNAL)
}

/// Byte-level scan for `<foreignObject` so a malformed or non-UTF8 SVG still
/// trips the guard. We match the start tag only (case sensitive per SVG
/// spec; XML element names are case-sensitive in SVG/XHTML).
fn contains_foreign_object(bytes: &[u8]) -> bool {
    bytes.windows(14).any(|w| w == b"<foreignObject")
}

fn write_err(err_buf: *mut c_char, err_buf_len: usize, msg: &str) {
    if err_buf.is_null() || err_buf_len == 0 {
        return;
    }
    let bytes = msg.as_bytes();
    let n = bytes.len().min(err_buf_len - 1);
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), err_buf as *mut u8, n);
        *err_buf.add(n) = 0;
    }
}

/// PASS 2: parse + render into the caller-owned buffer per the pinned pixel
/// contract. resvg/tiny-skia produce premultiplied RGBA; we un-premultiply to
/// straight RGBA here.
#[no_mangle]
pub extern "C" fn spe_svg_render(
    svg: *const u8,
    svg_len: usize,
    target_w_px: u32,
    target_h_px: u32,
    _dpi: f64,
    out_pixels: *mut u8,
    out_pixels_len: usize,
    err_buf: *mut c_char,
    err_buf_len: usize,
) -> i32 {
    let result = catch_unwind(AssertUnwindSafe(|| {
        if svg.is_null() || svg_len == 0 || out_pixels.is_null() {
            return SPE_SVG_ERR_BAD_ARGS;
        }
        if target_w_px == 0 || target_h_px == 0 {
            return SPE_SVG_ERR_BAD_ARGS;
        }
        let need = target_w_px as usize * target_h_px as usize * 4;
        if out_pixels_len < need {
            return SPE_SVG_ERR_BUFFER_TOO_SMALL;
        }

        let svg_bytes = unsafe { std::slice::from_raw_parts(svg, svg_len) };

        // WYSIWYG guard. resvg silently renders <foreignObject> as nothing
        // (status=Ok, fully-transparent output). If any foreignObject slips
        // into svg_source the printer would draw a blank box with no notice
        // -- exactly the silent divergence the C1 constraint forbids. Refuse
        // loudly here so the host's loud crosshatch + notice fire instead.
        if contains_foreign_object(svg_bytes) {
            write_err(err_buf, err_buf_len,
                "svg contains <foreignObject>; resvg cannot render HTML, refusing loudly");
            return SPE_SVG_ERR_UNSUPPORTED;
        }

        let mut opt = resvg::usvg::Options::default();
        opt.fontdb = std::sync::Arc::new(fontdb().clone());

        let tree = match resvg::usvg::Tree::from_data(svg_bytes, &opt) {
            Ok(t) => t,
            Err(e) => {
                write_err(err_buf, err_buf_len, &format!("svg parse: {e}"));
                return SPE_SVG_ERR_PARSE;
            }
        };
        // NB: a pre-shape "font-family resolves in fontdb?" guard was
        // tried (Round 6) and reverted as overly strict: resvg's text
        // shaper has its own opinionated fallback (substitutes the
        // database's default sans-serif when the requested family is
        // missing), so a CSS-style cascade like `font-family="Arial"`
        // on a Linux box with Liberation Sans installed renders fine
        // even though "Arial" alone does not resolve. Trust resvg's
        // shaping; the documented "empty fontdb -> blank text" scenario
        // does not arise on the Win32 host (Arial guaranteed) and is
        // tracked in MEMORY.md.
        let mut pixmap = match resvg::tiny_skia::Pixmap::new(target_w_px, target_h_px) {
            Some(p) => p,
            None => {
                write_err(err_buf, err_buf_len, "pixmap alloc failed");
                return SPE_SVG_ERR_INTERNAL;
            }
        };

        // Fit the SVG into the target box preserving aspect (transparent
        // letterbox); the host composites this into device_box.
        let size = tree.size();
        let (sw, sh) = (size.width(), size.height());
        if sw <= 0.0 || sh <= 0.0 {
            write_err(err_buf, err_buf_len, "svg has zero intrinsic size");
            return SPE_SVG_ERR_PARSE;
        }
        let scale = (target_w_px as f32 / sw).min(target_h_px as f32 / sh);
        let tx = (target_w_px as f32 - sw * scale) * 0.5;
        let ty = (target_h_px as f32 - sh * scale) * 0.5;
        let transform = resvg::tiny_skia::Transform::from_row(scale, 0.0, 0.0, scale, tx, ty);

        resvg::render(&tree, transform, &mut pixmap.as_mut());

        // tiny-skia: premultiplied RGBA, top-down, stride = w*4. Convert to
        // STRAIGHT RGBA per the ABI pixel contract.
        let src = pixmap.data();
        let dst = unsafe { std::slice::from_raw_parts_mut(out_pixels, need) };
        for px in 0..(target_w_px as usize * target_h_px as usize) {
            let i = px * 4;
            let (r, g, b, a) = (src[i], src[i + 1], src[i + 2], src[i + 3]);
            if a == 0 {
                dst[i] = 0;
                dst[i + 1] = 0;
                dst[i + 2] = 0;
                dst[i + 3] = 0;
            } else {
                // straight = round(premul * 255 / alpha)
                let un = |c: u8| (((c as u32) * 255 + (a as u32) / 2) / a as u32).min(255) as u8;
                dst[i] = un(r);
                dst[i + 1] = un(g);
                dst[i + 2] = un(b);
                dst[i + 3] = a;
            }
        }
        SPE_SVG_OK
    }));

    match result {
        Ok(code) => code,
        Err(_) => {
            write_err(err_buf, err_buf_len, "panic caught at ABI boundary");
            SPE_SVG_ERR_INTERNAL
        }
    }
}
