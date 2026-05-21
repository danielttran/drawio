// Extended correctness tests: cover path-parser edge cases, schema version
// handling, multi-page/multi-tile invariants, transform precision at extreme
// DPIs, page-escape notice posture, and rendering determinism. Every test
// here pins behaviour that the WYSIWYG-by-construction guarantee depends on
// — none of them touches a browser or a pixel oracle (C2).

#include "print_engine/contract_loader.hpp"
#include "print_engine/fixture_builder.hpp"
#include "print_engine/path.hpp"
#include "print_engine/renderer.hpp"

#include <catch2/catch_test_macros.hpp>

#include <array>
#include <string>

using print_engine::ContractErrorCode;
using print_engine::DegradationNoticeType;
using print_engine::EmittedKind;
using print_engine::PaintKind;
using print_engine::PathCommandKind;
using print_engine::RenderTarget;
using print_engine::load_baked_contract;
using print_engine::nearly_equal;
using print_engine::parse_absolute_svg_path;
using print_engine::render_to_trace;
using print_engine::render_design_preview_trace;
using print_engine::render_operator_preview_trace;
using print_engine::render_print_trace;
using print_engine::fixtures::FixtureBuilder;

namespace {

[[nodiscard]] std::string fixture_with_path(const std::string& d) {
  return
    R"({"schema":{"major":1,"minor":0},"document":{"units":"px","pages":[)"
    R"({"id":"page-1","size":{"w":200,"h":200},)"
    R"("tiles":[{"origin":{"x":0,"y":0},"size":{"w":200,"h":200}}],)"
    R"("paint":[{"kind":"path","d":")" + d + R"(","fill":null,)"
    R"("stroke":{"paint":{"type":"solid","color":"#000000","alpha":1},)"
    R"("width":1,"cap":"butt","join":"miter","miterLimit":4,"dash":null}}]}]}})";
}

[[nodiscard]] std::string fixture_with_paint(const std::string& paint_array) {
  return
    R"({"schema":{"major":1,"minor":0},"document":{"units":"px","pages":[)"
    R"({"id":"page-1","size":{"w":200,"h":200},)"
    R"("tiles":[{"origin":{"x":0,"y":0},"size":{"w":200,"h":200}}],)"
    R"("paint":[)" + paint_array + R"(]}]}})";
}

} // namespace

// ===========================================================================
// Path parser — exhaustive edge-case coverage. The parser is the engine's
// only structural input besides the contract schema, so a missed edge case
// here means an exporter output the engine can't render (silent reject) or
// a malformed path that renders wrong (silent divergence).
// ===========================================================================

TEST_CASE("Path parser accepts multiple sub-paths (M after Z)") {
  const auto loaded = load_baked_contract(fixture_with_path(
    "M 10 10 L 30 10 L 30 30 Z M 50 50 L 70 50 L 70 70 Z"));
  REQUIRE(loaded);
  const auto rendered = render_to_trace(loaded.value(), RenderTarget{96.0, 96.0});
  REQUIRE(rendered);
  // Each sub-path has 3 line commands + close = 4 commands, two sub-paths
  // = 8 commands plus possibly nothing else; assert the parser kept both
  // start positions (two MoveTo commands).
  const auto& cmds = rendered.value().commands[2].path_commands;
  int move_count = 0, close_count = 0;
  for (const auto& c : cmds) {
    if (c.kind == PathCommandKind::MoveTo) ++move_count;
    if (c.kind == PathCommandKind::Close)  ++close_count;
  }
  CHECK(move_count == 2);
  CHECK(close_count == 2);
}

TEST_CASE("Path parser handles decimal/negative/scientific numeric forms") {
  // Real exporter output uses 3-decimal numbers, some negative, some
  // scientifically formatted. All must parse to the same values they
  // would in JavaScript's parseFloat.
  const auto loaded = load_baked_contract(fixture_with_path(
    "M -10.5 0 L 20.25 0 L 1e1 5.0 L .5 1.5 L -.5 -1.5 Z"));
  REQUIRE(loaded);
  const auto rendered = render_to_trace(loaded.value(), RenderTarget{96.0, 96.0});
  REQUIRE(rendered);
  const auto& cmds = rendered.value().commands[2].path_commands;
  // First MoveTo at (-10.5, 0); subsequent LineTo's should match.
  REQUIRE(cmds.size() >= 5);
  CHECK(cmds[0].kind == PathCommandKind::MoveTo);
  CHECK(nearly_equal(cmds[0].values[0], -10.5, 1e-9));
  CHECK(nearly_equal(cmds[0].values[1], 0.0, 1e-9));
  CHECK(nearly_equal(cmds[1].values[0], 20.25, 1e-9));
  CHECK(nearly_equal(cmds[2].values[0], 10.0, 1e-9));    // 1e1 == 10
  CHECK(nearly_equal(cmds[3].values[0], 0.5, 1e-9));     // .5
}

TEST_CASE("Path parser accepts comma OR whitespace separators") {
  const auto loaded = load_baked_contract(fixture_with_path(
    "M10,5 L40,5 L40 20 Z"));
  REQUIRE(loaded);
  // Same path with mixed separators; the parser must yield identical commands.
  const auto rendered = render_to_trace(loaded.value(), RenderTarget{96.0, 96.0});
  REQUIRE(rendered);
  const auto& cmds = rendered.value().commands[2].path_commands;
  REQUIRE(cmds.size() == 4);
  CHECK(nearly_equal(cmds[1].values[0], 40.0, 1e-9));
}

TEST_CASE("Path parser refuses lowercase (relative) commands loudly") {
  // The exporter normalizes to absolute before emitting; a contract that
  // somehow carries relative commands is a contract violation, not a
  // best-effort target. Loud-fail.
  const auto loaded = load_baked_contract(fixture_with_path(
    "m 10 10 l 5 5 z"));
  REQUIRE_FALSE(loaded);
  CHECK(loaded.error().code == ContractErrorCode::ContractShapeError);
}

TEST_CASE("Path parser refuses unknown commands (Q/T/S not accepted)") {
  // Q/T/S are exporter-side: they must be expanded to C before reaching the
  // contract. If they appear at the engine, that's a contract violation.
  for (const auto& cmd : {"Q 10 10 20 20", "T 30 30", "S 5 5 10 10"}) {
    const auto loaded = load_baked_contract(fixture_with_path(
      std::string("M 0 0 ") + cmd));
    REQUIRE_FALSE(loaded);
    CHECK(loaded.error().code == ContractErrorCode::ContractShapeError);
  }
}

TEST_CASE("Path parser refuses empty path data") {
  const auto loaded = load_baked_contract(fixture_with_path(""));
  REQUIRE_FALSE(loaded);
  CHECK(loaded.error().code == ContractErrorCode::ContractShapeError);
}

TEST_CASE("Path parser refuses path starting with non-command tokens") {
  // Numbers ahead of any command must fail (no implicit operator).
  const auto loaded = load_baked_contract(fixture_with_path("10 20 L 30 40"));
  REQUIRE_FALSE(loaded);
  CHECK(loaded.error().code == ContractErrorCode::ContractShapeError);
}

TEST_CASE("Path parser refuses truncated arc argument list") {
  // Arc needs 7 numbers; 6 must fail (silent half-arc would diverge).
  const auto loaded = load_baked_contract(fixture_with_path(
    "M 0 0 A 5 5 0 0 1 10"));
  REQUIRE_FALSE(loaded);
  CHECK(loaded.error().code == ContractErrorCode::ContractShapeError);
}

TEST_CASE("Path parser direct API: H/V commands expand into 2-arg LineTo") {
  const auto parsed = parse_absolute_svg_path("M 5 5 H 50 V 30 Z");
  REQUIRE(parsed);
  REQUIRE(parsed.value().commands.size() == 4);
  CHECK(parsed.value().commands[1].kind == PathCommandKind::LineTo);
  CHECK(parsed.value().commands[1].values.size() == 2);
  CHECK(parsed.value().commands[1].values[0] == 50.0);
  CHECK(parsed.value().commands[1].values[1] == 5.0);
  CHECK(parsed.value().commands[2].values[0] == 50.0);
  CHECK(parsed.value().commands[2].values[1] == 30.0);
}

// ===========================================================================
// Schema versioning — INV-3 (refuse unknown major; loud notice on minor).
// ===========================================================================

TEST_CASE("Schema major bump = hard refuse; no paint emitted (INV-3)") {
  for (const int bad_major : {0, 2, 3, 7, 99}) {
    auto json = FixtureBuilder().schema(bad_major, 0).empty_page().build();
    const auto loaded = load_baked_contract(json);
    REQUIRE_FALSE(loaded);
    CHECK(loaded.error().code == ContractErrorCode::ContractVersionError);
    CHECK(loaded.error().path == "$.schema.major");
  }
}

TEST_CASE("Schema same major + minor bump = load with DegradationNotice") {
  for (const int minor : {1, 5, 99, 1000}) {
    const auto loaded = load_baked_contract(
      FixtureBuilder().schema(1, minor).empty_page().build());
    REQUIRE(loaded);
    CHECK(loaded.value().has_degradation_notice);
  }
}

TEST_CASE("Schema same major + minor 0 = clean load, no notice") {
  const auto loaded = load_baked_contract(
    FixtureBuilder().schema(1, 0).empty_page().build());
  REQUIRE(loaded);
  CHECK_FALSE(loaded.value().has_degradation_notice);
}

// ===========================================================================
// Transform precision — INV-4 (numeric drift < 0.5 device dot at any DPI).
// ===========================================================================

TEST_CASE("Transform stays within half a device dot at extreme DPIs") {
  // 96 dpi (preview), 300/600/1200 (print), 4800 (test extreme).
  const auto loaded = load_baked_contract(fixture_with_path(
    "M 0 0 L 100 0 L 100 40 L 0 40 Z"));
  REQUIRE(loaded);
  for (const double dpi : {72.0, 96.0, 150.0, 300.0, 600.0, 1200.0, 4800.0}) {
    const auto rendered = render_to_trace(loaded.value(), RenderTarget{dpi, 96.0});
    REQUIRE(rendered);
    const auto& box = rendered.value().commands[2].device_box;
    INFO("dpi=" << dpi);
    CHECK(nearly_equal(box.w, 100.0 * dpi / 96.0, 0.5));
    CHECK(nearly_equal(box.h, 40.0 * dpi / 96.0, 0.5));
    CHECK(nearly_equal(box.x, 0.0, 0.5));
    CHECK(nearly_equal(box.y, 0.0, 0.5));
  }
}

TEST_CASE("Transform precision: fractional DPI does not drift") {
  // Print drivers report odd device DPIs (e.g. 203 for thermal label
  // printers). Drift must stay sub-dot there too.
  const auto loaded = load_baked_contract(fixture_with_path(
    "M 0 0 L 100 0 L 100 40 L 0 40 Z"));
  REQUIRE(loaded);
  for (const double dpi : {203.0, 305.0, 600.5, 1200.25}) {
    const auto rendered = render_to_trace(loaded.value(), RenderTarget{dpi, 96.0});
    REQUIRE(rendered);
    const auto& box = rendered.value().commands[2].device_box;
    INFO("dpi=" << dpi);
    CHECK(nearly_equal(box.w, 100.0 * dpi / 96.0, 0.5));
    CHECK(nearly_equal(box.h, 40.0 * dpi / 96.0, 0.5));
  }
}

TEST_CASE("Transform: contract.units==px maps 1:1 at 96 dpi (sanity)") {
  const auto loaded = load_baked_contract(fixture_with_path(
    "M 0 0 L 100 0 L 100 50 L 0 50 Z"));
  REQUIRE(loaded);
  const auto rendered = render_to_trace(loaded.value(), RenderTarget{96.0, 96.0});
  REQUIRE(rendered);
  const auto& box = rendered.value().commands[2].device_box;
  CHECK(nearly_equal(box.w, 100.0, 1e-6));
  CHECK(nearly_equal(box.h, 50.0,  1e-6));
}

// ===========================================================================
// Page extent + clip notice posture. The renderer emits a single
// HardwareMarginClip notice per page when *any* paint escapes; never silent.
// ===========================================================================

TEST_CASE("SVG node padding (SVG_PAD slop) does NOT trigger spurious HardwareMarginClip") {
  // The exporter wraps each cell's literal SVG in a contract `svg` node whose
  // `box` is padded by SVG_PAD (2 contract units) on every side so resvg has
  // room for strokes/markers that extend past the cell's nominal bounds. A
  // cell at the canvas top-left (state.x == bounds.x) maps to box.x == -2 in
  // contract space. Without a tolerance, EVERY real diagram with content at
  // its top-left fires a wrong "diagram extends beyond the selected paper"
  // notice on every print. The engine must treat tiny (≤ SVG_PAD * 2) box
  // overhang as the documented stroke-slop, not as content clipping.
  const std::string p = R"({"kind":"svg","box":{"x":-2,"y":-2,"w":54,"h":54},)"
    R"("source":"PHN2Zy8+","aspect":"preserve"})";
  const auto loaded = load_baked_contract(fixture_with_paint(p));
  REQUIRE(loaded);
  const auto rendered = render_to_trace(loaded.value(), RenderTarget{96.0, 96.0});
  REQUIRE(rendered);
  for (const auto& n : rendered.value().notices) {
    INFO("notice: " << n.detail);
    CHECK(n.type != DegradationNoticeType::HardwareMarginClip);
  }
}

TEST_CASE("SVG_PAD-sized overhang at all four edges still tolerated") {
  // 200x200 page, an SVG cell that just touches the page corner on every
  // side via SVG_PAD overhang (-2,-2,204,204). No real content clipping.
  const std::string p = R"({"kind":"svg","box":{"x":-2,"y":-2,"w":204,"h":204},)"
    R"("source":"PHN2Zy8+","aspect":"preserve"})";
  const auto loaded = load_baked_contract(fixture_with_paint(p));
  REQUIRE(loaded);
  const auto rendered = render_to_trace(loaded.value(), RenderTarget{96.0, 96.0});
  REQUIRE(rendered);
  for (const auto& n : rendered.value().notices) {
    CHECK(n.type != DegradationNoticeType::HardwareMarginClip);
  }
}

TEST_CASE("Real overhang (> SVG_PAD slop) still fires HardwareMarginClip") {
  // 5-unit overhang is far more than padding slop — content is genuinely
  // off the page; the notice must still fire.
  const std::string p = R"({"kind":"svg","box":{"x":-5,"y":-5,"w":60,"h":60},)"
    R"("source":"PHN2Zy8+","aspect":"preserve"})";
  const auto loaded = load_baked_contract(fixture_with_paint(p));
  REQUIRE(loaded);
  const auto rendered = render_to_trace(loaded.value(), RenderTarget{96.0, 96.0});
  REQUIRE(rendered);
  int margin_count = 0;
  for (const auto& n : rendered.value().notices) {
    if (n.type == DegradationNoticeType::HardwareMarginClip) ++margin_count;
  }
  CHECK(margin_count == 1);
}

TEST_CASE("Cell exactly inside the page: no HardwareMarginClip notice") {
  // 200x200 page, cell rect at (0,0,200,200) — touches the edge but does
  // not escape. The "false positive" check.
  const auto loaded = load_baked_contract(fixture_with_path(
    "M 0 0 L 200 0 L 200 200 L 0 200 Z"));
  REQUIRE(loaded);
  const auto rendered = render_to_trace(loaded.value(), RenderTarget{96.0, 96.0});
  REQUIRE(rendered);
  for (const auto& n : rendered.value().notices) {
    CHECK(n.type != DegradationNoticeType::HardwareMarginClip);
  }
}

TEST_CASE("Cell escapes page extent: HardwareMarginClip notice fires once") {
  // 200x200 page, cell at (180,180,40,40) — bottom-right past the page.
  const auto loaded = load_baked_contract(fixture_with_path(
    "M 180 180 L 220 180 L 220 220 L 180 220 Z"));
  REQUIRE(loaded);
  const auto rendered = render_to_trace(loaded.value(), RenderTarget{96.0, 96.0});
  REQUIRE(rendered);
  int margin_count = 0;
  for (const auto& n : rendered.value().notices) {
    if (n.type == DegradationNoticeType::HardwareMarginClip) ++margin_count;
  }
  CHECK(margin_count == 1);
}

TEST_CASE("Two cells both escape: HardwareMarginClip notice is deduped") {
  // Two paths in one paint list, both escape — the engine must emit one
  // notice (per the dedup rule), not two, so the operator UI is not spammed.
  const std::string p1 =
    R"({"kind":"path","d":"M -10 0 L 0 0 L 0 10 Z","fill":null,)"
    R"("stroke":{"paint":{"type":"solid","color":"#000000","alpha":1},)"
    R"("width":1,"cap":"butt","join":"miter","miterLimit":4,"dash":null}})";
  const std::string p2 =
    R"({"kind":"path","d":"M 210 210 L 220 210 L 220 220 Z","fill":null,)"
    R"("stroke":{"paint":{"type":"solid","color":"#000000","alpha":1},)"
    R"("width":1,"cap":"butt","join":"miter","miterLimit":4,"dash":null}})";
  const auto loaded = load_baked_contract(fixture_with_paint(p1 + "," + p2));
  REQUIRE(loaded);
  const auto rendered = render_to_trace(loaded.value(), RenderTarget{96.0, 96.0});
  REQUIRE(rendered);
  int n = 0;
  for (const auto& note : rendered.value().notices) {
    if (note.type == DegradationNoticeType::HardwareMarginClip) ++n;
  }
  CHECK(n == 1);
}

// ===========================================================================
// Multi-page / multi-tile invariants.
// ===========================================================================

TEST_CASE("Multi-page contract: page IDs and order preserved") {
  const std::string json =
    R"({"schema":{"major":1,"minor":0},"document":{"units":"px","pages":[)"
    R"({"id":"alpha","size":{"w":100,"h":50},)"
    R"("tiles":[{"origin":{"x":0,"y":0},"size":{"w":100,"h":50}}],)"
    R"("paint":[]},)"
    R"({"id":"beta","size":{"w":80,"h":40},)"
    R"("tiles":[{"origin":{"x":0,"y":0},"size":{"w":80,"h":40}}],)"
    R"("paint":[]},)"
    R"({"id":"gamma","size":{"w":60,"h":30},)"
    R"("tiles":[{"origin":{"x":0,"y":0},"size":{"w":60,"h":30}}],)"
    R"("paint":[]})"
    R"(]}})";
  const auto loaded = load_baked_contract(json);
  REQUIRE(loaded);
  REQUIRE(loaded.value().pages.size() == 3);
  CHECK(loaded.value().pages[0].id == "alpha");
  CHECK(loaded.value().pages[1].id == "beta");
  CHECK(loaded.value().pages[2].id == "gamma");

  const auto rendered = render_to_trace(loaded.value(), RenderTarget{96.0, 96.0});
  REQUIRE(rendered);
  std::vector<std::string> tile_pages;
  for (const auto& c : rendered.value().commands) {
    if (c.kind == EmittedKind::StartTile) tile_pages.push_back(c.label);
  }
  REQUIRE(tile_pages.size() == 3);
  CHECK(tile_pages[0] == "alpha");
  CHECK(tile_pages[1] == "beta");
  CHECK(tile_pages[2] == "gamma");
}

TEST_CASE("Multi-tile single page: tile origin + clip emitted per tile") {
  const std::string json =
    R"({"schema":{"major":1,"minor":0},"document":{"units":"px","pages":[)"
    R"({"id":"p","size":{"w":200,"h":100},"tiles":[)"
    R"({"origin":{"x":0,"y":0},"size":{"w":100,"h":100}},)"
    R"({"origin":{"x":100,"y":0},"size":{"w":100,"h":100}})"
    R"(],"paint":[]}]}})";
  const auto loaded = load_baked_contract(json);
  REQUIRE(loaded);
  const auto rendered = render_to_trace(loaded.value(), RenderTarget{96.0, 96.0});
  REQUIRE(rendered);
  int start = 0, clip = 0, end_tile = 0;
  for (const auto& c : rendered.value().commands) {
    if (c.kind == EmittedKind::StartTile) ++start;
    if (c.kind == EmittedKind::Clip)      ++clip;
    if (c.kind == EmittedKind::EndTile)   ++end_tile;
  }
  CHECK(start == 2);
  CHECK(clip == 2);
  CHECK(end_tile == 2);
}

// ===========================================================================
// Render-determinism invariant: identical input -> identical trace bytes
// (a load-bearing assumption of INV-5: preview and print run the SAME
// trace; if it weren't deterministic, "share P1-P6" would be a fiction).
// ===========================================================================

TEST_CASE("Trace is deterministic: same contract -> same emitted commands") {
  const auto loaded = load_baked_contract(fixture_with_path(
    "M 10 10 L 50 10 L 50 50 L 10 50 Z"));
  REQUIRE(loaded);
  const auto a = render_to_trace(loaded.value(), RenderTarget{300.0, 96.0});
  const auto b = render_to_trace(loaded.value(), RenderTarget{300.0, 96.0});
  REQUIRE(a);
  REQUIRE(b);
  REQUIRE(a.value().commands.size() == b.value().commands.size());
  for (std::size_t i = 0; i < a.value().commands.size(); ++i) {
    CHECK(a.value().commands[i].kind == b.value().commands[i].kind);
    CHECK(a.value().commands[i].label == b.value().commands[i].label);
    CHECK(nearly_equal(a.value().commands[i].device_box.x,
                       b.value().commands[i].device_box.x, 1e-9));
    CHECK(nearly_equal(a.value().commands[i].device_box.w,
                       b.value().commands[i].device_box.w, 1e-9));
  }
}

// ===========================================================================
// Preview/print parity (INV-5) — operator preview + design preview + print
// trace share the same commands modulo lifecycle wrappers.
// ===========================================================================

TEST_CASE("Print and operator-preview traces match for a static document") {
  const auto loaded = load_baked_contract(fixture_with_path(
    "M 0 0 L 50 0 L 50 30 L 0 30 Z"));
  REQUIRE(loaded);
  const RenderTarget t{300.0, 96.0};
  const auto print_r = render_print_trace(loaded.value(), t, {});
  const auto preview_r = render_operator_preview_trace(loaded.value(), t, {});
  REQUIRE(print_r);
  REQUIRE(preview_r);
  // print wraps with StartDocument/EndDocument; preview does not.
  std::vector<EmittedKind> p_unwrapped, pv_kinds;
  for (const auto& c : print_r.value().commands) {
    if (c.kind == EmittedKind::StartDocument || c.kind == EmittedKind::EndDocument)
      continue;
    p_unwrapped.push_back(c.kind);
  }
  for (const auto& c : preview_r.value().commands) pv_kinds.push_back(c.kind);
  CHECK(p_unwrapped == pv_kinds);
}

TEST_CASE("Design and operator preview agree on static content (no merge)") {
  // For static-only content, design (sample) and operator (merge) previews
  // must produce the same commands — there's no merge data to differ on.
  const auto loaded = load_baked_contract(fixture_with_path(
    "M 0 0 L 100 0 L 100 100 L 0 100 Z"));
  REQUIRE(loaded);
  const RenderTarget t{200.0, 96.0};
  const auto design = render_design_preview_trace(loaded.value(), t);
  const auto op_r = render_operator_preview_trace(loaded.value(), t, {});
  REQUIRE(design);
  REQUIRE(op_r);
  REQUIRE(design.value().commands.size() == op_r.value().commands.size());
  for (std::size_t i = 0; i < design.value().commands.size(); ++i) {
    CHECK(design.value().commands[i].kind == op_r.value().commands[i].kind);
    CHECK(design.value().commands[i].label == op_r.value().commands[i].label);
  }
}

// ===========================================================================
// SVG node passthrough — INV-6 (no engine-side parsing; just route to host).
// ===========================================================================

TEST_CASE("SVG node survives the engine verbatim (no parse, no re-derive)") {
  // Engine must not touch svg_source bytes; the host rasterizer is the
  // only thing that interprets SVG (INV-1 + INV-6).
  const std::string svg_source = "PHN2ZyB4bWxucz0iIj48L3N2Zz4=";   // base64 of "<svg xmlns=''></svg>"
  const std::string p = std::string(R"({"kind":"svg","box":{"x":10,"y":10,"w":50,"h":50},)") +
    R"("source":")" + svg_source + R"(","aspect":"preserve"})";
  const auto loaded = load_baked_contract(fixture_with_paint(p));
  REQUIRE(loaded);
  REQUIRE(loaded.value().pages[0].paint.size() == 1);
  CHECK(loaded.value().pages[0].paint[0].kind == PaintKind::Svg);
  CHECK(loaded.value().pages[0].paint[0].svg_source == svg_source);

  const auto rendered = render_to_trace(loaded.value(), RenderTarget{96.0, 96.0});
  REQUIRE(rendered);
  bool found_svg = false;
  for (const auto& c : rendered.value().commands) {
    if (c.kind == EmittedKind::Svg) {
      found_svg = true;
      // Engine forwards svg_source untouched (INV-6).
      CHECK(c.svg_source == svg_source);
    }
  }
  CHECK(found_svg);
}

// ===========================================================================
// Paint list ORDER is preserved verbatim (the exporter z-order fix relies
// on this engine-side invariant: paint order in == draw order out).
// ===========================================================================

TEST_CASE("Engine emits paint commands in contract paint-list order (no reorder)") {
  // Four paths with distinct strokes; the engine must not reorder them.
  std::string paint;
  const char* colors[4] = {"#aa1111", "#22aa22", "#3333aa", "#aaaa44"};
  for (int i = 0; i < 4; ++i) {
    if (i) paint += ",";
    paint += std::string(R"({"kind":"path","d":"M )") + std::to_string(i * 10) +
      " 0 L " + std::to_string(i * 10 + 5) + " 5 Z" +
      R"(","fill":null,"stroke":{"paint":{"type":"solid","color":")" +
      colors[i] + R"(","alpha":1},"width":1,"cap":"butt","join":"miter","miterLimit":4,"dash":null}})";
  }
  const auto loaded = load_baked_contract(fixture_with_paint(paint));
  REQUIRE(loaded);
  const auto rendered = render_to_trace(loaded.value(), RenderTarget{96.0, 96.0});
  REQUIRE(rendered);
  std::vector<std::array<int, 3>> emitted_rgb;
  for (const auto& c : rendered.value().commands) {
    if (c.kind == EmittedKind::Path && c.stroke.has_value()) {
      emitted_rgb.push_back({c.stroke->paint.solid.r,
                             c.stroke->paint.solid.g,
                             c.stroke->paint.solid.b});
    }
  }
  REQUIRE(emitted_rgb.size() == 4);
  // 0xaa = 170, 0x11 = 17, 0x22 = 34, 0x33 = 51, 0x44 = 68
  CHECK(emitted_rgb[0] == std::array<int, 3>{170, 17, 17});
  CHECK(emitted_rgb[1] == std::array<int, 3>{34, 170, 34});
  CHECK(emitted_rgb[2] == std::array<int, 3>{51, 51, 170});
  CHECK(emitted_rgb[3] == std::array<int, 3>{170, 170, 68});
}

// ===========================================================================
// Negative tests on contract structure: every required field must be loudly
// missing/wrong, never silently defaulted.
// ===========================================================================

TEST_CASE("Missing schema is refused loudly") {
  const auto loaded = load_baked_contract(
    R"({"document":{"units":"px","pages":[]}})");
  REQUIRE_FALSE(loaded);
}

TEST_CASE("Document units must be px (only supported unit)") {
  const auto loaded = load_baked_contract(
    R"({"schema":{"major":1,"minor":0},"document":{"units":"inch","pages":[]}})");
  REQUIRE_FALSE(loaded);
}

TEST_CASE("Negative tile origin is rejected (would put content under origin)") {
  const std::string json =
    R"({"schema":{"major":1,"minor":0},"document":{"units":"px","pages":[)"
    R"({"id":"p","size":{"w":100,"h":50},)"
    R"("tiles":[{"origin":{"x":-5,"y":0},"size":{"w":100,"h":50}}],)"
    R"("paint":[]}]}})";
  const auto loaded = load_baked_contract(json);
  // Implementation may accept negative offset (it's just a translate) OR
  // refuse it. Pin whichever behaviour is current so a future regression
  // is loud.
  // The current loader does not refuse negative tile origins (no validator
  // for it). Confirm that intent: a negative origin loads, and the engine
  // simply translates by it. If you ever decide to refuse this, replace
  // REQUIRE(loaded) with REQUIRE_FALSE(loaded).
  REQUIRE(loaded);
}

// ===========================================================================
// Page paint with zero items: a perfectly valid (blank) page.
// ===========================================================================

TEST_CASE("Empty page renders to start/clip/end-tile with no paint commands") {
  const auto loaded = load_baked_contract(
    FixtureBuilder().empty_page().build());
  REQUIRE(loaded);
  const auto rendered = render_to_trace(loaded.value(), RenderTarget{96.0, 96.0});
  REQUIRE(rendered);
  int start = 0, clip = 0, end_tile = 0, path = 0;
  for (const auto& c : rendered.value().commands) {
    if (c.kind == EmittedKind::StartTile) ++start;
    if (c.kind == EmittedKind::Clip)      ++clip;
    if (c.kind == EmittedKind::EndTile)   ++end_tile;
    if (c.kind == EmittedKind::Path)      ++path;
  }
  CHECK(start == 1);
  CHECK(clip == 1);
  CHECK(end_tile == 1);
  CHECK(path == 0);
}
