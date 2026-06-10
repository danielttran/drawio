#pragma once

#include "print_engine/contract.hpp"
#include "print_engine/errors.hpp"
#include "print_engine/geometry.hpp"
#include "print_engine/renderer.hpp"
#include "print_engine/result.hpp"

#include <map>
#include <string>
#include <vector>

namespace print_engine {

struct DeviceCaps {
  double log_pixels_x = 300.0;
  double log_pixels_y = 300.0;
  double physical_offset_x = 0.0;
  double physical_offset_y = 0.0;
  double physical_width = 0.0;
  double physical_height = 0.0;
  double horz_res = 0.0;
  double vert_res = 0.0;
};

struct NativePrintTarget {
  double contract_units_per_inch = 96.0;
};

enum class NativeDrawKind {
  ConfigureSurface,
  BeginContainer,
  EndContainer,
  DrawPath,
  DrawText,
  DrawImage,
  DrawBarcodeStub,
  DrawSvgStub
};

struct NativeDrawCommand {
  NativeDrawKind kind;
  Rect contract_box;
  Rect device_box;
  std::string label;
  std::string style_signature;
  std::vector<RichParagraph> rich_paragraphs;
};

struct NativeSurfaceTrace {
  std::vector<NativeDrawCommand> commands;
  std::vector<DegradationNotice> notices;
};

enum class PrintLifecycleEvent {
  StartDoc,
  StartPage,
  EndPage,
  EndDoc,
  AbortDoc
};

class PrintLifecycle {
public:
  virtual ~PrintLifecycle() = default;

  virtual Result<Unit, ContractError> start_doc(const std::string& job_label) = 0;
  virtual Result<Unit, ContractError> start_page(const std::string& page_id, std::size_t tile_index) = 0;
  virtual Result<Unit, ContractError> end_page(const std::string& page_id, std::size_t tile_index) = 0;
  virtual void end_doc() = 0;
  virtual void abort_doc() = 0;
};

struct PrintJobTrace {
  std::vector<PrintLifecycleEvent> events;
  std::vector<Transform> tile_transforms;
  std::vector<DegradationNotice> notices;
};

using NativeSurfaceResult = Result<NativeSurfaceTrace, ContractError>;
using PrintJobResult = Result<PrintJobTrace, ContractError>;

[[nodiscard]] Transform make_printer_world_transform(
  const NativePrintTarget& target,
  const DeviceCaps& caps,
  const TileSummary& tile);

[[nodiscard]] bool tile_hits_hardware_margin(
  const NativePrintTarget& target,
  const DeviceCaps& caps,
  const TileSummary& tile);

// True when any paint node that intersects this tile extends into the
// device's non-printable margin (content the band blit cannot reach).
[[nodiscard]] bool tile_content_hits_hardware_margin(
  const NativePrintTarget& target,
  const DeviceCaps& caps,
  const PageSummary& page,
  const TileSummary& tile);

[[nodiscard]] NativeSurfaceResult render_to_native_surface_trace(
  const BakedDocument& document,
  const RenderTarget& target,
  const std::map<std::string, std::string>& merge_values,
  bool design_time_preview);

[[nodiscard]] PrintJobResult render_to_print_lifecycle(
  const BakedDocument& document,
  const NativePrintTarget& target,
  const DeviceCaps& caps,
  const std::map<std::string, std::string>& merge_values,
  const std::string& job_label,
  PrintLifecycle& lifecycle);

} // namespace print_engine
