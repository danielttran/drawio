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
use std::sync::{Arc, OnceLock};

extern crate ttf_parser;

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
/// First family from `prefs` that resolves to an installed face, if any.
/// fontdb is exact-name-match at query time (it does NOT consult fontconfig
/// aliases), so pointing a generic family at an ABSENT name makes resvg skip
/// text shaping entirely -> silently blank text (a C1 violation).
fn first_installed_family(
    db: &resvg::usvg::fontdb::Database,
    prefs: &[&'static str],
) -> Option<&'static str> {
    use resvg::usvg::fontdb;
    prefs.iter().copied().find(|name| {
        db.query(&fontdb::Query {
            families: &[fontdb::Family::Name(name)],
            ..Default::default()
        })
        .is_some()
    })
}

/// Generic-family preference chains: the production design font first, then
/// its metric-compatible open clones, then a guaranteed-glyph distro face.
const SANS_PREFS: &[&'static str] = &[
    "Arial",
    "Helvetica",
    "Liberation Sans",
    "Arimo",
    "DejaVu Sans",
    "FreeSans",
];
const SERIF_PREFS: &[&'static str] = &[
    "Times New Roman",
    "Liberation Serif",
    "Tinos",
    "DejaVu Serif",
    "FreeSerif",
];
const MONO_PREFS: &[&'static str] = &[
    "Courier New",
    "Liberation Mono",
    "Cousine",
    "DejaVu Sans Mono",
    "FreeMono",
];

fn fontdb() -> &'static resvg::usvg::fontdb::Database {
    static DB: OnceLock<resvg::usvg::fontdb::Database> = OnceLock::new();
    DB.get_or_init(|| {
        let mut db = resvg::usvg::fontdb::Database::new();
        db.load_system_fonts();
        // The production print server is provisioned with the design fonts;
        // when installed they are pinned exactly (Windows/browser defaults
        // draw.io authors see). On a box without them (Linux CI, the
        // browser-free verification gate), fall back to the metric-compatible
        // clone -- the same substitution fontconfig/browsers apply -- because
        // an alias naming an absent family is not a loud failure: resvg
        // returns SPE_SVG_OK with fully transparent text, the exact
        // silent-blank class this backend must never produce.
        if let Some(f) = first_installed_family(&db, SANS_PREFS) {
            db.set_sans_serif_family(f);
        }
        if let Some(f) = first_installed_family(&db, SERIF_PREFS) {
            db.set_serif_family(f);
        }
        if let Some(f) = first_installed_family(&db, MONO_PREFS) {
            db.set_monospace_family(f);
        }
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

// ---- D3 text metrics (spe_text_measure) --------------------------------

/// Matches spe_text_metrics_t in svg_rasterizer_abi.h.
#[repr(C)]
pub struct SpeTextMetrics {
    pub advance_px: f32,
    pub ascent_px: f32,
    pub descent_px: f32,
    pub line_height_px: f32,
}

fn c_str_to_str<'a>(ptr: *const c_char, fallback: &'a str) -> &'a str {
    if ptr.is_null() {
        return fallback;
    }
    unsafe { std::ffi::CStr::from_ptr(ptr).to_str().unwrap_or(fallback) }
}

fn measure_text_inner(
    family: &str,
    weight: u16,
    italic: bool,
    size_px: f32,
    text: &str,
) -> Option<SpeTextMetrics> {
    use resvg::usvg::fontdb;
    let db = fontdb();
    let style = if italic {
        fontdb::Style::Italic
    } else {
        fontdb::Style::Normal
    };
    let query = fontdb::Query {
        families: &[fontdb::Family::Name(family)],
        weight: fontdb::Weight(weight),
        style,
        ..Default::default()
    };
    // Try the requested family; fall back to system sans-serif.
    let face_id = db.query(&query).or_else(|| {
        let q2 = fontdb::Query {
            families: &[fontdb::Family::SansSerif],
            weight: fontdb::Weight(weight),
            style,
            ..Default::default()
        };
        db.query(&q2)
    })?;

    db.with_face_data(face_id, |data, idx| {
        let face = ttf_parser::Face::parse(data, idx).ok()?;
        let upem = face.units_per_em() as f32;
        let scale = size_px / upem;
        let ascent = face.ascender() as f32 * scale;
        let descent = -(face.descender() as f32 * scale); // positive
        let gap = face.line_gap() as f32 * scale;
        let mut advance = 0.0f32;
        for ch in text.chars() {
            if let Some(gid) = face.glyph_index(ch) {
                if let Some(adv) = face.glyph_hor_advance(gid) {
                    advance += adv as f32 * scale;
                }
            }
        }
        Some(SpeTextMetrics {
            advance_px: advance,
            ascent_px: ascent,
            descent_px: descent,
            line_height_px: ascent + descent + gap,
        })
    })?
}

/// D3: one font-metrics engine shared by bake measurement and rasterization.
#[no_mangle]
pub extern "C" fn spe_text_measure(
    family: *const c_char,
    weight: i32,
    italic: i32,
    size_px: f32,
    text: *const u8,
    text_len: usize,
    out: *mut SpeTextMetrics,
) -> i32 {
    let result = catch_unwind(AssertUnwindSafe(|| {
        if out.is_null() || size_px <= 0.0 {
            return SPE_SVG_ERR_BAD_ARGS;
        }
        let fam = c_str_to_str(family as *const c_char, "Arial");
        let txt = if text.is_null() || text_len == 0 {
            ""
        } else {
            let b = unsafe { std::slice::from_raw_parts(text, text_len) };
            std::str::from_utf8(b).unwrap_or("")
        };
        let w = (weight.max(100).min(900)) as u16;
        match measure_text_inner(fam, w, italic != 0, size_px, txt) {
            Some(m) => {
                unsafe {
                    *out = m;
                }
                SPE_SVG_OK
            }
            None => SPE_SVG_ERR_INTERNAL,
        }
    }));
    result.unwrap_or(SPE_SVG_ERR_INTERNAL)
}

/// Byte-level scan for an SVG `foreignObject` element so malformed or non-UTF8
/// SVG still trips the guard before resvg can silently render the HTML subtree
/// as transparent pixels. XML element names are case-sensitive, but namespace
/// prefixes are legal (`<svg:foreignObject>`), so compare the parsed local name
/// instead of searching only for the literal unprefixed spelling.
fn contains_foreign_object(bytes: &[u8]) -> bool {
    fn is_name_char(b: u8) -> bool {
        b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b':')
    }

    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] != b'<' {
            i += 1;
            continue;
        }
        i += 1;
        if i >= bytes.len() || matches!(bytes[i], b'/' | b'!' | b'?') {
            continue;
        }
        let start = i;
        while i < bytes.len() && is_name_char(bytes[i]) {
            i += 1;
        }
        if i == start {
            continue;
        }
        let name = &bytes[start..i];
        let local = name
            .iter()
            .rposition(|&b| b == b':')
            .map(|pos| &name[pos + 1..])
            .unwrap_or(name);
        if local == b"foreignObject" {
            return true;
        }
    }
    false
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
            write_err(
                err_buf,
                err_buf_len,
                "svg contains <foreignObject>; resvg cannot render HTML, refusing loudly",
            );
            return SPE_SVG_ERR_UNSUPPORTED;
        }

        let mut opt = resvg::usvg::Options::default();
        // Reuse the initialized production font database for every SVG render.
        // Text is converted to glyph outlines during usvg parsing; missing
        // fonts remain an environment/preflight problem rather than a silent
        // substitution to a non-design family.
        opt.fontdb = Arc::new(fontdb().clone());

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

#[cfg(test)]
mod tests {
    use super::{contains_foreign_object, fontdb};
    use resvg::usvg::fontdb::Family;

    #[test]
    fn foreign_object_guard_detects_unprefixed_and_prefixed_start_tags() {
        assert!(contains_foreign_object(
            b"<svg><foreignObject width='1'/></svg>"
        ));
        assert!(contains_foreign_object(
            b"<svg><svg:foreignObject width='1'/></svg>"
        ));
    }

    #[test]
    fn foreign_object_guard_remains_case_sensitive_to_svg_element_names() {
        assert!(!contains_foreign_object(
            b"<svg><foreignobject width='1'/></svg>"
        ));
        assert!(!contains_foreign_object(
            b"<svg><notforeignObject width='1'/></svg>"
        ));
    }

    #[test]
    fn generic_font_aliases_target_print_server_design_fonts() {
        use super::{first_installed_family, MONO_PREFS, SANS_PREFS, SERIF_PREFS};
        use resvg::usvg::fontdb::Query;
        let db = fontdb();
        for (generic, prefs) in [
            (Family::SansSerif, SANS_PREFS),
            (Family::Serif, SERIF_PREFS),
            (Family::Monospace, MONO_PREFS),
        ] {
            let alias = db.family_name(&generic).to_string();
            match first_installed_family(db, prefs) {
                Some(expected) => {
                    // Highest-preference installed family wins; on the
                    // production print server that is the design font itself
                    // (Arial / Times New Roman / Courier New).
                    assert_eq!(alias, expected);
                    // And the alias MUST resolve to a real face, otherwise
                    // resvg renders generic-family text silently blank.
                    assert!(
                        db.query(&Query {
                            families: &[generic],
                            ..Default::default()
                        })
                        .is_some(),
                        "generic {generic:?} alias '{alias}' must resolve to an installed face"
                    );
                }
                None => {
                    // No candidate installed at all: nothing to pin; the
                    // verification gate / font preflight stays loud.
                }
            }
        }
    }
}
