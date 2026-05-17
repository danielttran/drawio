#include "print_engine/contract_loader.hpp"
#include "print_engine/renderer.hpp"

#include <catch2/catch_test_macros.hpp>

using print_engine::ContractErrorCode;
using print_engine::EmittedKind;
using print_engine::PaintKind;
using print_engine::PathCommandKind;
using print_engine::RenderTarget;
using print_engine::load_baked_contract;
using print_engine::nearly_equal;
using print_engine::render_to_trace;

namespace {

[[nodiscard]] std::string phase1_path_fixture(std::string path) {
  return
    R"({"schema":{"major":1,"minor":0},"document":{"units":"px","pages":[)"
    R"({"id":"page-1","size":{"w":100,"h":40},"tiles":[{"origin":{"x":0,"y":0},"size":{"w":100,"h":40}}],"paint":[)"
    R"({"kind":"path","d":")" + path + R"(","fill":{"type":"solid","color":"#ff0000","alpha":1},"stroke":{"paint":{"type":"solid","color":"#000000","alpha":1},"width":2,"cap":"butt","join":"miter","miterLimit":4,"dash":[1,2]}})"
    R"(]}]}})";
}

} // namespace

TEST_CASE("Phase 1 emits path nodes through a single world transform") {
  const auto loaded = load_baked_contract(phase1_path_fixture("M 10 5 L 40 5 L 40 20 Z"));
  REQUIRE(loaded);
  REQUIRE(loaded.value().pages[0].paint.size() == 1);
  CHECK(loaded.value().pages[0].paint[0].kind == PaintKind::Path);

  const auto rendered = render_to_trace(loaded.value(), RenderTarget{300.0, 96.0});

  REQUIRE(rendered);
  REQUIRE(rendered.value().commands.size() == 4);
  CHECK(rendered.value().commands[0].kind == EmittedKind::StartTile);
  CHECK(rendered.value().commands[1].kind == EmittedKind::Clip);
  CHECK(rendered.value().commands[2].kind == EmittedKind::Path);
  CHECK(rendered.value().commands[3].kind == EmittedKind::EndTile);
  CHECK(nearly_equal(rendered.value().commands[2].contract_box.x, 10.0, 0.0001));
  CHECK(nearly_equal(rendered.value().commands[2].contract_box.y, 5.0, 0.0001));
  CHECK(nearly_equal(rendered.value().commands[2].device_box.w, 93.75, 0.0001));
  CHECK(nearly_equal(rendered.value().commands[2].device_box.h, 46.875, 0.0001));
}

TEST_CASE("Phase 1 numeric drift stays below half a device dot at print DPIs") {
  const auto loaded = load_baked_contract(phase1_path_fixture("M 0 0 L 100 0 L 100 40 Z"));
  REQUIRE(loaded);

  for (const double dpi : {300.0, 600.0, 1200.0}) {
    const auto rendered = render_to_trace(loaded.value(), RenderTarget{dpi, 96.0});
    REQUIRE(rendered);

    const auto& box = rendered.value().commands[2].device_box;
    INFO("dpi: " << dpi);
    CHECK(nearly_equal(box.w, 100.0 * dpi / 96.0, 0.499));
    CHECK(nearly_equal(box.h, 40.0 * dpi / 96.0, 0.499));
  }
}

TEST_CASE("Phase 1 normalizes horizontal and vertical path commands") {
  const auto loaded = load_baked_contract(phase1_path_fixture("M 2 3 H 12 V 9 Z"));
  REQUIRE(loaded);

  const auto rendered = render_to_trace(loaded.value(), RenderTarget{96.0, 96.0});

  REQUIRE(rendered);
  const auto& commands = rendered.value().commands[2].path_commands;
  REQUIRE(commands.size() == 4);
  CHECK(commands[1].kind == PathCommandKind::LineTo);
  REQUIRE(commands[1].values.size() == 2);
  CHECK(commands[1].values[0] == 12.0);
  CHECK(commands[1].values[1] == 3.0);
  REQUIRE(commands[2].values.size() == 2);
  CHECK(commands[2].values[0] == 12.0);
  CHECK(commands[2].values[1] == 9.0);
  CHECK(nearly_equal(rendered.value().commands[2].contract_box.w, 10.0, 0.0001));
  CHECK(nearly_equal(rendered.value().commands[2].contract_box.h, 6.0, 0.0001));
}

TEST_CASE("Phase 1 parses arc path commands without recomputing structural geometry") {
  const auto loaded = load_baked_contract(phase1_path_fixture("M 10 10 A 8 8 0 0 1 18 18 Z"));
  REQUIRE(loaded);

  const auto rendered = render_to_trace(loaded.value(), RenderTarget{300.0, 96.0});

  REQUIRE(rendered);
  const auto& commands = rendered.value().commands[2].path_commands;
  REQUIRE(commands.size() == 3);
  CHECK(commands[1].kind == PathCommandKind::ArcTo);
  REQUIRE(commands[1].values.size() == 7);
  CHECK(commands[1].values[0] == 8.0);
}

TEST_CASE("Phase 1 refuses malformed path data as a typed contract error") {
  const auto loaded = load_baked_contract(phase1_path_fixture("M 10 nope"));

  REQUIRE_FALSE(loaded);
  CHECK(loaded.error().code == ContractErrorCode::ContractShapeError);
}
