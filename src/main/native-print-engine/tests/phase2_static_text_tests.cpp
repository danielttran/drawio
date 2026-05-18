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

[[nodiscard]] std::string styled_text_fixture(int weight, bool italic) {
  return
    R"({"schema":{"major":1,"minor":0},"document":{"units":"px","pages":[)"
    R"({"id":"page-1","size":{"w":120,"h":80},"tiles":[{"origin":{"x":0,"y":0},"size":{"w":120,"h":80}}],"paint":[)"
    R"({"kind":"text","box":{"x":10,"y":20,"w":80,"h":30},"font":{"family":"Arial","sizePx":10,"weight":)"
    + std::to_string(weight) +
    R"(,"italic":)" + (italic ? "true" : "false") +
    R"(,"color":"#cc0000"},"align":{"h":"left","v":"top"},"content":{"type":"static","lines":["Styled"]}})"
    R"(]}]}})";
}

} // namespace

// §2 measure-at-the-sink: the engine no longer wraps/positions text. It
// forwards the raw text, the NODE box, the layout policy and the font
// verbatim; real glyph layout is the device sink's job (verified by host
// e2e). These tests assert that faithful forwarding + the box transform.
TEST_CASE("Phase 2 forwards static text, node box and style without layout") {
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
  // contract_box is the node box verbatim (no engine-computed text_box).
  CHECK(nearly_equal(text.contract_box.x, 10.0, 0.0001));
  CHECK(nearly_equal(text.contract_box.y, 20.0, 0.0001));
  CHECK(nearly_equal(text.contract_box.w, 80.0, 0.0001));
  CHECK(nearly_equal(text.contract_box.h, 30.0, 0.0001));
  CHECK(text.align_h == "left");
  CHECK(text.align_v == "top");
  CHECK(text.text_color.r == 0);
  CHECK(text.text_color.g == 0);
  CHECK(text.text_color.b == 0);
  CHECK(text.text_color.a == 1.0);
}

TEST_CASE("Phase 2 forwards horizontal alignment policy unchanged") {
  const auto centered = load_baked_contract(static_text_fixture_with_align("center"));
  const auto right = load_baked_contract(static_text_fixture_with_align("right"));
  REQUIRE(centered);
  REQUIRE(right);

  const auto centered_render = render_to_trace(centered.value(), RenderTarget{96.0, 96.0});
  const auto right_render = render_to_trace(right.value(), RenderTarget{96.0, 96.0});

  REQUIRE(centered_render);
  REQUIRE(right_render);
  // The engine does NOT pre-shift x for alignment; it forwards the policy and
  // the unchanged node box. The sink positions using real metrics.
  CHECK(centered_render.value().commands[2].align_h == "center");
  CHECK(right_render.value().commands[2].align_h == "right");
  CHECK(nearly_equal(centered_render.value().commands[2].contract_box.x, 10.0, 0.0001));
  CHECK(nearly_equal(right_render.value().commands[2].contract_box.x, 10.0, 0.0001));
}

TEST_CASE("Phase 2 forwards vertical alignment and scales the node box") {
  const auto loaded = load_baked_contract(static_text_fixture("Arial", "bottom"));
  REQUIRE(loaded);

  const auto rendered = render_to_trace(loaded.value(), RenderTarget{300.0, 96.0});

  REQUIRE(rendered);
  const auto& text = rendered.value().commands[2];
  CHECK(text.align_v == "bottom");
  // No baseline/vertical pre-offset: contract_box.y is the node box; the
  // device box is just that box under the world transform.
  CHECK(nearly_equal(text.contract_box.y, 20.0, 0.0001));
  CHECK(nearly_equal(text.device_box.y, 20.0 * 300.0 / 96.0, 0.0001));
}

TEST_CASE("Phase 2 missing font name is preserved for device substitution notice") {
  const auto loaded = load_baked_contract(static_text_fixture("DefinitelyMissingFont"));
  REQUIRE(loaded);

  const auto rendered = render_to_trace(loaded.value(), RenderTarget{96.0, 96.0});

  REQUIRE(rendered);
  const auto& text = rendered.value().commands[2];
  CHECK(text.font_family == "DefinitelyMissingFont");
  CHECK_FALSE(text.degradation_notice);
  CHECK(rendered.value().notices.empty());
}

TEST_CASE("Phase 2 preserves text weight italic and color in emitted commands") {
  const auto loaded = load_baked_contract(styled_text_fixture(700, true));
  REQUIRE(loaded);

  const auto rendered = render_to_trace(loaded.value(), RenderTarget{96.0, 96.0});

  REQUIRE(rendered);
  const auto& text = rendered.value().commands[2];
  CHECK(text.font_weight == 700);
  CHECK(text.font_italic);
  CHECK(text.text_color.r == 204);
  CHECK(text.text_color.g == 0);
  CHECK(text.text_color.b == 0);
}

TEST_CASE("Phase 2 forwards rich text paragraphs in emitted command") {
  const std::string json =
    R"({"schema":{"major":1,"minor":0},"document":{"units":"px","pages":[)"
    R"({"id":"page-1","size":{"w":120,"h":80},"tiles":[{"origin":{"x":0,"y":0},"size":{"w":120,"h":80}}],"paint":[)"
    R"({"kind":"text","box":{"x":10,"y":20,"w":80,"h":30},"font":{"family":"Arial","sizePx":10,"weight":400,"italic":false,"color":"#000000"},"align":{"h":"left","v":"top"},"content":{"type":"rich","paragraphs":[{"align":"left","runs":[{"text":"Rich","fontFamily":"Arial","sizePx":10,"weight":700,"italic":false,"underline":true,"strikethrough":false,"color":"#112233"}]},{"align":"right","runs":[]}]}})"
    R"(]}]}})";
  const auto loaded = load_baked_contract(json);
  REQUIRE(loaded);
  const auto rendered = render_to_trace(loaded.value(), RenderTarget{96.0, 96.0});
  REQUIRE(rendered);
  const auto& text = rendered.value().commands[2];
  CHECK(text.kind == EmittedKind::Text);
  CHECK(text.rich_paragraphs.size() == 2);
  CHECK(text.rich_paragraphs[0].runs.size() == 1);
  CHECK(text.rich_paragraphs[0].runs[0].text == "Rich");
  CHECK(text.label == "Rich\n");
}

TEST_CASE("Phase 2 rich text preserves paragraphs and run metrics in trace", "[rich]") {
  const std::string json =
    R"({"schema":{"major":1,"minor":0},"document":{"units":"px","pages":[)"
    R"({"id":"p1","size":{"w":200,"h":120},"tiles":[{"origin":{"x":0,"y":0},"size":{"w":200,"h":120}}],"paint":[)"
    R"({"kind":"text","box":{"x":10,"y":20,"w":120,"h":50},"font":{"family":"Arial","sizePx":12,"weight":400,"italic":false,"underline":false,"strikethrough":false,"color":"#000000"},"align":{"h":"left","v":"top"},"content":{"type":"rich","paragraphs":[)"
    R"({"align":"left","indentPx":8,"runs":[{"text":"A big","fontFamily":"Arial","sizePx":18,"weight":700,"italic":false,"underline":true,"strikethrough":false,"color":"#112233"},{"text":" run","fontFamily":"Arial","sizePx":10,"weight":400,"italic":true,"underline":false,"strikethrough":true,"color":"#445566"}]},)"
    R"({"align":"right","runs":[{"text":"tail","fontFamily":"Times New Roman","sizePx":11,"weight":400,"italic":false,"underline":false,"strikethrough":false,"color":"#778899"}]})"
    R"]}})]}]}})";

  const auto loaded = load_baked_contract(json);
  REQUIRE(loaded);
  const auto rendered = render_to_trace(loaded.value(), RenderTarget{96.0, 96.0});
  REQUIRE(rendered);
  const auto& text = rendered.value().commands[2];
  REQUIRE(text.kind == EmittedKind::Text);
  REQUIRE(text.rich_paragraphs.size() == 2);
  CHECK(text.rich_paragraphs[0].indent_px == Catch::Approx(8.0));
  CHECK(text.rich_paragraphs[0].runs.size() == 2);
  CHECK(text.rich_paragraphs[0].runs[0].underline);
  CHECK(text.rich_paragraphs[0].runs[1].strikethrough);
  CHECK(text.rich_paragraphs[1].align == "right");
  CHECK(text.label == "A big run\ntail");
}
