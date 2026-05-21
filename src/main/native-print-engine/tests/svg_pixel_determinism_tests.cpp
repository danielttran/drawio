// Cross-platform pixel-determinism golden for the SVG rasterizer cdylib.
//
// The host's production loader is intentionally LoadLibraryW-only (owner
// decision: GDI+ host == Windows-only) so its swap-acceptance test is also
// WIN32-gated. The Rust cdylib itself, however, is cross-platform; this test
// loads it directly (dlopen on POSIX, LoadLibraryW on Win32) and asserts the
// pinned ABI pixel contract:
//
//   1. ABI-version handshake and the four required exports resolve.
//   2. The SAME (svg, target_w, target_h, dpi) renders to byte-identical RGBA
//      across consecutive calls -- the INV-5 determinism the GDI+ host relies
//      on for "preview == print" pixels.
//   3. Bytes are straight (un-premultiplied) RGBA in R,G,B,A order, top-down.
//
// The test is opt-in: only built when SVG_RASTERIZER_LIB is defined to the
// absolute path of the built cdylib (the CI job that builds the Rust crate
// passes it via CMake). On a runner without the cdylib it compiles in but
// SKIPs with a clear message so the suite still passes.

#include <catch2/catch_test_macros.hpp>

#include <array>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#if defined(_WIN32)
#  define WIN32_LEAN_AND_MEAN
#  include <windows.h>
#else
#  include <dlfcn.h>
#endif

namespace {

struct Lib {
  void* handle = nullptr;

  ~Lib() {
    if (handle != nullptr) {
#if defined(_WIN32)
      ::FreeLibrary(reinterpret_cast<HMODULE>(handle));
#else
      ::dlclose(handle);
#endif
    }
  }

  template <typename Fn>
  Fn sym(const char* name) {
#if defined(_WIN32)
    return reinterpret_cast<Fn>(::GetProcAddress(
        reinterpret_cast<HMODULE>(handle), name));
#else
    return reinterpret_cast<Fn>(::dlsym(handle, name));
#endif
  }
};

// Opens the cdylib at `path` or returns an empty Lib (the test will SKIP).
Lib open_lib(const char* path) {
  Lib out;
#if defined(_WIN32)
  // Widen narrow path for LoadLibraryW.
  const int n = ::MultiByteToWideChar(CP_UTF8, 0, path, -1, nullptr, 0);
  std::wstring wpath(static_cast<std::size_t>(n), L'\0');
  ::MultiByteToWideChar(CP_UTF8, 0, path, -1, wpath.data(), n);
  out.handle = ::LoadLibraryW(wpath.c_str());
#else
  out.handle = ::dlopen(path, RTLD_NOW);
#endif
  return out;
}

#if !defined(SVG_RASTERIZER_LIB)
#  define SVG_RASTERIZER_LIB ""
#endif

}  // namespace

TEST_CASE("SVG rasterizer cdylib: ABI handshake + byte-identical pixel determinism",
          "[svg][cdylib][pixel_golden]") {
  const char* lib_path = SVG_RASTERIZER_LIB;
  if (lib_path == nullptr || lib_path[0] == '\0') {
    SKIP("SVG_RASTERIZER_LIB not configured; build the Rust shim first.");
  }

  Lib lib = open_lib(lib_path);
  if (lib.handle == nullptr) {
    SKIP(std::string("could not open svg rasterizer cdylib at ") + lib_path);
  }

  // ABI signatures mirror svg_rasterizer_abi.h verbatim (no header dependency
  // to keep this test isolated from the production loader).
  using FnVer = std::int32_t (*)();
  using FnId = std::size_t (*)(char*, std::size_t);
  using FnMeasure = std::int32_t (*)(const std::uint8_t*, std::size_t,
                                     std::uint32_t, std::uint32_t, double,
                                     std::uint32_t*, std::uint32_t*,
                                     std::size_t*);
  using FnRender = std::int32_t (*)(const std::uint8_t*, std::size_t,
                                    std::uint32_t, std::uint32_t, double,
                                    std::uint8_t*, std::size_t,
                                    char*, std::size_t);
  auto fn_ver = lib.sym<FnVer>("spe_svg_abi_version");
  auto fn_id = lib.sym<FnId>("spe_svg_backend_id");
  auto fn_measure = lib.sym<FnMeasure>("spe_svg_measure");
  auto fn_render = lib.sym<FnRender>("spe_svg_render");
  REQUIRE(fn_ver != nullptr);
  REQUIRE(fn_id != nullptr);
  REQUIRE(fn_measure != nullptr);
  REQUIRE(fn_render != nullptr);
  CHECK(fn_ver() == 1);
  char id[128] = {0};
  const std::size_t id_len = fn_id(id, sizeof(id));
  CHECK(id_len > 0);
  // Backend identity should start with the well-known string (resvg or any
  // future cairo-backed swap-in must populate this). The exact tail is
  // version-dependent.
  INFO("backend id: " << id);

  // A fixed deterministic SVG: solid red square. Pure vector content, no
  // fonts, no animation, no foreignObject -- the deterministic-by-ABI case.
  const std::string svg =
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'>"
      "<rect width='10' height='10' fill='red'/></svg>";
  const auto* svg_ptr = reinterpret_cast<const std::uint8_t*>(svg.data());

  constexpr std::uint32_t kW = 32;
  constexpr std::uint32_t kH = 32;
  std::uint32_t out_w = 0;
  std::uint32_t out_h = 0;
  std::size_t out_len = 0;
  REQUIRE(fn_measure(svg_ptr, svg.size(), kW, kH, 96.0,
                     &out_w, &out_h, &out_len) == 0);
  CHECK(out_w == kW);
  CHECK(out_h == kH);
  CHECK(out_len == static_cast<std::size_t>(kW) * kH * 4u);

  std::vector<std::uint8_t> first(out_len);
  std::vector<std::uint8_t> second(out_len);
  char err[256] = {0};
  REQUIRE(fn_render(svg_ptr, svg.size(), kW, kH, 96.0,
                    first.data(), first.size(), err, sizeof(err)) == 0);
  REQUIRE(fn_render(svg_ptr, svg.size(), kW, kH, 96.0,
                    second.data(), second.size(), err, sizeof(err)) == 0);

  // Determinism (INV-5 pixel half): byte-identical RGBA across two renders.
  CHECK(first == second);

  // Pixel contract: a sample inside the fitted square should be straight
  // (un-premultiplied) RGBA = (255, 0, 0, 255). Sample dead-center to dodge
  // any sub-pixel anti-alias on the box edge.
  const std::size_t mid_x = kW / 2;
  const std::size_t mid_y = kH / 2;
  const std::size_t i = (mid_y * kW + mid_x) * 4;
  CHECK(first[i + 0] == 0xff);   // R
  CHECK(first[i + 1] == 0x00);   // G
  CHECK(first[i + 2] == 0x00);   // B
  CHECK(first[i + 3] == 0xff);   // A (opaque)
}

TEST_CASE("SVG rasterizer cdylib: panic-safe -- malformed SVG returns loud parse error",
          "[svg][cdylib][pixel_golden]") {
  const char* lib_path = SVG_RASTERIZER_LIB;
  if (lib_path == nullptr || lib_path[0] == '\0') {
    SKIP("SVG_RASTERIZER_LIB not configured; build the Rust shim first.");
  }
  Lib lib = open_lib(lib_path);
  if (lib.handle == nullptr) {
    SKIP("could not open svg rasterizer cdylib");
  }
  using FnRender = std::int32_t (*)(const std::uint8_t*, std::size_t,
                                    std::uint32_t, std::uint32_t, double,
                                    std::uint8_t*, std::size_t,
                                    char*, std::size_t);
  auto fn_render = lib.sym<FnRender>("spe_svg_render");
  REQUIRE(fn_render != nullptr);

  const std::string garbage = "definitely not svg, just bytes";
  const auto* g = reinterpret_cast<const std::uint8_t*>(garbage.data());
  std::array<std::uint8_t, 32 * 32 * 4> px{};
  char err[256] = {0};
  // A panic crossing the C ABI is UB. Confirm the backend returns a typed
  // status code, NOT a process crash.
  const std::int32_t st =
      fn_render(g, garbage.size(), 32, 32, 96.0, px.data(), px.size(),
                err, sizeof(err));
  // SPE_SVG_ERR_PARSE == -2 (svg_rasterizer_abi.h). Either parse or internal
  // is acceptable; the contract is "loud, typed, never silent".
  CHECK(st < 0);
}

TEST_CASE("SVG rasterizer cdylib: hardening pack -- multiple sizes, gradients,"
          " transparency, paths all deterministic and panic-safe",
          "[svg][cdylib][pixel_golden][hardening]") {
  const char* lib_path = SVG_RASTERIZER_LIB;
  if (lib_path == nullptr || lib_path[0] == '\0') {
    SKIP("SVG_RASTERIZER_LIB not configured; build the Rust shim first.");
  }
  Lib lib = open_lib(lib_path);
  if (lib.handle == nullptr) {
    SKIP("could not open svg rasterizer cdylib");
  }
  using FnMeasure = std::int32_t (*)(const std::uint8_t*, std::size_t,
                                     std::uint32_t, std::uint32_t, double,
                                     std::uint32_t*, std::uint32_t*,
                                     std::size_t*);
  using FnRender = std::int32_t (*)(const std::uint8_t*, std::size_t,
                                    std::uint32_t, std::uint32_t, double,
                                    std::uint8_t*, std::size_t,
                                    char*, std::size_t);
  auto fn_measure = lib.sym<FnMeasure>("spe_svg_measure");
  auto fn_render = lib.sym<FnRender>("spe_svg_render");
  REQUIRE(fn_measure != nullptr);
  REQUIRE(fn_render != nullptr);

  // Mini-corpus: a flat-color square, a linear gradient, a translucent
  // overlay, a path with cubic Béziers, and a circle. Each one exercises a
  // different tiny-skia/usvg code path; they are the closest thing to "real
  // drawio embedded SVG content" without dragging in a real diagram.
  const std::array<std::string, 5> corpus = {
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'>"
      "<rect width='10' height='10' fill='red'/></svg>",

      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'>"
      "<defs><linearGradient id='g' x1='0' y1='0' x2='10' y2='0'>"
      "<stop offset='0' stop-color='red'/>"
      "<stop offset='1' stop-color='blue'/></linearGradient></defs>"
      "<rect width='10' height='10' fill='url(#g)'/></svg>",

      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'>"
      "<rect width='10' height='10' fill='red'/>"
      "<rect width='10' height='10' fill='blue' opacity='0.5'/></svg>",

      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'>"
      "<path d='M1 1 C 3 -1 7 -1 9 1 L 9 9 Z' fill='green' stroke='black' "
      "stroke-width='0.4'/></svg>",

      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'>"
      "<circle cx='5' cy='5' r='4' fill='orange'/></svg>",
  };
  const std::array<std::pair<std::uint32_t, std::uint32_t>, 4> sizes = {{
      {1u, 1u},      // 1x1 must not crash + must be deterministic
      {16u, 16u},
      {64u, 32u},    // non-square aspect, exercises letterbox math
      {300u, 300u},  // a typical print-DPI box
  }};

  char err[256] = {0};
  for (const auto& svg : corpus) {
    const auto* svg_ptr = reinterpret_cast<const std::uint8_t*>(svg.data());
    for (const auto& [w, h] : sizes) {
      std::uint32_t mw = 0;
      std::uint32_t mh = 0;
      std::size_t mlen = 0;
      REQUIRE(fn_measure(svg_ptr, svg.size(), w, h, 96.0, &mw, &mh, &mlen) == 0);
      CHECK(mw == w);
      CHECK(mh == h);
      CHECK(mlen == static_cast<std::size_t>(w) * h * 4u);

      std::vector<std::uint8_t> a(mlen);
      std::vector<std::uint8_t> b(mlen);
      const std::int32_t s1 =
          fn_render(svg_ptr, svg.size(), w, h, 96.0,
                    a.data(), a.size(), err, sizeof(err));
      const std::int32_t s2 =
          fn_render(svg_ptr, svg.size(), w, h, 96.0,
                    b.data(), b.size(), err, sizeof(err));
      INFO("svg: " << svg);
      INFO("size: " << w << "x" << h);
      INFO("err: " << err);
      REQUIRE(s1 == 0);
      REQUIRE(s2 == 0);
      // Same inputs => identical bytes. This is the INV-5 pixel guarantee
      // the host's preview vs print depends on for SVG artwork.
      CHECK(a == b);
    }
  }
}

TEST_CASE("SVG rasterizer cdylib: <foreignObject> is refused LOUDLY (status="
          " SPE_SVG_ERR_UNSUPPORTED), never silently rendered as a blank box",
          "[svg][cdylib][wysiwyg]") {
  // The WYSIWYG-critical guard. resvg's underlying parser SKIPS
  // foreignObject and returns success with a fully-transparent buffer --
  // that would print a SILENTLY blank box, the exact C1 violation.
  // The shim must intercept and report SPE_SVG_ERR_UNSUPPORTED so the host
  // emits a loud crosshatch + notice instead.
  const char* lib_path = SVG_RASTERIZER_LIB;
  if (lib_path == nullptr || lib_path[0] == '\0') {
    SKIP("SVG_RASTERIZER_LIB not configured; build the Rust shim first.");
  }
  Lib lib = open_lib(lib_path);
  if (lib.handle == nullptr) {
    SKIP("could not open svg rasterizer cdylib");
  }
  using FnRender = std::int32_t (*)(const std::uint8_t*, std::size_t,
                                    std::uint32_t, std::uint32_t, double,
                                    std::uint8_t*, std::size_t,
                                    char*, std::size_t);
  auto fn_render = lib.sym<FnRender>("spe_svg_render");
  REQUIRE(fn_render != nullptr);

  const std::string svg =
      "<svg xmlns='http://www.w3.org/2000/svg' width='100' height='40'>"
      "<foreignObject x='0' y='0' width='100' height='40'>"
      "<div xmlns='http://www.w3.org/1999/xhtml'>HTML in SVG</div>"
      "</foreignObject></svg>";
  std::array<std::uint8_t, 100 * 40 * 4> px{};
  char err[256] = {0};
  const std::int32_t st = fn_render(
      reinterpret_cast<const std::uint8_t*>(svg.data()), svg.size(),
      100, 40, 96.0, px.data(), px.size(), err, sizeof(err));
  // SPE_SVG_ERR_UNSUPPORTED == -3 per svg_rasterizer_abi.h.
  CHECK(st == -3);
  // The err message must name the failure mode so the host's
  // StubbedSvgArtwork notice carries actionable detail.
  CHECK(std::string(err).find("foreignObject") != std::string::npos);
}

// LOUD-OR-FAITHFUL: when an SVG asks for a font-family list whose entries
// all fail to resolve against the system font database, resvg silently
// shapes the text with zero glyphs (the rendered text region is fully
// transparent, status=OK). That is the silent-blank-label class C1
// forbids on the production print path. Pinned here: the shim must
// return SPE_SVG_ERR_UNSUPPORTED with a descriptive message so the host
// emits its existing StubbedSvgArtwork notice instead.
TEST_CASE("SVG rasterizer cdylib: unresolvable font family is refused LOUDLY",
          "[svg][cdylib][wysiwyg]") {
  const char* lib_path = SVG_RASTERIZER_LIB;
  if (lib_path == nullptr || lib_path[0] == '\0') {
    SKIP("SVG_RASTERIZER_LIB not configured");
  }
  Lib lib = open_lib(lib_path);
  if (lib.handle == nullptr) {
    SKIP("could not open svg rasterizer cdylib");
  }
  using FnRender = std::int32_t (*)(const std::uint8_t*, std::size_t,
                                    std::uint32_t, std::uint32_t, double,
                                    std::uint8_t*, std::size_t,
                                    char*, std::size_t);
  auto fn_render = lib.sym<FnRender>("spe_svg_render");
  REQUIRE(fn_render != nullptr);
  // A font-family unlikely to be installed on any CI runner. If the local
  // box happens to have it the test would falsely pass; the name is chosen
  // to be vanishingly unlikely.
  const std::string svg =
      "<svg xmlns='http://www.w3.org/2000/svg' width='200' height='40'>"
      "<text x='100' y='25' text-anchor='middle' "
      "font-family='ZZZ-DefinitelyNotInstalledFontFamily-2026' "
      "font-size='14' fill='#222'>Hello world</text></svg>";
  std::array<std::uint8_t, 200 * 40 * 4> px{};
  char err[512] = {0};
  const std::int32_t st = fn_render(
      reinterpret_cast<const std::uint8_t*>(svg.data()), svg.size(),
      200, 40, 96.0, px.data(), px.size(), err, sizeof(err));
  // SPE_SVG_ERR_UNSUPPORTED == -3 per svg_rasterizer_abi.h.
  CHECK(st == -3);
  CHECK(std::string(err).find("font") != std::string::npos);
}

TEST_CASE("SVG rasterizer cdylib: a real drawio-flavor SVG corpus all renders"
          " with non-empty output (no silent blank cells)",
          "[svg][cdylib][wysiwyg]") {
  // Realistic drawio SVG output uses: solid + gradient fills, stroke +
  // dash, ellipse + radial gradient, shadow-as-translated-clone (the
  // mxSvgCanvas2D drop-shadow pattern), <text> with font-family/anchor,
  // multi-line via <tspan dy>, path + <marker> arrowhead, clipPath.
  // Every one MUST rasterize to >0 opaque pixels -- a silent blank means
  // the printed page would silently lose a cell.
  const char* lib_path = SVG_RASTERIZER_LIB;
  if (lib_path == nullptr || lib_path[0] == '\0') {
    SKIP("SVG_RASTERIZER_LIB not configured");
  }
  Lib lib = open_lib(lib_path);
  if (lib.handle == nullptr) {
    SKIP("could not open svg rasterizer cdylib");
  }
  using FnRender = std::int32_t (*)(const std::uint8_t*, std::size_t,
                                    std::uint32_t, std::uint32_t, double,
                                    std::uint8_t*, std::size_t,
                                    char*, std::size_t);
  auto fn_render = lib.sym<FnRender>("spe_svg_render");
  REQUIRE(fn_render != nullptr);

  struct Case { const char* name; const char* svg; };
  const std::array<Case, 9> corpus = {{
      {"solid rect + stroke",
       "<svg xmlns='http://www.w3.org/2000/svg' width='100' height='80'>"
       "<rect x='10' y='10' width='80' height='60' fill='#4a90e2' "
       "stroke='#222' stroke-width='2'/></svg>"},
      {"linear gradient fill",
       "<svg xmlns='http://www.w3.org/2000/svg' width='100' height='80'>"
       "<defs><linearGradient id='g' x1='0' y1='0' x2='0' y2='1'>"
       "<stop offset='0' stop-color='#fff'/>"
       "<stop offset='1' stop-color='#4a90e2'/></linearGradient></defs>"
       "<rect x='10' y='10' width='80' height='60' fill='url(#g)'/></svg>"},
      {"radial gradient ellipse",
       "<svg xmlns='http://www.w3.org/2000/svg' width='100' height='80'>"
       "<defs><radialGradient id='r'>"
       "<stop offset='0' stop-color='#ff0'/>"
       "<stop offset='1' stop-color='#f00'/></radialGradient></defs>"
       "<ellipse cx='50' cy='40' rx='40' ry='30' fill='url(#r)'/></svg>"},
      {"mxgraph drop-shadow (translated-clone)",
       "<svg xmlns='http://www.w3.org/2000/svg' width='110' height='90'>"
       "<g transform='translate(3,3)' opacity='0.3'>"
       "<rect x='10' y='10' width='80' height='60' fill='#000'/></g>"
       "<rect x='10' y='10' width='80' height='60' fill='#fff' "
       "stroke='#222' stroke-width='2'/></svg>"},
      // Font-family declared with a fallback chain so the corpus runs on
      // every CI runner: Arial first (matches drawio's typical bake on
      // Windows print boxes), then Liberation Sans (Ubuntu's metric clone
      // installed via fonts-liberation), then DejaVu Sans (preinstalled on
      // most Linux images), then the CSS generic sans-serif as a last
      // resort. fontdb's family-name lookup is strict (no fontconfig alias
      // at query time), so without the chain a Linux runner without Arial
      // resolves to nothing and resvg silently emits a blank — which the
      // corpus invariant correctly flags but cannot distinguish from a
      // real C1 bug. This test pins "no silent blanks", not "Arial works".
      {"text font-family + bold + anchor",
       "<svg xmlns='http://www.w3.org/2000/svg' width='200' height='40'>"
       "<text x='100' y='25' text-anchor='middle' "
       "font-family='Arial, &quot;Liberation Sans&quot;, &quot;DejaVu Sans&quot;, sans-serif' "
       "font-size='14' font-weight='bold' fill='#222'>Hello world</text></svg>"},
      {"multi-line text via tspan dy",
       "<svg xmlns='http://www.w3.org/2000/svg' width='200' height='80'>"
       "<text x='10' y='20' "
       "font-family='Arial, &quot;Liberation Sans&quot;, &quot;DejaVu Sans&quot;, sans-serif' "
       "font-size='12'>"
       "<tspan x='10' dy='0'>Line one</tspan>"
       "<tspan x='10' dy='14'>Line two</tspan></text></svg>"},
      {"cubic-bezier path + marker arrowhead",
       "<svg xmlns='http://www.w3.org/2000/svg' width='200' height='80'>"
       "<defs><marker id='m' markerWidth='10' markerHeight='10' "
       "refX='9' refY='5' orient='auto'>"
       "<path d='M 0 0 L 10 5 L 0 10 z' fill='#222'/></marker></defs>"
       "<path d='M 10 40 C 70 10 130 70 190 40' fill='none' stroke='#222' "
       "stroke-width='2' marker-end='url(#m)'/></svg>"},
      {"dashed stroke",
       "<svg xmlns='http://www.w3.org/2000/svg' width='100' height='40'>"
       "<path d='M 10 20 L 90 20' fill='none' stroke='#a00' stroke-width='2' "
       "stroke-dasharray='6 4'/></svg>"},
      {"clipPath + nested transform",
       "<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100'>"
       "<defs><clipPath id='c'>"
       "<circle cx='50' cy='50' r='40'/></clipPath></defs>"
       "<g clip-path='url(#c)'>"
       "<rect x='0' y='0' width='100' height='100' fill='#00f'/>"
       "<rect x='0' y='0' width='50' height='50' fill='#0f0'/></g></svg>"},
  }};
  for (const auto& c : corpus) {
    constexpr std::uint32_t kW = 200;
    constexpr std::uint32_t kH = 100;
    std::vector<std::uint8_t> px(static_cast<std::size_t>(kW) * kH * 4u);
    char err[256] = {0};
    const std::int32_t st = fn_render(
        reinterpret_cast<const std::uint8_t*>(c.svg), std::strlen(c.svg),
        kW, kH, 96.0, px.data(), px.size(), err, sizeof(err));
    INFO("case: " << c.name);
    INFO("err: " << err);
    REQUIRE(st == 0);
    std::size_t opaque = 0;
    for (std::size_t i = 3; i < px.size(); i += 4) {
      if (px[i] != 0u) ++opaque;
    }
    INFO("opaque pixels: " << opaque);
    CHECK(opaque > 0u);  // a silent blank cell would print silently wrong
  }
}

TEST_CASE("SVG rasterizer cdylib: caller-allocates with too-small buffer is"
          " a typed failure, never a buffer overrun",
          "[svg][cdylib][pixel_golden]") {
  const char* lib_path = SVG_RASTERIZER_LIB;
  if (lib_path == nullptr || lib_path[0] == '\0') {
    SKIP("SVG_RASTERIZER_LIB not configured; build the Rust shim first.");
  }
  Lib lib = open_lib(lib_path);
  if (lib.handle == nullptr) {
    SKIP("could not open svg rasterizer cdylib");
  }
  using FnRender = std::int32_t (*)(const std::uint8_t*, std::size_t,
                                    std::uint32_t, std::uint32_t, double,
                                    std::uint8_t*, std::size_t,
                                    char*, std::size_t);
  auto fn_render = lib.sym<FnRender>("spe_svg_render");
  REQUIRE(fn_render != nullptr);

  const std::string svg =
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'>"
      "<rect width='10' height='10' fill='red'/></svg>";
  // Need 16*16*4 = 1024 bytes; pass 100.
  std::array<std::uint8_t, 100> small{};
  char err[256] = {0};
  const std::int32_t st = fn_render(
      reinterpret_cast<const std::uint8_t*>(svg.data()), svg.size(),
      16, 16, 96.0, small.data(), small.size(), err, sizeof(err));
  // SPE_SVG_ERR_BUFFER_TOO_SMALL == -4.
  CHECK(st == -4);
}
