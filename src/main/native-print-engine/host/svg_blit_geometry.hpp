// svg_blit_geometry.hpp -- pure host-side geometry for embedded-SVG blits
// (no Win32/GDI+ types, so the math is testable on every CI runner).
//
// The rasterizer shim STRETCHES an SVG to exactly the pixel box it is asked
// for (see svg_rasterizer_abi.h / the resvg shim); aspect policy lives HERE:
//  * aspect:"fill"      -> rasterize at the full device_box size.
//  * aspect:"preserve"  -> compute the aspect-fit sub-rect of device_box
//                          first (same math as the image sink's
//                          image_destination), rasterize at THAT size.
// Either way the chosen rect is snapped to whole device pixels so the raster
// is blitted strictly 1:1 -- the renderer's deterministic bytes reach the
// page unresampled (INV-5), instead of an lround-sized raster being smeared
// into a fractional destination rect.
#ifndef PRINT_ENGINE_HOST_SVG_BLIT_GEOMETRY_HPP
#define PRINT_ENGINE_HOST_SVG_BLIT_GEOMETRY_HPP

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <optional>
#include <string>

namespace print_engine::host {

// Integer device-pixel rect: the raster is produced at exactly w x h and
// blitted with its top-left at (x, y), 1:1.
struct SvgBlitRect {
  int x = 0;
  int y = 0;
  int w = 1;
  int h = 1;
};

// Snap a (possibly aspect-fitted) fractional destination rect to whole device
// pixels. lround keeps the rect centered on the fractional box (max +-0.5px
// shift per edge); sizes are clamped to >= 1 so a degenerate box still yields
// a renderable raster.
[[nodiscard]] inline SvgBlitRect snap_svg_blit_rect(double x, double y,
                                                    double w, double h) {
  SvgBlitRect out;
  out.x = static_cast<int>(std::lround(x));
  out.y = static_cast<int>(std::lround(y));
  out.w = static_cast<int>(std::max(1L, std::lround(w)));
  out.h = static_cast<int>(std::max(1L, std::lround(h)));
  return out;
}

// Aspect-fit + snap: largest intrinsic_w:intrinsic_h rect centered inside the
// box (the SVG semantics of preserveAspectRatio="xMidYMid meet", and exactly
// what the image sink's image_destination does for aspect:"preserve").
// Non-positive intrinsic dims mean "no usable intrinsic ratio" -> full box.
[[nodiscard]] inline SvgBlitRect svg_blit_rect_preserve(double box_x,
                                                        double box_y,
                                                        double box_w,
                                                        double box_h,
                                                        double intrinsic_w,
                                                        double intrinsic_h) {
  if (intrinsic_w <= 0.0 || intrinsic_h <= 0.0 || box_w <= 0.0 ||
      box_h <= 0.0) {
    return snap_svg_blit_rect(box_x, box_y, box_w, box_h);
  }
  const double scale =
      std::min(box_w / intrinsic_w, box_h / intrinsic_h);
  const double w = intrinsic_w * scale;
  const double h = intrinsic_h * scale;
  return snap_svg_blit_rect(box_x + (box_w - w) / 2.0,
                            box_y + (box_h - h) / 2.0, w, h);
}

namespace detail {

// Value of an XML attribute inside a start tag's attribute substring, or
// nullopt. Requires whitespace before the name and '=' + quote after it, so
// `stroke-width=` never matches a `width` lookup and quoted VALUES (e.g.
// style="width:10px") are skipped.
[[nodiscard]] inline std::optional<std::string> svg_tag_attr(
    const std::string& tag, const std::string& name) {
  std::size_t pos = 0;
  while ((pos = tag.find(name, pos)) != std::string::npos) {
    const bool boundary_before =
        pos > 0 &&
        std::isspace(static_cast<unsigned char>(tag[pos - 1])) != 0;
    std::size_t i = pos + name.size();
    while (i < tag.size() &&
           std::isspace(static_cast<unsigned char>(tag[i])) != 0) {
      ++i;
    }
    if (!boundary_before || i >= tag.size() || tag[i] != '=') {
      pos += name.size();
      continue;
    }
    ++i;
    while (i < tag.size() &&
           std::isspace(static_cast<unsigned char>(tag[i])) != 0) {
      ++i;
    }
    if (i >= tag.size() || (tag[i] != '"' && tag[i] != '\'')) {
      pos += name.size();
      continue;
    }
    const char quote = tag[i++];
    const std::size_t end = tag.find(quote, i);
    if (end == std::string::npos) {
      return std::nullopt;
    }
    return tag.substr(i, end - i);
  }
  return std::nullopt;
}

// Attribute substring (between the element name and '>') of the ROOT <svg>
// element, or empty when the document does not start with one.
[[nodiscard]] inline std::string root_svg_tag(const std::string& svg) {
  std::size_t i = 0;
  while ((i = svg.find('<', i)) != std::string::npos) {
    ++i;
    if (i >= svg.size()) {
      break;
    }
    if (svg[i] == '!' || svg[i] == '?' || svg[i] == '/') {
      continue;  // doctype/PI/comment-ish prologue; keep scanning
    }
    const std::size_t start = i;
    auto is_name_char = [](char ch) {
      const unsigned char c = static_cast<unsigned char>(ch);
      return std::isalnum(c) != 0 || ch == '_' || ch == '-' || ch == '.' ||
             ch == ':';
    };
    while (i < svg.size() && is_name_char(svg[i])) {
      ++i;
    }
    if (i == start) {
      continue;
    }
    const std::string name = svg.substr(start, i - start);
    const std::size_t colon = name.rfind(':');
    const std::string local =
        colon == std::string::npos ? name : name.substr(colon + 1);
    if (local != "svg") {
      return std::string();  // first element is not the svg root
    }
    const std::size_t end = svg.find('>', i);
    return end == std::string::npos ? std::string() : svg.substr(i, end - i);
  }
  return std::string();
}

// Numeric value of an SVG length attribute, ignoring a unit suffix (only the
// RATIO matters here and width/height share their unit in practice).
// Percentages and non-positive/garbage values yield nullopt -- a percent
// width has no intrinsic dimension.
[[nodiscard]] inline std::optional<double> parse_svg_length(
    const std::optional<std::string>& value) {
  if (!value || value->find('%') != std::string::npos) {
    return std::nullopt;
  }
  char* end = nullptr;
  const double parsed = std::strtod(value->c_str(), &end);
  if (end == value->c_str() || !std::isfinite(parsed) || parsed <= 0.0) {
    return std::nullopt;
  }
  return parsed;
}

}  // namespace detail

// Best-effort intrinsic size of the ROOT <svg> element: width/height
// attributes first, else the viewBox dimensions. Returns false when neither
// yields a usable positive ratio (missing/percent) -- per the CSS
// replaced-element rules such an SVG has NO intrinsic aspect ratio and the
// destination box legitimately defines its geometry (stretch IS the faithful
// browser behavior, so the caller treats "preserve" as "fill" then).
[[nodiscard]] inline bool svg_intrinsic_size(const std::string& svg,
                                             double& out_w, double& out_h) {
  const std::string tag = detail::root_svg_tag(svg);
  if (tag.empty()) {
    return false;
  }
  const auto width = detail::parse_svg_length(detail::svg_tag_attr(tag, "width"));
  const auto height =
      detail::parse_svg_length(detail::svg_tag_attr(tag, "height"));
  if (width && height) {
    out_w = *width;
    out_h = *height;
    return true;
  }
  if (const auto view_box = detail::svg_tag_attr(tag, "viewBox")) {
    double nums[4] = {0.0, 0.0, 0.0, 0.0};
    const char* p = view_box->c_str();
    int n = 0;
    for (; n < 4; ++n) {
      while (*p == ',' ||
             std::isspace(static_cast<unsigned char>(*p)) != 0) {
        ++p;
      }
      char* end = nullptr;
      const double parsed = std::strtod(p, &end);
      if (end == p) {
        break;
      }
      nums[n] = parsed;
      p = end;
    }
    if (n == 4 && std::isfinite(nums[2]) && std::isfinite(nums[3]) &&
        nums[2] > 0.0 && nums[3] > 0.0) {
      out_w = nums[2];
      out_h = nums[3];
      return true;
    }
  }
  return false;
}

}  // namespace print_engine::host

#endif  // PRINT_ENGINE_HOST_SVG_BLIT_GEOMETRY_HPP
