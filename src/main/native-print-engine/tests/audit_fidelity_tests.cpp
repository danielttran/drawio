// Audit regression tests (WYSIWYG end-to-end audit): each case pins a fixed
// silent-divergence or robustness defect found while auditing the engine
// against the C1 mandate ("faithful render or a loud notice -- never a
// silent divergence"). Browser-free (C2).

#include "print_engine/contract_loader.hpp"
#include "print_engine/path.hpp"
#include "print_engine/proto.hpp"
#include "print_engine/proto_adapter.hpp"
#include "print_engine/renderer.hpp"

#include <catch2/catch_test_macros.hpp>

#include <string>

using print_engine::ContractErrorCode;
using print_engine::DegradationNoticeType;
using print_engine::PaintKind;
using print_engine::RenderTarget;
using print_engine::load_baked_contract;
using print_engine::parse_absolute_svg_path;
using print_engine::render_to_trace;

namespace {

// One paint node on a 200x110 page, in the requested units.
[[nodiscard]] std::string one_node_contract(const std::string& units,
                                            double page_w, double page_h,
                                            const std::string& node) {
  return
    R"({"schema":{"major":1,"minor":1},"document":{"units":")" + units +
    R"(","pages":[{"id":"page-1","size":{"w":)" + std::to_string(page_w) +
    R"(,"h":)" + std::to_string(page_h) +
    R"(},"tiles":[{"origin":{"x":0,"y":0},"size":{"w":)" +
    std::to_string(page_w) + R"(,"h":)" + std::to_string(page_h) +
    R"(}}],"paint":[)" + node + R"(]}]}})";
}

[[nodiscard]] std::string svg_node(double x, double y, double w, double h) {
  return R"({"kind":"svg","box":{"x":)" + std::to_string(x) +
         R"(,"y":)" + std::to_string(y) + R"(,"w":)" + std::to_string(w) +
         R"(,"h":)" + std::to_string(h) +
         R"(},"format":"svg+xml;base64","aspect":"fill","source":"PHN2Zy8+"})";
}

[[nodiscard]] std::string path_node(const std::string& d) {
  return R"({"kind":"path","d":")" + d + R"(","fill":null,)"
         R"("stroke":{"paint":{"type":"solid","color":"#000000","alpha":1},)"
         R"("width":1,"cap":"butt","join":"miter","miterLimit":4,"dash":null}})";
}

[[nodiscard]] int margin_clip_count(const print_engine::RenderTrace& trace) {
  int n = 0;
  for (const auto& notice : trace.notices) {
    if (notice.type == DegradationNoticeType::HardwareMarginClip) ++n;
  }
  return n;
}

} // namespace

// ===========================================================================
// Page-escape tolerance must be unit-aware (was 4 *contract units*, i.e.
// 4 um on a production um bake = 0.16% of the exporter's px pad slop ->
// spurious HardwareMarginClip on virtually every real print).
// ===========================================================================

TEST_CASE("um contract with px-pad slop does NOT fire HardwareMarginClip") {
  // SVG_PAD = 2px per side -> box.x = -2px = -529.167um. The old 4-unit
  // tolerance read that as a page escape.
  const double pad_um = 2.0 * 25400.0 / 96.0;
  const auto loaded = load_baked_contract(one_node_contract(
      "um", 79375, 39687.5,
      svg_node(-pad_um, -pad_um, 31750 + 2 * pad_um, 21166 + 2 * pad_um)));
  REQUIRE(loaded);
  const auto rendered =
      render_to_trace(loaded.value(), RenderTarget{300.0, 25400.0});
  REQUIRE(rendered);
  CHECK(margin_clip_count(rendered.value()) == 0);
}

TEST_CASE("um contract with real overhang still fires HardwareMarginClip") {
  // 10px-equivalent overhang (2645um) is well past the 4px (1058um) slop.
  const double overhang_um = 10.0 * 25400.0 / 96.0;
  const auto loaded = load_baked_contract(one_node_contract(
      "um", 79375, 39687.5, svg_node(-overhang_um, 0, 31750, 21166)));
  REQUIRE(loaded);
  const auto rendered =
      render_to_trace(loaded.value(), RenderTarget{300.0, 25400.0});
  REQUIRE(rendered);
  CHECK(margin_clip_count(rendered.value()) == 1);
}

TEST_CASE("px contract tolerance is unchanged (4px slop ok, beyond fires)") {
  const auto pad_ok = load_baked_contract(one_node_contract(
      "px", 200, 110, svg_node(-2, -2, 104, 104)));
  REQUIRE(pad_ok);
  const auto r1 = render_to_trace(pad_ok.value(), RenderTarget{96.0, 96.0});
  REQUIRE(r1);
  CHECK(margin_clip_count(r1.value()) == 0);

  const auto over = load_baked_contract(one_node_contract(
      "px", 200, 110, svg_node(-6, 0, 104, 104)));
  REQUIRE(over);
  const auto r2 = render_to_trace(over.value(), RenderTarget{96.0, 96.0});
  REQUIRE(r2);
  CHECK(margin_clip_count(r2.value()) == 1);
}

// ===========================================================================
// Arc bounding boxes: `end +- r` UNDER-estimated large-arc sweeps by up to r
// (real ink silently past the page edge with no notice) and OVER-estimated
// short arcs by up to 2r (spurious notices for rounded corners / ellipse
// halves at page edges).
// ===========================================================================

TEST_CASE("large-arc sweep ink past the page top fires HardwareMarginClip") {
  // M 50 51 A 50 50 0 1 1 60 51: the large-arc sweep reaches y ~ -48.75,
  // far above the page. The old end+-r box ([1,101]) judged it inside.
  const auto loaded = load_baked_contract(one_node_contract(
      "px", 200, 110, path_node("M 50 51 A 50 50 0 1 1 60 51")));
  REQUIRE(loaded);
  const auto rendered =
      render_to_trace(loaded.value(), RenderTarget{96.0, 96.0});
  REQUIRE(rendered);
  CHECK(margin_clip_count(rendered.value()) == 1);
}

TEST_CASE("short arc near a page edge does NOT fire a spurious clip notice") {
  // A quarter-circle corner at the page's top-left: real ink stays inside
  // [10,60]x[10,60]; the old end+-r box reached x=-40 and fired.
  const auto loaded = load_baked_contract(one_node_contract(
      "px", 200, 110, path_node("M 10 60 A 50 50 0 0 1 60 10 L 60 60 Z")));
  REQUIRE(loaded);
  const auto rendered =
      render_to_trace(loaded.value(), RenderTarget{96.0, 96.0});
  REQUIRE(rendered);
  CHECK(margin_clip_count(rendered.value()) == 0);
}

TEST_CASE("arc path bounds cover the true sweep extent") {
  const auto parsed =
      parse_absolute_svg_path("M 50 51 A 50 50 0 1 1 60 51");
  REQUIRE(parsed);
  // The sweep's top is near y = -49 (center ~ (55,51), radius 50, plus
  // cubic hull slack); the old box stopped at y = 1.
  CHECK(parsed.value().bounds.y < 0.0);
  CHECK(parsed.value().bounds.y > -60.0);
}

// ===========================================================================
// Malformed contract numbers must surface as typed errors, never escape as
// exceptions (std::stod threw std::logic_error subclasses straight through
// the runtime_error catch -> std::terminate in the host loop).
// ===========================================================================

TEST_CASE("overflowing and malformed number literals are typed errors") {
  const auto overflow = load_baked_contract(R"({"x": 1e999})");
  REQUIRE_FALSE(overflow);
  CHECK(overflow.error().code == ContractErrorCode::ContractSyntaxError);

  const auto bare_minus = load_baked_contract(R"({"x": -})");
  REQUIRE_FALSE(bare_minus);
  CHECK(bare_minus.error().code == ContractErrorCode::ContractSyntaxError);
}

TEST_CASE("huge integer fields are rejected, not UB-cast") {
  const auto loaded = load_baked_contract(
    R"({"schema":{"major":1,"minor":10000000000},"document":)"
    R"({"units":"px","pages":[]}})");
  REQUIRE_FALSE(loaded);
}

// ===========================================================================
// Duplicate JSON keys: last-wins, matching JavaScript JSON.parse, so the
// producer-side validator and the engine cannot read different values from
// the same contract text.
// ===========================================================================

TEST_CASE("duplicate JSON keys resolve last-wins like JSON.parse") {
  const auto loaded = load_baked_contract(one_node_contract(
      "px", 200, 110,
      R"({"kind":"svg","box":{"x":0,"y":0,"w":50,"h":50},)"
      R"("box":{"x":10,"y":10,"w":60,"h":60},)"
      R"("format":"svg+xml;base64","aspect":"fill","source":"PHN2Zy8+"})"));
  REQUIRE(loaded);
  const auto& node = loaded.value().pages.at(0).paint.at(0);
  CHECK(node.box.x == 10.0);
  CHECK(node.box.w == 60.0);
}

// ===========================================================================
// SchemaMinorAhead must reach the operator on Print/RenderPreview, not only
// GetContractFields (additive minor features silently dropped otherwise).
// ===========================================================================

namespace {

// Minimal fake device surface for the adapter (mirrors proto_adapter_tests).
class AuditFakeServices : public print_engine::proto::EngineServices {
 public:
  std::vector<print_engine::proto::PrinterInfo> enumerate_printers() override {
    print_engine::proto::StockInfo s{"stock-4x6", "4x6 label", 101600, 152400,
                                     300.0, 300.0};
    print_engine::proto::PrinterInfo p{"printer-1", "Bench", "stock-4x6", {s}};
    return {p};
  }

  print_engine::Result<print_engine::proto::PreviewOutput,
                       print_engine::ContractError>
  render_preview(const print_engine::BakedDocument&,
                 const std::map<std::string, std::string>&, double) override {
    print_engine::proto::PreviewOutput out;
    out.png = {0x89, 'P', 'N', 'G'};
    out.width_px = 10;
    out.height_px = 10;
    return print_engine::Result<print_engine::proto::PreviewOutput,
                                print_engine::ContractError>::ok(
        std::move(out));
  }

  print_engine::Result<print_engine::proto::PrintOutput,
                       print_engine::ContractError>
  print(const print_engine::BakedDocument&,
        const std::map<std::string, std::string>&, const std::string&,
        const std::string&, int,
        print_engine::proto::PrintRenderOptions = {}) override {
    print_engine::proto::PrintOutput job;
    job.job_id = "job-1";
    job.job_log = print_engine::proto::Json::object();
    return print_engine::Result<print_engine::proto::PrintOutput,
                                print_engine::ContractError>::ok(
        std::move(job));
  }
};

}  // namespace

TEST_CASE("minor-ahead contract carries SchemaMinorAhead on render paths") {
  const std::string contract = one_node_contract(
      "px", 200, 110, svg_node(0, 0, 50, 50));
  std::string ahead = contract;
  const auto pos = ahead.find(R"("minor":1)");
  REQUIRE(pos != std::string::npos);
  ahead.replace(pos, 9, R"("minor":9)");

  using print_engine::proto::Json;
  AuditFakeServices svc;
  print_engine::proto::ProtoDispatcher dispatcher(svc);

  Json hello = Json::object();
  hello.set("op", Json::str("Hello"));
  Json proto_v = Json::object();
  proto_v.set("major", Json::number(print_engine::proto::kProtoMajor));
  proto_v.set("minor", Json::number(print_engine::proto::kProtoMinor));
  hello.set("proto", std::move(proto_v));
  (void)dispatcher.handle(hello);

  for (const char* op : {"RenderPreview", "Print"}) {
    Json req = Json::object();
    req.set("op", Json::str(op));
    Json cref = Json::object();
    cref.set("inline", Json::str(ahead));
    req.set("contractRef", std::move(cref));
    if (std::string(op) == "Print") {
      req.set("printerId", Json::str("printer-1"));
      req.set("stockId", Json::str("stock-4x6"));
    }
    const auto out = dispatcher.handle(req);
    const Json* notices = out.control.get("notices");
    REQUIRE(notices != nullptr);
    bool found = false;
    for (const Json& n : notices->items()) {
      const Json* kind = n.get("kind");
      if (kind != nullptr && kind->as_string() == "SchemaMinorAhead") {
        found = true;
      }
    }
    CHECK(found);
  }
}

// ===========================================================================
// Audit round 7: loader/validator parity + tile-coverage loudness.
// Each case below pins a gate asymmetry or silent-loss class found while
// auditing the engine against the JS validator and the host draw path.
// ===========================================================================

TEST_CASE("audit7: zero or negative box extents are refused at load") {
  // escapes_page only tests left/top+extent edges, and GDI+ silently MIRRORS
  // a negative-width image destination -- these boxes must never load.
  const auto zero_h = load_baked_contract(one_node_contract(
    "px", 200.0, 110.0, svg_node(10.0, 10.0, 50.0, 0.0)));
  REQUIRE_FALSE(zero_h);
  CHECK(zero_h.error().code == ContractErrorCode::ContractValueError);

  const auto neg_w = load_baked_contract(one_node_contract(
    "px", 200.0, 110.0, svg_node(500.0, 10.0, -100.0, 20.0)));
  REQUIRE_FALSE(neg_w);
  CHECK(neg_w.error().code == ContractErrorCode::ContractValueError);
}

TEST_CASE("audit7: empty static lines array is refused (validator parity)") {
  const std::string node =
    R"({"kind":"text","box":{"x":1,"y":2,"w":40,"h":10},)"
    R"("font":{"family":"Arial","sizePx":8,"weight":400,"italic":false,"color":"#000000"},)"
    R"("align":{"h":"left","v":"top"},"content":{"type":"static","lines":[]}})";
  const auto loaded = load_baked_contract(one_node_contract("px", 200.0, 110.0, node));
  REQUIRE_FALSE(loaded);
  CHECK(loaded.error().code == ContractErrorCode::ContractValueError);
}

TEST_CASE("audit7: svg source with mid-stream base64 padding is refused at load") {
  // is_base64_like permits "QQ==QQ==", which decode_base64 refuses at DRAW
  // time -- an engine-"valid" contract previously printed a crosshatch stub.
  const std::string node =
    R"({"kind":"svg","box":{"x":1,"y":2,"w":40,"h":10},)"
    R"("format":"svg+xml;base64","aspect":"preserve","source":"QQ==QQ=="})";
  const auto loaded = load_baked_contract(one_node_contract("px", 200.0, 110.0, node));
  REQUIRE_FALSE(loaded);
  CHECK(loaded.error().code == ContractErrorCode::ContractValueError);
}

TEST_CASE("audit7: negative schema minor is refused") {
  const auto loaded = load_baked_contract(
    R"({"schema":{"major":1,"minor":-1},"document":{"units":"px","pages":[)"
    R"({"id":"p","size":{"w":100,"h":50},"tiles":[{"origin":{"x":0,"y":0},"size":{"w":100,"h":50}}],"paint":[]}]}})");
  REQUIRE_FALSE(loaded);
  CHECK(loaded.error().code == ContractErrorCode::ContractVersionError);
}

TEST_CASE("audit7: duplicate page ids are refused (notices are keyed by page id)") {
  const auto loaded = load_baked_contract(
    R"({"schema":{"major":1,"minor":0},"document":{"units":"px","pages":[)"
    R"({"id":"p","size":{"w":100,"h":50},"tiles":[{"origin":{"x":0,"y":0},"size":{"w":100,"h":50}}],"paint":[]},)"
    R"({"id":"p","size":{"w":100,"h":50},"tiles":[{"origin":{"x":0,"y":0},"size":{"w":100,"h":50}}],"paint":[]})"
    R"(]}})");
  REQUIRE_FALSE(loaded);
  CHECK(loaded.error().code == ContractErrorCode::ContractValueError);

  const auto distinct = load_baked_contract(
    R"({"schema":{"major":1,"minor":0},"document":{"units":"px","pages":[)"
    R"({"id":"p1","size":{"w":100,"h":50},"tiles":[{"origin":{"x":0,"y":0},"size":{"w":100,"h":50}}],"paint":[]},)"
    R"({"id":"p2","size":{"w":100,"h":50},"tiles":[{"origin":{"x":0,"y":0},"size":{"w":100,"h":50}}],"paint":[]})"
    R"(]}})");
  REQUIRE(distinct);
}

TEST_CASE("audit7: huge-but-finite page/tile extents are refused at load") {
  // 1e300 survives every isfinite() guard; std::lround of the derived device
  // extent is unspecified downstream (observed: silent 1x1 white preview).
  const auto huge_page = load_baked_contract(
    R"({"schema":{"major":1,"minor":0},"document":{"units":"px","pages":[)"
    R"({"id":"p","size":{"w":1e300,"h":50},"tiles":[{"origin":{"x":0,"y":0},"size":{"w":1e300,"h":50}}],"paint":[]}]}})");
  REQUIRE_FALSE(huge_page);
  CHECK(huge_page.error().code == ContractErrorCode::ContractValueError);

  const auto huge_origin = load_baked_contract(
    R"({"schema":{"major":1,"minor":0},"document":{"units":"px","pages":[)"
    R"({"id":"p","size":{"w":100,"h":50},"tiles":[{"origin":{"x":1e30,"y":0},"size":{"w":100,"h":50}}],"paint":[]}]}})");
  REQUIRE_FALSE(huge_origin);

  // A real large-format banner-scale extent stays accepted (1e7 um = 10 m).
  const auto banner = load_baked_contract(
    R"({"schema":{"major":1,"minor":1},"document":{"units":"um","pages":[)"
    R"({"id":"p","size":{"w":1e7,"h":914400},"tiles":[{"origin":{"x":0,"y":0},"size":{"w":1e7,"h":914400}}],"paint":[]}]}})");
  REQUIRE(banner);
}

TEST_CASE("audit7: merge sample exceeding its own maxLen is refused at load") {
  // The sample renders in design previews; statically inconsistent nodes
  // previously surfaced only as a render-time MergeOverflowError.
  const std::string text_node =
    R"({"kind":"text","box":{"x":1,"y":2,"w":40,"h":10},)"
    R"("font":{"family":"Arial","sizePx":8,"weight":400,"italic":false,"color":"#000000"},)"
    R"("align":{"h":"left","v":"top"},)"
    R"("content":{"type":"merge","key":"NAME","sample":"TOO-LONG-SAMPLE","maxLen":4,"wrap":"none","overflow":"clip"}})";
  const auto text_loaded = load_baked_contract(one_node_contract("px", 200.0, 110.0, text_node));
  REQUIRE_FALSE(text_loaded);
  CHECK(text_loaded.error().code == ContractErrorCode::ContractValueError);

  const std::string barcode_node =
    R"({"kind":"barcode","box":{"x":1,"y":2,"w":40,"h":10},"symbology":"stub","params":{},)"
    R"("value":{"type":"merge","key":"CODE","sample":"123456","maxLen":4,"errorOnUnencodable":true}})";
  const auto barcode_loaded = load_baked_contract(one_node_contract("px", 200.0, 110.0, barcode_node));
  REQUIRE_FALSE(barcode_loaded);
  CHECK(barcode_loaded.error().code == ContractErrorCode::ContractValueError);

  // Multi-byte sample at exactly maxLen counts CODE POINTS, not bytes.
  const std::string unicode_node =
    R"({"kind":"text","box":{"x":1,"y":2,"w":40,"h":10},)"
    R"("font":{"family":"Arial","sizePx":8,"weight":400,"italic":false,"color":"#000000"},)"
    R"("align":{"h":"left","v":"top"},)"
    R"("content":{"type":"merge","key":"NAME","sample":"éééé","maxLen":4,"wrap":"none","overflow":"clip"}})";
  REQUIRE(load_baked_contract(one_node_contract("px", 200.0, 110.0, unicode_node)));
}

TEST_CASE("audit7: content outside the tile union fires a loud TileCoverageGap") {
  // One tile covers only the LEFT half of the page; the node sits fully
  // inside the page but in the uncovered right half -- the per-tile clip
  // would silently drop it.
  const std::string gap_contract =
    R"({"schema":{"major":1,"minor":0},"document":{"units":"px","pages":[)"
    R"({"id":"p","size":{"w":200,"h":100},)"
    R"("tiles":[{"origin":{"x":0,"y":0},"size":{"w":100,"h":100}}],)"
    R"("paint":[)" + svg_node(150.0, 10.0, 40.0, 40.0) + R"(]}]}})";
  const auto gap_loaded = load_baked_contract(gap_contract);
  REQUIRE(gap_loaded);
  const auto gap_rendered = render_to_trace(gap_loaded.value(), RenderTarget{96.0, 96.0});
  REQUIRE(gap_rendered);
  int gap_notices = 0;
  for (const auto& n : gap_rendered.value().notices) {
    if (n.type == DegradationNoticeType::TileCoverageGap) ++gap_notices;
  }
  CHECK(gap_notices == 1);

  // An exact two-tile cover of the same page must NOT fire the notice.
  const std::string covered_contract =
    R"({"schema":{"major":1,"minor":0},"document":{"units":"px","pages":[)"
    R"({"id":"p","size":{"w":200,"h":100},)"
    R"("tiles":[{"origin":{"x":0,"y":0},"size":{"w":100,"h":100}},)"
    R"({"origin":{"x":100,"y":0},"size":{"w":100,"h":100}}],)"
    R"("paint":[)" + svg_node(150.0, 10.0, 40.0, 40.0) + R"(]}]}})";
  const auto covered = load_baked_contract(covered_contract);
  REQUIRE(covered);
  const auto covered_rendered = render_to_trace(covered.value(), RenderTarget{96.0, 96.0});
  REQUIRE(covered_rendered);
  for (const auto& n : covered_rendered.value().notices) {
    CHECK(n.type != DegradationNoticeType::TileCoverageGap);
  }

  // A node hanging past the PAGE with full tile cover keeps firing ONLY the
  // page-escape notice (no double-report from the coverage check).
  const std::string overhang_contract =
    R"({"schema":{"major":1,"minor":0},"document":{"units":"px","pages":[)"
    R"({"id":"p","size":{"w":200,"h":100},)"
    R"("tiles":[{"origin":{"x":0,"y":0},"size":{"w":200,"h":100}}],)"
    R"("paint":[)" + svg_node(180.0, 10.0, 60.0, 40.0) + R"(]}]}})";
  const auto overhang = load_baked_contract(overhang_contract);
  REQUIRE(overhang);
  const auto overhang_rendered = render_to_trace(overhang.value(), RenderTarget{96.0, 96.0});
  REQUIRE(overhang_rendered);
  CHECK(margin_clip_count(overhang_rendered.value()) == 1);
  for (const auto& n : overhang_rendered.value().notices) {
    CHECK(n.type != DegradationNoticeType::TileCoverageGap);
  }
}
