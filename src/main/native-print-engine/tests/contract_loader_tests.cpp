#include "print_engine/contract_loader.hpp"
#include "print_engine/fixture_builder.hpp"

#include <catch2/catch_test_macros.hpp>

using print_engine::ContractErrorCode;
using print_engine::load_baked_contract;
using print_engine::fixtures::FixtureBuilder;

TEST_CASE("valid phase-0 fixture loads") {
  const auto result = load_baked_contract(FixtureBuilder().empty_page().build());

  REQUIRE(result);
  CHECK(result.value().schema.major == 1);
  CHECK(result.value().schema.minor == 0);
  CHECK(result.value().units == "px");
  REQUIRE(result.value().pages.size() == 1);
  REQUIRE(result.value().pages[0].tiles.size() == 1);
  CHECK(result.value().pages[0].paint.empty());
}

TEST_CASE("unsupported major refuses loudly before document validation") {
  const auto json = FixtureBuilder().schema(2, 0).empty_page().build();
  const auto result = load_baked_contract(json);

  REQUIRE_FALSE(result);
  CHECK(result.error().code == ContractErrorCode::ContractVersionError);
  CHECK(result.error().path == "$.schema.major");
}

TEST_CASE("future additive minor loads with degradation notice") {
  const auto json = FixtureBuilder().schema(1, 9).empty_page().build();
  const auto result = load_baked_contract(json);

  REQUIRE(result);
  CHECK(result.value().has_degradation_notice);
}

TEST_CASE("merge text and barcode descriptors are phase-0 schema citizens") {
  const auto json = FixtureBuilder().merge_text_and_barcode_page().build();
  const auto result = load_baked_contract(json);

  REQUIRE(result);
  CHECK(result.value().has_merge_text);
  CHECK(result.value().has_barcode);
  REQUIRE(result.value().pages[0].paint.size() == 2);
}

TEST_CASE("static text carrying merge layout fields is refused") {
  const std::string json =
    R"({"schema":{"major":1,"minor":0},"document":{"units":"px","pages":[)"
    R"({"id":"page-1","size":{"w":100,"h":50},"tiles":[{"origin":{"x":0,"y":0},"size":{"w":100,"h":50}}],"paint":[)"
    R"({"kind":"text","box":{"x":1,"y":2,"w":40,"h":10},"font":{"family":"Arial","sizePx":8,"weight":400,"italic":false,"color":"#000000"},"align":{"h":"left","v":"top"},"content":{"type":"static","lines":["ready"],"wrap":"word"}})"
    R"(]}]}})";

  const auto result = load_baked_contract(json);

  REQUIRE_FALSE(result);
  CHECK(result.error().code == ContractErrorCode::ContractShapeError);
}

TEST_CASE("adversarial malformed JSON is a typed syntax refusal") {
  const auto result = load_baked_contract(R"({"schema":{"major":1,"minor":0})");

  REQUIRE_FALSE(result);
  CHECK(result.error().code == ContractErrorCode::ContractSyntaxError);
}

TEST_CASE("unknown paint node kind is a typed enum refusal") {
  const std::string json =
    R"({"schema":{"major":1,"minor":0},"document":{"units":"px","pages":[)"
    R"({"id":"page-1","size":{"w":100,"h":50},"tiles":[{"origin":{"x":0,"y":0},"size":{"w":100,"h":50}}],"paint":[{"kind":"layout"}]})"
    R"(]}})";

  const auto result = load_baked_contract(json);

  REQUIRE_FALSE(result);
  CHECK(result.error().code == ContractErrorCode::ContractEnumError);
}
