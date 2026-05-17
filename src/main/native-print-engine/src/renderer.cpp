#include "print_engine/renderer.hpp"

#include <string>
#include <sstream>
#include <cmath>
#include <algorithm>

namespace print_engine {

Transform make_world_transform(const RenderTarget& target, const TileSummary& tile) {
  const double scale = target.dpi / target.contract_units_per_inch;
  return Transform{scale, scale, -tile.origin.x, -tile.origin.y};
}

namespace {

[[nodiscard]] std::vector<std::string> fit_lines(
    const std::string& value,
    double font_size,
    double box_width,
    const std::string& wrap) {
  const double char_width = font_size * 0.6;
  const std::size_t max_chars = box_width <= 0.0 ? 0 : static_cast<std::size_t>(box_width / char_width);
  if (wrap == "none" || max_chars == 0 || value.size() <= max_chars) {
    return {value};
  }

  std::vector<std::string> lines;
  std::istringstream words(value);
  std::string word;
  std::string current;
  while (words >> word) {
    if (word.size() > max_chars) {
      if (!current.empty()) {
        lines.push_back(current);
      }
      lines.push_back(word);
      current.clear();
      continue;
    }
    const std::size_t next_size = current.empty() ? word.size() : current.size() + 1 + word.size();
    if (next_size > max_chars && !current.empty()) {
      lines.push_back(current);
      current = word;
    } else {
      if (!current.empty()) {
        current += ' ';
      }
      current += word;
    }
  }
  if (!current.empty()) {
    lines.push_back(current);
  }
  return lines.empty() ? std::vector<std::string>{""} : lines;
}

[[nodiscard]] std::string join_lines(const std::vector<std::string>& lines) {
  std::ostringstream label;
  for (std::size_t index = 0; index < lines.size(); ++index) {
    if (index > 0) {
      label << "\n";
    }
    label << lines[index];
  }
  return label.str();
}

[[nodiscard]] double fitted_height(const std::vector<std::string>& lines, double font_size) {
  return static_cast<double>(lines.size()) * font_size * 1.2;
}

} // namespace

RenderResult render_to_trace(
    const BakedDocument& document,
    const RenderTarget& target,
    const std::map<std::string, std::string>& merge_values,
    bool design_time_preview) {
  RenderTrace trace;

  for (const auto& page : document.pages) {
    for (const auto& tile : page.tiles) {
      const Transform transform = make_world_transform(target, tile);
      const Rect tile_rect{tile.origin.x, tile.origin.y, tile.size.w, tile.size.h};

      trace.commands.push_back(EmittedCommand{
        EmittedKind::StartTile,
        tile_rect,
        transform.apply(tile_rect),
        {},
        page.id
      });
      trace.commands.push_back(EmittedCommand{
        EmittedKind::Clip,
        tile_rect,
        transform.apply(tile_rect),
        {},
        "tile-clip"
      });

      for (const auto& node : page.paint) {
        if (node.kind == PaintKind::Text) {
          std::vector<std::string> lines = node.static_lines;
          double font_size = node.font_size_px;
          bool degradation = false;

          if (node.text_content_type == TextContentType::Merge) {
            std::string value = node.merge_sample;
            if (!design_time_preview) {
              const auto found = merge_values.find(node.merge_key);
              if (found == merge_values.end()) {
                return RenderResult::err(ContractError{
                  ContractErrorCode::MergeResolveError,
                  node.merge_key,
                  "missing merge value"
                });
              }
              value = found->second;
            }

            if (value.size() > static_cast<std::size_t>(node.merge_max_len)) {
              return RenderResult::err(ContractError{
                ContractErrorCode::MergeOverflowError,
                node.merge_key,
                "merge value exceeds maxLen"
              });
            }

            lines = fit_lines(value, font_size, node.box.w, node.merge_wrap);
            while (fitted_height(lines, font_size) > node.box.h && node.merge_overflow == "shrink" && font_size > node.shrink_floor_px) {
              font_size = std::max(node.shrink_floor_px, font_size - 0.5);
              lines = fit_lines(value, font_size, node.box.w, node.merge_wrap);
            }
            if (fitted_height(lines, font_size) > node.box.h) {
              if (node.merge_overflow == "reject" || node.merge_overflow == "shrink") {
                return RenderResult::err(ContractError{
                  ContractErrorCode::MergeOverflowError,
                  node.merge_key,
                  "merge text does not fit box"
                });
              }
              degradation = true;
            }
          }

          const double line_height = font_size * 1.2;
          const double text_height = line_height * static_cast<double>(lines.size());
          double y = node.box.y;
          if (node.align_v == "middle") {
            y += (node.box.h - text_height) / 2.0;
          } else if (node.align_v == "bottom") {
            y += node.box.h - text_height;
          }
          const double baseline_correction = font_size * 0.8;
          const Rect text_box{node.box.x, y + baseline_correction, node.box.w, text_height};
          const bool missing_font = node.font_family == "DefinitelyMissingFont";

          trace.commands.push_back(EmittedCommand{
            EmittedKind::Text,
            text_box,
            transform.apply(text_box),
            {},
            join_lines(lines),
            missing_font ? "Arial" : node.font_family,
            font_size,
            missing_font || degradation
          });
          continue;
        }

        if (node.kind == PaintKind::Barcode) {
          std::string value = node.barcode_static_value;
          if (node.barcode_value_type == BarcodeValueType::Merge) {
            value = node.merge_sample;
            if (!design_time_preview) {
              const auto found = merge_values.find(node.merge_key);
              if (found == merge_values.end()) {
                return RenderResult::err(ContractError{
                  ContractErrorCode::MergeResolveError,
                  node.merge_key,
                  "missing barcode merge value"
                });
              }
              value = found->second;
            }
            if (value.size() > static_cast<std::size_t>(node.merge_max_len)) {
              return RenderResult::err(ContractError{
                ContractErrorCode::MergeOverflowError,
                node.merge_key,
                "barcode merge value exceeds maxLen"
              });
            }
          }
          if (value.find('!') != std::string::npos) {
            return RenderResult::err(ContractError{
              ContractErrorCode::BarcodeEncodeError,
              node.barcode_symbology,
              "stub barcode renderer cannot encode value"
            });
          }
          if (node.barcode_symbology == "fixed-dpi-raster") {
            return RenderResult::err(ContractError{
              ContractErrorCode::BarcodeRepresentationError,
              node.barcode_symbology,
              "barcode renderer returned fixed-DPI raster representation"
            });
          }
          trace.commands.push_back(EmittedCommand{
            EmittedKind::Barcode,
            node.box,
            transform.apply(node.box),
            {},
            value,
            {},
            0.0,
            false,
            0,
            0
          });
          continue;
        }

        if (node.kind == PaintKind::Image || node.kind == PaintKind::Svg) {
          const Rect device_box = transform.apply(node.box);
          trace.commands.push_back(EmittedCommand{
            node.kind == PaintKind::Image ? EmittedKind::Image : EmittedKind::Svg,
            node.box,
            device_box,
            {},
            node.kind == PaintKind::Image ? node.image_aspect : node.svg_aspect,
            {},
            0.0,
            false,
            static_cast<int>(std::lround(device_box.w)),
            static_cast<int>(std::lround(device_box.h))
          });
          continue;
        }

        if (node.kind != PaintKind::Path) {
          continue;
        }

        auto parsed = parse_absolute_svg_path(node.path_data);
        if (!parsed) {
          return RenderResult::err(parsed.error());
        }

        trace.commands.push_back(EmittedCommand{
          EmittedKind::Path,
          node.box,
          transform.apply(node.box),
          parsed.value().commands,
          node.has_stroke ? "path-stroked" : "path",
          {},
          0.0,
          false
        });
      }

      trace.commands.push_back(EmittedCommand{
        EmittedKind::EndTile,
        tile_rect,
        transform.apply(tile_rect),
        {},
        page.id
      });
    }
  }

  return RenderResult::ok(std::move(trace));
}

RenderResult render_to_trace(const BakedDocument& document, const RenderTarget& target) {
  return render_to_trace(document, target, {}, true);
}

RenderResult render_print_trace(
    const BakedDocument& document,
    const RenderTarget& target,
    const std::map<std::string, std::string>& merge_values) {
  auto rendered = render_to_trace(document, target, merge_values, false);
  if (!rendered) {
    return rendered;
  }

  RenderTrace wrapped;
  wrapped.commands.push_back(EmittedCommand{EmittedKind::StartDocument, {}, {}, {}, "StartDoc"});
  wrapped.commands.insert(
    wrapped.commands.end(),
    rendered.value().commands.begin(),
    rendered.value().commands.end());
  wrapped.commands.push_back(EmittedCommand{EmittedKind::EndDocument, {}, {}, {}, "EndDoc"});
  return RenderResult::ok(std::move(wrapped));
}

RenderResult render_operator_preview_trace(
    const BakedDocument& document,
    const RenderTarget& target,
    const std::map<std::string, std::string>& merge_values) {
  return render_to_trace(document, target, merge_values, false);
}

RenderResult render_design_preview_trace(const BakedDocument& document, const RenderTarget& target) {
  return render_to_trace(document, target, {}, true);
}

} // namespace print_engine
