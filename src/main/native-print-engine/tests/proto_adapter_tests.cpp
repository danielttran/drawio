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

  std::vector<proto::PrinterInfo> enumerate_printers() override {
    proto::StockInfo s{"stock-4x6", "4x6 label", 101600, 152400, 300.0, 300.0};
    proto::PrinterInfo p{"printer-1", "Bench Label Printer", "stock-4x6", {s}};
    return {p};
  }

  Result<proto::PreviewOutput, ContractError> render_preview(
      const BakedDocument&, const std::map<std::string, std::string>&,
      double) override {
    proto::PreviewOutput out;
    out.png = {0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A};  // PNG magic
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
      const std::string&, const std::string&, int) override {
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
