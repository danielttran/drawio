// Layer 2 — engine-side protocol adapter, tested against synthetic contract
// fixtures with a fake EngineServices: no transport, no Win32, no host
// (spec §10.2). Proves ops map onto contract loading + the Result taxonomy
// and that the handshake/ordering/single-flight gates hold end to end.

#include "print_engine/proto_adapter.hpp"

#include "print_engine/contract.hpp"
#include "print_engine/fixture_builder.hpp"

#include <catch2/catch_test_macros.hpp>

#include <cstdio>
#include <filesystem>
#include <fstream>
#include <functional>
#include <string>

using namespace print_engine;
using proto::Json;

namespace {

Json req(const std::string& op) {
  Json j = Json::object();
  j.set("op", Json::str(op));
  return j;
}

Json hello_with(std::uint32_t major, std::uint32_t minor) {
  Json j = req("Hello");
  Json p = Json::object();
  p.set("major", Json::number(major));
  p.set("minor", Json::number(minor));
  j.set("proto", std::move(p));
  return j;
}

Json hello_msg() { return hello_with(proto::kProtoMajor, proto::kProtoMinor); }

Json inline_ref(const std::string& contract_json) {
  Json cr = Json::object();
  cr.set("inline", Json::str(contract_json));
  return cr;
}

// Fake device surface. A render/print hook lets a test re-enter the dispatcher
// to exercise the single-flight EngineBusyError path (§3.4).
class FakeServices : public proto::EngineServices {
 public:
  std::function<void()> on_print;
  proto::PrintRenderOptions last_opts;  // captured for D6 AA control tests

  std::vector<proto::PrinterInfo> enumerate_printers() override {
    proto::StockInfo s{"stock-4x6", "4x6 label", 101600, 152400, 300.0, 300.0};
    proto::PrinterInfo p{"printer-1", "Bench Label Printer", "stock-4x6", {s}};
    return {p};
  }

  Result<proto::PreviewOutput, ContractError> render_preview(
      const BakedDocument& doc, const std::map<std::string, std::string>& merge,
      double dpi, const proto::PrintRenderOptions& opts) override {
    last_opts = opts;
    return render_preview(doc, merge, dpi);
  }

  std::size_t forced_png_size = 0;  // nonzero => synthesize a PNG this large

  Result<proto::PreviewOutput, ContractError> render_preview(
      const BakedDocument&, const std::map<std::string, std::string>&,
      double) override {
    proto::PreviewOutput out;
    out.png = {0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A};  // PNG magic
    if (forced_png_size != 0) {
      out.png.assign(forced_png_size, 0x00);
    }
    out.width_px = 1200;
    out.height_px = 1800;
    DegradationNotice n;
    n.type = DegradationNoticeType::StubbedBarcode;
    n.page_id = "page-1";
    n.symbology = "stub";
    n.resolved_value = "12345";
    out.notices.push_back(n);
    return Result<proto::PreviewOutput, ContractError>::ok(std::move(out));
  }

  Result<proto::PrintOutput, ContractError> print(
      const BakedDocument&, const std::map<std::string, std::string>&,
      const std::string&, const std::string&, int,
      proto::PrintRenderOptions opts = {}) override {
    last_opts = opts;
    if (on_print) on_print();
    proto::PrintOutput job;
    job.job_id = "job-7";
    job.job_log = Json::object();
    job.job_log.set("engineVersion", Json::str("native-print-engine"));
    return Result<proto::PrintOutput, ContractError>::ok(std::move(job));
  }
};

}  // namespace

TEST_CASE("adapter completes Hello and reports supported schema",
          "[adapter][handshake]") {
  FakeServices svc;
  proto::ProtoDispatcher d(svc);
  auto r = d.handle(hello_msg());
  CHECK(r.control.get("result")->as_string() == "HelloOk");
  CHECK(r.control.get("supportedSchemaMajor")->as_number() ==
        static_cast<double>(SupportedMajor));
  CHECK(d.session().handshaked());
}

TEST_CASE("adapter refuses pre-Hello ops with ProtoHandshakeError",
          "[adapter][handshake]") {
  FakeServices svc;
  proto::ProtoDispatcher d(svc);
  auto r = d.handle(req("Ping"));
  CHECK(r.control.get("result")->as_string() == "Error");
  CHECK(r.control.get("error")->as_string() == "ProtoHandshakeError");
}

TEST_CASE("adapter rejects proto major mismatch and stays refused",
          "[adapter][handshake]") {
  FakeServices svc;
  proto::ProtoDispatcher d(svc);
  auto r = d.handle(hello_with(proto::kProtoMajor + 1, 0));
  CHECK(r.control.get("error")->as_string() == "ProtoVersionError");
  // No best-effort afterwards.
  auto r2 = d.handle(req("Ping"));
  CHECK(r2.control.get("error")->as_string() == "ProtoVersionError");
}

TEST_CASE("adapter emits ProtoMinorAhead on a minor-ahead handshake",
          "[adapter][handshake]") {
  FakeServices svc;
  proto::ProtoDispatcher d(svc);
  auto r = d.handle(hello_with(proto::kProtoMajor, proto::kProtoMinor + 2));
  CHECK(r.control.get("result")->as_string() == "HelloOk");
  const Json& notices = *r.control.get("notices");
  REQUIRE(notices.items().size() == 1);
  CHECK(notices.items()[0].get("kind")->as_string() == "ProtoMinorAhead");
}

TEST_CASE("Ping returns Pong with uptime", "[adapter][ops]") {
  FakeServices svc;
  proto::ProtoDispatcher d(svc);
  (void)d.handle(hello_msg());
  auto r = d.handle(req("Ping"));
  CHECK(r.control.get("result")->as_string() == "Pong");
  CHECK(r.control.get("engineUptimeMs")->as_number() >= 0.0);
}

TEST_CASE("GetCapabilities reports engine-enumerated printers",
          "[adapter][ops]") {
  FakeServices svc;
  proto::ProtoDispatcher d(svc);
  (void)d.handle(hello_msg());
  auto r = d.handle(req("GetCapabilities"));
  CHECK(r.control.get("result")->as_string() == "Capabilities");
  const Json& printers = *r.control.get("printers");
  REQUIRE(printers.items().size() == 1);
  CHECK(printers.items()[0].get("name")->as_string() == "Bench Label Printer");
  CHECK(printers.items()[0].get("stocks")->items()[0].get("widthMicrons")
            ->as_number() == 101600.0);
}

TEST_CASE("GetContractFields extracts merge-bound fields from a fixture",
          "[adapter][ops]") {
  FakeServices svc;
  proto::ProtoDispatcher d(svc);
  (void)d.handle(hello_msg());
  const std::string contract =
      fixtures::FixtureBuilder().merge_text_and_barcode_page().build();
  Json m = req("GetContractFields");
  m.set("contractRef", inline_ref(contract));
  auto r = d.handle(m);
  REQUIRE(r.control.get("result")->as_string() == "ContractFields");
  const Json& fields = *r.control.get("fields");
  REQUIRE(fields.items().size() == 2);
  CHECK(fields.items()[0].get("key")->as_string() == "NAME");
  CHECK(fields.items()[0].get("kind")->as_string() == "text");
  CHECK(fields.items()[0].get("maxLen")->as_number() == 20.0);
  CHECK(fields.items()[1].get("key")->as_string() == "CODE");
  CHECK(fields.items()[1].get("kind")->as_string() == "barcode");
}

TEST_CASE("GetContractFields is loud on an invalid contract",
          "[adapter][ops]") {
  FakeServices svc;
  proto::ProtoDispatcher d(svc);
  (void)d.handle(hello_msg());
  Json m = req("GetContractFields");
  m.set("contractRef", inline_ref("{ this is not json"));
  auto r = d.handle(m);
  CHECK(r.control.get("result")->as_string() == "Error");
  CHECK(r.control.get("error")->as_string() == "ContractValidationError");
}

TEST_CASE("RenderPreview returns a PreviewResult plus a correlated blob",
          "[adapter][ops]") {
  FakeServices svc;
  proto::ProtoDispatcher d(svc);
  (void)d.handle(hello_msg());
  Json m = req("RenderPreview");
  m.set("contractRef",
        inline_ref(fixtures::FixtureBuilder().empty_page().build()));
  m.set("dpi", Json::number(300));
  auto r = d.handle(m);
  REQUIRE(r.control.get("result")->as_string() == "PreviewResult");
  CHECK(r.control.get("imageFormat")->as_string() == "png");
  CHECK(r.has_binary);
  // The control frame's imageStreamId must equal the 0x02 blob's streamId.
  CHECK(static_cast<std::uint32_t>(
            r.control.get("imageStreamId")->as_number()) ==
        r.binary_stream_id);
  CHECK(r.binary.size() == 8);
  CHECK(r.control.get("notices")->items()[0].get("kind")->as_string() ==
        "StubbedBarcode");
}

TEST_CASE("Print returns a typed job result with a job log",
          "[adapter][ops]") {
  FakeServices svc;
  proto::ProtoDispatcher d(svc);
  (void)d.handle(hello_msg());
  Json m = req("Print");
  m.set("contractRef",
        inline_ref(fixtures::FixtureBuilder().empty_page().build()));
  m.set("printerId", Json::str("printer-1"));
  m.set("stockId", Json::str("stock-4x6"));
  m.set("copies", Json::number(2));
  auto r = d.handle(m);
  CHECK(r.control.get("result")->as_string() == "PrintResult");
  CHECK(r.control.get("jobId")->as_string() == "job-7");
  CHECK(r.control.get("jobLog")->get("engineVersion")->as_string() ==
        "native-print-engine");
}

TEST_CASE("D6: Print with aa:crisp sets edge_crisp on PrintRenderOptions",
          "[adapter][d6][aa]") {
  FakeServices svc;
  proto::ProtoDispatcher d(svc);
  (void)d.handle(hello_msg());
  Json m = req("Print");
  m.set("contractRef",
        inline_ref(fixtures::FixtureBuilder().empty_page().build()));
  m.set("printerId", Json::str("printer-1"));
  m.set("stockId", Json::str("stock-4x6"));
  m.set("aa", Json::str("crisp"));
  auto r = d.handle(m);
  CHECK(r.control.get("result")->as_string() == "PrintResult");
  CHECK(svc.last_opts.edge_crisp == true);
}

TEST_CASE("D6: Print with aa:on (default) keeps edge_crisp false",
          "[adapter][d6][aa]") {
  FakeServices svc;
  proto::ProtoDispatcher d(svc);
  (void)d.handle(hello_msg());
  Json m = req("Print");
  m.set("contractRef",
        inline_ref(fixtures::FixtureBuilder().empty_page().build()));
  m.set("printerId", Json::str("printer-1"));
  m.set("stockId", Json::str("stock-4x6"));
  // No "aa" field — default must be AA on (edge_crisp = false)
  auto r = d.handle(m);
  CHECK(r.control.get("result")->as_string() == "PrintResult");
  CHECK(svc.last_opts.edge_crisp == false);
}

TEST_CASE("D6/INV-5: RenderPreview with aa:crisp threads edge_crisp into the"
          " preview render options",
          "[adapter][d6][aa][inv5]") {
  FakeServices svc;
  proto::ProtoDispatcher d(svc);
  (void)d.handle(hello_msg());
  Json m = req("RenderPreview");
  m.set("contractRef",
        inline_ref(fixtures::FixtureBuilder().empty_page().build()));
  m.set("aa", Json::str("crisp"));
  auto r = d.handle(m);
  CHECK(r.control.get("result")->as_string() == "PreviewResult");
  CHECK(svc.last_opts.edge_crisp == true);

  // And the default stays AA on, matching Print.
  svc.last_opts = {};
  Json m2 = req("RenderPreview");
  m2.set("contractRef",
         inline_ref(fixtures::FixtureBuilder().empty_page().build()));
  auto r2 = d.handle(m2);
  CHECK(r2.control.get("result")->as_string() == "PreviewResult");
  CHECK(svc.last_opts.edge_crisp == false);
}

TEST_CASE("Phase 5 device-side SvgArtworkRasterized notice round-trips through"
          " the proto adapter wire format",
          "[adapter][notice][svg]") {
  // Build the notice as if draw_trace had emitted it from a successful
  // external rasterization (carries backend identity in `detail`).
  DegradationNotice n;
  n.type = DegradationNoticeType::SvgArtworkRasterized;
  n.page_id = "page-2";
  n.detail = "svg rendered via external rasterizer: resvg 0.47";
  const Json j = proto::notice_to_json(n);
  CHECK(j.get("kind")->as_string() == "SvgArtworkRasterized");
  CHECK(j.get("pageId")->as_string() == "page-2");
  CHECK(j.get("detail")->get("detail")->as_string() ==
        "svg rendered via external rasterizer: resvg 0.47");
}

TEST_CASE("Phase 5 fallback StubbedSvgArtwork notice still serializes when"
          " the rasterizer is unavailable",
          "[adapter][notice][svg]") {
  DegradationNotice n;
  n.type = DegradationNoticeType::StubbedSvgArtwork;
  n.page_id = "page-1";
  n.detail = "svg rasterizer fallback: no backend";
  const Json j = proto::notice_to_json(n);
  // Engine posture preserved: the kind on the wire is unchanged.
  CHECK(j.get("kind")->as_string() == "StubbedSvgArtwork");
  CHECK(j.get("detail")->get("detail")->as_string() ==
        "svg rasterizer fallback: no backend");
}

TEST_CASE("RenderPreview during an in-flight Print is EngineBusyError",
          "[adapter][concurrency]") {
  FakeServices svc;
  proto::ProtoDispatcher d(svc);
  (void)d.handle(hello_msg());
  std::string busy_error;
  svc.on_print = [&]() {
    Json pv = req("RenderPreview");
    pv.set("contractRef",
           inline_ref(fixtures::FixtureBuilder().empty_page().build()));
    auto rr = d.handle(pv);
    busy_error = rr.control.get("error")->as_string();
  };
  Json m = req("Print");
  m.set("contractRef",
        inline_ref(fixtures::FixtureBuilder().empty_page().build()));
  (void)d.handle(m);
  CHECK(busy_error == "EngineBusyError");
}

TEST_CASE("ReleaseContract and Shutdown acknowledge", "[adapter][lifecycle]") {
  FakeServices svc;
  proto::ProtoDispatcher d(svc);
  (void)d.handle(hello_msg());
  CHECK(d.handle(req("ReleaseContract")).control.get("result")->as_string() ==
        "Released");
  auto s = d.handle(req("Shutdown"));
  CHECK(s.control.get("result")->as_string() == "ShutdownAck");
  CHECK(s.shutdown);
}

TEST_CASE("contractRef path is read and validated like inline",
          "[adapter][contractref]") {
  FakeServices svc;
  proto::ProtoDispatcher d(svc);
  (void)d.handle(hello_msg());

  const std::string tmp =
      (std::filesystem::temp_directory_path() / "pe_contract_test.json")
          .string();
  {
    std::ofstream out(tmp, std::ios::binary);
    out << fixtures::FixtureBuilder().merge_text_and_barcode_page().build();
  }
  Json cr = Json::object();
  cr.set("path", Json::str(tmp));
  Json m = req("GetContractFields");
  m.set("contractRef", std::move(cr));
  auto r = d.handle(m);
  CHECK(r.control.get("result")->as_string() == "ContractFields");
  CHECK(r.control.get("fields")->items().size() == 2);
  std::remove(tmp.c_str());
}

TEST_CASE("Hello refuses non-integral / out-of-range proto version numbers",
          "[adapter][handshake][hardening]") {
  // static_cast of an out-of-range double to uint32 is UB; the adapter must
  // refuse these wire values loudly instead of casting them.
  for (const double bad : {1e300, -1.0, 1.5, 4294967296.0}) {
    FakeServices svc;
    proto::ProtoDispatcher d(svc);
    Json m = req("Hello");
    Json p = Json::object();
    p.set("major", Json::number(bad));
    p.set("minor", Json::number(0));
    m.set("proto", std::move(p));
    auto r = d.handle(m);
    INFO("major: " << bad);
    CHECK(r.control.get("result")->as_string() == "Error");
    CHECK(r.control.get("error")->as_string() == "ProtoHandshakeError");
    CHECK_FALSE(d.session().handshaked());
  }
}

TEST_CASE("RenderPreview refuses out-of-range or non-numeric dpi",
          "[adapter][ops][hardening]") {
  FakeServices svc;
  proto::ProtoDispatcher d(svc);
  (void)d.handle(hello_msg());
  const auto preview_with_dpi = [&](Json dpi) {
    Json m = req("RenderPreview");
    m.set("contractRef",
          inline_ref(fixtures::FixtureBuilder().empty_page().build()));
    m.set("dpi", std::move(dpi));
    return d.handle(m);
  };

  for (const double bad : {1e300, 0.0, -300.0, 10001.0}) {
    auto r = preview_with_dpi(Json::number(bad));
    INFO("dpi: " << bad);
    CHECK(r.control.get("result")->as_string() == "Error");
    CHECK(r.control.get("error")->as_string() == "ContractValidationError");
  }
  // Present-but-not-a-number is refused, never silently defaulted.
  auto str_dpi = preview_with_dpi(Json::str("300"));
  CHECK(str_dpi.control.get("result")->as_string() == "Error");
  // In-range dpi still renders.
  auto ok = preview_with_dpi(Json::number(600));
  CHECK(ok.control.get("result")->as_string() == "PreviewResult");
}

TEST_CASE("Print refuses out-of-range or fractional copies",
          "[adapter][ops][hardening]") {
  FakeServices svc;
  proto::ProtoDispatcher d(svc);
  (void)d.handle(hello_msg());
  const auto print_with_copies = [&](Json copies) {
    Json m = req("Print");
    m.set("contractRef",
          inline_ref(fixtures::FixtureBuilder().empty_page().build()));
    m.set("printerId", Json::str("printer-1"));
    m.set("stockId", Json::str("stock-4x6"));
    m.set("copies", std::move(copies));
    return d.handle(m);
  };

  for (const double bad : {1e300, 0.0, -1.0, 2.5, 1000.0}) {
    auto r = print_with_copies(Json::number(bad));
    INFO("copies: " << bad);
    CHECK(r.control.get("result")->as_string() == "Error");
    CHECK(r.control.get("error")->as_string() == "ContractValidationError");
  }
  auto ok = print_with_copies(Json::number(999));
  CHECK(ok.control.get("result")->as_string() == "PrintResult");
}

TEST_CASE("non-string mergeData values are refused loudly, naming the key",
          "[adapter][ops][hardening]") {
  FakeServices svc;
  proto::ProtoDispatcher d(svc);
  (void)d.handle(hello_msg());
  const std::string contract =
      fixtures::FixtureBuilder().merge_text_and_barcode_page().build();

  Json md = Json::object();
  md.set("NAME", Json::str("fine"));
  md.set("qty", Json::number(5));  // would have merged as "" -> blank print

  Json m = req("Print");
  m.set("contractRef", inline_ref(contract));
  m.set("printerId", Json::str("printer-1"));
  m.set("stockId", Json::str("stock-4x6"));
  m.set("mergeData", std::move(md));
  auto r = d.handle(m);
  CHECK(r.control.get("result")->as_string() == "Error");
  CHECK(r.control.get("error")->as_string() == "ContractValidationError");
  REQUIRE(r.control.get("detail") != nullptr);
  CHECK(r.control.get("detail")->as_string().find("qty") != std::string::npos);

  // RenderPreview takes the same refusal path.
  Json md2 = Json::object();
  md2.set("CODE", Json::boolean(true));
  Json pm = req("RenderPreview");
  pm.set("contractRef", inline_ref(contract));
  pm.set("mergeData", std::move(md2));
  auto pr = d.handle(pm);
  CHECK(pr.control.get("result")->as_string() == "Error");
  CHECK(pr.control.get("detail")->as_string().find("CODE") !=
        std::string::npos);

  // All-string mergeData still prints.
  Json md3 = Json::object();
  md3.set("NAME", Json::str("Ada"));
  md3.set("CODE", Json::str("12345"));
  Json om = req("Print");
  om.set("contractRef", inline_ref(contract));
  om.set("printerId", Json::str("printer-1"));
  om.set("stockId", Json::str("stock-4x6"));
  om.set("mergeData", std::move(md3));
  auto orr = d.handle(om);
  CHECK(orr.control.get("result")->as_string() == "PrintResult");
}

namespace {

// Two merge nodes sharing one key with DIFFERENT maxLen: the renderer
// enforces each node's own limit, so the field's binding constraint is the
// minimum across the nodes.
std::string duplicate_key_contract() {
  return
    R"({"schema":{"major":1,"minor":0},"document":{"units":"px","pages":[)"
    R"({"id":"page-1","size":{"w":100,"h":50},"tiles":[{"origin":{"x":0,"y":0},"size":{"w":100,"h":50}}],"paint":[)"
    R"({"kind":"text","box":{"x":1,"y":2,"w":40,"h":10},"font":{"family":"Arial","sizePx":8,"weight":400,"italic":false,"color":"#000000"},"align":{"h":"left","v":"top"},"content":{"type":"merge","key":"NAME","sample":"Sample","maxLen":10,"wrap":"word","overflow":"clip"}},)"
    R"({"kind":"text","box":{"x":1,"y":20,"w":40,"h":10},"font":{"family":"Arial","sizePx":8,"weight":400,"italic":false,"color":"#000000"},"align":{"h":"left","v":"top"},"content":{"type":"merge","key":"NAME","sample":"Sm","maxLen":2,"wrap":"word","overflow":"clip"}})"
    R"(]}]}})";
}

}  // namespace

TEST_CASE("GetContractFields reports the MINIMUM maxLen across nodes sharing"
          " a merge key",
          "[adapter][ops][hardening]") {
  FakeServices svc;
  proto::ProtoDispatcher d(svc);
  (void)d.handle(hello_msg());
  Json m = req("GetContractFields");
  m.set("contractRef", inline_ref(duplicate_key_contract()));
  auto r = d.handle(m);
  REQUIRE(r.control.get("result")->as_string() == "ContractFields");
  const Json& fields = *r.control.get("fields");
  REQUIRE(fields.items().size() == 1);
  CHECK(fields.items()[0].get("key")->as_string() == "NAME");
  // First-wins dedupe reported 10; a 3..10 char value then overflowed the
  // maxLen=2 node at render time. The binding constraint is 2.
  CHECK(fields.items()[0].get("maxLen")->as_number() == 2.0);
  // audit7: the sample must stay PAIRED with the binding maxLen — keeping
  // the first node's "Sample" (6 cp) advertised a sample the reported
  // maxLen=2 field could never accept.
  CHECK(fields.items()[0].get("sampleValue")->as_string() == "Sm");
}

TEST_CASE("Print refuses non-string printerId / stockId loudly",
          "[adapter][ops][hardening]") {
  FakeServices svc;
  proto::ProtoDispatcher d(svc);
  (void)d.handle(hello_msg());
  const auto print_with = [&](const char* key, Json value) {
    Json m = req("Print");
    m.set("contractRef",
          inline_ref(fixtures::FixtureBuilder().empty_page().build()));
    m.set("printerId", Json::str("printer-1"));
    m.set("stockId", Json::str("stock-4x6"));
    m.set(key, std::move(value));
    return d.handle(m);
  };

  // Non-string values used to coerce to "" => silently routed to the
  // default printer / default stock.
  for (const char* key : {"printerId", "stockId"}) {
    auto num = print_with(key, Json::number(7));
    INFO("key: " << key);
    CHECK(num.control.get("result")->as_string() == "Error");
    CHECK(num.control.get("error")->as_string() == "ContractValidationError");
    CHECK(num.control.get("detail")->as_string().find(key) !=
          std::string::npos);
    auto null_v = print_with(key, Json());
    CHECK(null_v.control.get("result")->as_string() == "Error");
  }

  // Absent stays default (no error): both omitted is still a valid job.
  Json m = req("Print");
  m.set("contractRef",
        inline_ref(fixtures::FixtureBuilder().empty_page().build()));
  CHECK(d.handle(m).control.get("result")->as_string() == "PrintResult");
}

TEST_CASE("aa render option must be exactly \"on\" or \"crisp\"",
          "[adapter][ops][hardening][aa]") {
  FakeServices svc;
  proto::ProtoDispatcher d(svc);
  (void)d.handle(hello_msg());
  const auto print_with_aa = [&](Json aa) {
    Json m = req("Print");
    m.set("contractRef",
          inline_ref(fixtures::FixtureBuilder().empty_page().build()));
    m.set("printerId", Json::str("printer-1"));
    m.set("stockId", Json::str("stock-4x6"));
    m.set("aa", std::move(aa));
    return d.handle(m);
  };

  // Unknown strings and non-strings used to coerce to AA-on silently.
  for (Json bad : {Json::str("CRISP"), Json::str("off"), Json::boolean(true),
                   Json::number(1)}) {
    auto r = print_with_aa(std::move(bad));
    CHECK(r.control.get("result")->as_string() == "Error");
    CHECK(r.control.get("error")->as_string() == "ContractValidationError");
  }
  // The two legal values still work.
  auto on = print_with_aa(Json::str("on"));
  CHECK(on.control.get("result")->as_string() == "PrintResult");
  CHECK(svc.last_opts.edge_crisp == false);
  auto crisp = print_with_aa(Json::str("crisp"));
  CHECK(crisp.control.get("result")->as_string() == "PrintResult");
  CHECK(svc.last_opts.edge_crisp == true);

  // RenderPreview takes the same refusal path (INV-5 parity).
  Json pm = req("RenderPreview");
  pm.set("contractRef",
         inline_ref(fixtures::FixtureBuilder().empty_page().build()));
  pm.set("aa", Json::str("smooth"));
  auto pr = d.handle(pm);
  CHECK(pr.control.get("result")->as_string() == "Error");
  CHECK(pr.control.get("error")->as_string() == "ContractValidationError");
}

TEST_CASE("RenderPreview refuses a preview image over the frame limit with a"
          " typed error and the transport stays alive",
          "[adapter][ops][hardening][frame]") {
  FakeServices svc;
  svc.forced_png_size = proto::kMaxFramePayload + 1;
  proto::ProtoDispatcher d(svc);
  (void)d.handle(hello_msg());
  Json m = req("RenderPreview");
  m.set("contractRef",
        inline_ref(fixtures::FixtureBuilder().empty_page().build()));
  auto r = d.handle(m);
  // Typed Error control frame, no 0x02 frame the peer's decoder would die on.
  CHECK(r.control.get("result")->as_string() == "Error");
  CHECK(r.control.get("error")->as_string() == "EngineInternalError");
  CHECK(r.control.get("detail")->as_string().find("frame limit") !=
        std::string::npos);
  CHECK_FALSE(r.has_binary);

  // The session/transport is still usable afterwards.
  svc.forced_png_size = 0;
  CHECK(d.handle(req("Ping")).control.get("result")->as_string() == "Pong");
  Json m2 = req("RenderPreview");
  m2.set("contractRef",
         inline_ref(fixtures::FixtureBuilder().empty_page().build()));
  CHECK(d.handle(m2).control.get("result")->as_string() == "PreviewResult");
}
