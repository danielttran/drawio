// Regression: a larger selected paper must NOT scale the diagram up; it only
// adds whitespace (the contract page == the chosen paper, diagram stays 1:1).
// Content that escapes the page is clipped with a loud notice -- but escaping
// is judged against the whole page, never an individual tile (multi-tile
// pagination is normal, not "clipped").

#include "print_engine/contract_loader.hpp"
#include "print_engine/renderer.hpp"

#include <catch2/catch_test_macros.hpp>

using print_engine::DegradationNoticeType;
using print_engine::EmittedKind;
using print_engine::RenderTarget;
using print_engine::load_baked_contract;
using print_engine::nearly_equal;
using print_engine::render_to_trace;

namespace {

// One fixed-size image node on a single-tile page whose size == the paper.
[[nodiscard]] std::string page_fixture(int page_w, int page_h) {
  const std::string w = std::to_string(page_w);
  const std::string h = std::to_string(page_h);
  return
    R"({"schema":{"major":1,"minor":0},"document":{"units":"px","pages":[)"
    R"({"id":"page-1","size":{"w":)" + w + R"(,"h":)" + h + R"(},)"
    R"("tiles":[{"origin":{"x":0,"y":0},"size":{"w":)" + w + R"(,"h":)" + h + R"(}}],)"
    R"("paint":[{"kind":"image","box":{"x":10,"y":12,"w":32,"h":16},)"
    R"("format":"png","data":"iVBORw==","aspect":"preserve","flipH":false,"flipV":false})"
    R"(]}]}})";
}

[[nodiscard]] std::size_t clip_notices(const print_engine::RenderTrace& t) {
  std::size_t n = 0;
  for (const auto& notice : t.notices) {
    if (notice.type == DegradationNoticeType::HardwareMarginClip) ++n;
  }
  return n;
}

[[nodiscard]] const print_engine::EmittedCommand& first_image(
    const print_engine::RenderTrace& t) {
  for (const auto& c : t.commands) {
    if (c.kind == EmittedKind::Image) return c;
  }
  // Fixtures here always contain exactly one image node.
  return t.commands.at(0);
}

} // namespace

TEST_CASE("Larger paper does not scale the diagram (the reported bug)") {
  const auto letter = load_baked_contract(page_fixture(816, 1056));   // ~8.5x11
  const auto tabloid = load_baked_contract(page_fixture(2000, 1500)); // much bigger
  REQUIRE(letter);
  REQUIRE(tabloid);

  const auto small = render_to_trace(letter.value(), RenderTarget{96.0, 96.0});
  const auto big = render_to_trace(tabloid.value(), RenderTarget{96.0, 96.0});
  REQUIRE(small);
  REQUIRE(big);

  const auto& a = first_image(small.value());
  const auto& b = first_image(big.value());

  // Identical device geometry on both papers: the diagram is 1:1, the extra
  // paper is only whitespace. (Pre-fix: page == diagram bounds, so a larger
  // selected paper let the driver scale the single oversized page up.)
  CHECK(nearly_equal(a.device_box.x, b.device_box.x, 0.0001));
  CHECK(nearly_equal(a.device_box.y, b.device_box.y, 0.0001));
  CHECK(nearly_equal(a.device_box.w, b.device_box.w, 0.0001));
  CHECK(nearly_equal(a.device_box.h, b.device_box.h, 0.0001));
  CHECK(nearly_equal(a.device_box.w, 32.0, 0.0001));
  CHECK(nearly_equal(a.device_box.h, 16.0, 0.0001));
}

TEST_CASE("Diagram within the paper raises no clip notice") {
  const auto fits = load_baked_contract(page_fixture(816, 1056));
  REQUIRE(fits);
  const auto rendered = render_to_trace(fits.value(), RenderTarget{96.0, 96.0});
  REQUIRE(rendered);
  CHECK(clip_notices(rendered.value()) == 0);
}

TEST_CASE("Diagram larger than the paper is clipped with one loud notice") {
  // Node box {10,12,32,16} escapes a 20x20 page.
  const auto tiny = load_baked_contract(page_fixture(20, 20));
  REQUIRE(tiny);
  const auto rendered = render_to_trace(tiny.value(), RenderTarget{96.0, 96.0});
  REQUIRE(rendered);
  CHECK(clip_notices(rendered.value()) == 1);
}
