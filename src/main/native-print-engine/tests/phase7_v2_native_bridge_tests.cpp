#include "print_engine/contract_loader.hpp"
#include "print_engine/devmode.hpp"
#include "print_engine/native_print.hpp"
#include "print_engine/renderer.hpp"

#include <catch2/catch_test_macros.hpp>

#include <map>
#include <string>
#include <vector>

using print_engine::ContractError;
using print_engine::ContractErrorCode;
using print_engine::DegradationNoticeType;
using print_engine::DeviceCaps;
using print_engine::DevModeSnapshot;
using print_engine::DmPaperUser;
using print_engine::NativeDrawKind;
using print_engine::NativePrintTarget;
using print_engine::PrintJobResult;
using print_engine::PrintLifecycle;
using print_engine::PrintLifecycleEvent;
using print_engine::RenderTarget;
using print_engine::Result;
using print_engine::TileSummary;
using print_engine::Unit;
using print_engine::build_merged_dev_mode;
using print_engine::load_baked_contract;
using print_engine::make_printer_world_transform;
using print_engine::nearly_equal;
using print_engine::render_design_preview_trace;
using print_engine::render_operator_preview_trace;
using print_engine::render_to_native_surface_trace;
using print_engine::render_to_print_lifecycle;
using print_engine::tile_hits_hardware_margin;

namespace {

class RecordingLifecycle final : public PrintLifecycle {
public:
  explicit RecordingLifecycle(int fail_start_page = -1) : fail_start_page_(fail_start_page) {}

  Result<Unit, ContractError> start_doc(const std::string&) override {
    events.push_back(PrintLifecycleEvent::StartDoc);
    return Result<Unit, ContractError>::ok(Unit{});
  }

  Result<Unit, ContractError> start_page(const std::string& page_id, std::size_t tile_index) override {
    (void)page_id;
    (void)tile_index;
    events.push_back(PrintLifecycleEvent::StartPage);
    ++start_page_count_;
    if (start_page_count_ == fail_start_page_) {
      return Result<Unit, ContractError>::err(ContractError{
        ContractErrorCode::PrintDeviceError,
        page_id,
        "mock StartPage failed"
      });
    }
    return Result<Unit, ContractError>::ok(Unit{});
  }

  Result<Unit, ContractError> end_page(const std::string& page_id, std::size_t tile_index) override {
    (void)page_id;
    (void)tile_index;
    events.push_back(PrintLifecycleEvent::EndPage);
    return Result<Unit, ContractError>::ok(Unit{});
  }

  void end_doc() override {
    events.push_back(PrintLifecycleEvent::EndDoc);
  }

  void abort_doc() override {
    events.push_back(PrintLifecycleEvent::AbortDoc);
  }

  std::vector<PrintLifecycleEvent> events;

private:
  int fail_start_page_ = -1;
  int start_page_count_ = 0;
};

[[nodiscard]] std::string stub_fixture() {
  return
    R"({"schema":{"major":1,"minor":0},"document":{"units":"px","pages":[)"
    R"({"id":"page-1","size":{"w":120,"h":80},"tiles":[{"origin":{"x":0,"y":0},"size":{"w":120,"h":80}}],"paint":[)"
    R"({"kind":"path","d":"M 0 0 L 10 0 L 10 10 Z","fill":{"type":"solid","color":"#000000","alpha":1},"stroke":null},)"
    R"({"kind":"barcode","box":{"x":10,"y":10,"w":50,"h":20},"symbology":"code128","params":{},"value":{"type":"merge","key":"CODE","sample":"SAMPLE","maxLen":12,"errorOnUnencodable":true}},)"
    R"({"kind":"svg","box":{"x":70,"y":10,"w":20,"h":20},"source":"PHN2Zz48L3N2Zz4=","aspect":"fill"})"
    R"(]}]}})";
}

[[nodiscard]] std::string multi_tile_fixture() {
  return
    R"({"schema":{"major":1,"minor":0},"document":{"units":"px","pages":[)"
    R"({"id":"page-1","size":{"w":100,"h":50},"tiles":[{"origin":{"x":0,"y":0},"size":{"w":50,"h":50}},{"origin":{"x":50,"y":0},"size":{"w":50,"h":50}}],"paint":[)"
    R"({"kind":"text","box":{"x":0,"y":0,"w":40,"h":20},"font":{"family":"Arial","sizePx":10,"weight":400,"italic":false,"color":"#000000"},"align":{"h":"left","v":"top"},"content":{"type":"static","lines":["A"]}}]},)"
    R"({"id":"page-2","size":{"w":100,"h":50},"tiles":[{"origin":{"x":0,"y":0},"size":{"w":100,"h":50}}],"paint":[)"
    R"({"kind":"text","box":{"x":10,"y":10,"w":40,"h":20},"font":{"family":"Arial","sizePx":10,"weight":400,"italic":false,"color":"#000000"},"align":{"h":"left","v":"top"},"content":{"type":"static","lines":["B"]}})"
    R"(]}]}})";
}

[[nodiscard]] std::string margin_safe_content_fixture() {
  return
    R"({"schema":{"major":1,"minor":0},"document":{"units":"px","pages":[)"
    R"({"id":"page-1","size":{"w":100,"h":50},"tiles":[{"origin":{"x":0,"y":0},"size":{"w":100,"h":50}}],"paint":[)"
    R"({"kind":"text","box":{"x":10,"y":10,"w":40,"h":20},"font":{"family":"Arial","sizePx":10,"weight":400,"italic":false,"color":"#000000"},"align":{"h":"left","v":"top"},"content":{"type":"static","lines":["A"]}})"
    R"(]}]}})";
}

[[nodiscard]] std::string multi_tile_stub_fixture() {
  return
    R"({"schema":{"major":1,"minor":0},"document":{"units":"px","pages":[)"
    R"({"id":"page-1","size":{"w":120,"h":80},"tiles":[{"origin":{"x":0,"y":0},"size":{"w":60,"h":80}},{"origin":{"x":60,"y":0},"size":{"w":60,"h":80}}],"paint":[)"
    R"({"kind":"barcode","box":{"x":10,"y":10,"w":50,"h":20},"symbology":"code128","params":{},"value":{"type":"static","data":"ABC"}},)"
    R"({"kind":"svg","box":{"x":70,"y":10,"w":20,"h":20},"source":"PHN2Zz48L3N2Zz4=","aspect":"fill"})"
    R"(]}]}})";
}

[[nodiscard]] std::string image_fixture(std::string data) {
  return
    R"({"schema":{"major":1,"minor":0},"document":{"units":"px","pages":[)"
    R"({"id":"page-1","size":{"w":20,"h":20},"tiles":[{"origin":{"x":0,"y":0},"size":{"w":20,"h":20}}],"paint":[)"
    R"({"kind":"image","box":{"x":0,"y":0,"w":10,"h":10},"format":"png","data":")" + data + R"(","aspect":"fill","flipH":false,"flipV":false})"
    R"(]}]}})";
}

[[nodiscard]] DeviceCaps caps_for(double dpi) {
  return DeviceCaps{
    dpi,
    dpi,
    dpi * 0.05,
    dpi * 0.10,
    dpi * 4.0,
    dpi * 3.0,
    dpi * 3.8,
    dpi * 2.7
  };
}

} // namespace

TEST_CASE("Phase 7 v2 printer world transform covers 203 300 and 600 dpi caps without rounding") {
  const TileSummary tile{{12.25, 3.5}, {80.0, 30.0}};

  for (const double dpi : {203.0, 300.0, 600.0}) {
    const DeviceCaps caps = caps_for(dpi);
    const auto transform = make_printer_world_transform(NativePrintTarget{96.0}, caps, tile);
    const auto device = transform.apply(print_engine::Rect{12.25, 3.5, 50.5, 10.25});

    CHECK(nearly_equal(device.x, -caps.physical_offset_x, 0.499));
    CHECK(nearly_equal(device.y, -caps.physical_offset_y, 0.499));
    CHECK(nearly_equal(device.w, 50.5 * dpi / 96.0, 0.499));
    CHECK(nearly_equal(device.h, 10.25 * dpi / 96.0, 0.499));
  }
}

TEST_CASE("Phase 7 v2 DEVMODE merge preserves driver private bytes and uses custom stock") {
  const DevModeSnapshot driver_default{{0xde, 0xad, 0xbe, 0xef}, 9, 0.0, 0.0};

  const auto merged = build_merged_dev_mode(driver_default, 101.6, 76.2);

  REQUIRE(merged);
  CHECK(merged.value().driver_extra == driver_default.driver_extra);
  CHECK(merged.value().paper_size == DmPaperUser);
  CHECK(merged.value().paper_width_mm == 101.6);
  CHECK(merged.value().paper_height_mm == 76.2);
}

TEST_CASE("Phase 7 v2 DEVMODE merge refuses invalid custom stock loudly") {
  const DevModeSnapshot driver_default{{1, 2, 3}, 9, 0.0, 0.0};

  const auto merged = build_merged_dev_mode(driver_default, 0.0, 76.2);

  REQUIRE_FALSE(merged);
  CHECK(merged.error().code == ContractErrorCode::PrintDeviceError);
}

TEST_CASE("Phase 7 v2 hardware margin clipping is surfaced as degradation") {
  const auto loaded = load_baked_contract(multi_tile_fixture());
  REQUIRE(loaded);
  RecordingLifecycle lifecycle;

  const auto result = render_to_print_lifecycle(
    loaded.value(),
    NativePrintTarget{96.0},
    caps_for(300.0),
    {},
    "job",
    lifecycle);

  REQUIRE(result);
  REQUIRE_FALSE(result.value().notices.empty());
  CHECK(result.value().notices[0].type == DegradationNoticeType::HardwareMarginClip);
  CHECK(tile_hits_hardware_margin(NativePrintTarget{96.0}, caps_for(300.0), loaded.value().pages[0].tiles[0]));
}

TEST_CASE("Phase 7 v2 hardware margin warning is content based not tile based") {
  const auto loaded = load_baked_contract(margin_safe_content_fixture());
  REQUIRE(loaded);
  RecordingLifecycle lifecycle;

  const auto result = render_to_print_lifecycle(
    loaded.value(),
    NativePrintTarget{96.0},
    caps_for(300.0),
    {},
    "job",
    lifecycle);

  REQUIRE(result);
  CHECK(result.value().notices.empty());
  CHECK(tile_hits_hardware_margin(NativePrintTarget{96.0}, caps_for(300.0), loaded.value().pages[0].tiles[0]));
}

TEST_CASE("Phase 7 v2 document page tile lifecycle emits EndDoc on success") {
  const auto loaded = load_baked_contract(multi_tile_fixture());
  REQUIRE(loaded);
  RecordingLifecycle lifecycle;

  const auto result = render_to_print_lifecycle(
    loaded.value(),
    NativePrintTarget{96.0},
    DeviceCaps{300.0, 300.0, 0.0, 0.0, 1200.0, 900.0, 1200.0, 900.0},
    {},
    "multi tile job",
    lifecycle);

  REQUIRE(result);
  CHECK(lifecycle.events == std::vector<PrintLifecycleEvent>{
    PrintLifecycleEvent::StartDoc,
    PrintLifecycleEvent::StartPage,
    PrintLifecycleEvent::EndPage,
    PrintLifecycleEvent::StartPage,
    PrintLifecycleEvent::EndPage,
    PrintLifecycleEvent::StartPage,
    PrintLifecycleEvent::EndPage,
    PrintLifecycleEvent::EndDoc
  });
}

TEST_CASE("Phase 7 v2 lifecycle aborts instead of ending the document on mid-job failure") {
  const auto loaded = load_baked_contract(multi_tile_fixture());
  REQUIRE(loaded);
  RecordingLifecycle lifecycle(2);

  const PrintJobResult result = render_to_print_lifecycle(
    loaded.value(),
    NativePrintTarget{96.0},
    DeviceCaps{300.0, 300.0, 0.0, 0.0, 1200.0, 900.0, 1200.0, 900.0},
    {},
    "failing job",
    lifecycle);

  REQUIRE_FALSE(result);
  CHECK(result.error().code == ContractErrorCode::PrintDeviceError);
  CHECK(lifecycle.events == std::vector<PrintLifecycleEvent>{
    PrintLifecycleEvent::StartDoc,
    PrintLifecycleEvent::StartPage,
    PrintLifecycleEvent::EndPage,
    PrintLifecycleEvent::StartPage,
    PrintLifecycleEvent::AbortDoc
  });
}

TEST_CASE("Phase 7 v2 invalid device caps fail before any lifecycle call") {
  const auto loaded = load_baked_contract(multi_tile_fixture());
  REQUIRE(loaded);
  RecordingLifecycle lifecycle;

  const PrintJobResult result = render_to_print_lifecycle(
    loaded.value(),
    NativePrintTarget{96.0},
    DeviceCaps{0.0, 300.0, 0.0, 0.0, 1200.0, 900.0, 1200.0, 900.0},
    {},
    "bad caps",
    lifecycle);

  REQUIRE_FALSE(result);
  CHECK(result.error().code == ContractErrorCode::PrintDeviceError);
  CHECK(lifecycle.events.empty());
}

TEST_CASE("Phase 7 v2 preflight render failure fails before StartDoc") {
  const auto loaded = load_baked_contract(image_fixture("iVBORw=="));
  REQUIRE(loaded);
  RecordingLifecycle lifecycle;

  const PrintJobResult result = render_to_print_lifecycle(
    loaded.value(),
    NativePrintTarget{96.0},
    DeviceCaps{300.0, 300.0, 0.0, 0.0, 1200.0, 900.0, 1200.0, 900.0},
    {},
    "bad image",
    lifecycle);

  REQUIRE_FALSE(result);
  CHECK(result.error().code == ContractErrorCode::ImageDecodeError);
  CHECK(lifecycle.events.empty());
}

TEST_CASE("Phase 7 v2 native surface renders barcode and svg as distinct loud stubs") {
  const auto loaded = load_baked_contract(stub_fixture());
  REQUIRE(loaded);

  const auto surface = render_to_native_surface_trace(
    loaded.value(),
    RenderTarget{300.0, 96.0},
    {{"CODE", "ZX42"}},
    false);

  REQUIRE(surface);
  REQUIRE(surface.value().notices.size() == 2);
  CHECK(surface.value().notices[0].type == DegradationNoticeType::StubbedBarcode);
  CHECK(surface.value().notices[1].type == DegradationNoticeType::StubbedSvgArtwork);

  bool saw_barcode = false;
  bool saw_svg = false;
  for (const auto& command : surface.value().commands) {
    if (command.kind == NativeDrawKind::DrawBarcodeStub) {
      saw_barcode = true;
      CHECK(command.label == std::string("BARCODE STUB \xE2\x80\x94 symbology=code128 value=ZX42"));
      CHECK(command.style_signature == "stub-barcode-diagonal-hatch");
    }
    if (command.kind == NativeDrawKind::DrawSvgStub) {
      saw_svg = true;
      CHECK(command.label == "SVG ARTWORK STUB");
      CHECK(command.style_signature == "stub-svg-crosshatch");
    }
  }
  CHECK(saw_barcode);
  CHECK(saw_svg);
}

TEST_CASE("Phase 7 v2 preview and print parity includes stub notices") {
  const auto loaded = load_baked_contract(stub_fixture());
  REQUIRE(loaded);

  const auto print_preview = render_operator_preview_trace(
    loaded.value(),
    RenderTarget{300.0, 96.0},
    {{"CODE", "ZX42"}});
  const auto design_preview = render_design_preview_trace(loaded.value(), RenderTarget{300.0, 96.0});

  REQUIRE(print_preview);
  REQUIRE(design_preview);
  REQUIRE(print_preview.value().notices.size() == 2);
  REQUIRE(design_preview.value().notices.size() == 2);
  CHECK(print_preview.value().notices[0].type == design_preview.value().notices[0].type);
  CHECK(print_preview.value().notices[1].type == design_preview.value().notices[1].type);
  CHECK(print_preview.value().commands[3].style_signature == design_preview.value().commands[3].style_signature);
  CHECK(print_preview.value().commands[4].style_signature == design_preview.value().commands[4].style_signature);
}

TEST_CASE("Phase 7 v2 print lifecycle surfaces stub notices once per job not once per tile") {
  const auto loaded = load_baked_contract(multi_tile_stub_fixture());
  REQUIRE(loaded);
  RecordingLifecycle lifecycle;

  const auto result = render_to_print_lifecycle(
    loaded.value(),
    NativePrintTarget{96.0},
    DeviceCaps{300.0, 300.0, 0.0, 0.0, 1200.0, 900.0, 1200.0, 900.0},
    {},
    "stub job",
    lifecycle);

  REQUIRE(result);
  REQUIRE(result.value().notices.size() == 2);
  CHECK(result.value().notices[0].type == DegradationNoticeType::StubbedBarcode);
  CHECK(result.value().notices[1].type == DegradationNoticeType::StubbedSvgArtwork);
}

TEST_CASE("Phase 7 v2 native image decode failure is typed and loud") {
  const auto loaded = load_baked_contract(image_fixture("iVBORw=="));
  REQUIRE(loaded);

  const auto surface = render_to_native_surface_trace(loaded.value(), RenderTarget{96.0, 96.0}, {}, true);

  REQUIRE_FALSE(surface);
  CHECK(surface.error().code == ContractErrorCode::ImageDecodeError);
}
