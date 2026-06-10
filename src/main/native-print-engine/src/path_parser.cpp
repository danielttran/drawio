#include "print_engine/path.hpp"

#include <cctype>
#include <charconv>
#include <cstdlib>
#include <algorithm>
#include <cmath>
#include <limits>
#include <string>

namespace print_engine {
namespace {

inline constexpr double Pi = 3.14159265358979323846264338327950288;

[[nodiscard]] double radians(double degrees) {
  return degrees * Pi / 180.0;
}

[[nodiscard]] Point rotate(Point p, double cos_phi, double sin_phi) {
  return Point{
    p.x * cos_phi - p.y * sin_phi,
    p.x * sin_phi + p.y * cos_phi
  };
}

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

    // from_chars, not strtod: locale-independent (strtod parses "10.5" as
    // 10 under an LC_NUMERIC comma locale -- a silent geometry corruption
    // if this library is ever embedded in a locale-initialized host).
    const char* start = input_.data() + pos_;
    const char* limit = input_.data() + input_.size();
    // SVG numbers allow an explicit leading '+', which from_chars does not.
    const char* numeric_start = (start < limit && *start == '+') ? start + 1
                                                                 : start;
    double value = 0.0;
    const auto [end, ec] = std::from_chars(numeric_start, limit, value);
    if (end == numeric_start || ec != std::errc() || !std::isfinite(value)) {
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

  // Include the EXACT extent of one cubic segment: endpoints plus the
  // curve's axis extrema (roots of B'(t) per axis), never the control hull.
  void include_cubic_extent(Point p0, Point c1, Point c2, Point p3) {
    include(p0);
    include(p3);
    const auto point_at = [&](double t) {
      const double mt = 1.0 - t;
      return Point{
        mt * mt * mt * p0.x + 3.0 * mt * mt * t * c1.x +
            3.0 * mt * t * t * c2.x + t * t * t * p3.x,
        mt * mt * mt * p0.y + 3.0 * mt * mt * t * c1.y +
            3.0 * mt * t * t * c2.y + t * t * t * p3.y};
    };
    const auto axis_roots = [&](double a0, double a1, double a2, double a3) {
      // B'(t)/3 = (a1-a0) + 2(a2-2a1+a0)t + (a3-3a2+3a1-a0)t^2
      const double a = a3 - 3.0 * a2 + 3.0 * a1 - a0;
      const double b = 2.0 * (a2 - 2.0 * a1 + a0);
      const double c = a1 - a0;
      const auto eval_at = [&](double t) {
        if (t > 0.0 && t < 1.0) include(point_at(t));
      };
      if (std::abs(a) < 1e-12) {
        if (std::abs(b) > 1e-12) eval_at(-c / b);
        return;
      }
      const double disc = b * b - 4.0 * a * c;
      if (disc < 0.0) return;
      const double sq = std::sqrt(disc);
      eval_at((-b + sq) / (2.0 * a));
      eval_at((-b - sq) / (2.0 * a));
    };
    axis_roots(p0.x, c1.x, c2.x, p3.x);
    axis_roots(p0.y, c1.y, c2.y, p3.y);
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
      // EXACT cubic extent (not the control-point hull): the hull
      // over-estimates by up to ~30% of the control offset, which fired
      // spurious HardwareMarginClip notices for curve-bulgy shapes (cloud,
      // ellipse-ish paths) sitting flush at a page edge.
      const Point start = current_;
      const Point c1{values[0], values[1]};
      const Point c2{values[2], values[3]};
      current_ = Point{values[4], values[5]};
      include_cubic_extent(start, c1, c2, current_);
      path_.commands.push_back(PathCommand{PathCommandKind::CubicTo, values});
      return;
    }

    if (command == 'A') {
      // True arc extent: the ellipse is bounded by center +- r, and the
      // center can sit up to r away from the END point, so the old
      // `end +- r` box UNDER-estimated large-arc sweeps by up to r (real
      // ink silently outside the box -> missed HardwareMarginClip and
      // wrongly-clipped content) and over-estimated short arcs by up to 2r
      // (spurious clip notices). Use the exact cubic expansion the
      // renderer itself draws and take its control-point hull -- a tight
      // conservative bound that can never under-estimate the drawn curve.
      const Point start = current_;
      current_ = Point{values[5], values[6]};
      const auto cubics = arc_to_cubic_beziers(start, values);
      if (cubics.empty()) {
        // Degenerate arc (zero radius / coincident endpoints): renders as
        // a straight line to the endpoint.
        include(start);
        include(current_);
      } else {
        include(start);
        Point seg_start = start;
        for (const auto& c : cubics) {
          include_cubic_extent(seg_start, c.c1, c.c2, c.end);
          seg_start = c.end;
        }
      }
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

std::vector<CubicBezier> arc_to_cubic_beziers(
    Point start,
    const std::vector<double>& arc_values) {
  if (arc_values.size() < 7) {
    return {};
  }

  double rx = std::abs(arc_values[0]);
  double ry = std::abs(arc_values[1]);
  const double phi = radians(arc_values[2]);
  const bool large_arc = std::abs(arc_values[3]) > 0.5;
  const bool sweep = std::abs(arc_values[4]) > 0.5;
  const Point end{arc_values[5], arc_values[6]};
  if (rx == 0.0 || ry == 0.0 || (start.x == end.x && start.y == end.y)) {
    return {};
  }

  const double cos_phi = std::cos(phi);
  const double sin_phi = std::sin(phi);
  const double dx = (start.x - end.x) / 2.0;
  const double dy = (start.y - end.y) / 2.0;
  const Point p1p{
    cos_phi * dx + sin_phi * dy,
    -sin_phi * dx + cos_phi * dy
  };

  const double lambda = (p1p.x * p1p.x) / (rx * rx) + (p1p.y * p1p.y) / (ry * ry);
  if (lambda > 1.0) {
    const double scale = std::sqrt(lambda);
    rx *= scale;
    ry *= scale;
  }

  const double rx2 = rx * rx;
  const double ry2 = ry * ry;
  const double x1p2 = p1p.x * p1p.x;
  const double y1p2 = p1p.y * p1p.y;
  const double denom = rx2 * y1p2 + ry2 * x1p2;
  if (denom == 0.0) {
    return {};
  }
  const double sign = large_arc == sweep ? -1.0 : 1.0;
  const double factor = sign * std::sqrt(std::max(0.0, (rx2 * ry2 - rx2 * y1p2 - ry2 * x1p2) / denom));
  const Point cp{
    factor * (rx * p1p.y / ry),
    factor * (-ry * p1p.x / rx)
  };
  const Point center{
    cos_phi * cp.x - sin_phi * cp.y + (start.x + end.x) / 2.0,
    sin_phi * cp.x + cos_phi * cp.y + (start.y + end.y) / 2.0
  };

  auto angle_between = [](Point u, Point v) {
    const double dot = u.x * v.x + u.y * v.y;
    const double len = std::sqrt((u.x * u.x + u.y * u.y) * (v.x * v.x + v.y * v.y));
    const double ratio = len == 0.0 ? 1.0 : std::clamp(dot / len, -1.0, 1.0);
    const double sign = (u.x * v.y - u.y * v.x) < 0.0 ? -1.0 : 1.0;
    return sign * std::acos(ratio);
  };

  const Point v1{(p1p.x - cp.x) / rx, (p1p.y - cp.y) / ry};
  const Point v2{(-p1p.x - cp.x) / rx, (-p1p.y - cp.y) / ry};
  double theta1 = angle_between(Point{1.0, 0.0}, v1);
  double delta = angle_between(v1, v2);
  if (!sweep && delta > 0.0) {
    delta -= 2.0 * Pi;
  } else if (sweep && delta < 0.0) {
    delta += 2.0 * Pi;
  }

  const int segments = std::max(1, static_cast<int>(std::ceil(std::abs(delta) / (Pi / 2.0))));
  const double delta_segment = delta / static_cast<double>(segments);
  std::vector<CubicBezier> cubics;
  cubics.reserve(static_cast<std::size_t>(segments));
  for (int i = 0; i < segments; ++i) {
    const double t1 = theta1 + static_cast<double>(i) * delta_segment;
    const double t2 = t1 + delta_segment;
    const double alpha = 4.0 / 3.0 * std::tan((t2 - t1) / 4.0);
    const Point p0{rx * std::cos(t1), ry * std::sin(t1)};
    const Point p3{rx * std::cos(t2), ry * std::sin(t2)};
    const Point c1{p0.x - alpha * rx * std::sin(t1), p0.y + alpha * ry * std::cos(t1)};
    const Point c2{p3.x + alpha * rx * std::sin(t2), p3.y - alpha * ry * std::cos(t2)};
    const Point rc1 = rotate(c1, cos_phi, sin_phi);
    const Point rc2 = rotate(c2, cos_phi, sin_phi);
    const Point rend = rotate(p3, cos_phi, sin_phi);
    cubics.push_back(CubicBezier{
      Point{rc1.x + center.x, rc1.y + center.y},
      Point{rc2.x + center.x, rc2.y + center.y},
      Point{rend.x + center.x, rend.y + center.y}
    });
  }
  return cubics;
}

} // namespace print_engine
