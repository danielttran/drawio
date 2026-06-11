#include "print_engine/contract_loader.hpp"
#include "print_engine/fixture_builder.hpp"

#include <catch2/catch_test_macros.hpp>

using print_engine::ContractErrorCode;
using print_engine::load_baked_contract;
using print_engine::units_per_inch;
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


TEST_CASE("rich text content is accepted as additive schema") {
  const std::string json =
    R"({"schema":{"major":1,"minor":0},"document":{"units":"px","pages":[)"
    R"({"id":"p1","size":{"w":100,"h":50},"tiles":[{"origin":{"x":0,"y":0},"size":{"w":100,"h":50}}],"paint":[)"
    R"({"kind":"text","box":{"x":1,"y":2,"w":40,"h":10},"font":{"family":"Arial","sizePx":8,"weight":400,"italic":false,"color":"#000000"},"align":{"h":"left","v":"top"},"content":{"type":"rich","paragraphs":[{"align":"left","runs":[{"text":"A","fontFamily":"Arial","sizePx":8,"weight":400,"italic":false,"underline":false,"strikethrough":false,"color":"#112233"}]},{"align":"center","runs":[]}]}})"
    R"(]}]}})";

  const auto result = load_baked_contract(json);
  REQUIRE(result);
  REQUIRE(result.value().pages[0].paint.size() == 1);
  CHECK(result.value().has_rich_text);
}

TEST_CASE("rich text invalid paragraph alignment is refused") {
  const std::string json =
    R"({"schema":{"major":1,"minor":0},"document":{"units":"px","pages":[)"
    R"({"id":"p1","size":{"w":100,"h":50},"tiles":[{"origin":{"x":0,"y":0},"size":{"w":100,"h":50}}],"paint":[)"
    R"({"kind":"text","box":{"x":1,"y":2,"w":40,"h":10},"font":{"family":"Arial","sizePx":8,"weight":400,"italic":false,"color":"#000000"},"align":{"h":"left","v":"top"},"content":{"type":"rich","paragraphs":[{"align":"justify","runs":[]}]}})"
    R"(]}]}})";

  const auto result = load_baked_contract(json);
  REQUIRE_FALSE(result);
  CHECK(result.error().code == ContractErrorCode::ContractEnumError);
}

// ---------------------------------------------------------------------------
// D4 physical units (schema 1.1): "um" is accepted; unknown units are refused
// ---------------------------------------------------------------------------

TEST_CASE("D4: um contract units are accepted (schema 1.1)") {
  const auto json = FixtureBuilder().schema(1, 1).units("um").empty_page().build();
  const auto result = load_baked_contract(json);

  REQUIRE(result);
  CHECK(result.value().units == "um");
  CHECK_FALSE(result.value().has_degradation_notice);
}

TEST_CASE("D4: um contract with minor=0 loads but the new engine treats it as supported") {
  const auto json = FixtureBuilder().schema(1, 0).units("um").empty_page().build();
  const auto result = load_baked_contract(json);

  REQUIRE(result);
  CHECK(result.value().units == "um");
}

TEST_CASE("D4: px contract with minor=1 loads without degradation") {
  const auto json = FixtureBuilder().schema(1, 1).units("px").empty_page().build();
  const auto result = load_baked_contract(json);

  REQUIRE(result);
  CHECK(result.value().units == "px");
  CHECK_FALSE(result.value().has_degradation_notice);
}

TEST_CASE("D4: unknown units are refused with enum error") {
  const auto json = FixtureBuilder().units("inch").empty_page().build();
  const auto result = load_baked_contract(json);

  REQUIRE_FALSE(result);
  CHECK(result.error().code == ContractErrorCode::ContractEnumError);
  CHECK(result.error().path == "$.document.units");
}

TEST_CASE("D4: mm units are refused with enum error") {
  const auto json = FixtureBuilder().units("mm").empty_page().build();
  const auto result = load_baked_contract(json);

  REQUIRE_FALSE(result);
  CHECK(result.error().code == ContractErrorCode::ContractEnumError);
}

TEST_CASE("D4: units_per_inch returns 96 for px") {
  CHECK(units_per_inch("px") == 96.0);
}

TEST_CASE("D4: units_per_inch returns 25400 for um") {
  CHECK(units_per_inch("um") == 25400.0);
}

TEST_CASE("deeply nested contract JSON is a typed syntax error, not a crash") {
  // 100k nested arrays: a recursive-descent parser without a depth guard
  // overflows the stack here and kills the engine process.
  const std::string deep(100000, '[');
  const auto result = load_baked_contract(deep);

  REQUIRE_FALSE(result);
  CHECK(result.error().code == ContractErrorCode::ContractSyntaxError);
  CHECK(result.error().message == "nesting depth exceeded");
}

TEST_CASE("nesting under the depth ceiling still parses") {
  // Sanity: the guard refuses pathological depth, not ordinary documents.
  std::string nested(100, '[');
  nested += "1";
  nested += std::string(100, ']');
  const auto result = load_baked_contract(nested);

  REQUIRE_FALSE(result);  // an array root is a shape error, not a syntax error
  CHECK(result.error().code == ContractErrorCode::ContractShapeError);
}

namespace {

std::string static_text_contract(const std::string& raw_line_json) {
  return
    R"({"schema":{"major":1,"minor":0},"document":{"units":"px","pages":[)"
    R"({"id":"page-1","size":{"w":100,"h":50},"tiles":[{"origin":{"x":0,"y":0},"size":{"w":100,"h":50}}],"paint":[)"
    R"({"kind":"text","box":{"x":1,"y":2,"w":40,"h":10},"font":{"family":"Arial","sizePx":8,"weight":400,"italic":false,"color":"#000000"},"align":{"h":"left","v":"top"},"content":{"type":"static","lines":[")"
    + raw_line_json +
    R"("]}})"
    R"(]}]}})";
}

} // namespace

TEST_CASE("\\uXXXX escapes decode to UTF-8 including surrogate pairs") {
  // JSON.stringify output: "A", U+00E9, U+4E2D and a U+1F600 surrogate pair.
  const auto result = load_baked_contract(
    static_text_contract(R"(\u0041\u00e9\u4e2d\ud83d\ude00)"));

  REQUIRE(result);
  REQUIRE(result.value().pages[0].paint.size() == 1);
  const auto& lines = result.value().pages[0].paint[0].static_lines;
  REQUIRE(lines.size() == 1);
  CHECK(lines[0] == "A\xC3\xA9\xE4\xB8\xAD\xF0\x9F\x98\x80");
}

TEST_CASE("\\uXXXX control-character escapes from JSON.stringify decode") {
  const auto result = load_baked_contract(static_text_contract(R"(a\u0007b)"));

  REQUIRE(result);
  CHECK(result.value().pages[0].paint[0].static_lines[0] == "a\x07"
                                                            "b");
}

TEST_CASE("lone surrogate escapes substitute U+FFFD instead of refusing") {
  // JSON.parse accepts lone surrogates; they have no valid UTF-8 form, so the
  // loader substitutes U+FFFD (EF BF BD) -- visible, never a silent refusal.
  const std::string replacement = "\xEF\xBF\xBD";

  const auto high = load_baked_contract(static_text_contract(R"(\ud800)"));
  REQUIRE(high);
  CHECK(high.value().pages[0].paint[0].static_lines[0] == replacement);

  const auto low = load_baked_contract(static_text_contract(R"(\udc00x)"));
  REQUIRE(low);
  CHECK(low.value().pages[0].paint[0].static_lines[0] == replacement + "x");

  // High surrogate followed by a non-surrogate escape: both survive.
  const auto split = load_baked_contract(static_text_contract(R"(\ud83d\u0041)"));
  REQUIRE(split);
  CHECK(split.value().pages[0].paint[0].static_lines[0] == replacement + "A");

  // High surrogate followed by a plain character.
  const auto plain = load_baked_contract(static_text_contract(R"(\ud83dZ)"));
  REQUIRE(plain);
  CHECK(plain.value().pages[0].paint[0].static_lines[0] == replacement + "Z");
}

TEST_CASE("truncated \\u escape is a typed syntax error") {
  const auto result = load_baked_contract(static_text_contract(R"(\u00)"));

  REQUIRE_FALSE(result);
  CHECK(result.error().code == ContractErrorCode::ContractSyntaxError);
}
