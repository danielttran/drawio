// WYSIWYG-parity net (engine side).
//
// The exporter test suite proves "every drawio object is faithful OR loudly
// degraded, and schema-valid". This suite closes the loop: every contract
// SHAPE/ATTRIBUTE the exporter can emit must load and render through the real
// engine WITHOUT error and with geometry preserved — so a complex file can
// never render in the app yet be silently rejected or geometrically diverged
// at print time. It also asserts the engine still LOUDLY rejects a
// non-conformant contract (the safety net is real, not vacuous).

#include "print_engine/contract_loader.hpp"
#include "print_engine/renderer.hpp"

#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>

#include <string>

using namespace print_engine;

namespace {

// Wrap one paint-node JSON into a full v1.1 contract (single page/tile).
std::string contract_with(const std::string& paint_nodes,
                          double w = 200.0, double h = 120.0) {
  return
    R"({"schema":{"major":1,"minor":0},"document":{"units":"px","pages":[)"
    R"({"id":"page-1","size":{"w":)" + std::to_string(w) +
    R"(,"h":)" + std::to_string(h) +
    R"(},"tiles":[{"origin":{"x":0,"y":0},"size":{"w":)" + std::to_string(w) +
    R"(,"h":)" + std::to_string(h) + R"(}}],"paint":[)" + paint_nodes +
    R"(]}]}})";
}

const char* kSolidFill = R"("fill":{"type":"solid","color":"#204060","alpha":1})";
const char* kStroke =
    R"("stroke":{"paint":{"type":"solid","color":"#101010","alpha":1},)"
    R"("width":2,"cap":"butt","join":"miter","miterLimit":10,"dash":null})";

std::string path_node(const std::string& d) {
  return R"({"kind":"path","d":")" + d + R"(",)" + kSolidFill + "," + kStroke + "}";
}

[[nodiscard]] std::size_t count_kind(const RenderTrace& t, EmittedKind k) {
  std::size_t n = 0;
  for (const auto& c : t.commands) if (c.kind == k) ++n;
  return n;
}

}  // namespace

// Exactly the path strings the exporter's shapePath()/edgePath() produce.
TEST_CASE("Every exporter vertex shape loads and renders through the engine",
          "[wysiwyg]") {
  const std::string shapes[] = {
    "M 0 0 L 80 0 L 80 40 L 0 40 Z",                                  // rect
    "M 4.8 0 L 75.2 0 A 4.8 4.8 0 0 1 80 4.8 L 80 35.2 "
    "A 4.8 4.8 0 0 1 75.2 40 L 4.8 40 A 4.8 4.8 0 0 1 0 35.2 "
    "L 0 4.8 A 4.8 4.8 0 0 1 4.8 0 Z",                                 // rounded
    "M 0 20 A 40 20 0 1 0 80 20 A 40 20 0 1 0 0 20 Z",                 // ellipse
    "M 40 0 L 80 20 L 40 40 L 0 20 Z",                                 // rhombus
    "M 40 0 L 80 40 L 0 40 Z",                                         // tri N
    "M 0 0 L 80 0 L 40 40 Z",                                          // tri S
    "M 0 0 L 80 20 L 0 40 Z",                                          // tri E
    "M 80 0 L 0 20 L 80 40 Z",                                         // tri W
    "M 0 7.2 C 0 4.8 80 4.8 80 7.2 L 80 32.8 C 80 35.2 0 35.2 0 32.8 "
    "Z M 0 7.2 C 0 9.6 80 9.6 80 7.2",                                 // cylinder
    "M 20 30 C -4 28.8 0 14 20 15.2 C 22.4 3.2 49.6 3.2 52 14.4 "
    "C 76 11.2 85.6 27.2 62.4 30 C 52.8 38 30.4 38 20 30 Z"            // cloud
  };
  for (const auto& d : shapes) {
    const auto loaded = load_baked_contract(contract_with(path_node(d)));
    REQUIRE(loaded);  // engine MUST accept every exporter shape
    for (const double dpi : {96.0, 300.0, 600.0}) {
      const auto r = render_to_trace(loaded.value(), RenderTarget{dpi, 96.0});
      REQUIRE(r);
      REQUIRE(count_kind(r.value(), EmittedKind::Path) == 1);
      const auto& cmd = r.value().commands[2];
      CHECK(cmd.kind == EmittedKind::Path);
      CHECK_FALSE(cmd.path_commands.empty());
      CHECK(cmd.fill.has_value());
      CHECK(cmd.stroke.has_value());
      // Geometry preserved: device box is the contract box under the scale.
      CHECK(nearly_equal(cmd.device_box.w,
                         cmd.contract_box.w * dpi / 96.0, 0.5));
    }
  }
}

TEST_CASE("Exporter fill/stroke attribute variants survive the engine",
          "[wysiwyg]") {
  // gradient fill + dashed stroke + opacity (exporter emits these verbatim).
  const std::string node =
    R"({"kind":"path","d":"M 0 0 L 80 0 L 80 40 L 0 40 Z",)"
    R"("fill":{"type":"linear","stops":[)"
    R"({"offset":0,"color":"#ff0000","alpha":0.5},)"
    R"({"offset":1,"color":"#0000ff","alpha":0.5}]},)"
    R"("stroke":{"paint":{"type":"solid","color":"#00ff00","alpha":0.25},)"
    R"("width":4,"cap":"round","join":"bevel","miterLimit":10,"dash":[5,2]}})";
  const auto loaded = load_baked_contract(contract_with(node));
  REQUIRE(loaded);
  const auto r = render_to_trace(loaded.value(), RenderTarget{300.0, 96.0});
  REQUIRE(r);
  const auto& cmd = r.value().commands[2];
  REQUIRE(cmd.fill.has_value());
  CHECK(cmd.fill->type == PaintType::Linear);
  CHECK(cmd.fill->stops.size() == 2);
  REQUIRE(cmd.stroke.has_value());
  CHECK(cmd.stroke->dash.size() == 2);
  CHECK(cmd.stroke->cap == "round");
  CHECK(cmd.stroke->join == "bevel");
}

TEST_CASE("Exporter text nodes pass through with policy + box preserved",
          "[wysiwyg]") {
  const char* hs[] = {"left", "center", "right"};
  const char* vs[] = {"top", "middle", "bottom"};
  for (const char* h : hs) {
    for (const char* v : vs) {
      const std::string node =
        std::string(R"({"kind":"text","box":{"x":10,"y":12,"w":120,"h":36},)") +
        R"("font":{"family":"Times New Roman","sizePx":18,"weight":700,)"
        R"("italic":true,"color":"#10306a"},"align":{"h":")" + h +
        R"(","v":")" + v + R"("},"content":{"type":"static",)"
        R"("lines":["First line","Second line"]}})";
      const auto loaded = load_baked_contract(contract_with(node));
      REQUIRE(loaded);
      const auto r = render_to_trace(loaded.value(), RenderTarget{600.0, 96.0});
      REQUIRE(r);
      REQUIRE(count_kind(r.value(), EmittedKind::Text) == 1);
      const auto& t = r.value().commands[2];
      CHECK(t.label == "First line\nSecond line");  // raw, engine does NOT wrap
      CHECK(t.font_family == "Times New Roman");
      CHECK(t.font_weight == 700);
      CHECK(t.font_italic);
      CHECK(t.align_h == h);
      CHECK(t.align_v == v);
      // Pass-through: contract_box == node box (no engine-side layout).
      CHECK(nearly_equal(t.contract_box.x, 10.0, 1e-6));
      CHECK(nearly_equal(t.contract_box.w, 120.0, 1e-6));
      CHECK(nearly_equal(t.device_box.w, 120.0 * 600.0 / 96.0, 0.5));
    }
  }
}

TEST_CASE("Text style flags (bold/italic/underline/strikethrough) round-trip",
          "[wysiwyg]") {
  auto text_node = [](const std::string& font_extra) {
    return std::string(
      R"({"kind":"text","box":{"x":0,"y":0,"w":80,"h":20},"font":{"family":)"
      R"("Arial","sizePx":12,"weight":700,"italic":true)") + font_extra +
      R"(,"color":"#000000"},"align":{"h":"left","v":"top"},)"
      R"("content":{"type":"static","lines":["Styled"]}})";
  };
  // Underline + strikethrough explicitly set (the reported italic+underline
  // case generalized): all four flags must survive to the EmittedCommand.
  {
    const auto loaded = load_baked_contract(contract_with(
        text_node(R"(,"underline":true,"strikethrough":true)")));
    REQUIRE(loaded);
    const auto r = render_to_trace(loaded.value(), RenderTarget{96.0, 96.0});
    REQUIRE(r);
    const auto& t = r.value().commands[2];
    CHECK(t.font_weight == 700);
    CHECK(t.font_italic);
    CHECK(t.font_underline);
    CHECK(t.font_strikethrough);
  }
  // Backward compatible: a contract WITHOUT the new keys still loads and the
  // flags default to false (no spurious underline/strike on legacy contracts).
  {
    const auto loaded = load_baked_contract(contract_with(text_node("")));
    REQUIRE(loaded);
    const auto r = render_to_trace(loaded.value(), RenderTarget{96.0, 96.0});
    REQUIRE(r);
    const auto& t = r.value().commands[2];
    CHECK(t.font_italic);
    CHECK_FALSE(t.font_underline);
    CHECK_FALSE(t.font_strikethrough);
  }
  // Present-but-wrong-type is loud-rejected (not silently ignored).
  CHECK_FALSE(load_baked_contract(contract_with(
      text_node(R"(,"underline":"yes")"))));
}

TEST_CASE("Exporter merge text overflow policy is forwarded, not pre-judged",
          "[wysiwyg]") {
  for (const char* policy : {"reject", "clip", "shrink"}) {
    const std::string shrink =
        std::string(policy) == "shrink" ? R"(,"shrinkFloorPx":6)" : "";
    const std::string node =
      std::string(R"({"kind":"text","box":{"x":0,"y":0,"w":40,"h":14},)") +
      R"("font":{"family":"Arial","sizePx":12,"weight":400,"italic":false,)"
      R"("color":"#000000"},"align":{"h":"left","v":"top"},)"
      R"("content":{"type":"merge","key":"K","sample":"S","maxLen":64,)"
      R"("wrap":"word","overflow":")" + policy + R"(")" + shrink + R"(}})";
    const auto loaded = load_baked_contract(contract_with(node));
    REQUIRE(loaded);
    const auto r = render_to_trace(
        loaded.value(), RenderTarget{96.0, 96.0},
        {{"K", "a value that is far too wide to ever fit the tiny box"}},
        false);
    REQUIRE(r);  // engine forwards; device decides fit (no engine error here)
    const auto& t = r.value().commands[2];
    CHECK(t.overflow == policy);
    CHECK(t.label == "a value that is far too wide to ever fit the tiny box");
  }
}

TEST_CASE("Exporter PNG image node loads and renders through the engine",
          "[wysiwyg]") {
  // Canonical 1x1 transparent PNG (matches the exporter test's PNG_1x1).
  const std::string png_b64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGNgAAEA"
      "AAUAAQ0KLbQAAAAASUVORK5CYII=";
  const std::string node =
      R"({"kind":"image","box":{"x":12,"y":8,"w":64,"h":48},)"
      R"("format":"png","aspect":"preserve","flipH":false,"flipV":true,)"
      R"("data":")" + png_b64 + R"("})";
  const auto loaded = load_baked_contract(contract_with(node));
  REQUIRE(loaded);  // engine MUST accept the exporter's image node
  const auto r = render_to_trace(loaded.value(), RenderTarget{300.0, 96.0});
  REQUIRE(r);
  REQUIRE(count_kind(r.value(), EmittedKind::Image) == 1);
  const auto& cmd = r.value().commands[2];
  CHECK(cmd.kind == EmittedKind::Image);
  CHECK_FALSE(cmd.image_data.empty());
  CHECK(cmd.image_format == "png");
  CHECK(cmd.flip_v);
  CHECK(nearly_equal(cmd.device_box.w, 64.0 * 300.0 / 96.0, 0.5));
}

TEST_CASE("Exporter edges (straight/orthogonal) render through the engine",
          "[wysiwyg]") {
  const std::string straight = path_node("M -10 -20 L 90 -20");
  const std::string ortho = path_node("M 0 0 L 100 0 L 100 80");
  const auto a = load_baked_contract(contract_with(straight, 240, 160));
  const auto b = load_baked_contract(contract_with(ortho, 240, 160));
  REQUIRE(a);
  REQUIRE(b);
  CHECK(render_to_trace(a.value(), RenderTarget{300.0, 96.0}));
  CHECK(render_to_trace(b.value(), RenderTarget{300.0, 96.0}));
}

TEST_CASE("A complex mixed document renders without silent divergence",
          "[wysiwyg]") {
  const std::string nodes =
    path_node("M 0 0 L 80 0 L 80 40 L 0 40 Z") + "," +
    path_node("M 0 20 A 40 20 0 1 0 80 20 A 40 20 0 1 0 0 20 Z") + "," +
    R"({"kind":"text","box":{"x":5,"y":5,"w":150,"h":30},"font":{"family":)"
    R"("Arial","sizePx":14,"weight":400,"italic":false,"color":"#222222"},)"
    R"("align":{"h":"center","v":"middle"},"content":{"type":"static",)"
    R"("lines":["Mixed"]}})" + "," +
    path_node("M 0 0 L 120 80");  // an edge
  const auto loaded = load_baked_contract(contract_with(nodes, 300, 200));
  REQUIRE(loaded);
  const auto r = render_to_trace(loaded.value(), RenderTarget{600.0, 96.0});
  REQUIRE(r);
  CHECK(count_kind(r.value(), EmittedKind::Path) == 3);
  CHECK(count_kind(r.value(), EmittedKind::Text) == 1);
}

TEST_CASE("The safety net is real: a non-conformant contract is loud-rejected",
          "[wysiwyg]") {
  // Exporter must never emit this; if it ever did, the engine MUST refuse it
  // (not silently mis-render) — proving WYSIWYG safety is enforced, not hoped.
  const std::string missing_dash_key =
    R"({"kind":"path","d":"M 0 0 L 1 1","fill":null,)"
    R"("stroke":{"paint":{"type":"solid","color":"#000000","alpha":1},)"
    R"("width":1,"cap":"butt","join":"miter","miterLimit":10}})";  // no dash
  const auto bad = load_baked_contract(contract_with(missing_dash_key));
  CHECK_FALSE(bad);

  const std::string bad_hex =
    R"({"kind":"path","d":"M 0 0 L 1 1","fill":)"
    R"({"type":"solid","color":"#12345","alpha":1},"stroke":null})";
  CHECK_FALSE(load_baked_contract(contract_with(bad_hex)));

  const std::string relative_path =
    path_node("M 0 0 l 10 10 z");  // lowercase relative commands
  CHECK_FALSE(load_baked_contract(contract_with(relative_path)));
}

TEST_CASE("Rich text preview==print structural parity for mixed runs", "[wysiwyg][rich]") {
  const std::string rich_node =
    R"({"kind":"text","box":{"x":10,"y":10,"w":140,"h":40},"font":{"family":"Arial","sizePx":12,"weight":400,"italic":false,"underline":false,"strikethrough":false,"color":"#000000"},"align":{"h":"left","v":"top"},"content":{"type":"rich","paragraphs":[)"
    R"({"align":"left","runs":[{"text":"Bold ","fontFamily":"Arial","sizePx":14,"weight":700,"italic":false,"underline":true,"strikethrough":false,"color":"#ff0000"},{"text":"small","fontFamily":"Arial","sizePx":10,"weight":400,"italic":true,"underline":false,"strikethrough":true,"color":"#0000ff"}]},)"
    R"({"align":"right","runs":[{"text":"tail","fontFamily":"Times New Roman","sizePx":12,"weight":400,"italic":false,"underline":false,"strikethrough":false,"color":"#008000"}]}]}})";

  const auto loaded = load_baked_contract(contract_with(rich_node, 220, 120));
  REQUIRE(loaded);

  const auto preview = render_operator_preview_trace(loaded.value(), RenderTarget{300.0, 96.0}, {});
  const auto print = render_print_trace(loaded.value(), RenderTarget{300.0, 96.0}, {});
  REQUIRE(preview);
  REQUIRE(print);

  // render_print_trace wraps the shared trace with StartDocument/EndDocument
  // lifecycle commands by design; strip them so the structural parity check
  // compares the drawable commands (the INV-5 guarantee), not the wrapper.
  std::vector<print_engine::EmittedCommand> print_drawable;
  for (const auto& c : print.value().commands) {
    if (c.kind == EmittedKind::StartDocument || c.kind == EmittedKind::EndDocument) {
      continue;
    }
    print_drawable.push_back(c);
  }

  REQUIRE(preview.value().commands.size() == print_drawable.size());
  for (std::size_t i = 0; i < preview.value().commands.size(); ++i) {
    const auto& a = preview.value().commands[i];
    const auto& b = print_drawable[i];
    CHECK(a.kind == b.kind);
    CHECK(a.style_signature == b.style_signature);
    if (a.kind == EmittedKind::Text) {
      CHECK(a.label == b.label);
      CHECK(a.rich_paragraphs.size() == b.rich_paragraphs.size());
      CHECK(a.rich_paragraphs[0].runs.size() == b.rich_paragraphs[0].runs.size());
      CHECK(a.rich_paragraphs[0].runs[0].text == b.rich_paragraphs[0].runs[0].text);
      CHECK(a.rich_paragraphs[1].align == b.rich_paragraphs[1].align);
      CHECK(a.device_box.w == Catch::Approx(b.device_box.w).margin(0.01));
      CHECK(a.device_box.h == Catch::Approx(b.device_box.h).margin(0.01));
    }
  }
}

TEST_CASE("Rich text per-run attributes survive engine emission verbatim",
          "[wysiwyg][rich]") {
  // Defense-in-depth structural golden: every run attribute that draw_trace
  // reads (text / fontFamily / sizePx / weight / italic / underline /
  // strikethrough / color) must reach the emitted command unchanged. A
  // regression here would silently mis-style runs at print time and there is
  // no pixel-level test for that on Linux CI (the host is Windows-only).
  const std::string rich_node =
    R"({"kind":"text","box":{"x":10,"y":10,"w":200,"h":80},)"
    R"("font":{"family":"Arial","sizePx":12,"weight":400,"italic":false,)"
    R"("underline":false,"strikethrough":false,"color":"#111111"},)"
    R"("align":{"h":"left","v":"top"},)"
    R"("content":{"type":"rich","paragraphs":[{"align":"center","indentPx":4,)"
    R"("runs":[)"
    R"({"text":"R1 ","fontFamily":"Verdana","sizePx":18,"weight":700,)"
    R"("italic":true,"underline":true,"strikethrough":false,"color":"#ff0000"},)"
    R"({"text":"R2","fontFamily":"Courier New","sizePx":10,"weight":400,)"
    R"("italic":false,"underline":false,"strikethrough":true,"color":"#00aa00"})"
    R"(]}]}})";

  const auto loaded = load_baked_contract(contract_with(rich_node, 220, 120));
  REQUIRE(loaded);

  const auto trace = render_to_trace(loaded.value(),
                                     RenderTarget{300.0, 96.0});
  REQUIRE(trace);

  // Find the Text command (commands[0]=StartTile, [1]=Clip, [2]=Text...
  // depending on contract_with's emission order).
  const print_engine::EmittedCommand* text = nullptr;
  for (const auto& c : trace.value().commands) {
    if (c.kind == EmittedKind::Text) { text = &c; break; }
  }
  REQUIRE(text != nullptr);
  REQUIRE(text->rich_paragraphs.size() == 1);
  const auto& para = text->rich_paragraphs[0];
  CHECK(para.align == "center");
  CHECK(para.indent_px == Catch::Approx(4.0));
  REQUIRE(para.runs.size() == 2);

  const auto& r1 = para.runs[0];
  CHECK(r1.text == "R1 ");
  CHECK(r1.font_family == "Verdana");
  CHECK(r1.size_px == Catch::Approx(18.0));
  CHECK(r1.weight == 700);
  CHECK(r1.italic);
  CHECK(r1.underline);
  CHECK_FALSE(r1.strikethrough);
  CHECK(r1.color.r == 0xff);
  CHECK(r1.color.g == 0x00);
  CHECK(r1.color.b == 0x00);

  const auto& r2 = para.runs[1];
  CHECK(r2.text == "R2");
  CHECK(r2.font_family == "Courier New");
  CHECK(r2.size_px == Catch::Approx(10.0));
  CHECK(r2.weight == 400);
  CHECK_FALSE(r2.italic);
  CHECK_FALSE(r2.underline);
  CHECK(r2.strikethrough);
  CHECK(r2.color.g == 0xaa);
}

TEST_CASE("Rich text emits independent commands per text node (no run merge"
          " across nodes)",
          "[wysiwyg][rich]") {
  // Two text nodes back-to-back must each yield their own EmittedKind::Text
  // command with their own rich_paragraphs. A merge-across-nodes bug would
  // silently lose runs at print time.
  const std::string two_nodes =
    R"json({"kind":"text","box":{"x":10,"y":10,"w":80,"h":30},)json"
    R"json("font":{"family":"Arial","sizePx":12,"weight":400,"italic":false,)json"
    R"json("underline":false,"strikethrough":false,"color":"#000000"},)json"
    R"json("align":{"h":"left","v":"top"},)json"
    R"json("content":{"type":"rich","paragraphs":[{"align":"left","indentPx":0,)json"
    R"json("runs":[{"text":"alpha","fontFamily":"Arial","sizePx":12,)json"
    R"json("weight":400,"italic":false,"underline":false,)json"
    R"json("strikethrough":false,"color":"#000000"}]}]}},)json"
    R"json({"kind":"text","box":{"x":10,"y":50,"w":80,"h":30},)json"
    R"json("font":{"family":"Arial","sizePx":12,"weight":400,"italic":false,)json"
    R"json("underline":false,"strikethrough":false,"color":"#000000"},)json"
    R"json("align":{"h":"left","v":"top"},)json"
    R"json("content":{"type":"rich","paragraphs":[{"align":"right","indentPx":0,)json"
    R"json("runs":[{"text":"beta","fontFamily":"Arial","sizePx":12,)json"
    R"json("weight":700,"italic":false,"underline":false,)json"
    R"json("strikethrough":false,"color":"#0000ff"}]}]}})json";

  const auto loaded = load_baked_contract(contract_with(two_nodes, 220, 120));
  REQUIRE(loaded);
  const auto trace = render_to_trace(loaded.value(),
                                     RenderTarget{300.0, 96.0});
  REQUIRE(trace);

  std::vector<const print_engine::EmittedCommand*> texts;
  for (const auto& c : trace.value().commands) {
    if (c.kind == EmittedKind::Text) texts.push_back(&c);
  }
  REQUIRE(texts.size() == 2);
  CHECK(texts[0]->rich_paragraphs.at(0).runs.at(0).text == "alpha");
  CHECK(texts[0]->rich_paragraphs.at(0).align == "left");
  CHECK(texts[1]->rich_paragraphs.at(0).runs.at(0).text == "beta");
  CHECK(texts[1]->rich_paragraphs.at(0).align == "right");
  CHECK(texts[1]->rich_paragraphs.at(0).runs.at(0).weight == 700);
}
