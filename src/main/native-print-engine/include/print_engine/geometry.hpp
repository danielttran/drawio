#pragma once

#include <cmath>

namespace print_engine {

struct Point {
  double x = 0.0;
  double y = 0.0;
};

struct Size {
  double w = 0.0;
  double h = 0.0;
};

struct Rect {
  double x = 0.0;
  double y = 0.0;
  double w = 0.0;
  double h = 0.0;
};

struct Transform {
  double scale_x = 1.0;
  double scale_y = 1.0;
  double translate_x = 0.0;
  double translate_y = 0.0;

  [[nodiscard]] Point apply(Point point) const {
    return Point{
      (point.x + translate_x) * scale_x,
      (point.y + translate_y) * scale_y
    };
  }

  [[nodiscard]] Rect apply(Rect rect) const {
    const Point origin = apply(Point{rect.x, rect.y});
    return Rect{origin.x, origin.y, rect.w * scale_x, rect.h * scale_y};
  }
};

[[nodiscard]] inline bool nearly_equal(double a, double b, double tolerance) {
  return std::fabs(a - b) <= tolerance;
}

} // namespace print_engine
