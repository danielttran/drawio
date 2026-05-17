#pragma once

#include "print_engine/errors.hpp"
#include "print_engine/geometry.hpp"
#include "print_engine/result.hpp"

#include <string>
#include <string_view>
#include <vector>

namespace print_engine {

enum class PathCommandKind {
  MoveTo,
  LineTo,
  CubicTo,
  ArcTo,
  Close
};

struct PathCommand {
  PathCommandKind kind;
  std::vector<double> values;
};

struct ParsedPath {
  std::vector<PathCommand> commands;
  Rect bounds;
};

using PathParseResult = Result<ParsedPath, ContractError>;

[[nodiscard]] PathParseResult parse_absolute_svg_path(std::string_view path_data);

} // namespace print_engine
