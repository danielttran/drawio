#include "print_engine/contract_loader.hpp"
#include "print_engine/renderer.hpp"

#include <catch2/catch_test_macros.hpp>

#include <map>

using print_engine::ContractErrorCode;
using print_engine::DegradationNoticeType;
using print_engine::EmittedKind;
using print_engine::RenderTarget;
using print_engine::load_baked_contract;
using print_engine::nearly_equal;
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

[[nodiscard]] std::string merge_fixture_with_width(std::string overflow, double box_width, int max_len = 32,
                                                   std::string sample = "Sample") {
  // The loader statically requires sample <= maxLen (the sample renders in
  // design previews), so fixtures must carry a consistent sample.
  const std::string shrink = overflow == "shrink" ? R"(,"shrinkFloorPx":6)" : "";
  return
    R"({"schema":{"major":1,"minor":0},"document":{"units":"px","pages":[)"
    R"({"id":"page-1","size":{"w":120,"h":80},"tiles":[{"origin":{"x":0,"y":0},"size":{"w":120,"h":80}}],"paint":[)"
    R"({"kind":"text","box":{"x":10,"y":20,"w":)" + std::to_string(box_width) + R"(,"h":20},"font":{"family":"Arial","sizePx":12,"weight":400,"italic":false,"color":"#000000"},"align":{"h":"left","v":"top"},"content":{"type":"merge","key":"NAME","sample":")" + sample + R"(","maxLen":)"
    + std::to_string(max_len) +
    R"(,"wrap":"none","overflow":")" + overflow + R"(")" + shrink + R"(}})"
    R"(]}]}})";
}

[[nodiscard]] std::string static_barcode_fixture() {
  return
    R"({"schema":{"major":1,"minor":0},"document":{"units":"px","pages":[)"
    R"({"id":"page-1","size":{"w":120,"h":80},"tiles":[{"origin":{"x":0,"y":0},"size":{"w":120,"h":80}}],"paint":[)"
    R"({"kind":"barcode","box":{"x":10,"y":50,"w":50,"h":20},"symbology":"stub","params":{},"value":{"type":"static","data":"ABC123"}})"
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
  CHECK(rendered.value().commands[3].label == std::string("BARCODE STUB \xE2\x80\x94 symbology=stub value=ZX42"));
  CHECK(rendered.value().commands[3].style_signature == "stub-barcode-diagonal-hatch");
  REQUIRE(rendered.value().notices.size() == 1);
  CHECK(rendered.value().notices[0].type == DegradationNoticeType::StubbedBarcode);
  CHECK(rendered.value().notices[0].resolved_value == "ZX42");
}

TEST_CASE("Phase 4 design-time preview uses merge samples") {
  const auto loaded = load_baked_contract(merge_fixture());
  REQUIRE(loaded);

  const auto rendered = render_to_trace(loaded.value(), RenderTarget{96.0, 96.0}, {}, true);

  REQUIRE(rendered);
  CHECK(rendered.value().commands[2].label == "Sample");
  CHECK(rendered.value().commands[3].label == std::string("BARCODE STUB \xE2\x80\x94 symbology=stub value=12345"));
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

TEST_CASE("Phase 4 accepts merge value exactly at maxLen") {
  const auto loaded = load_baked_contract(merge_fixture_with_width("clip", 200.0, 4, "ABCD"));
  REQUIRE(loaded);

  const auto rendered = render_to_trace(
    loaded.value(),
    RenderTarget{96.0, 96.0},
    {{"NAME", "ABCD"}},
    false);

  REQUIRE(rendered);
  CHECK(rendered.value().commands[2].label == "ABCD");
}

// §2 measure-at-the-sink: width-overflow is metric-dependent, so the engine
// no longer decides it — it forwards the value + the overflow policy and the
// device sink enforces reject/clip with real glyph metrics (host e2e).
// The engine keeps ONLY the metric-independent maxLen guard.
TEST_CASE("Phase 4 forwards reject policy without deciding width overflow") {
  const auto loaded = load_baked_contract(merge_fixture_with_width("reject", 10.0));
  REQUIRE(loaded);

  const auto rendered = render_to_trace(
    loaded.value(),
    RenderTarget{96.0, 96.0},
    {{"NAME", "TOO-WIDE"}},  // 8 chars <= maxLen 32: engine must NOT error
    false);

  REQUIRE(rendered);
  CHECK(rendered.value().commands[2].label == "TOO-WIDE");
  CHECK(rendered.value().commands[2].overflow == "reject");
}

TEST_CASE("Phase 4 forwards clip policy for device-side enforcement") {
  const auto loaded = load_baked_contract(merge_fixture_with_width("clip", 10.0));
  REQUIRE(loaded);

  const auto rendered = render_to_trace(
    loaded.value(),
    RenderTarget{96.0, 96.0},
    {{"NAME", "TOO-WIDE"}},
    false);

  REQUIRE(rendered);
  CHECK(rendered.value().commands[2].overflow == "clip");
  CHECK(rendered.value().commands[2].label == "TOO-WIDE");
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

TEST_CASE("Phase 4 forwards shrink policy and font size unchanged") {
  const auto loaded = load_baked_contract(merge_fixture("shrink", 13.0));
  REQUIRE(loaded);

  const auto rendered = render_to_trace(
    loaded.value(),
    RenderTarget{96.0, 96.0},
    {{"NAME", "One Two"}, {"CODE", "123"}},
    false);

  REQUIRE(rendered);
  const auto& text = rendered.value().commands[2];
  // The engine no longer shrinks (no real metrics here); it forwards the
  // requested font size, the shrink policy and floor for the sink to apply.
  CHECK(text.font_size_px == 12.0);
  CHECK(text.overflow == "shrink");
  CHECK(nearly_equal(text.shrink_floor_px, 6.0, 0.0001));
  CHECK(nearly_equal(text.contract_box.h, 13.0, 0.0001));
}

TEST_CASE("Phase 4 v2 barcode stub is loud even for future unencodable values") {
  const auto loaded = load_baked_contract(merge_fixture());
  REQUIRE(loaded);

  const auto rendered = render_to_trace(
    loaded.value(),
    RenderTarget{96.0, 96.0},
    {{"NAME", "Ada"}, {"CODE", "BAD!"}},
    false);

  REQUIRE(rendered);
  CHECK(rendered.value().commands[3].label == std::string("BARCODE STUB \xE2\x80\x94 symbology=stub value=BAD!"));
  CHECK(rendered.value().commands[3].degradation_notice);
}

TEST_CASE("Phase 4 v2 barcode stub preserves future representation seam without fixed-DPI output") {
  std::string json = merge_fixture();
  const std::string from = R"("symbology":"stub")";
  const std::string to = R"("symbology":"fixed-dpi-raster")";
  json.replace(json.find(from), from.size(), to);
  const auto loaded = load_baked_contract(json);
  REQUIRE(loaded);

  const auto rendered = render_to_trace(loaded.value(), RenderTarget{96.0, 96.0}, {{"NAME", "Ada"}, {"CODE", "123"}}, false);

  REQUIRE(rendered);
  CHECK(rendered.value().commands[3].style_signature == "stub-barcode-diagonal-hatch");
  CHECK(rendered.value().commands[3].raster_width_px == 0);
}

TEST_CASE("Phase 4 renders static barcode values through the barcode seam") {
  const auto loaded = load_baked_contract(static_barcode_fixture());
  REQUIRE(loaded);

  const auto rendered = render_to_trace(loaded.value(), RenderTarget{96.0, 96.0}, {}, false);

  REQUIRE(rendered);
  CHECK(rendered.value().commands[2].kind == EmittedKind::Barcode);
  CHECK(rendered.value().commands[2].label == std::string("BARCODE STUB \xE2\x80\x94 symbology=stub value=ABC123"));
  REQUIRE(rendered.value().notices.size() == 1);
  CHECK(rendered.value().notices[0].type == DegradationNoticeType::StubbedBarcode);
}
