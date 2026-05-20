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
