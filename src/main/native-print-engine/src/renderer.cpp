#include "print_engine/renderer.hpp"

#include <string>
#include <sstream>
#include <cmath>
#include <algorithm>
#include <optional>
#include <utility>

namespace print_engine {

Transform make_world_transform(const RenderTarget& target, const TileSummary& tile) {
  const double scale = target.dpi / target.contract_units_per_inch;
  return Transform{scale, scale, -tile.origin.x, -tile.origin.y};
}

namespace {

// Padding tolerance for the exporter's SVG_PAD convention: each `svg`
// node's box is padded by ~2 contract units per side so resvg has room
// for strokes/markers that extend past the cell's nominal bounds. The
// padded area is transparent — clipping it doesn't lose visible
// content. Without tolerance, EVERY diagram with a cell at its top-left
// (state.x == bounds.x) fires a spurious "diagram extends beyond the
// selected paper" notice on every print. 4 units (= SVG_PAD * 2) is
// tight enough that genuine overhang (real content past the page) still
// fires the notice. Hoisted to namespace scope so the inner lambda can
// reach it as a constant expression on every toolchain (MSVC strict mode
// does not implicitly capture local constexpr non-integral types).
constexpr double kPageEscapeTolerance = 4.0;

[[nodiscard]] std::string barcode_stub_label(const std::string& symbology, const std::string& value) {
  return std::string("BARCODE STUB \xE2\x80\x94 symbology=") + symbology + " value=" + value;
}

[[nodiscard]] DegradationNotice make_notice(
    DegradationNoticeType type,
    std::string page_id,
    std::string detail,
    std::string symbology = {},
    std::string resolved_value = {}) {
  return DegradationNotice{
    type,
    std::move(page_id),
    std::move(detail),
    std::move(symbology),
    std::move(resolved_value)
  };
}

void push_notice_unique(std::vector<DegradationNotice>& notices, DegradationNotice notice) {
  const auto matches = [&notice](const DegradationNotice& existing) {
    return existing.type == notice.type &&
           existing.page_id == notice.page_id &&
           existing.detail == notice.detail &&
           existing.symbology == notice.symbology &&
           existing.resolved_value == notice.resolved_value;
  };
  if (std::find_if(notices.begin(), notices.end(), matches) == notices.end()) {
    notices.push_back(std::move(notice));
  }
}

// Hard line breaks are preserved; the device sink does all real metric
// layout (§2 measure-at-the-sink). No fake-metric helpers remain here.
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

} // namespace

RenderResult render_to_trace(
    const BakedDocument& document,
    const RenderTarget& target,
    const std::map<std::string, std::string>& merge_values,
    bool design_time_preview) {
  RenderTrace trace;

  for (const auto& page : document.pages) {
    // Content past the page extent (the union of all tiles == the selected
    // paper for the paper-aware bake) is clipped by the per-tile clip below.
    // Surface that loudly once per page (§6 "true size, never silent scale").
    // NB: escaping an individual tile is normal multi-tile pagination and is
    // NOT clipped — only escaping the whole page is.
    const Rect page_rect{0.0, 0.0, page.width, page.height};
    const auto escapes_page = [&page_rect](const Rect& b) {
      return b.x < page_rect.x - kPageEscapeTolerance ||
             b.y < page_rect.y - kPageEscapeTolerance ||
             b.x + b.w > page_rect.x + page_rect.w + kPageEscapeTolerance ||
             b.y + b.h > page_rect.y + page_rect.h + kPageEscapeTolerance;
    };
    for (const auto& node : page.paint) {
      if (escapes_page(node.box)) {
        push_notice_unique(trace.notices, make_notice(
          DegradationNoticeType::HardwareMarginClip, page.id,
          "diagram extends beyond the selected paper and was clipped"));
        break;
      }
    }

    for (const auto& tile : page.tiles) {
      const Transform transform = make_world_transform(target, tile);
      const Rect tile_rect{tile.origin.x, tile.origin.y, tile.size.w, tile.size.h};

      trace.commands.push_back(EmittedCommand{
        .kind = EmittedKind::StartTile,
        .contract_box = tile_rect,
        .device_box = transform.apply(tile_rect),
        .label = page.id,
        .style_signature = "lifecycle"
      });
      trace.commands.push_back(EmittedCommand{
        .kind = EmittedKind::Clip,
        .contract_box = tile_rect,
        .device_box = transform.apply(tile_rect),
        .label = "tile-clip",
        .style_signature = "clip"
      });

      for (const auto& node : page.paint) {
        if (node.kind == PaintKind::Text) {
          // §2 measure-at-the-sink: the engine does NO wrapping/fitting/
          // positioning (real glyph metrics live only in the device sink).
          // It forwards the raw text + the node box + the layout policy, and
          // keeps ONLY the metric-independent hard guards.
          std::string text;
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
            // Content-length guard is metric-independent → stays in the engine.
            if (value.size() > static_cast<std::size_t>(node.merge_max_len)) {
              return RenderResult::err(ContractError{
                ContractErrorCode::MergeOverflowError,
                node.merge_key,
                "merge value exceeds maxLen"
              });
            }
            text = value;
          } else if (node.text_content_type == TextContentType::Rich) {
            std::ostringstream rich_text;
            for (std::size_t p = 0; p < node.rich_paragraphs.size(); ++p) {
              if (p > 0) rich_text << "\n";
              for (const auto& run : node.rich_paragraphs[p].runs) {
                rich_text << run.text;
              }
            }
            text = rich_text.str();
          } else {
            text = join_lines(node.static_lines);  // hard line breaks kept
          }

          trace.commands.push_back(EmittedCommand{
            .kind = EmittedKind::Text,
            .contract_box = node.box,
            .device_box = transform.apply(node.box),
            .label = text,
            .style_signature = "content-text",
            .text_color = node.font_color,
            .font_family = node.font_family,
            .font_size_px = node.font_size_px,
            .font_weight = node.font_weight,
            .font_italic = node.font_italic,
            .font_underline = node.font_underline,
            .font_strikethrough = node.font_strikethrough,
            .rich_paragraphs = node.rich_paragraphs,
            .align_h = node.align_h,
            .align_v = node.align_v,
            .wrap = node.merge_wrap,
            .overflow = node.merge_overflow,
            .shrink_floor_px = node.shrink_floor_px
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
          const std::string label = barcode_stub_label(node.barcode_symbology, value);
          push_notice_unique(trace.notices, make_notice(
            DegradationNoticeType::StubbedBarcode,
            page.id,
            "barcode rendered as loud stub",
            node.barcode_symbology,
            value));
          trace.commands.push_back(EmittedCommand{
            .kind = EmittedKind::Barcode,
            .contract_box = node.box,
            .device_box = transform.apply(node.box),
            .label = label,
            .style_signature = "stub-barcode-diagonal-hatch",
            .degradation_notice = true
          });
          continue;
        }

        if (node.kind == PaintKind::Image || node.kind == PaintKind::Svg) {
          const Rect device_box = transform.apply(node.box);
          // SVG nodes no longer emit an unconditional StubbedSvgArtwork
          // notice from the engine -- it was misleading once the host
          // wired up the resvg rasterizer (operator saw "STUBBED" even
          // when the SVG actually rendered correctly). The HOST decides:
          // success => SvgArtworkRasterized (carries backend identity);
          // failure => StubbedSvgArtwork (carries the failure reason).
          // The per-command degradation_notice flag below preserves the
          // "this is a loud primitive" signal for downstream consumers.
          trace.commands.push_back(EmittedCommand{
            .kind = node.kind == PaintKind::Image ? EmittedKind::Image
                                                  : EmittedKind::Svg,
            .contract_box = node.box,
            .device_box = device_box,
            .label = node.kind == PaintKind::Image ? node.image_aspect
                                                   : std::string("SVG ARTWORK STUB"),
            .style_signature = node.kind == PaintKind::Image
                                   ? std::string("content-image")
                                   : std::string("stub-svg-crosshatch"),
            .image_data = node.kind == PaintKind::Image ? node.image_data
                                                        : std::string{},
            .image_format = node.kind == PaintKind::Image ? node.image_format
                                                          : std::string{},
            .image_aspect = node.kind == PaintKind::Image ? node.image_aspect
                                                          : node.svg_aspect,
            .svg_source = node.kind == PaintKind::Svg ? node.svg_source
                                                      : std::string{},
            .flip_h = node.kind == PaintKind::Image ? node.flip_h : false,
            .flip_v = node.kind == PaintKind::Image ? node.flip_v : false,
            .degradation_notice = node.kind == PaintKind::Svg,
            .raster_width_px = static_cast<int>(std::lround(device_box.w)),
            .raster_height_px = static_cast<int>(std::lround(device_box.h))
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
          .kind = EmittedKind::Path,
          .contract_box = node.box,
          .device_box = transform.apply(node.box),
          .path_commands = parsed.value().commands,
          .label = node.stroke.has_value() ? "path-stroked" : "path",
          .style_signature = "content-path",
          .fill = node.fill,
          .stroke = node.stroke
        });
      }

      trace.commands.push_back(EmittedCommand{
        .kind = EmittedKind::EndTile,
        .contract_box = tile_rect,
        .device_box = transform.apply(tile_rect),
        .label = page.id,
        .style_signature = "lifecycle"
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
  wrapped.commands.push_back(EmittedCommand{
    .kind = EmittedKind::StartDocument,
    .label = "StartDoc",
    .style_signature = "lifecycle"
  });
  wrapped.commands.insert(
    wrapped.commands.end(),
    rendered.value().commands.begin(),
    rendered.value().commands.end());
  wrapped.commands.push_back(EmittedCommand{
    .kind = EmittedKind::EndDocument,
    .label = "EndDoc",
    .style_signature = "lifecycle"
  });
  wrapped.notices = rendered.value().notices;
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
