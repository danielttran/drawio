#include "print_engine/contract_loader.hpp"
#include "print_engine/renderer.hpp"

#include <catch2/catch_test_macros.hpp>

#include <map>

using print_engine::ContractErrorCode;
using print_engine::EmittedKind;
using print_engine::RenderTarget;
using print_engine::load_baked_contract;
using print_engine::render_to_trace;

namespace {

[[nodiscard]] std::string merge_fixture(std::string overflow = "shrink", double box_height = 24.0) {
  const std::string shrink = overflow == "shrink" ? R"(,"shrinkFloorPx":6)" : "";
  return
    R"({"schema":{"major":1,"minor":0},"document":{"units":"px","pages":[)"
    R"({"id":"page-1","size":{"w":120,"h":80},"tiles":[{"origin":{"x":0,"y":0},"size":{"w":120,"h":80}}],"paint":[)"
    R"({"kind":"text","box":{"x":10,"y":20,"w":42,"h":)" + std::to_string(box_height) + R"(},"font":{"family":"Arial","sizePx":12,"weight":400,"italic":false,"color":"#000000"},"align":{"h":"left","v":"top"},"content":{"type":"merge","key":"NAME","sample":"Sample","maxLen":32,"wrap":"word","overflow":")" + overflow + R"(")" + shrink + R"(}},)"
    R"({"kind":"barcode","box":{"x":10,"y":50,"w":50,"h":20},"symbology":"stub","params":{},"value":{"type":"merge","key":"CODE","sample":"12345","maxLen":12,"errorOnUnencodable":true}})"
    R"(]}]}})";
}

} // namespace

TEST_CASE("Phase 4 resolves merge text and barcode values through seams") {
  const auto loaded = load_baked_contract(merge_fixture());
  REQUIRE(loaded);

  const auto rendered = render_to_trace(
    loaded.value(),
    RenderTarget{96.0, 96.0},
    {{"NAME", "Ada Lovelace"}, {"CODE", "ZX42"}},
    false);

  REQUIRE(rendered);
  REQUIRE(rendered.value().commands.size() == 5);
  CHECK(rendered.value().commands[2].kind == EmittedKind::Text);
  CHECK(rendered.value().commands[2].label.find("Ada") != std::string::npos);
  CHECK(rendered.value().commands[3].kind == EmittedKind::Barcode);
  CHECK(rendered.value().commands[3].label == "ZX42");
}

TEST_CASE("Phase 4 design-time preview uses merge samples") {
  const auto loaded = load_baked_contract(merge_fixture());
  REQUIRE(loaded);

  const auto rendered = render_to_trace(loaded.value(), RenderTarget{96.0, 96.0}, {}, true);

  REQUIRE(rendered);
  CHECK(rendered.value().commands[2].label == "Sample");
  CHECK(rendered.value().commands[3].label == "12345");
}

TEST_CASE("Phase 4 rejects merge value beyond maxLen") {
  const auto loaded = load_baked_contract(merge_fixture());
  REQUIRE(loaded);

  const auto rendered = render_to_trace(
    loaded.value(),
    RenderTarget{96.0, 96.0},
    {{"NAME", "this value is intentionally far beyond the field max length"}},
    false);

  REQUIRE_FALSE(rendered);
  CHECK(rendered.error().code == ContractErrorCode::MergeOverflowError);
}

TEST_CASE("Phase 4 refuses missing runtime merge values") {
  const auto loaded = load_baked_contract(merge_fixture());
  REQUIRE(loaded);

  const auto rendered = render_to_trace(
    loaded.value(),
    RenderTarget{96.0, 96.0},
    {{"CODE", "123"}},
    false);

  REQUIRE_FALSE(rendered);
  CHECK(rendered.error().code == ContractErrorCode::MergeResolveError);
}

TEST_CASE("Phase 4 shrink geometry uses the fitted font size") {
  const auto loaded = load_baked_contract(merge_fixture("shrink", 13.0));
  REQUIRE(loaded);

  const auto rendered = render_to_trace(
    loaded.value(),
    RenderTarget{96.0, 96.0},
    {{"NAME", "One Two"}, {"CODE", "123"}},
    false);

  REQUIRE(rendered);
  const auto& text = rendered.value().commands[2];
  CHECK(text.font_size_px < 12.0);
  CHECK(text.contract_box.h <= 13.0);
}

TEST_CASE("Phase 4 rejects unencodable barcode values") {
  const auto loaded = load_baked_contract(merge_fixture());
  REQUIRE(loaded);

  const auto rendered = render_to_trace(
    loaded.value(),
    RenderTarget{96.0, 96.0},
    {{"NAME", "Ada"}, {"CODE", "BAD!"}},
    false);

  REQUIRE_FALSE(rendered);
  CHECK(rendered.error().code == ContractErrorCode::BarcodeEncodeError);
}

TEST_CASE("Phase 4 rejects fixed-DPI barcode representations") {
  std::string json = merge_fixture();
  const std::string from = R"("symbology":"stub")";
  const std::string to = R"("symbology":"fixed-dpi-raster")";
  json.replace(json.find(from), from.size(), to);
  const auto loaded = load_baked_contract(json);
  REQUIRE(loaded);

  const auto rendered = render_to_trace(loaded.value(), RenderTarget{96.0, 96.0}, {{"NAME", "Ada"}, {"CODE", "123"}}, false);

  REQUIRE_FALSE(rendered);
  CHECK(rendered.error().code == ContractErrorCode::BarcodeRepresentationError);
}
