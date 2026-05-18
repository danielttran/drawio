// Windows-only: ABI-version handshake + §5 swap acceptance for the SVG
// rasterizer loader. Drives the loader against the fake backend cdylib with
// ZERO loader/C++ change -- proving the hand-owned ABI is backend-agnostic
// (librsvg+cairo can later replace resvg by swapping the DLL only).
//
// Built/run only on WIN32 (the loader is LoadLibraryW-only because the host
// print path is GDI+ / Windows-exclusive).

#include "svg_rasterizer.hpp"

#include <catch2/catch_test_macros.hpp>

#include <filesystem>

using print_engine::host::SvgRasterizerDll;
using print_engine::host::SvgRasterStatus;

TEST_CASE("SVG rasterizer loader: missing DLL refuses loudly (loud-stub path)") {
  auto r = SvgRasterizerDll::load("definitely-not-a-real-rasterizer.dll");
  CHECK(r == nullptr);  // caller falls back to the loud StubbedSvgArtwork
}

TEST_CASE("SVG rasterizer loader: fake backend passes the ABI handshake") {
  const std::filesystem::path dll = FAKE_SVG_RASTERIZER_PATH;
  REQUIRE(std::filesystem::exists(dll));

  auto r = SvgRasterizerDll::load(dll);
  REQUIRE(r != nullptr);
  CHECK(r->available());
  CHECK(r->backend_id() == "fake-solid 1.0");
}

TEST_CASE("SVG rasterizer loader: fake backend renders the pinned pixel "
          "contract with no C++ change (swap acceptance)") {
  auto r = SvgRasterizerDll::load(std::filesystem::path(FAKE_SVG_RASTERIZER_PATH));
  REQUIRE(r != nullptr);

  const std::string svg = "<svg xmlns='http://www.w3.org/2000/svg'/>";
  auto out = r->render(svg, /*w=*/4, /*h=*/3, /*dpi=*/96.0);

  REQUIRE(out.ok());
  CHECK(out.status == SvgRasterStatus::Ok);
  CHECK(out.raster.width == 4u);
  CHECK(out.raster.height == 3u);
  // stride == width*4, tightly packed: 4*3*4 bytes.
  REQUIRE(out.raster.rgba.size() == 4u * 3u * 4u);
  // Straight RGBA, byte order R,G,B,A -- the fake fills 0x12,0x34,0x56,0x78.
  for (std::size_t i = 0; i < out.raster.rgba.size(); i += 4) {
    CHECK(out.raster.rgba[i + 0] == 0x12);
    CHECK(out.raster.rgba[i + 1] == 0x34);
    CHECK(out.raster.rgba[i + 2] == 0x56);
    CHECK(out.raster.rgba[i + 3] == 0x78);
  }
}

TEST_CASE("SVG rasterizer loader: empty SVG / zero box is a loud failure") {
  auto r = SvgRasterizerDll::load(std::filesystem::path(FAKE_SVG_RASTERIZER_PATH));
  REQUIRE(r != nullptr);

  CHECK_FALSE(r->render("", 4, 3, 96.0).ok());
  CHECK_FALSE(r->render("<svg/>", 0, 3, 96.0).ok());
}
