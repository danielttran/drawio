// dash_pattern.hpp -- pure host-side dash-array normalization for the GDI+
// pen (no Win32/GDI+ types, so the logic is testable on every CI runner; the
// Win32 sink feeds the result straight into Pen::SetDashPattern).
#ifndef PRINT_ENGINE_HOST_DASH_PATTERN_HPP
#define PRINT_ENGINE_HOST_DASH_PATTERN_HPP

#include <algorithm>
#include <cstddef>
#include <vector>

namespace print_engine::host {

// GDI+ dash-array elements are MULTIPLES OF PEN WIDTH; the contract carries
// absolute units (SVG stroke-dasharray semantics, already pre-multiplied by
// stroke width on the producer side). Feeding raw values printed dash lengths
// proportional to width^2 -- divide by the stroke width so device dash
// length == value * scale.
//
// SVG repeat semantics also say an ODD-count dasharray is repeated to even
// length ("3 1 2" dashes like "3 1 2 3 1 2"). GDI+ does not document its
// odd-count behavior (and some renderers reject it outright), so double the
// array defensively before handing it to SetDashPattern -- the dash phase
// then matches SVG exactly instead of depending on undocumented GDI+
// behavior.
inline std::vector<float> gdiplus_dash_pattern(const std::vector<double>& dash,
                                               double stroke_width) {
  const double width_divisor = std::max(stroke_width, 1e-6);
  std::vector<float> out;
  out.reserve(dash.size() * 2);
  for (const double value : dash) {
    out.push_back(static_cast<float>(value / width_divisor));
  }
  if (out.size() % 2 != 0) {
    const std::size_t n = out.size();
    out.reserve(n * 2);  // no reallocation while self-appending below
    for (std::size_t i = 0; i < n; ++i) {
      out.push_back(out[i]);
    }
  }
  return out;
}

}  // namespace print_engine::host

#endif  // PRINT_ENGINE_HOST_DASH_PATTERN_HPP
