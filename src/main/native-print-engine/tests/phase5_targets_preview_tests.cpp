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

TEST_CASE("Phase 5 numeric drift covers text image svg and barcode boxes") {
  const std::string json =
    R"({"schema":{"major":1,"minor":0},"document":{"units":"px","pages":[)"
    R"({"id":"page-1","size":{"w":120,"h":80},"tiles":[{"origin":{"x":0,"y":0},"size":{"w":120,"h":80}}],"paint":[)"
    R"({"kind":"text","box":{"x":10,"y":10,"w":50,"h":20},"font":{"family":"Arial","sizePx":10,"weight":400,"italic":false,"color":"#000000"},"align":{"h":"left","v":"top"},"content":{"type":"static","lines":["AB"]}},)"
    R"({"kind":"image","box":{"x":20,"y":10,"w":32,"h":16},"format":"png","data":"iVBORw==","aspect":"preserve","flipH":false,"flipV":false},)"
    R"({"kind":"svg","box":{"x":30,"y":10,"w":20,"h":10},"source":"PHN2Zz48L3N2Zz4=","aspect":"fill"},)"
    R"({"kind":"barcode","box":{"x":40,"y":10,"w":50,"h":20},"symbology":"stub","params":{},"value":{"type":"static","data":"ABC123"}})"
    R"(]}]}})";
  const auto loaded = load_baked_contract(json);
  REQUIRE(loaded);

  const auto rendered = render_design_preview_trace(loaded.value(), RenderTarget{300.0, 96.0});

  REQUIRE(rendered);
  // §2 measure-at-the-sink: the text command now carries the NODE box
  // (w=50), not a fake engine-measured text width. Drift parity still holds.
  CHECK(nearly_equal(rendered.value().commands[2].device_box.w, 50.0 * 300.0 / 96.0, 0.499));
  CHECK(nearly_equal(rendered.value().commands[3].device_box.w, 32.0 * 300.0 / 96.0, 0.499));
  CHECK(nearly_equal(rendered.value().commands[4].device_box.w, 20.0 * 300.0 / 96.0, 0.499));
  CHECK(nearly_equal(rendered.value().commands[5].device_box.w, 50.0 * 300.0 / 96.0, 0.499));
}
