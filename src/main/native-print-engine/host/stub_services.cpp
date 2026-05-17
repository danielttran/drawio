// PLACEHOLDER EngineServices for the standalone host executable.
//
// This exists so the protocol spine + transport are runnable and end-to-end
// testable today. It does NOT touch any real device: enumerate_printers
// returns one clearly-labelled stub printer, render_preview returns a fixed
// 1x1 PNG, print is a no-op job. The production Win32/GDI+ implementation
// (real EnumPrinters, real GDI+ raster, real printer DC with StartDoc/
// AbortDoc discipline) replaces this file via make_engine_services() with no
// change to ProtoDispatcher or the transport.

#include "engine_services_factory.hpp"

#include <memory>
#include <string>

namespace print_engine::proto {
namespace {

// A minimal valid 1x1 transparent PNG (67 bytes). Satisfies the
// imageFormat:"png" contract until real raster lands.
const std::vector<std::uint8_t> kStubPng = {
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00,
    0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
    0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82};

class StubServices final : public EngineServices {
 public:
  std::vector<PrinterInfo> enumerate_printers() override {
    StockInfo s{"stock-4x6", "4x6 in (102x152 mm)", 101600, 152400, 300.0,
                300.0};
    PrinterInfo p{"stub-printer",
                  "[STUB] Native Print Engine (no real device yet)",
                  "stock-4x6", {s}};
    return {p};
  }

  Result<PreviewOutput, ContractError> render_preview(
      const BakedDocument&, const std::map<std::string, std::string>&,
      double) override {
    PreviewOutput out;
    out.png = kStubPng;
    out.width_px = 1;
    out.height_px = 1;
    DegradationNotice n;
    n.type = DegradationNoticeType::StubbedSvgArtwork;
    n.detail = "preview is a stub bitmap; real GDI+ raster not yet wired";
    out.notices.push_back(n);
    return Result<PreviewOutput, ContractError>::ok(std::move(out));
  }

  Result<PrintOutput, ContractError> print(
      const BakedDocument&, const std::map<std::string, std::string>&,
      const std::string& printer_id, const std::string& stock_id,
      int copies) override {
    PrintOutput job;
    job.job_id = "stub-job";
    job.job_log = Json::object();
    job.job_log.set("engineVersion", Json::str("native-print-engine"));
    job.job_log.set("printerId", Json::str(printer_id));
    job.job_log.set("stockId", Json::str(stock_id));
    job.job_log.set("copies", Json::number(copies));
    job.job_log.set("note",
                    Json::str("STUB: nothing was sent to a real device"));
    DegradationNotice n;
    n.type = DegradationNoticeType::StubbedSvgArtwork;
    n.detail = "print is a stub; real printer DC not yet wired";
    job.notices.push_back(n);
    return Result<PrintOutput, ContractError>::ok(std::move(job));
  }
};

}  // namespace

std::unique_ptr<EngineServices> make_engine_services() {
  return std::make_unique<StubServices>();
}

}  // namespace print_engine::proto
