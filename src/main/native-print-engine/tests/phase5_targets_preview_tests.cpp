#include "print_engine/contract_loader.hpp"
#include "print_engine/renderer.hpp"

#include <catch2/catch_test_macros.hpp>

#include <map>

using print_engine::EmittedKind;
using print_engine::RenderTarget;
using print_engine::load_baked_contract;
using print_engine::nearly_equal;
using print_engine::render_design_preview_trace;
using print_engine::render_operator_preview_trace;
using print_engine::render_print_trace;

namespace {

[[nodiscard]] std::string target_fixture() {
  return
    R"({"schema":{"major":1,"minor":0},"document":{"units":"px","pages":[)"
    R"({"id":"page-1","size":{"w":100,"h":40},"tiles":[{"origin":{"x":0,"y":0},"size":{"w":50,"h":40}},{"origin":{"x":50,"y":0},"size":{"w":50,"h":40}}],"paint":[)"
    R"({"kind":"path","d":"M 0 0 L 100 0 L 100 40 Z","fill":{"type":"solid","color":"#ff0000","alpha":1},"stroke":null},)"
    R"({"kind":"text","box":{"x":10,"y":10,"w":60,"h":20},"font":{"family":"Arial","sizePx":10,"weight":400,"italic":false,"color":"#000000"},"align":{"h":"left","v":"top"},"content":{"type":"merge","key":"NAME","sample":"Sample","maxLen":20,"wrap":"none","overflow":"clip"}})"
    R"(]}]}})";
}

[[nodiscard]] const print_engine::EmittedCommand& first_text(const print_engine::RenderTrace& trace) {
  for (const auto& command : trace.commands) {
    if (command.kind == EmittedKind::Text) {
      return command;
    }
  }
  throw std::runtime_error("text command not found");
}

[[nodiscard]] int count_kind(const print_engine::RenderTrace& trace, EmittedKind kind) {
  int count = 0;
  for (const auto& command : trace.commands) {
    if (command.kind == kind) {
      ++count;
    }
  }
  return count;
}

} // namespace

TEST_CASE("Phase 5 print target wraps the shared pipeline in document commands") {
  const auto loaded = load_baked_contract(target_fixture());
  REQUIRE(loaded);

  const auto printed = render_print_trace(loaded.value(), RenderTarget{300.0, 96.0}, {{"NAME", "Actual"}});

  REQUIRE(printed);
  REQUIRE(printed.value().commands.size() >= 2);
  CHECK(printed.value().commands.front().kind == EmittedKind::StartDocument);
  CHECK(printed.value().commands.back().kind == EmittedKind::EndDocument);
  CHECK(count_kind(printed.value(), EmittedKind::StartTile) == 2);
  CHECK(count_kind(printed.value(), EmittedKind::EndTile) == 2);
}

TEST_CASE("Phase 5 print and operator preview share node order and normalized geometry") {
  const auto loaded = load_baked_contract(target_fixture());
  REQUIRE(loaded);

  const auto printed = render_print_trace(loaded.value(), RenderTarget{300.0, 96.0}, {{"NAME", "Actual"}});
  const auto preview = render_operator_preview_trace(loaded.value(), RenderTarget{96.0, 96.0}, {{"NAME", "Actual"}});

  REQUIRE(printed);
  REQUIRE(preview);
  const auto& print_text = first_text(printed.value());
  const auto& preview_text = first_text(preview.value());
  CHECK(print_text.label == preview_text.label);
  CHECK(nearly_equal(print_text.contract_box.x, preview_text.contract_box.x, 0.0001));
  CHECK(nearly_equal(print_text.contract_box.y, preview_text.contract_box.y, 0.0001));
}

TEST_CASE("Phase 5 design preview uses samples while operator preview uses actual merge data") {
  const auto loaded = load_baked_contract(target_fixture());
  REQUIRE(loaded);

  const auto design = render_design_preview_trace(loaded.value(), RenderTarget{96.0, 96.0});
  const auto operator_preview = render_operator_preview_trace(loaded.value(), RenderTarget{96.0, 96.0}, {{"NAME", "Actual"}});

  REQUIRE(design);
  REQUIRE(operator_preview);
  CHECK(first_text(design.value()).label == "Sample");
  CHECK(first_text(operator_preview.value()).label == "Actual");
}
