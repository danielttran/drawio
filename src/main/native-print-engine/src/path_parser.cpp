#include "print_engine/path.hpp"

#include <cctype>
#include <cstdlib>
#include <algorithm>
#include <cmath>
#include <limits>
#include <string>

namespace print_engine {
namespace {

class PathParser {
public:
  explicit PathParser(std::string_view input) : input_(input) {}

  [[nodiscard]] PathParseResult parse() {
    skip_separators();
    while (pos_ < input_.size()) {
      const char command = consume();
      if (!std::isalpha(static_cast<unsigned char>(command)) || std::islower(static_cast<unsigned char>(command))) {
        return fail("only absolute SVG path commands are supported");
      }

      const int arity = command_arity(command);
      if (arity < 0) {
        return fail("unsupported SVG path command");
      }

      if (command == 'Z') {
        path_.commands.push_back(PathCommand{PathCommandKind::Close, {}});
        skip_separators();
        continue;
      }

      std::vector<double> values;
      for (int index = 0; index < arity; ++index) {
        auto number = parse_number();
        if (!number.has_value) {
          return fail("path command has missing or malformed numeric argument");
        }
        values.push_back(number.value);
      }

      normalize_and_store(command, values);
      skip_separators();
    }

    if (path_.commands.empty()) {
      return fail("path must contain at least one command");
    }
    if (!has_bounds_) {
      return fail("path must contain at least one positioned command");
    }
    path_.bounds = Rect{min_x_, min_y_, max_x_ - min_x_, max_y_ - min_y_};

    return PathParseResult::ok(std::move(path_));
  }

private:
  struct Number {
    bool has_value = false;
    double value = 0.0;
  };

  [[nodiscard]] PathParseResult fail(std::string message) const {
    return PathParseResult::err(ContractError{
      ContractErrorCode::ContractShapeError,
      "$.path.d",
      std::move(message)
    });
  }

  void skip_separators() {
    while (pos_ < input_.size()) {
      const char ch = input_[pos_];
      if (!std::isspace(static_cast<unsigned char>(ch)) && ch != ',') {
        return;
      }
      ++pos_;
    }
  }

  char consume() {
    return input_[pos_++];
  }

  [[nodiscard]] Number parse_number() {
    skip_separators();
    if (pos_ >= input_.size()) {
      return {};
    }

    const char* start = input_.data() + pos_;
    char* end = nullptr;
    const double value = std::strtod(start, &end);
    if (end == start || !std::isfinite(value)) {
      return {};
    }

    pos_ += static_cast<std::size_t>(end - start);
    skip_separators();
    return Number{true, value};
  }

  [[nodiscard]] static int command_arity(char command) {
    switch (command) {
      case 'M':
      case 'L':
        return 2;
      case 'H':
      case 'V':
        return 1;
      case 'C':
        return 6;
      case 'A':
        return 7;
      case 'Z':
        return 0;
      default:
        return -1;
    }
  }

  [[nodiscard]] static PathCommandKind to_kind(char command) {
    switch (command) {
      case 'M':
        return PathCommandKind::MoveTo;
      case 'L':
      case 'H':
      case 'V':
        return PathCommandKind::LineTo;
      case 'C':
        return PathCommandKind::CubicTo;
      case 'A':
        return PathCommandKind::ArcTo;
      default:
        return PathCommandKind::Close;
    }
  }

  void include(Point point) {
    if (!has_bounds_) {
      min_x_ = point.x;
      max_x_ = point.x;
      min_y_ = point.y;
      max_y_ = point.y;
      has_bounds_ = true;
      return;
    }

    min_x_ = std::min(min_x_, point.x);
    max_x_ = std::max(max_x_, point.x);
    min_y_ = std::min(min_y_, point.y);
    max_y_ = std::max(max_y_, point.y);
  }

  void normalize_and_store(char command, const std::vector<double>& values) {
    if (command == 'M') {
      current_ = Point{values[0], values[1]};
      include(current_);
      path_.commands.push_back(PathCommand{PathCommandKind::MoveTo, values});
      return;
    }

    if (command == 'L') {
      current_ = Point{values[0], values[1]};
      include(current_);
      path_.commands.push_back(PathCommand{PathCommandKind::LineTo, values});
      return;
    }

    if (command == 'H') {
      current_ = Point{values[0], current_.y};
      include(current_);
      path_.commands.push_back(PathCommand{PathCommandKind::LineTo, {current_.x, current_.y}});
      return;
    }

    if (command == 'V') {
      current_ = Point{current_.x, values[0]};
      include(current_);
      path_.commands.push_back(PathCommand{PathCommandKind::LineTo, {current_.x, current_.y}});
      return;
    }

    if (command == 'C') {
      include(Point{values[0], values[1]});
      include(Point{values[2], values[3]});
      current_ = Point{values[4], values[5]};
      include(current_);
      path_.commands.push_back(PathCommand{PathCommandKind::CubicTo, values});
      return;
    }

    if (command == 'A') {
      const double rx = std::abs(values[0]);
      const double ry = std::abs(values[1]);
      current_ = Point{values[5], values[6]};
      include(Point{current_.x - rx, current_.y - ry});
      include(Point{current_.x + rx, current_.y + ry});
      path_.commands.push_back(PathCommand{PathCommandKind::ArcTo, values});
    }
  }

  std::string_view input_;
  std::size_t pos_ = 0;
  Point current_;
  bool has_bounds_ = false;
  double min_x_ = std::numeric_limits<double>::infinity();
  double min_y_ = std::numeric_limits<double>::infinity();
  double max_x_ = -std::numeric_limits<double>::infinity();
  double max_y_ = -std::numeric_limits<double>::infinity();
  ParsedPath path_;
};

} // namespace

PathParseResult parse_absolute_svg_path(std::string_view path_data) {
  return PathParser(path_data).parse();
}

} // namespace print_engine
