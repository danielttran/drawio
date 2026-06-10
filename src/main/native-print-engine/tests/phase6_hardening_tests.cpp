#include "print_engine/contract_loader.hpp"
#include "print_engine/renderer.hpp"

#include <catch2/catch_test_macros.hpp>

#include <string>
#include <vector>

using print_engine::ContractErrorCode;
using print_engine::load_baked_contract;
using print_engine::render_design_preview_trace;
using print_engine::RenderTarget;

TEST_CASE("Phase 6 adversarial JSON corpus refuses loudly without exceptions") {
  const std::vector<std::string> corpus = {
    "",
    "null",
    "[]",
    R"({"schema":{"major":1,"minor":0},"document":{"units":"px","pages":[]}})",
    R"({"schema":{"major":1,"minor":0},"document":{"units":"pt","pages":[{"id":"p","size":{"w":1,"h":1},"tiles":[{"origin":{"x":0,"y":0},"size":{"w":1,"h":1}}],"paint":[]}]}})",
    R"({"schema":{"major":1,"minor":0},"document":{"units":"px","pages":[{"id":"p","size":{"w":1,"h":1},"tiles":[],"paint":[]}]}})",
    R"({"schema":{"major":1,"minor":0},"document":{"units":"px","pages":[{"id":"p","size":{"w":1,"h":1},"tiles":[{"origin":{"x":0,"y":0},"size":{"w":1,"h":1}}],"paint":[{"kind":"path","d":"m 0 0"}]}]}})"
  };

  for (const auto& json : corpus) {
    const auto loaded = load_baked_contract(json);
    INFO("json: " << json);
    REQUIRE_FALSE(loaded);
  }
}

TEST_CASE("Phase 6 deterministic fuzz ingest produces typed errors or renderable contracts") {
  for (int index = 0; index < 64; ++index) {
    std::string fuzz = R"({"schema":{"major":1,"minor":0},"document":{"units":"px","pages":[)";
    fuzz += std::to_string(index % 2 == 0 ? 123 : index);
    fuzz += R"(]}})";

    const auto loaded = load_baked_contract(fuzz);
    if (!loaded) {
      const bool expected_error =
        loaded.error().code == ContractErrorCode::ContractShapeError ||
        loaded.error().code == ContractErrorCode::ContractValueError ||
        loaded.error().code == ContractErrorCode::ContractSyntaxError;
      CHECK(expected_error);
    } else {
      const auto rendered = render_design_preview_trace(loaded.value(), RenderTarget{96.0, 96.0});
      CHECK(rendered);
    }
  }
}

TEST_CASE("Phase 6 regression pair keeps prior static text and image behavior pinned") {
  const std::string json =
    R"({"schema":{"major":1,"minor":0},"document":{"units":"px","pages":[)"
    R"({"id":"page-1","size":{"w":120,"h":80},"tiles":[{"origin":{"x":0,"y":0},"size":{"w":120,"h":80}}],"paint":[)"
    R"({"kind":"text","box":{"x":10,"y":20,"w":80,"h":30},"font":{"family":"Arial","sizePx":10,"weight":400,"italic":false,"color":"#000000"},"align":{"h":"left","v":"top"},"content":{"type":"static","lines":["Pinned"]}},)"
    R"({"kind":"image","box":{"x":10,"y":12,"w":32,"h":16},"format":"png","data":"iVBORw==","aspect":"preserve","flipH":false,"flipV":false})"
    R"(]}]}})";

  const auto loaded = load_baked_contract(json);
  REQUIRE(loaded);
  const auto rendered = render_design_preview_trace(loaded.value(), RenderTarget{96.0, 96.0});
  REQUIRE(rendered);
  REQUIRE(rendered.value().commands.size() == 5);
  CHECK(rendered.value().commands[2].label == "Pinned");
  CHECK(rendered.value().commands[3].label == "preserve");
}
