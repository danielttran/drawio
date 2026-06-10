#include "print_engine/contract_loader.hpp"

#include <catch2/catch_test_macros.hpp>

#include <string>

using print_engine::ContractErrorCode;
using print_engine::PaintType;
using print_engine::load_baked_contract;

namespace {

[[nodiscard]] std::string doc_with_paint(std::string paint) {
  return
    R"({"schema":{"major":1,"minor":0},"document":{"units":"px","pages":[)"
    R"({"id":"page-1","size":{"w":100,"h":50},"tiles":[{"origin":{"x":0,"y":0},"size":{"w":100,"h":50}}],"paint":[)"
    + paint +
    R"(]}]}})";
}

[[nodiscard]] std::string static_text(std::string align_h = "left", std::string align_v = "top", double size = 8.0) {
  return
    R"({"kind":"text","box":{"x":1,"y":2,"w":40,"h":10},"font":{"family":"Arial","sizePx":)"
    + std::to_string(size) +
    R"(,"weight":400,"italic":false,"color":"#000000"},"align":{"h":")"
    + align_h +
    R"(","v":")"
    + align_v +
    R"("},"content":{"type":"static","lines":["ready"]}})";
}

[[nodiscard]] std::string path_with_stroke(std::string cap = "butt", std::string join = "miter", std::string dash = "[1,2]") {
  return
    R"({"kind":"path","d":"M 0 0 L 10 10","fill":{"type":"solid","color":"#ff0000","alpha":1},"stroke":{"paint":{"type":"solid","color":"#000000","alpha":1},"width":2,"cap":")"
    + cap +
    R"(","join":")"
    + join +
    R"(","miterLimit":4,"dash":)"
    + dash +
    R"(}})";
}

} // namespace

TEST_CASE("contract validation rejects unknown text alignment enums") {
  const auto bad_h = load_baked_contract(doc_with_paint(static_text("justify", "top")));
  REQUIRE_FALSE(bad_h);
  CHECK(bad_h.error().code == ContractErrorCode::ContractEnumError);

  const auto bad_v = load_baked_contract(doc_with_paint(static_text("left", "baseline")));
  REQUIRE_FALSE(bad_v);
  CHECK(bad_v.error().code == ContractErrorCode::ContractEnumError);
}

TEST_CASE("contract validation rejects non-positive font sizes") {
  const auto result = load_baked_contract(doc_with_paint(static_text("left", "top", 0.0)));

  REQUIRE_FALSE(result);
  CHECK(result.error().code == ContractErrorCode::ContractValueError);
}

TEST_CASE("contract validation rejects unknown image and svg options") {
  const auto bad_image = load_baked_contract(doc_with_paint(
    R"({"kind":"image","box":{"x":1,"y":2,"w":40,"h":10},"format":"jpg","data":"iVBORw==","aspect":"preserve","flipH":false,"flipV":false})"));
  REQUIRE_FALSE(bad_image);
  CHECK(bad_image.error().code == ContractErrorCode::ContractEnumError);

  const auto bad_svg = load_baked_contract(doc_with_paint(
    R"({"kind":"svg","box":{"x":1,"y":2,"w":40,"h":10},"source":"PHN2Zz48L3N2Zz4=","aspect":"stretch"})"));
  REQUIRE_FALSE(bad_svg);
  CHECK(bad_svg.error().code == ContractErrorCode::ContractEnumError);
}

TEST_CASE("contract validation rejects invalid stroke enums and dash values") {
  const auto bad_cap = load_baked_contract(doc_with_paint(path_with_stroke("triangle", "miter", "[1,2]")));
  REQUIRE_FALSE(bad_cap);
  CHECK(bad_cap.error().code == ContractErrorCode::ContractEnumError);

  const auto bad_join = load_baked_contract(doc_with_paint(path_with_stroke("butt", "curve", "[1,2]")));
  REQUIRE_FALSE(bad_join);
  CHECK(bad_join.error().code == ContractErrorCode::ContractEnumError);

  const auto bad_dash = load_baked_contract(doc_with_paint(path_with_stroke("butt", "miter", "[1,-2]")));
  REQUIRE_FALSE(bad_dash);
  CHECK(bad_dash.error().code == ContractErrorCode::ContractValueError);
}

TEST_CASE("contract validation preserves sorted gradient stops and alpha") {
  const auto result = load_baked_contract(doc_with_paint(
    R"({"kind":"path","d":"M 0 0 L 10 0 L 10 10 Z","fill":{"type":"linear","stops":[{"offset":1,"color":"#0000ff","alpha":0.25},{"offset":0,"color":"#ff0000","alpha":0.75}]},"stroke":{"paint":{"type":"radial","stops":[{"offset":0,"color":"#ffffff","alpha":1},{"offset":1,"color":"#000000","alpha":0.5}]},"width":2,"cap":"round","join":"bevel","miterLimit":4,"dash":null}})"));

  REQUIRE(result);
  const auto& node = result.value().pages[0].paint[0];
  REQUIRE(node.fill.has_value());
  CHECK(node.fill->type == PaintType::Linear);
  REQUIRE(node.fill->stops.size() == 2);
  CHECK(node.fill->stops[0].offset == 0.0);
  CHECK(node.fill->stops[0].color.r == 255);
  CHECK(node.fill->stops[0].color.a == 0.75);
  CHECK(node.fill->stops[1].offset == 1.0);
  CHECK(node.fill->stops[1].color.b == 255);
  CHECK(node.fill->stops[1].color.a == 0.25);
  REQUIRE(node.stroke.has_value());
  CHECK(node.stroke->paint.type == PaintType::Radial);
  CHECK(node.stroke->cap == "round");
  CHECK(node.stroke->join == "bevel");
  CHECK(node.stroke->dash.empty());
}

TEST_CASE("contract validation rejects invalid paint colors alpha and stops") {
  const auto bad_color = load_baked_contract(doc_with_paint(
    R"({"kind":"path","d":"M 0 0 L 10 10","fill":{"type":"solid","color":"#abcd","alpha":1},"stroke":null})"));
  REQUIRE_FALSE(bad_color);
  CHECK(bad_color.error().code == ContractErrorCode::ContractValueError);

  const auto bad_alpha = load_baked_contract(doc_with_paint(
    R"({"kind":"path","d":"M 0 0 L 10 10","fill":{"type":"solid","color":"#abcdef","alpha":1.2},"stroke":null})"));
  REQUIRE_FALSE(bad_alpha);
  CHECK(bad_alpha.error().code == ContractErrorCode::ContractValueError);

  const auto empty_stops = load_baked_contract(doc_with_paint(
    R"({"kind":"path","d":"M 0 0 L 10 10","fill":{"type":"linear","stops":[]},"stroke":null})"));
  REQUIRE_FALSE(empty_stops);
  CHECK(empty_stops.error().code == ContractErrorCode::ContractValueError);
}

TEST_CASE("contract validation requires barcode merge errors to be loud") {
  const auto result = load_baked_contract(doc_with_paint(
    R"({"kind":"barcode","box":{"x":1,"y":2,"w":40,"h":10},"symbology":"stub","params":{},"value":{"type":"merge","key":"CODE","sample":"123","maxLen":12,"errorOnUnencodable":false}})"));

  REQUIRE_FALSE(result);
  CHECK(result.error().code == ContractErrorCode::ContractValueError);
}

TEST_CASE("contract validation rejects non-positive page and tile dimensions") {
  const std::string bad_page =
    R"({"schema":{"major":1,"minor":0},"document":{"units":"px","pages":[{"id":"page-1","size":{"w":0,"h":50},"tiles":[{"origin":{"x":0,"y":0},"size":{"w":100,"h":50}}],"paint":[]}]}})";
  const auto page_result = load_baked_contract(bad_page);
  REQUIRE_FALSE(page_result);
  CHECK(page_result.error().code == ContractErrorCode::ContractValueError);

  const std::string bad_tile =
    R"({"schema":{"major":1,"minor":0},"document":{"units":"px","pages":[{"id":"page-1","size":{"w":100,"h":50},"tiles":[{"origin":{"x":0,"y":0},"size":{"w":0,"h":50}}],"paint":[]}]}})";
  const auto tile_result = load_baked_contract(bad_tile);
  REQUIRE_FALSE(tile_result);
  CHECK(tile_result.error().code == ContractErrorCode::ContractValueError);
}
