#include "print_engine/native_print.hpp"

#include <algorithm>
#include <cmath>
#include <utility>

namespace print_engine {
namespace {

[[nodiscard]] NativeDrawKind to_native_kind(EmittedKind kind) {
  switch (kind) {
    case EmittedKind::Path:
      return NativeDrawKind::DrawPath;
    case EmittedKind::Text:
      return NativeDrawKind::DrawText;
    case EmittedKind::Image:
      return NativeDrawKind::DrawImage;
    case EmittedKind::Barcode:
      return NativeDrawKind::DrawBarcodeStub;
    case EmittedKind::Svg:
      return NativeDrawKind::DrawSvgStub;
    default:
      return NativeDrawKind::ConfigureSurface;
  }
}

[[nodiscard]] bool is_draw_command(EmittedKind kind) {
  return kind == EmittedKind::Path ||
         kind == EmittedKind::Text ||
         kind == EmittedKind::Image ||
         kind == EmittedKind::Barcode ||
         kind == EmittedKind::Svg;
}

[[nodiscard]] bool starts_with_png_signature(const std::string& data) {
  return data.rfind("iVBORw0KGgo", 0) == 0;
}

[[nodiscard]] Rect printable_contract_rect(const NativePrintTarget& target, const DeviceCaps& caps) {
  const double scale_x = caps.log_pixels_x / target.contract_units_per_inch;
  const double scale_y = caps.log_pixels_y / target.contract_units_per_inch;
  return Rect{
    caps.physical_offset_x / scale_x,
    caps.physical_offset_y / scale_y,
    caps.horz_res / scale_x,
    caps.vert_res / scale_y
  };
}

[[nodiscard]] bool intersects(Rect a, Rect b) {
  return a.x < b.x + b.w &&
         a.x + a.w > b.x &&
         a.y < b.y + b.h &&
         a.y + a.h > b.y;
}

[[nodiscard]] bool outside(Rect inner, Rect outer) {
  return inner.x < outer.x ||
         inner.y < outer.y ||
         inner.x + inner.w > outer.x + outer.w ||
         inner.y + inner.h > outer.y + outer.h;
}

[[nodiscard]] DegradationNotice hardware_margin_notice(const std::string& page_id, std::size_t tile_index) {
  return DegradationNotice{
    DegradationNoticeType::HardwareMarginClip,
    page_id,
    "tile intersects hardware non-printable margin",
    {},
    std::to_string(tile_index)
  };
}

[[nodiscard]] bool valid_device_caps(const DeviceCaps& caps) {
  return caps.log_pixels_x > 0.0 &&
         caps.log_pixels_y > 0.0 &&
         caps.physical_offset_x >= 0.0 &&
         caps.physical_offset_y >= 0.0 &&
         caps.physical_width > 0.0 &&
         caps.physical_height > 0.0 &&
         caps.horz_res > 0.0 &&
         caps.vert_res > 0.0 &&
         caps.horz_res <= caps.physical_width &&
         caps.vert_res <= caps.physical_height;
}

[[nodiscard]] bool valid_print_target(const NativePrintTarget& target) {
  return target.contract_units_per_inch > 0.0;
}

} // namespace

Transform make_printer_world_transform(
    const NativePrintTarget& target,
    const DeviceCaps& caps,
    const TileSummary& tile) {
  const double scale_x = caps.log_pixels_x / target.contract_units_per_inch;
  const double scale_y = caps.log_pixels_y / target.contract_units_per_inch;
  return Transform{
    scale_x,
    scale_y,
    -tile.origin.x - (caps.physical_offset_x / scale_x),
    -tile.origin.y - (caps.physical_offset_y / scale_y)
  };
}

bool tile_hits_hardware_margin(
    const NativePrintTarget& target,
    const DeviceCaps& caps,
    const TileSummary& tile) {
  const Rect printable = printable_contract_rect(target, caps);
  const double tile_left = tile.origin.x;
  const double tile_top = tile.origin.y;
  const double tile_right = tile.origin.x + tile.size.w;
  const double tile_bottom = tile.origin.y + tile.size.h;

  return tile_left < printable.x ||
         tile_top < printable.y ||
         tile_right > printable.x + printable.w ||
         tile_bottom > printable.y + printable.h;
}

bool tile_content_hits_hardware_margin(
    const NativePrintTarget& target,
    const DeviceCaps& caps,
    const PageSummary& page,
    const TileSummary& tile) {
  const Rect printable = printable_contract_rect(target, caps);
  const Rect tile_rect{tile.origin.x, tile.origin.y, tile.size.w, tile.size.h};
  for (const auto& node : page.paint) {
    if (intersects(node.box, tile_rect) && outside(node.box, printable)) {
      return true;
    }
  }
  return false;
}

NativeSurfaceResult render_to_native_surface_trace(
    const BakedDocument& document,
    const RenderTarget& target,
    const std::map<std::string, std::string>& merge_values,
    bool design_time_preview) {
  const auto rendered = render_to_trace(document, target, merge_values, design_time_preview);
  if (!rendered) {
    return NativeSurfaceResult::err(rendered.error());
  }

  NativeSurfaceTrace native;
  native.notices = rendered.value().notices;
  native.commands.push_back(NativeDrawCommand{
    NativeDrawKind::ConfigureSurface,
    {},
    {},
    "TextAntiAlias|HighQualityBicubic|SmoothingAntiAlias|PixelOffsetHalf",
    "surface-config",
    {}
  });

  for (const auto& page : document.pages) {
    for (const auto& node : page.paint) {
      if (node.kind == PaintKind::Image && !starts_with_png_signature(node.image_data)) {
        // This is the PORTABLE pre-decode gate (GDI+ never ran here); the
        // old "GDI+ bitmap decode failed" text mislabeled the failure site.
        return NativeSurfaceResult::err(ContractError{
          ContractErrorCode::ImageDecodeError,
          page.id,
          "image payload is not a PNG (signature mismatch)"
        });
      }
    }
  }

  for (const auto& command : rendered.value().commands) {
    if (command.kind == EmittedKind::Clip) {
      native.commands.push_back(NativeDrawCommand{
        NativeDrawKind::BeginContainer,
        command.contract_box,
        command.device_box,
        "clip+transform container",
        "container",
        {}
      });
      continue;
    }
    if (command.kind == EmittedKind::EndTile) {
      native.commands.push_back(NativeDrawCommand{
        NativeDrawKind::EndContainer,
        command.contract_box,
        command.device_box,
        "clip+transform container",
        "container",
        {}
      });
      continue;
    }
    if (!is_draw_command(command.kind)) {
      continue;
    }
    native.commands.push_back(NativeDrawCommand{
      to_native_kind(command.kind),
      command.contract_box,
      command.device_box,
      command.label,
      command.style_signature,
      command.rich_paragraphs
    });
  }

  return NativeSurfaceResult::ok(std::move(native));
}

PrintJobResult render_to_print_lifecycle(
    const BakedDocument& document,
    const NativePrintTarget& target,
    const DeviceCaps& caps,
    const std::map<std::string, std::string>& merge_values,
    const std::string& job_label,
    PrintLifecycle& lifecycle) {
  PrintJobTrace trace;
  auto record = [&trace](PrintLifecycleEvent event) {
    trace.events.push_back(event);
  };

  if (!valid_print_target(target)) {
    return PrintJobResult::err(ContractError{
      ContractErrorCode::PrintDeviceError,
      "print-target",
      "contract units per inch must be positive"
    });
  }
  if (!valid_device_caps(caps)) {
    return PrintJobResult::err(ContractError{
      ContractErrorCode::PrintDeviceError,
      "device-caps",
      "printer device caps are invalid"
    });
  }

  const RenderTarget render_target{caps.log_pixels_x, target.contract_units_per_inch};
  auto rendered = render_to_native_surface_trace(document, render_target, merge_values, false);
  if (!rendered) {
    return PrintJobResult::err(rendered.error());
  }
  trace.notices.insert(trace.notices.end(), rendered.value().notices.begin(), rendered.value().notices.end());

  auto started = lifecycle.start_doc(job_label);
  record(PrintLifecycleEvent::StartDoc);
  if (!started) {
    return PrintJobResult::err(started.error());
  }

  for (const auto& page : document.pages) {
    for (std::size_t tile_index = 0; tile_index < page.tiles.size(); ++tile_index) {
      const auto& tile = page.tiles[tile_index];
      auto page_started = lifecycle.start_page(page.id, tile_index);
      record(PrintLifecycleEvent::StartPage);
      if (!page_started) {
        lifecycle.abort_doc();
        record(PrintLifecycleEvent::AbortDoc);
        return PrintJobResult::err(page_started.error());
      }

      trace.tile_transforms.push_back(make_printer_world_transform(target, caps, tile));
      if (tile_content_hits_hardware_margin(target, caps, page, tile)) {
        trace.notices.push_back(hardware_margin_notice(page.id, tile_index));
      }

      auto page_ended = lifecycle.end_page(page.id, tile_index);
      record(PrintLifecycleEvent::EndPage);
      if (!page_ended) {
        lifecycle.abort_doc();
        record(PrintLifecycleEvent::AbortDoc);
        return PrintJobResult::err(page_ended.error());
      }
    }
  }

  lifecycle.end_doc();
  record(PrintLifecycleEvent::EndDoc);
  return PrintJobResult::ok(std::move(trace));
}

} // namespace print_engine
