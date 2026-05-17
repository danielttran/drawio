#include "print_engine/contract_loader.hpp"
#include "print_engine/renderer.hpp"

#include <catch2/catch_test_macros.hpp>

using print_engine::EmittedKind;
using print_engine::RenderTarget;
using print_engine::load_baked_contract;
using print_engine::nearly_equal;
using print_engine::render_to_trace;

namespace {

[[nodiscard]] std::string static_text_fixture(std::string family = "Arial", std::string align_v = "top") {
  return
    R"({"schema":{"major":1,"minor":0},"document":{"units":"px","pages":[)"
    R"({"id":"page-1","size":{"w":120,"h":80},"tiles":[{"origin":{"x":0,"y":0},"size":{"w":120,"h":80}}],"paint":[)"
    R"({"kind":"text","box":{"x":10,"y":20,"w":80,"h":30},"font":{"family":")" + family + R"(","sizePx":10,"weight":400,"italic":false,"color":"#000000"},"align":{"h":"left","v":")" + align_v + R"("},"content":{"type":"static","lines":["Line A","Line B"]}})"
    R"(]}]}})";
}

[[nodiscard]] std::string static_text_fixture_with_align(std::string align_h) {
  return
    R"({"schema":{"major":1,"minor":0},"document":{"units":"px","pages":[)"
    R"({"id":"page-1","size":{"w":120,"h":80},"tiles":[{"origin":{"x":0,"y":0},"size":{"w":120,"h":80}}],"paint":[)"
    R"({"kind":"text","box":{"x":10,"y":20,"w":80,"h":30},"font":{"family":"Arial","sizePx":10,"weight":400,"italic":false,"color":"#000000"},"align":{"h":")" + align_h + R"(","v":"top"},"content":{"type":"static","lines":["AB"]}})"
    R"(]}]}})";
}

} // namespace

TEST_CASE("Phase 2 renders static pre-wrapped lines without fitting") {
  const auto loaded = load_baked_contract(static_text_fixture());
  REQUIRE(loaded);

  const auto rendered = render_to_trace(loaded.value(), RenderTarget{96.0, 96.0});

  REQUIRE(rendered);
  REQUIRE(rendered.value().commands.size() == 4);
  const auto& text = rendered.value().commands[2];
  CHECK(text.kind == EmittedKind::Text);
  CHECK(text.label == "Line A\nLine B");
  CHECK(text.font_family == "Arial");
  CHECK(text.font_size_px == 10.0);
  CHECK(nearly_equal(text.contract_box.y, 28.0, 0.0001));
}

TEST_CASE("Phase 2 applies deterministic horizontal alignment") {
  const auto centered = load_baked_contract(static_text_fixture_with_align("center"));
  const auto right = load_baked_contract(static_text_fixture_with_align("right"));
  REQUIRE(centered);
  REQUIRE(right);

  const auto centered_render = render_to_trace(centered.value(), RenderTarget{96.0, 96.0});
  const auto right_render = render_to_trace(right.value(), RenderTarget{96.0, 96.0});

  REQUIRE(centered_render);
  REQUIRE(right_render);
  CHECK(nearly_equal(centered_render.value().commands[2].contract_box.x, 44.0, 0.0001));
  CHECK(nearly_equal(right_render.value().commands[2].contract_box.x, 78.0, 0.0001));
}

TEST_CASE("Phase 2 applies deterministic vertical alignment and baseline correction") {
  const auto loaded = load_baked_contract(static_text_fixture("Arial", "bottom"));
  REQUIRE(loaded);

  const auto rendered = render_to_trace(loaded.value(), RenderTarget{300.0, 96.0});

  REQUIRE(rendered);
  const auto& text = rendered.value().commands[2];
  CHECK(nearly_equal(text.contract_box.y, 34.0, 0.0001));
  CHECK(nearly_equal(text.device_box.y, 34.0 * 300.0 / 96.0, 0.0001));
}

TEST_CASE("Phase 2 missing font emits deterministic substitution notice") {
  const auto loaded = load_baked_contract(static_text_fixture("DefinitelyMissingFont"));
  REQUIRE(loaded);

  const auto rendered = render_to_trace(loaded.value(), RenderTarget{96.0, 96.0});

  REQUIRE(rendered);
  const auto& text = rendered.value().commands[2];
  CHECK(text.font_family == "Arial");
  CHECK(text.degradation_notice);
}
