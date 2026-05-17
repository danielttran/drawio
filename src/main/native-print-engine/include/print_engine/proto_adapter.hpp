#pragma once

// Layer 2 — engine-side protocol adapter (spec §10.2). A thin layer mapping
// protocol ops to the existing P1–P7 entry points and the Result taxonomy.
//
// Split so the engine still builds/tests with zero host present (INV-1):
//  - ProtoDispatcher is PURE protocol + contract logic. It depends only on
//    engine types and an injected EngineServices. Tested against synthetic
//    contract fixtures with a fake services impl — no transport, no Win32.
//  - The device-touching surface (printer enumeration, real raster preview,
//    real printer-DC print) is the EngineServices interface; its production
//    Win32/GDI+ implementation is the separate rendering workstream. The
//    standalone executable wires a real impl + a transport.

#include "print_engine/contract.hpp"
#include "print_engine/errors.hpp"
#include "print_engine/proto.hpp"
#include "print_engine/result.hpp"

#include <map>
#include <string>
#include <vector>

namespace print_engine::proto {

// ---- Device-owned data the engine reports; the UI renders from it (§3.3) ----
struct StockInfo {
  std::string id;
  std::string name;
  long width_microns = 0;
  long height_microns = 0;
  double dpi_x = 0.0;
  double dpi_y = 0.0;
};

struct PrinterInfo {
  std::string id;
  std::string name;
  std::string default_stock_id;
  std::vector<StockInfo> stocks;
};

struct PreviewOutput {
  std::vector<std::uint8_t> png;  // travels as the correlated 0x02 frame
  int width_px = 0;
  int height_px = 0;
  std::vector<DegradationNotice> notices;
};

struct PrintOutput {
  std::string job_id;
  std::vector<DegradationNotice> notices;
  Json job_log;  // structured record; merged values redacted default-off (§7)
};

// The device-touching surface the engine owns (§1). Production impl is
// Win32/GDI+ (separate workstream); tests inject a fake. Pure ops
// (GetContractFields) are intentionally NOT here — they need no device.
class EngineServices {
 public:
  virtual ~EngineServices() = default;
  virtual std::vector<PrinterInfo> enumerate_printers() = 0;
  virtual Result<PreviewOutput, ContractError> render_preview(
      const BakedDocument& doc,
      const std::map<std::string, std::string>& merge, double dpi) = 0;
  virtual Result<PrintOutput, ContractError> print(
      const BakedDocument& doc,
      const std::map<std::string, std::string>& merge,
      const std::string& printer_id, const std::string& stock_id,
      int copies) = 0;
};

struct DispatchResult {
  Json control;                          // the response control message
  bool has_binary = false;               // a 0x02 frame must follow
  std::uint32_t binary_stream_id = 0;    // == PreviewResult.imageStreamId
  std::vector<std::uint8_t> binary;      // the 0x02 payload
  bool shutdown = false;                 // dispatcher saw a Shutdown op
};

// One per connection. Owns the ProtoSession (handshake/ordering/version gate)
// and a single-flight Print guard (§3.4). Holds no file handle: it reads a
// contractRef fully per op, so ReleaseContract acknowledges immediately (§6).
class ProtoDispatcher {
 public:
  explicit ProtoDispatcher(EngineServices& services);

  // Decode → gate → execute → encode. `request` is a decoded control message.
  [[nodiscard]] DispatchResult handle(const Json& request);

  [[nodiscard]] const ProtoSession& session() const { return session_; }

 private:
  EngineServices& services_;
  ProtoSession session_;
  bool print_in_flight_ = false;
  std::uint32_t next_stream_id_ = 1;

  DispatchResult error_reply(const Json& request, ProtoErrorKind kind,
                             const std::string& detail) const;
};

// Shared helpers (also used by the executable and tests).
[[nodiscard]] Json notice_to_json(const DegradationNotice& n);

// Resolve a contractRef object ({path:...} | {inline:...}) to contract JSON
// text. The engine validates everything it consumes regardless of source
// (§3.5) — path-passing is a transport optimization, not trust delegation.
[[nodiscard]] Result<std::string, ContractError> read_contract_ref(
    const Json& contract_ref);

}  // namespace print_engine::proto
