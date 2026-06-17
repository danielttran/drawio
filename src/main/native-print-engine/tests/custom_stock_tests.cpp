// Cross-platform tests for the custom-stock stockId parser used by the host
// to set DMPAPER_USER + explicit physical paper dimensions (v2.0 §5). The
// parser itself is pure C++ -- it lives under host/ (outside the engine
// library's include/ + src/ INV-1 scan) so it can be tested on Linux CI.

#include "../host/custom_stock.hpp"

#include <catch2/catch_test_macros.hpp>

using print_engine::host::CustomStock;
using print_engine::host::parse_custom_stock_id;

TEST_CASE("custom-stock parser accepts well-formed ids", "[host][custom_stock]") {
  auto r = parse_custom_stock_id("custom:101600x152400");
  REQUIRE(r.has_value());
  CHECK(r->width_microns == 101600);  // 4 in
  CHECK(r->height_microns == 152400); // 6 in
}

TEST_CASE("custom-stock parser refuses everything that is not the exact shape",
          "[host][custom_stock]") {
  // missing prefix
  CHECK_FALSE(parse_custom_stock_id("101600x152400").has_value());
  // wrong prefix
  CHECK_FALSE(parse_custom_stock_id("Custom:101600x152400").has_value());
  // missing separator
  CHECK_FALSE(parse_custom_stock_id("custom:101600").has_value());
  // wrong separator (uppercase X is intentionally refused so the wire
  // encoding cannot drift host-to-host)
  CHECK_FALSE(parse_custom_stock_id("custom:101600X152400").has_value());
  // negative / sign characters
  CHECK_FALSE(parse_custom_stock_id("custom:-1x10").has_value());
  CHECK_FALSE(parse_custom_stock_id("custom:1x-10").has_value());
  CHECK_FALSE(parse_custom_stock_id("custom:+1x10").has_value());
  // non-digits
  CHECK_FALSE(parse_custom_stock_id("custom:1.5x10").has_value());
  CHECK_FALSE(parse_custom_stock_id("custom:1ex10").has_value());
  CHECK_FALSE(parse_custom_stock_id("custom:abcxdef").has_value());
  // zero dim
  CHECK_FALSE(parse_custom_stock_id("custom:0x10").has_value());
  CHECK_FALSE(parse_custom_stock_id("custom:10x0").has_value());
  // empty dims
  CHECK_FALSE(parse_custom_stock_id("custom:x10").has_value());
  CHECK_FALSE(parse_custom_stock_id("custom:10x").has_value());
  // empty input
  CHECK_FALSE(parse_custom_stock_id("").has_value());
  // trailing garbage
  CHECK_FALSE(parse_custom_stock_id("custom:10x20-mm").has_value());
}

TEST_CASE("custom-stock parser refuses dimensions that would overflow DEVMODE",
          "[host][custom_stock]") {
  // DEVMODE.dmPaperWidth/Length is a signed SHORT in tenths of mm; max valid
  // value is SHRT_MAX (32767) tenths-of-mm == 3,276,700 microns (~3.27 m).
  // Anything larger must refuse — silently truncating to a smaller paper
  // would print on the wrong stock with no notice.
  CHECK_FALSE(parse_custom_stock_id("custom:3276701x100").has_value());
  CHECK_FALSE(parse_custom_stock_id("custom:100x3276701").has_value());
  // The boundary value itself is accepted (max physical paper).
  auto r = parse_custom_stock_id("custom:3276700x3276700");
  REQUIRE(r.has_value());
  CHECK(r->width_microns == 3276700);
  CHECK(r->height_microns == 3276700);
  // A typical label stock (4x6 in == 101.6 x 152.4 mm == 101600 x 152400
  // microns) round-trips exactly.
  auto label = parse_custom_stock_id("custom:101600x152400");
  REQUIRE(label.has_value());
  CHECK(label->width_microns == 101600);
}

TEST_CASE("microns_to_tenth_mm_rounded rounds to nearest, never truncates",
          "[host][custom_stock]") {
  using print_engine::host::microns_to_tenth_mm_rounded;
  // Exact multiples of 100 microns are unchanged.
  CHECK(microns_to_tenth_mm_rounded(101600) == 1016);  // 4 in
  CHECK(microns_to_tenth_mm_rounded(152400) == 1524);  // 6 in
  // Sub-100-micron remainders ROUND to nearest tenth-mm rather than truncating
  // down (the silent-paper-shrink bug): 49 um rounds down, 50/99 um round up.
  CHECK(microns_to_tenth_mm_rounded(2159) == 22);    // 2159 -> 21.59 -> 22
  CHECK(microns_to_tenth_mm_rounded(2149) == 21);    // 2149 -> 21.49 -> 21
  CHECK(microns_to_tenth_mm_rounded(2150) == 22);    // exact .5 rounds up
  CHECK(microns_to_tenth_mm_rounded(99) == 1);       // would truncate to 0
  CHECK(microns_to_tenth_mm_rounded(50) == 1);
  CHECK(microns_to_tenth_mm_rounded(49) == 0);
  // The parser's max accepted dimension still fits a signed SHORT after
  // rounding (no overflow introduced by the +50): 3,276,700 -> 32,767.
  CHECK(microns_to_tenth_mm_rounded(3276700) == 32767);
}
