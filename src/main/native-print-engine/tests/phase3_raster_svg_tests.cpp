#include "print_engine/contract_loader.hpp"
#include "print_engine/renderer.hpp"

#include <catch2/catch_test_macros.hpp>

using print_engine::ContractErrorCode;
using print_engine::EmittedKind;
using print_engine::RenderTarget;
using print_engine::load_baked_contract;
using print_engine::nearly_equal;
using print_engine::render_to_trace;

namespace {

[[nodiscard]] std::string image_fixture(std::string data = "iVBORw==") {
  return
    R"({"schema":{"major":1,"minor":0},"document":{"units":"px","pages":[)"
    R"({"id":"page-1","size":{"w":120,"h":80},"tiles":[{"origin":{"x":0,"y":0},"size":{"w":120,"h":80}}],"paint":[)"
    R"({"kind":"image","box":{"x":10,"y":12,"w":32,"h":16},"format":"png","data":")" + data + R"(","aspect":"preserve","flipH":true,"flipV":false})"
    R"(]}]}})";
}

[[nodiscard]] std::string svg_fixture() {
  return
    R"({"schema":{"major":1,"minor":0},"document":{"units":"px","pages":[)"
    R"({"id":"page-1","size":{"w":120,"h":80},"tiles":[{"origin":{"x":0,"y":0},"size":{"w":120,"h":80}}],"paint":[)"
    R"({"kind":"svg","box":{"x":5,"y":5,"w":20,"h":10},"source":"PHN2Zz48L3N2Zz4=","aspect":"fill"})"
    R"(]}]}})";
}

} // namespace

TEST_CASE("Phase 3 emits raster image nodes through the shared transform") {
  const auto loaded = load_baked_contract(image_fixture());
  REQUIRE(loaded);

  const auto rendered = render_to_trace(loaded.value(), RenderTarget{300.0, 96.0});

  REQUIRE(rendered);
  const auto& image = rendered.value().commands[2];
  CHECK(image.kind == EmittedKind::Image);
  CHECK(image.label == "preserve");
  CHECK(image.image_format == "png");
  CHECK(image.image_data == "iVBORw==");
  CHECK(image.image_aspect == "preserve");
  CHECK(image.flip_h);
  CHECK_FALSE(image.flip_v);
  CHECK(nearly_equal(image.device_box.w, 100.0, 0.0001));
  CHECK(nearly_equal(image.device_box.h, 50.0, 0.0001));
}

TEST_CASE("Phase 3 refuses truncated image base64 as a typed contract error") {
  const auto loaded = load_baked_contract(image_fixture("not-base64"));

  REQUIRE_FALSE(loaded);
  CHECK(loaded.error().code == ContractErrorCode::ContractValueError);
}

TEST_CASE("Phase 3 refuses PNG ICC profiles loudly") {
  const auto loaded = load_baked_contract(image_fixture("iVBORw0KGgoAAAANaUNDUGZha2UtcHJvZmlsZQAAAAAASUVORK5CYII="));

  REQUIRE_FALSE(loaded);
  CHECK(loaded.error().code == ContractErrorCode::ImageColorError);
}

TEST_CASE("Phase 3 retains SVG source and emits loud stub geometry at consumer DPI") {
  const auto loaded = load_baked_contract(svg_fixture());
  REQUIRE(loaded);

  const auto preview = render_to_trace(loaded.value(), RenderTarget{96.0, 96.0});
  const auto print = render_to_trace(loaded.value(), RenderTarget{384.0, 96.0});

  REQUIRE(preview);
  REQUIRE(print);
  const auto& preview_svg = preview.value().commands[2];
  const auto& print_svg = print.value().commands[2];
  CHECK(preview_svg.kind == EmittedKind::Svg);
  CHECK(print_svg.kind == EmittedKind::Svg);
  CHECK(preview_svg.label == "SVG ARTWORK STUB");
  CHECK(preview_svg.degradation_notice);
  CHECK(preview_svg.raster_width_px == 20);
  CHECK(print_svg.raster_width_px == 80);
  CHECK(nearly_equal(preview_svg.contract_box.w, print_svg.contract_box.w, 0.0001));
}
