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
/// caller's target box (the SVG is STRETCHED to fill it; aspect policy --
/// preserve vs fill -- is the HOST's job, which requests the aspect-fit
/// sub-rect size when preserving), so measure is stateless and never parses --
/// a parse failure surfaces loudly at render. Keeps the ABI stateless
/// (purity/swap rule).
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
        // checked_mul: w*h*4 silently wrapped for absurd-but-representable
        // targets (u32 max squared, or any large box on a 32-bit usize),
        // reporting a tiny byte length the caller would then under-allocate.
        let byte_len = match (target_w_px as usize)
            .checked_mul(target_h_px as usize)
            .and_then(|px| px.checked_mul(4))
        {
            Some(n) => n,
            None => return SPE_SVG_ERR_BUFFER_TOO_SMALL,
        };
        unsafe {
            *out_w = target_w_px;
            *out_h = target_h_px;
            *out_byte_len = byte_len;
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
        // Fallback advance for characters the face cannot map: a renderer
        // draws .notdef (tofu) for them, which still occupies horizontal
        // space. Silently adding 0 understated the measured run and the
        // caller's text box clipped every following glyph -- a silent
        // divergence (C1). Use the face's .notdef advance; if even that is
        // missing, 0.5em (the conventional tofu width).
        let notdef_advance = face
            .glyph_hor_advance(ttf_parser::GlyphId(0))
            .map(|adv| adv as f32 * scale)
            .unwrap_or(size_px * 0.5);
        let mut advance = 0.0f32;
        for ch in text.chars() {
            advance += face
                .glyph_index(ch)
                .and_then(|gid| face.glyph_hor_advance(gid))
                .map(|adv| adv as f32 * scale)
                .unwrap_or(notdef_advance);
        }
        Some(SpeTextMetrics {
            advance_px: advance,
            ascent_px: ascent,
            descent_px: descent,
            line_height_px: ascent + descent + gap,
        })
    })?
}

/// D3 font-metrics measurement over the host's real installed faces (ttf-parser
/// advances), exposed for the host/service to verify metric compatibility. NOTE:
/// the JS bake computes its own wrap/alignment layout from the bundled core AFM
/// tables (exporter.js) — it does NOT call this FFI — so this is a host-side
/// measurement/preflight aid, not a layout engine shared with the bake.
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

/// Byte-level scan for an SVG `<image>` element whose `href`/`xlink:href`
/// points at an EXTERNAL resource (anything that is not a `data:` URI). usvg's
/// default `ImageHrefResolver` resolves ONLY `data:` URIs; a non-data href
/// (http/https/file/relative path) resolves to `None` and the `<image>` renders
/// as nothing while `Tree::from_data` still returns `Ok` -- the printer draws a
/// blank where artwork should be, with no error and no notice. That is the
/// exact silent-blank class the `foreignObject` guard exists to refuse, so refuse
/// it here too: the host then draws its loud crosshatch + `StubbedSvgArtwork`
/// notice instead of a silent blank.
///
/// Scoped to `<image>` ELEMENTS (namespace-prefix aware, case-sensitive on the
/// element name) so legitimate internal fragment refs on OTHER elements
/// (`<use href="#id">`, `<linearGradient xlink:href="#base">`, clipPath refs)
/// are never mistaken for external image artwork. Tolerant of malformed/non-UTF8
/// bytes, exactly like `contains_foreign_object`.
fn contains_external_image_href(bytes: &[u8]) -> bool {
    fn is_name_char(b: u8) -> bool {
        b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b':')
    }
    fn starts_with_ci(value: &[u8], prefix: &[u8]) -> bool {
        value.len() >= prefix.len()
            && value[..prefix.len()]
                .iter()
                .zip(prefix)
                .all(|(a, b)| a.to_ascii_lowercase() == *b)
    }
    // Does this `<image ...>` tag body carry an href attribute whose value is
    // not a `data:` URI? Searches for the `href` attribute name (covers both
    // `href` and `xlink:href`, which share the `href` suffix), then reads its
    // quoted value.
    fn tag_has_external_href(tag: &[u8]) -> bool {
        let needle = b"href";
        let mut k = 0usize;
        while k + needle.len() <= tag.len() {
            if &tag[k..k + needle.len()] != needle {
                k += 1;
                continue;
            }
            // Attribute-name boundary: the char before `href` must not be a
            // name char that would make this the tail of a longer word. The
            // `:` of `xlink:href` is allowed (not in the rejected set).
            let prev_ok = k == 0 || {
                let p = tag[k - 1];
                p == b':' || (!is_name_char(p))
            };
            let mut m = k + needle.len();
            while m < tag.len() && tag[m].is_ascii_whitespace() {
                m += 1;
            }
            if prev_ok && m < tag.len() && tag[m] == b'=' {
                m += 1;
                while m < tag.len() && tag[m].is_ascii_whitespace() {
                    m += 1;
                }
                if m < tag.len() && (tag[m] == b'"' || tag[m] == b'\'') {
                    let quote = tag[m];
                    m += 1;
                    let mut v = m;
                    while v < tag.len() && tag[v].is_ascii_whitespace() {
                        v += 1;
                    }
                    let vstart = v;
                    while v < tag.len() && tag[v] != quote {
                        v += 1;
                    }
                    let val = &tag[vstart..v];
                    return !starts_with_ci(val, b"data:");
                }
            }
            k += 1;
        }
        false
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
        if local != b"image" {
            continue;
        }
        // Read this element's attribute list up to the closing '>'.
        let tag_start = i;
        let mut j = i;
        while j < bytes.len() && bytes[j] != b'>' {
            j += 1;
        }
        if tag_has_external_href(&bytes[tag_start..j.min(bytes.len())]) {
            return true;
        }
        i = j;
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
    dpi: f64,
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
        // checked_mul: see spe_svg_measure -- a wrapped `need` would pass the
        // length check below and the pixel loop would write past the caller's
        // buffer. Overflow is by definition "buffer cannot be big enough".
        let need = match (target_w_px as usize)
            .checked_mul(target_h_px as usize)
            .and_then(|px| px.checked_mul(4))
        {
            Some(n) => n,
            None => return SPE_SVG_ERR_BUFFER_TOO_SMALL,
        };
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

        // WYSIWYG guard. usvg resolves ONLY `data:` image hrefs; an external
        // `<image href="http|file|relative">` renders as nothing with status=Ok
        // -- a silent blank where artwork should be. Refuse loudly so the host's
        // crosshatch + StubbedSvgArtwork notice fire instead. (The draw.io bake
        // already embeds every image as a data: URI and raises its own loud
        // notice for unresolved externals; this is the engine-side backstop, in
        // the same spirit as the foreignObject guard above.)
        if contains_external_image_href(svg_bytes) {
            write_err(
                err_buf,
                err_buf_len,
                "svg contains <image> with a non-data: href; the external resource \
                 cannot be resolved offline and would render blank, refusing loudly",
            );
            return SPE_SVG_ERR_UNSUPPORTED;
        }

        let mut opt = resvg::usvg::Options::default();
        // The ABI declares dpi part of the determinism key; usvg uses it to
        // resolve physical units (pt/mm/in) inside the SVG. Dropping it kept
        // the parser pinned at 96 -- a latent INV-5 break the moment preview
        // and print pass different values. Guard non-finite/non-positive.
        if dpi.is_finite() && dpi > 0.0 {
            opt.dpi = dpi as f32;
        }
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

        // STRETCH the SVG to exactly the requested target box (independent
        // x/y scale, no centering, no transparent letterbox). Aspect policy
        // is the HOST's job: for aspect:"preserve" the host computes the
        // aspect-fit sub-rect of the destination and requests THAT pixel
        // size (so the blit stays strictly 1:1); for aspect:"fill" it
        // requests the full box. The old shim-side preserve+letterbox made
        // "fill" unreachable -- an SVG could never stretch, silently
        // diverging from the contract's aspect enum (C1).
        let size = tree.size();
        let (sw, sh) = (size.width(), size.height());
        if sw <= 0.0 || sh <= 0.0 {
            write_err(err_buf, err_buf_len, "svg has zero intrinsic size");
            return SPE_SVG_ERR_PARSE;
        }
        let scale_x = target_w_px as f32 / sw;
        let scale_y = target_h_px as f32 / sh;
        let transform =
            resvg::tiny_skia::Transform::from_row(scale_x, 0.0, 0.0, scale_y, 0.0, 0.0);

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
    use super::{contains_external_image_href, contains_foreign_object, fontdb};
    use resvg::usvg::fontdb::Family;
    use std::os::raw::c_char;

    #[test]
    fn render_stretches_a_2_to_1_svg_to_fill_a_square_target_no_letterbox_bars() {
        // The old shim letterboxed (scale = min, centered): a 2:1 SVG in a
        // 32x32 target left rows 0..7 and 24..31 fully transparent, so
        // aspect:"fill" could never stretch. The shim now stretches to
        // exactly the requested box; EVERY pixel must be opaque red.
        let svg = b"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 10'>\
                    <rect width='20' height='10' fill='red'/></svg>";
        const W: u32 = 32;
        const H: u32 = 32;
        let mut px = vec![0u8; (W * H * 4) as usize];
        let mut err = vec![0 as c_char; 256];
        let st = super::spe_svg_render(
            svg.as_ptr(),
            svg.len(),
            W,
            H,
            96.0,
            px.as_mut_ptr(),
            px.len(),
            err.as_mut_ptr(),
            err.len(),
        );
        assert_eq!(st, super::SPE_SVG_OK);
        for (i, p) in px.chunks_exact(4).enumerate() {
            assert_eq!(
                p[3], 255,
                "pixel {i} is not opaque: letterbox-bar regression (shim must stretch)"
            );
            assert_eq!((p[0], p[1], p[2]), (255, 0, 0), "pixel {i} is not red");
        }
    }

    #[test]
    fn measure_overflowing_byte_length_is_a_typed_buffer_error_not_a_wrap() {
        // u32::MAX * u32::MAX pixels fits usize on 64-bit but *4 overflows;
        // on 32-bit it overflows immediately. Either way the typed buffer
        // error must come back -- never a silently wrapped tiny byte_len.
        let mut w = 0u32;
        let mut h = 0u32;
        let mut len = 0usize;
        let st = super::spe_svg_measure(
            std::ptr::null(),
            0,
            u32::MAX,
            u32::MAX,
            96.0,
            &mut w,
            &mut h,
            &mut len,
        );
        assert_eq!(st, super::SPE_SVG_ERR_BUFFER_TOO_SMALL);
    }

    #[test]
    fn unmapped_glyphs_count_a_fallback_advance_not_silently_zero() {
        // Private-use code points are unmapped in every production face; a
        // renderer still draws .notdef tofu for them, which takes space.
        let mut base = super::SpeTextMetrics {
            advance_px: 0.0,
            ascent_px: 0.0,
            descent_px: 0.0,
            line_height_px: 0.0,
        };
        let probe = "A";
        let st_probe = super::spe_text_measure(
            std::ptr::null(),
            400,
            0,
            16.0,
            probe.as_ptr(),
            probe.len(),
            &mut base,
        );
        if st_probe != super::SPE_SVG_OK {
            return; // no usable font installed: nothing to pin on this box
        }
        let tofu = "\u{E000}\u{E001}";
        let mut m = super::SpeTextMetrics {
            advance_px: 0.0,
            ascent_px: 0.0,
            descent_px: 0.0,
            line_height_px: 0.0,
        };
        let st = super::spe_text_measure(
            std::ptr::null(),
            400,
            0,
            16.0,
            tofu.as_ptr(),
            tofu.len(),
            &mut m,
        );
        assert_eq!(st, super::SPE_SVG_OK);
        assert!(
            m.advance_px > 0.0,
            "unmapped glyphs must contribute a fallback (.notdef/0.5em) advance"
        );
    }

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
    fn external_image_href_guard_flags_non_data_urls() {
        // http/https/file/relative hrefs all resolve to nothing in usvg's
        // data-only resolver -> silent blank. Each must trip the guard.
        assert!(contains_external_image_href(
            br#"<svg><image href="http://example.com/logo.png"/></svg>"#
        ));
        assert!(contains_external_image_href(
            br#"<svg><image xlink:href="file:///etc/logo.png"/></svg>"#
        ));
        assert!(contains_external_image_href(
            br#"<svg><image href="assets/icon.svg"/></svg>"#
        ));
        // Single-quoted attribute, leading whitespace in the value.
        assert!(contains_external_image_href(
            b"<svg><image href=' https://x/y.png'/></svg>"
        ));
        // Namespace-prefixed <image> element name.
        assert!(contains_external_image_href(
            br#"<svg><svg:image href="http://x/y.png"/></svg>"#
        ));
    }

    #[test]
    fn external_image_href_guard_allows_embedded_data_uris() {
        // Embedded data: artwork (what the bake always emits) must NOT trip.
        assert!(!contains_external_image_href(
            br#"<svg><image href="data:image/png;base64,iVBORw0KGgo="/></svg>"#
        ));
        assert!(!contains_external_image_href(
            br#"<svg><image xlink:href="data:image/jpeg;base64,/9j/4AAQ"/></svg>"#
        ));
        // Case-insensitive scheme.
        assert!(!contains_external_image_href(
            br#"<svg><image href="DATA:image/png;base64,AAAA"/></svg>"#
        ));
    }

    #[test]
    fn external_image_href_guard_ignores_internal_fragment_refs_on_other_elements() {
        // <use>/<linearGradient> fragment refs are legitimate and common in
        // baked SVG; they must NEVER be mistaken for external image artwork.
        assert!(!contains_external_image_href(
            br##"<svg><use href="#shape"/><linearGradient xlink:href="#base"/></svg>"##
        ));
        // An <image> with a data: href alongside a gradient fragment ref.
        assert!(!contains_external_image_href(
            br##"<svg><linearGradient xlink:href="#g"/><image href="data:image/png;base64,AA"/></svg>"##
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
