#pragma once

#include "print_engine/contract.hpp"
#include "print_engine/errors.hpp"
#include "print_engine/geometry.hpp"
#include "print_engine/path.hpp"
#include "print_engine/result.hpp"

#include <string>
#include <map>
#include <vector>

namespace print_engine {

struct RenderTarget {
  double dpi = 96.0;
  double contract_units_per_inch = 96.0;
};

enum class EmittedKind {
  StartDocument,
  StartTile,
  Clip,
  Path,
  Text,
  Image,
  Svg,
  Barcode,
  EndTile,
  EndDocument
};

struct EmittedCommand {
  EmittedKind kind;
  Rect contract_box;
  Rect device_box;
  std::vector<PathCommand> path_commands;
  std::string label;
  std::string style_signature;
  std::string font_family;
  double font_size_px = 0.0;
  bool degradation_notice = false;
  int raster_width_px = 0;
  int raster_height_px = 0;
};

struct RenderTrace {
  std::vector<EmittedCommand> commands;
  std::vector<DegradationNotice> notices;
};

using RenderResult = Result<RenderTrace, ContractError>;

[[nodiscard]] Transform make_world_transform(const RenderTarget& target, const TileSummary& tile);
[[nodiscard]] RenderResult render_to_trace(const BakedDocument& document, const RenderTarget& target);
[[nodiscard]] RenderResult render_to_trace(
  const BakedDocument& document,
  const RenderTarget& target,
  const std::map<std::string, std::string>& merge_values,
  bool design_time_preview);
[[nodiscard]] RenderResult render_print_trace(
  const BakedDocument& document,
  const RenderTarget& target,
  const std::map<std::string, std::string>& merge_values);
[[nodiscard]] RenderResult render_operator_preview_trace(
  const BakedDocument& document,
  const RenderTarget& target,
  const std::map<std::string, std::string>& merge_values);
[[nodiscard]] RenderResult render_design_preview_trace(
  const BakedDocument& document,
  const RenderTarget& target);

} // namespace print_engine
