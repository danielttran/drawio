// Production EngineServices for Windows: real printer enumeration (winspool),
// real GDI+ raster for the preview (INV-5: the preview is the SAME render
// trace as print, only sink + DPI differ), and a real printer DC for Print
// with StartDoc/StartPage/EndPage/EndDoc and AbortDoc-on-failure discipline
// (v2.0 §5.2 — never a silent partial). Replaces host_stub_services.cpp via
// make_engine_services(); the engine library itself stays device-free (INV-1).

#include "engine_services_factory.hpp"

#include "custom_stock.hpp"
#include "print_engine/contract_loader.hpp"
#include "print_engine/native_print.hpp"
#include "print_engine/renderer.hpp"
#include "svg_rasterizer.hpp"

// GDI+ / Win32 system headers warn under /W4 /WX; silence only the system
// headers, not our own code (which stays warning-clean).
#ifndef NOMINMAX
#define NOMINMAX  // keep std::min/std::max usable
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#pragma warning(push, 0)
#include <windows.h>
#include <objidl.h>
#include <gdiplus.h>
#include <winspool.h>
#pragma warning(pop)

#pragma comment(lib, "gdiplus.lib")
#pragma comment(lib, "winspool.lib")

#include <algorithm>
#include <cmath>
#include <cstring>
#include <cctype>
#include <cwchar>
#include <cstdint>
#include <memory>
#include <optional>
#include <set>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

namespace print_engine::proto {
namespace {

using ::print_engine::host::CustomStock;
using ::print_engine::host::ISvgRasterizer;
using ::print_engine::host::SvgRasterizerDll;
using ::print_engine::host::SvgRasterResult;
using ::print_engine::host::SvgRasterStatus;
using ::print_engine::host::parse_custom_stock_id;

std::wstring widen(const std::string& s) {
  if (s.empty()) return std::wstring();
  const int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(),
                                    static_cast<int>(s.size()), nullptr, 0);
  std::wstring w(static_cast<std::size_t>(n), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()),
                      w.data(), n);
  return w;
}

std::string narrow(const std::wstring& w) {
  if (w.empty()) return std::string();
  const int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(),
                                    static_cast<int>(w.size()), nullptr, 0,
                                    nullptr, nullptr);
  std::string s(static_cast<std::size_t>(n), '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.c_str(), static_cast<int>(w.size()),
                      s.data(), n, nullptr, nullptr);
  return s;
}

bool is_xml_name_char(char ch) {
  const unsigned char c = static_cast<unsigned char>(ch);
  return std::isalnum(c) != 0 || ch == '_' || ch == '-' || ch == '.' ||
         ch == ':';
}

bool contains_foreign_object_element(const std::string& svg) {
  std::size_t i = 0;
  while (i < svg.size()) {
    if (svg[i] != '<') {
      ++i;
      continue;
    }
    ++i;
    if (i >= svg.size() || svg[i] == '/' || svg[i] == '!' || svg[i] == '?') {
      continue;
    }
    const std::size_t start = i;
    while (i < svg.size() && is_xml_name_char(svg[i])) {
      ++i;
    }
    if (i == start) continue;
    const std::string name = svg.substr(start, i - start);
    const std::size_t colon = name.rfind(':');
    const std::string local =
        colon == std::string::npos ? name : name.substr(colon + 1);
    if (local == "foreignObject") return true;
  }
  return false;
}

struct PrinterHandle {
  HANDLE handle = nullptr;
  explicit PrinterHandle(HANDLE h = nullptr) : handle(h) {}
  ~PrinterHandle() {
    if (handle != nullptr) ClosePrinter(handle);
  }
  PrinterHandle(const PrinterHandle&) = delete;
  PrinterHandle& operator=(const PrinterHandle&) = delete;
};

// One-process GDI+ token.
struct GdiplusScope {
  ULONG_PTR token = 0;
  GdiplusScope() {
    Gdiplus::GdiplusStartupInput in;
    Gdiplus::GdiplusStartup(&token, &in, nullptr);
  }
  ~GdiplusScope() { Gdiplus::GdiplusShutdown(token); }
};

int png_encoder_clsid(CLSID& clsid) {
  UINT num = 0, size = 0;
  Gdiplus::GetImageEncodersSize(&num, &size);
  if (size == 0) return -1;
  std::vector<std::uint8_t> buf(size);
  auto* codecs = reinterpret_cast<Gdiplus::ImageCodecInfo*>(buf.data());
  Gdiplus::GetImageEncoders(num, size, codecs);
  for (UINT i = 0; i < num; ++i) {
    if (std::wstring(codecs[i].MimeType) == L"image/png") {
      clsid = codecs[i].Clsid;
      return static_cast<int>(i);
    }
  }
  return -1;
}

Result<std::vector<std::uint8_t>, ContractError> merged_devmode_for(
    const std::wstring& printer_name,
    const std::string& stock_id) {
  HANDLE raw = nullptr;
  if (!OpenPrinterW(const_cast<LPWSTR>(printer_name.c_str()), &raw, nullptr)) {
    return Result<std::vector<std::uint8_t>, ContractError>::err(ContractError{
        ContractErrorCode::PrintDeviceError, narrow(printer_name),
        "OpenPrinter failed"});
  }
  PrinterHandle printer(raw);
  const LONG needed = DocumentPropertiesW(nullptr, printer.handle,
                                          const_cast<LPWSTR>(printer_name.c_str()),
                                          nullptr, nullptr, 0);
  if (needed <= 0) {
    return Result<std::vector<std::uint8_t>, ContractError>::err(ContractError{
        ContractErrorCode::PrintDeviceError, narrow(printer_name),
        "DocumentProperties size query failed"});
  }
  std::vector<std::uint8_t> buffer(static_cast<std::size_t>(needed));
  auto* devmode = reinterpret_cast<DEVMODEW*>(buffer.data());
  if (DocumentPropertiesW(nullptr, printer.handle,
                          const_cast<LPWSTR>(printer_name.c_str()),
                          devmode, nullptr, DM_OUT_BUFFER) != IDOK) {
    return Result<std::vector<std::uint8_t>, ContractError>::err(ContractError{
        ContractErrorCode::PrintDeviceError, narrow(printer_name),
        "DocumentProperties default fetch failed"});
  }

  if (!stock_id.empty()) {
    // Custom stock (v2.0 §5): "custom:<wMicrons>x<hMicrons>" => DMPAPER_USER
    // + dmPaperWidth/Length in tenths of millimetre. No DC_PAPERNAMES lookup;
    // the DEVMODE carries the exact requested physical dimensions, which is
    // the spec's "explicit dims, never a named-paper enum" rule.
    if (const auto custom = parse_custom_stock_id(stock_id); custom) {
      devmode->dmFields |= DM_PAPERSIZE | DM_PAPERWIDTH | DM_PAPERLENGTH;
      devmode->dmPaperSize = DMPAPER_USER;
      // Microns / 100 == tenths of millimetre (the dmPaperWidth/Length unit).
      devmode->dmPaperWidth =
          static_cast<short>(custom->width_microns / 100);
      devmode->dmPaperLength =
          static_cast<short>(custom->height_microns / 100);
      // Orientation stays PORTRAIT: dmPaperWidth/Length already describe
      // the physical sheet exactly as the contract page maps onto it
      // (identity, no rotation). Adding DMORIENT_LANDSCAPE because
      // width > height double-specified the rotation: drivers honoring
      // both rotated the raster 90 degrees and clipped a wide label to
      // its short dimension -- a silently wrong paper mapping.
      devmode->dmFields |= DM_ORIENTATION;
      devmode->dmOrientation = DMORIENT_PORTRAIT;
      // Merge through DocumentProperties so the driver can fold this with its
      // private (dmDriverExtra) bytes; same code path as the named-stock case.
      devmode->dmFields |= DM_COPIES;
      devmode->dmCopies = 1;
      if (DocumentPropertiesW(nullptr, printer.handle,
                              const_cast<LPWSTR>(printer_name.c_str()),
                              devmode, devmode,
                              DM_IN_BUFFER | DM_OUT_BUFFER) != IDOK) {
        return Result<std::vector<std::uint8_t>, ContractError>::err(ContractError{
            ContractErrorCode::PrintDeviceError, narrow(printer_name),
            "DocumentProperties merge (custom stock) failed"});
      }
      return Result<std::vector<std::uint8_t>, ContractError>::ok(std::move(buffer));
    }

    const int paper_count = DeviceCapabilitiesW(
        const_cast<LPWSTR>(printer_name.c_str()), nullptr, DC_PAPERNAMES,
        nullptr, nullptr);
    if (paper_count <= 0) {
      return Result<std::vector<std::uint8_t>, ContractError>::err(ContractError{
          ContractErrorCode::PrintDeviceError, stock_id,
          "printer did not report paper names"});
    }
    std::vector<wchar_t> names(static_cast<std::size_t>(paper_count) * 64);
    std::vector<WORD> paper_ids(static_cast<std::size_t>(paper_count));
    std::vector<POINT> paper_sizes(static_cast<std::size_t>(paper_count));
    const int names_count = DeviceCapabilitiesW(
        const_cast<LPWSTR>(printer_name.c_str()), nullptr, DC_PAPERNAMES,
        names.data(), nullptr);
    const int ids_count = DeviceCapabilitiesW(
        const_cast<LPWSTR>(printer_name.c_str()), nullptr, DC_PAPERS,
        reinterpret_cast<LPWSTR>(paper_ids.data()), nullptr);
    const int sizes_count = DeviceCapabilitiesW(
        const_cast<LPWSTR>(printer_name.c_str()), nullptr, DC_PAPERSIZE,
        reinterpret_cast<LPWSTR>(paper_sizes.data()), nullptr);
    if (names_count != paper_count || ids_count != paper_count ||
        sizes_count != paper_count) {
      return Result<std::vector<std::uint8_t>, ContractError>::err(ContractError{
          ContractErrorCode::PrintDeviceError, stock_id,
          "printer paper capability query failed"});
    }
    const std::wstring wanted = widen(stock_id);
    bool found = false;
    for (int i = 0; i < paper_count; ++i) {
      const wchar_t* cell = &names[static_cast<std::size_t>(i) * 64];
      const std::wstring name(cell, wcsnlen(cell, 64));
      if (name == wanted) {
        devmode->dmFields |= DM_PAPERSIZE;
        devmode->dmPaperSize = static_cast<short>(paper_ids[static_cast<std::size_t>(i)]);
        // Orientation stays PORTRAIT (identity mapping): the stock list
        // shown to the operator carries DC_PAPERSIZE dims as-is, and the
        // contract page is baked to those dims. Deriving LANDSCAPE from
        // the paper's natural aspect rotated the raster on top of the
        // already-correct dims (double rotation on wide label stocks).
        (void)paper_sizes;
        devmode->dmFields |= DM_ORIENTATION;
        devmode->dmOrientation = DMORIENT_PORTRAIT;
        found = true;
        break;
      }
    }
    if (!found) {
      return Result<std::vector<std::uint8_t>, ContractError>::err(ContractError{
          ContractErrorCode::PrintDeviceError, stock_id,
          "requested stock not found"});
    }
  }

  devmode->dmFields |= DM_COPIES;
  devmode->dmCopies = 1;
  if (DocumentPropertiesW(nullptr, printer.handle,
                          const_cast<LPWSTR>(printer_name.c_str()),
                          devmode, devmode,
                          DM_IN_BUFFER | DM_OUT_BUFFER) != IDOK) {
    return Result<std::vector<std::uint8_t>, ContractError>::err(ContractError{
        ContractErrorCode::PrintDeviceError, narrow(printer_name),
        "DocumentProperties merge failed"});
  }
  return Result<std::vector<std::uint8_t>, ContractError>::ok(std::move(buffer));
}

// Map a contract-space point to device pixels using the affine implied by a
// command's contract_box -> device_box (uniform scale + translate; see
// renderer.cpp make_world_transform).
struct Affine {
  double sx = 1.0, sy = 1.0, tx = 0.0, ty = 0.0;
  Gdiplus::PointF map(double x, double y) const {
    return Gdiplus::PointF(static_cast<Gdiplus::REAL>(x * sx + tx),
                           static_cast<Gdiplus::REAL>(y * sy + ty));
  }
};

Affine affine_for(const Rect& contract_box, const Rect& device_box) {
  Affine a;
  a.sx = contract_box.w != 0.0 ? device_box.w / contract_box.w : 1.0;
  a.sy = contract_box.h != 0.0 ? device_box.h / contract_box.h : 1.0;
  a.tx = device_box.x - contract_box.x * a.sx;
  a.ty = device_box.y - contract_box.y * a.sy;
  return a;
}

BYTE byte_alpha(double a) {
  return static_cast<BYTE>(std::clamp(std::lround(a * 255.0), 0L, 255L));
}

Gdiplus::Color gdip_color(const Rgba& c) {
  return Gdiplus::Color(byte_alpha(c.a),
                        static_cast<BYTE>(std::clamp(c.r, 0, 255)),
                        static_cast<BYTE>(std::clamp(c.g, 0, 255)),
                        static_cast<BYTE>(std::clamp(c.b, 0, 255)));
}

// D3: CSS hex color string for SVG markup (e.g. "#1a2b3c").
std::string color_to_css(const Rgba& c) {
  char buf[8];
  std::snprintf(buf, sizeof(buf), "#%02x%02x%02x",
                std::clamp(c.r, 0, 255),
                std::clamp(c.g, 0, 255),
                std::clamp(c.b, 0, 255));
  return buf;
}

// Normalize an interpolation ramp for SetInterpolationColors per SVG stop
// semantics. GDI+ REQUIRES positions[0]==0 and positions[n-1]==1 (otherwise
// it rejects the call -- silently when Status is unchecked). SVG instead
// says everything before the first stop takes the first stop's color and
// everything after the last stop takes the last stop's color. So: synthesize
// boundary stops at 0/1 (same color as the nearest real stop) instead of
// MOVING the real first/last stops there, which would shift the whole ramp.
// Also enforces strictly increasing positions (GDI+ requires non-decreasing;
// exact duplicates are nudged by epsilon).
void normalize_gradient_ramp(std::vector<Gdiplus::Color>& colors,
                             std::vector<Gdiplus::REAL>& positions) {
  if (colors.empty() || colors.size() != positions.size()) return;
  for (auto& p : positions) {
    p = std::clamp(p, 0.0f, 1.0f);
  }
  if (positions.front() > 0.0f) {
    positions.insert(positions.begin(), 0.0f);
    colors.insert(colors.begin(), colors.front());
  }
  if (positions.back() < 1.0f) {
    positions.push_back(1.0f);
    colors.push_back(colors.back());
  }
  constexpr Gdiplus::REAL kEps = 1.0e-5f;
  // Forward pass: nudge duplicates upward (saturating at 1).
  for (std::size_t i = 1; i < positions.size(); ++i) {
    if (positions[i] <= positions[i - 1]) {
      positions[i] = std::min(1.0f, positions[i - 1] + kEps);
    }
  }
  // Backward pass: a run saturated at 1.0 is resolved by nudging the
  // earlier entries downward; the last entry stays exactly 1.0 and the
  // first stays exactly 0.0 (neither is modified by its own pass).
  for (std::size_t i = positions.size() - 1; i-- > 1;) {
    if (positions[i] >= positions[i + 1]) {
      positions[i] = std::max(0.0f, positions[i + 1] - kEps);
    }
  }
}

std::unique_ptr<Gdiplus::Brush> make_brush(const Paint& paint,
                                            const Gdiplus::RectF& bounds) {
  if (paint.type == PaintType::Solid) {
    return std::make_unique<Gdiplus::SolidBrush>(gdip_color(paint.solid));
  }
  if (paint.type == PaintType::Linear && !paint.stops.empty()) {
    const Gdiplus::Color first = gdip_color(paint.stops.front().color);
    const Gdiplus::Color last = gdip_color(paint.stops.back().color);
    auto brush = std::make_unique<Gdiplus::LinearGradientBrush>(
        Gdiplus::PointF(bounds.X, bounds.Y),
        Gdiplus::PointF(bounds.X + bounds.Width, bounds.Y),
        first, last);
    // Always install an explicit interpolation ramp so SVG stop OFFSETS are
    // honored. The old code skipped this for 2-stop gradients (offsets
    // 0.3/0.7 silently became a full-span 0..1 ramp) and pinned the real
    // first/last stops to 0/1 for >=3 stops (shifting the ramp).
    {
      std::vector<Gdiplus::Color> colors;
      std::vector<Gdiplus::REAL> positions;
      colors.reserve(paint.stops.size() + 2);
      positions.reserve(paint.stops.size() + 2);
      for (const auto& stop : paint.stops) {
        colors.push_back(gdip_color(stop.color));
        positions.push_back(static_cast<Gdiplus::REAL>(stop.offset));
      }
      normalize_gradient_ramp(colors, positions);
      if (colors.size() >= 2) {
        brush->SetInterpolationColors(colors.data(), positions.data(),
                                      static_cast<INT>(colors.size()));
      }
    }
    return brush;
  }
  if (paint.type == PaintType::Radial && !paint.stops.empty()) {
    Gdiplus::GraphicsPath ellipse;
    ellipse.AddEllipse(bounds);
    auto brush = std::make_unique<Gdiplus::PathGradientBrush>(&ellipse);
    brush->SetCenterColor(gdip_color(paint.stops.front().color));
    Gdiplus::Color surround = gdip_color(paint.stops.back().color);
    INT count = 1;
    brush->SetSurroundColors(&surround, &count);
    // GDI+ PathGradientBrush interpolation positions run 0 = path
    // BOUNDARY -> 1 = center, the opposite of SVG radial offsets
    // (0 = center). Feed the stops reversed or radial gradients render
    // inverted. As with the linear branch, always install an explicit
    // ramp with synthetic boundary stops so SVG offsets are honored
    // instead of being discarded (2 stops) or pinned (>=3 stops).
    {
      std::vector<Gdiplus::Color> colors;
      std::vector<Gdiplus::REAL> positions;
      colors.reserve(paint.stops.size() + 2);
      positions.reserve(paint.stops.size() + 2);
      for (auto it = paint.stops.rbegin(); it != paint.stops.rend(); ++it) {
        colors.push_back(gdip_color(it->color));
        positions.push_back(static_cast<Gdiplus::REAL>(1.0 - it->offset));
      }
      normalize_gradient_ramp(colors, positions);
      if (colors.size() >= 2) {
        brush->SetInterpolationColors(colors.data(), positions.data(),
                                      static_cast<INT>(colors.size()));
      }
    }
    return brush;
  }
  return std::make_unique<Gdiplus::SolidBrush>(Gdiplus::Color(255, 0, 0, 0));
}

Gdiplus::LineCap line_cap(const std::string& cap) {
  if (cap == "round") return Gdiplus::LineCapRound;
  if (cap == "square") return Gdiplus::LineCapSquare;
  return Gdiplus::LineCapFlat;
}

Gdiplus::LineJoin line_join(const std::string& join) {
  if (join == "round") return Gdiplus::LineJoinRound;
  if (join == "bevel") return Gdiplus::LineJoinBevel;
  return Gdiplus::LineJoinMiter;
}

struct StyledPen {
  std::unique_ptr<Gdiplus::Brush> brush;
  std::unique_ptr<Gdiplus::Pen> pen;
};

StyledPen make_pen(const StrokeStyle& stroke,
                   const Gdiplus::RectF& bounds,
                   double scale) {
  StyledPen styled;
  styled.brush = make_brush(stroke.paint, bounds);
  styled.pen = std::make_unique<Gdiplus::Pen>(
      styled.brush.get(), static_cast<Gdiplus::REAL>(stroke.width * scale));
  styled.pen->SetStartCap(line_cap(stroke.cap));
  styled.pen->SetEndCap(line_cap(stroke.cap));
  styled.pen->SetLineJoin(line_join(stroke.join));
  styled.pen->SetMiterLimit(static_cast<Gdiplus::REAL>(stroke.miter_limit));
  if (!stroke.dash.empty()) {
    // GDI+ dash-array elements are MULTIPLES OF PEN WIDTH; the contract
    // carries absolute units (SVG stroke-dasharray semantics, already
    // pre-multiplied by stroke width on the producer side). Feeding raw
    // values printed dash lengths proportional to width^2 -- divide by the
    // stroke width so device dash length == value * scale.
    const double width_divisor = std::max(stroke.width, 1e-6);
    std::vector<Gdiplus::REAL> dash;
    dash.reserve(stroke.dash.size());
    for (const double value : stroke.dash) {
      dash.push_back(static_cast<Gdiplus::REAL>(value / width_divisor));
    }
    styled.pen->SetDashPattern(dash.data(), static_cast<INT>(dash.size()));
  }
  return styled;
}

double command_scale(const EmittedCommand& c) {
  const double sx =
      c.contract_box.w != 0.0 ? c.device_box.w / c.contract_box.w : 0.0;
  const double sy =
      c.contract_box.h != 0.0 ? c.device_box.h / c.contract_box.h : 0.0;
  if (sx > 0.0 && sy > 0.0) return (sx + sy) / 2.0;
  if (sx > 0.0) return sx;
  if (sy > 0.0) return sy;
  return 1.0;
}

INT font_style_for(const EmittedCommand& c) {
  INT style = Gdiplus::FontStyleRegular;
  if (c.font_weight >= 600) style |= Gdiplus::FontStyleBold;
  if (c.font_italic) style |= Gdiplus::FontStyleItalic;
  if (c.font_underline) style |= Gdiplus::FontStyleUnderline;
  if (c.font_strikethrough) style |= Gdiplus::FontStyleStrikeout;
  return style;
}

int base64_value(char ch) {
  if (ch >= 'A' && ch <= 'Z') return ch - 'A';
  if (ch >= 'a' && ch <= 'z') return ch - 'a' + 26;
  if (ch >= '0' && ch <= '9') return ch - '0' + 52;
  if (ch == '+') return 62;
  if (ch == '/') return 63;
  return -1;
}

bool decode_base64(const std::string& text, std::vector<std::uint8_t>& out) {
  if (text.empty() || text.size() % 4 != 0) return false;
  out.clear();
  for (std::size_t index = 0; index < text.size(); index += 4) {
    const bool last_group = index + 4 == text.size();
    const bool pad2 = text[index + 2] == '=';
    const bool pad3 = text[index + 3] == '=';
    // '=' is only valid as trailing padding of the FINAL group; "AB=A"
    // previously emitted a garbage byte from c=-1 instead of failing loud.
    if ((pad2 || pad3) && !last_group) return false;
    if (pad2 && !pad3) return false;
    const int a = base64_value(text[index]);
    const int b = base64_value(text[index + 1]);
    const int c = pad2 ? -1 : base64_value(text[index + 2]);
    const int d = pad3 ? -1 : base64_value(text[index + 3]);
    if (a < 0 || b < 0 || (!pad2 && c < 0) || (!pad3 && d < 0)) {
      return false;
    }
    out.push_back(static_cast<std::uint8_t>((a << 2) | (b >> 4)));
    if (text[index + 2] != '=') {
      out.push_back(static_cast<std::uint8_t>(((b & 0x0f) << 4) | (c >> 2)));
    }
    if (text[index + 3] != '=') {
      out.push_back(static_cast<std::uint8_t>(((c & 0x03) << 6) | d));
    }
  }
  return true;
}

Gdiplus::RectF image_destination(const EmittedCommand& c,
                                 Gdiplus::REAL src_w,
                                 Gdiplus::REAL src_h) {
  Gdiplus::RectF dst(
      static_cast<Gdiplus::REAL>(c.device_box.x),
      static_cast<Gdiplus::REAL>(c.device_box.y),
      static_cast<Gdiplus::REAL>(c.device_box.w),
      static_cast<Gdiplus::REAL>(c.device_box.h));
  if (c.image_aspect != "preserve" || src_w <= 0.0f || src_h <= 0.0f ||
      dst.Width <= 0.0f || dst.Height <= 0.0f) {
    return dst;
  }
  const Gdiplus::REAL scale =
      std::min(dst.Width / src_w, dst.Height / src_h);
  const Gdiplus::REAL w = src_w * scale;
  const Gdiplus::REAL h = src_h * scale;
  return Gdiplus::RectF(dst.X + (dst.Width - w) / 2.0f,
                        dst.Y + (dst.Height - h) / 2.0f,
                        w, h);
}

void add_path_command(Gdiplus::GraphicsPath& path, const PathCommand& cmd,
                       const Affine& a, Gdiplus::PointF& cur,
                       Gdiplus::PointF& start) {
  const auto& v = cmd.values;
  switch (cmd.kind) {
    case PathCommandKind::MoveTo:
      if (v.size() >= 2) {
        cur = a.map(v[0], v[1]);
        start = cur;
        path.StartFigure();
      }
      break;
    case PathCommandKind::LineTo:
      if (v.size() >= 2) {
        Gdiplus::PointF p = a.map(v[0], v[1]);
        path.AddLine(cur, p);
        cur = p;
      }
      break;
    case PathCommandKind::CubicTo:
      if (v.size() >= 6) {
        Gdiplus::PointF c1 = a.map(v[0], v[1]);
        Gdiplus::PointF c2 = a.map(v[2], v[3]);
        Gdiplus::PointF p = a.map(v[4], v[5]);
        path.AddBezier(cur, c1, c2, p);
        cur = p;
      }
      break;
    case PathCommandKind::ArcTo:
      if (v.size() >= 7) {
        const Point start_contract{
            (cur.X - static_cast<Gdiplus::REAL>(a.tx)) / static_cast<Gdiplus::REAL>(a.sx),
            (cur.Y - static_cast<Gdiplus::REAL>(a.ty)) / static_cast<Gdiplus::REAL>(a.sy)};
        const auto cubics = arc_to_cubic_beziers(start_contract, v);
        if (cubics.empty()) {
          Gdiplus::PointF p = a.map(v[5], v[6]);
          path.AddLine(cur, p);
          cur = p;
        } else {
          for (const auto& cubic : cubics) {
            Gdiplus::PointF c1 = a.map(cubic.c1.x, cubic.c1.y);
            Gdiplus::PointF c2 = a.map(cubic.c2.x, cubic.c2.y);
            Gdiplus::PointF p = a.map(cubic.end.x, cubic.end.y);
            path.AddBezier(cur, c1, c2, p);
            cur = p;
          }
        }
      }
      break;
    case PathCommandKind::Close:
      path.CloseFigure();
      cur = start;
      break;
  }
}

struct DrawResult {
  std::vector<DegradationNotice> notices;
};

void push_notice_unique(std::vector<DegradationNotice>& notices,
                        DegradationNotice notice) {
  const auto duplicate = std::find_if(
      notices.begin(), notices.end(), [&notice](const DegradationNotice& n) {
        return n.type == notice.type && n.page_id == notice.page_id &&
               n.detail == notice.detail;
      });
  if (duplicate == notices.end()) {
    notices.push_back(std::move(notice));
  }
}

// Convert straight RGBA8 (top-down, stride=w*4, byte order R,G,B,A per the
// svg_rasterizer_abi.h pixel contract) to GDI+ 32bppPARGB (premultiplied,
// byte order in memory B,G,R,A per the GDI+ format). The host owns this
// conversion (the ABI says backends always emit straight RGBA), so swapping
// resvg -> librsvg+cairo never touches the conversion code.
void straight_rgba_to_premul_bgra(const std::uint8_t* src,
                                  std::uint8_t* dst,
                                  std::size_t pixel_count) {
  for (std::size_t i = 0; i < pixel_count; ++i) {
    const std::uint8_t r = src[i * 4 + 0];
    const std::uint8_t green = src[i * 4 + 1];
    const std::uint8_t b = src[i * 4 + 2];
    const std::uint8_t a = src[i * 4 + 3];
    const std::uint32_t a32 = static_cast<std::uint32_t>(a);
    dst[i * 4 + 0] = static_cast<std::uint8_t>(
        (static_cast<std::uint32_t>(b) * a32 + 127u) / 255u);
    dst[i * 4 + 1] = static_cast<std::uint8_t>(
        (static_cast<std::uint32_t>(green) * a32 + 127u) / 255u);
    dst[i * 4 + 2] = static_cast<std::uint8_t>(
        (static_cast<std::uint32_t>(r) * a32 + 127u) / 255u);
    dst[i * 4 + 3] = a;
  }
}

// Draw one render trace onto a Graphics already translated so device (0,0) is
// the page origin. Shared by preview and print so they cannot diverge (INV-5).
// `svg_rasterizer` may be null (no backend installed); when null OR the
// backend fails for any reason, the SVG branch falls back to the existing
// loud crosshatch stub — never silent.
// D6 AA control: edge_crisp=true disables anti-aliasing (threshold mode) for
// T-Barcode/thermal use; false (default) keeps SmoothingModeAntiAlias.
Result<DrawResult, ContractError> draw_trace(Gdiplus::Graphics& g,
                                             const RenderTrace& trace,
                                             ISvgRasterizer* svg_rasterizer,
                                             double raster_dpi,
                                             bool edge_crisp = false) {
  if (edge_crisp) {
    g.SetSmoothingMode(Gdiplus::SmoothingModeHighSpeed);
    g.SetTextRenderingHint(
        Gdiplus::TextRenderingHintSingleBitPerPixelGridFit);
  } else {
    g.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
    g.SetTextRenderingHint(Gdiplus::TextRenderingHintAntiAlias);
  }
  Gdiplus::SolidBrush black(Gdiplus::Color(255, 0, 0, 0));
  Gdiplus::Pen black_pen(Gdiplus::Color(255, 0, 0, 0), 1.0f);
  DrawResult result;
  std::string current_page_id;

  for (const auto& c : trace.commands) {
    if (c.kind == EmittedKind::StartTile) {
      current_page_id = c.label;
      g.ResetClip();
    } else if (c.kind == EmittedKind::EndTile) {
      g.ResetClip();
    } else if (c.kind == EmittedKind::Clip) {
      // Per-tile clip. The engine RELIES on the sink honoring this (its
      // HardwareMarginClip notice says content "was clipped"); ignoring it
      // let preview show overhanging/neighbor-tile content that paper
      // clips -- an INV-5 preview!=print divergence.
      g.SetClip(Gdiplus::RectF(
          static_cast<Gdiplus::REAL>(c.device_box.x),
          static_cast<Gdiplus::REAL>(c.device_box.y),
          static_cast<Gdiplus::REAL>(c.device_box.w),
          static_cast<Gdiplus::REAL>(c.device_box.h)));
    } else if (c.kind == EmittedKind::Path) {
      const Affine a = affine_for(c.contract_box, c.device_box);
      Gdiplus::GraphicsPath path;
      // SVG semantics: fill-rule nonzero (GDI+ default Alternate = even-odd
      // would hollow out same-winding subpaths the preview fills solid).
      path.SetFillMode(Gdiplus::FillModeWinding);
      Gdiplus::PointF cur(0, 0), start(0, 0);
      for (const auto& pc : c.path_commands) {
        add_path_command(path, pc, a, cur, start);
      }
      Gdiplus::RectF bounds(
          static_cast<Gdiplus::REAL>(c.device_box.x),
          static_cast<Gdiplus::REAL>(c.device_box.y),
          static_cast<Gdiplus::REAL>(c.device_box.w),
          static_cast<Gdiplus::REAL>(c.device_box.h));
      if (c.fill.has_value()) {
        auto brush = make_brush(*c.fill, bounds);
        g.FillPath(brush.get(), &path);
      }
      if (c.stroke.has_value()) {
        auto styled_pen = make_pen(*c.stroke, bounds, command_scale(c));
        g.DrawPath(styled_pen.pen.get(), &path);
      }
    } else if (c.kind == EmittedKind::Text) {
      if (c.label.empty()) {
        continue;
      }

      // §2 measure-at-the-sink: ALL text layout (wrap, shrink-to-fit, align,
      // clip) is done here with real GDI+ glyph metrics. Preview and print
      // run this same code, so what is measured is exactly what prints
      // (INV-5). NB: an earlier "route text through resvg" bypass was
      // removed -- it silently discarded wrap/overflow/align_v/decoration/
      // rich-run styling that this reference sink implements (C1).

      const double scale = command_scale(c);
      const std::wstring family =
          widen(c.font_family.empty() ? std::string("Arial") : c.font_family);
      Gdiplus::FontFamily ff(family.c_str());
      Gdiplus::FontFamily arial(L"Arial");
      const bool font_available = ff.IsAvailable();
      const Gdiplus::FontFamily& use = font_available ? ff : arial;
      std::set<std::string> rich_missing_fonts;
      if (!font_available) {
        push_notice_unique(result.notices, DegradationNotice{
            DegradationNoticeType::FontSubstitution,
            current_page_id,
            "font substituted: " + c.font_family + " -> Arial",
            {},
            {}});
      }
      const Gdiplus::RectF box(
          static_cast<Gdiplus::REAL>(c.device_box.x),
          static_cast<Gdiplus::REAL>(c.device_box.y),
          static_cast<Gdiplus::REAL>(c.device_box.w),
          static_cast<Gdiplus::REAL>(c.device_box.h));
      Gdiplus::SolidBrush text_brush(gdip_color(c.text_color));

      std::unique_ptr<Gdiplus::StringFormat> fmt(
          Gdiplus::StringFormat::GenericTypographic()->Clone());
      fmt->SetFormatFlags(fmt->GetFormatFlags() |
                          Gdiplus::StringFormatFlagsNoWrap |
                          Gdiplus::StringFormatFlagsMeasureTrailingSpaces);

      // Hard line breaks from the contract are honored verbatim.
      std::vector<std::wstring> paragraphs;
      std::vector<std::string> paragraph_align;
      std::vector<double> paragraph_indent;
      if (!c.rich_paragraphs.empty()) {
        for (const auto& p : c.rich_paragraphs) {
          std::wstring line;
          for (const auto& r : p.runs) {
            line += widen(r.text);
          }
          paragraphs.push_back(std::move(line));
          paragraph_align.push_back(p.align.empty() ? c.align_h : p.align);
          paragraph_indent.push_back(std::max(0.0, p.indent_px * scale));
        }
      } else {
        const std::wstring all = widen(c.label);
        std::size_t pos = 0;
        while (true) {
          const std::size_t nl = all.find(L'\n', pos);
          paragraphs.push_back(all.substr(
              pos, nl == std::wstring::npos ? std::wstring::npos : nl - pos));
          paragraph_align.push_back(c.align_h);
          paragraph_indent.push_back(0.0);
          if (nl == std::wstring::npos) break;
          pos = nl + 1;
        }
      }
      const bool do_wrap = (c.wrap == "word");
      const int style = font_style_for(c);

      struct RichLineStyle {
        std::wstring family;
        int style = 0;
        double em = 0.0;
        Gdiplus::Color color;
      };
      const double base_node_em = std::max(1.0, c.font_size_px * scale);
      auto style_for_para = [&](std::size_t pi, double em_factor) -> RichLineStyle {
        RichLineStyle out{family, style, base_node_em * em_factor, gdip_color(c.text_color)};
        if (!c.rich_paragraphs.empty() && pi < c.rich_paragraphs.size() &&
            !c.rich_paragraphs[pi].runs.empty()) {
          const auto& run = c.rich_paragraphs[pi].runs[0];
          out.family = widen(run.font_family.empty() ? std::string("Arial") : run.font_family);
          out.style = 0;
          if (run.weight >= 600) out.style |= Gdiplus::FontStyleBold;
          if (run.italic) out.style |= Gdiplus::FontStyleItalic;
          out.color = gdip_color(run.color);
          out.em = std::max(1.0, run.size_px * scale * em_factor);
        }
        return out;
      };

      auto style_for_run = [&](const RichRun& run, double em_factor) -> RichLineStyle {
        RichLineStyle out{widen(run.font_family.empty() ? std::string("Arial") : run.font_family), 0,
                          std::max(1.0, run.size_px * scale * em_factor), gdip_color(run.color)};
        if (run.weight >= 600) out.style |= Gdiplus::FontStyleBold;
        if (run.italic) out.style |= Gdiplus::FontStyleItalic;
        return out;
      };

      auto measure_w = [&](const Gdiplus::Font& f,
                           const std::wstring& s) -> double {

        if (s.empty()) return 0.0;
        Gdiplus::RectF bb;
        g.MeasureString(s.c_str(), -1, &f,
                        Gdiplus::RectF(0, 0, 1.0e6f, 1.0e6f), fmt.get(), &bb);
        return bb.Width;
      };

      struct Seg {
        std::wstring text;
        std::size_t para = 0;
        RichLineStyle st;
        bool underline = false;
        bool strikethrough = false;
      };
      struct SegMetrics {
        double width = 0.0;
        double height = 0.0;
        double ascent = 0.0;
        double descent = 0.0;
      };
      struct Line {
        std::vector<Seg> segs;
        std::size_t para = 0;
        double width = 0.0;
        double height = 0.0;
      };
      struct Layout {
        std::vector<Line> lines;
        double line_h = 0.0;
        double block_w = 0.0;
        double block_h = 0.0;
      };

      auto measure_seg = [&](const Seg& seg) -> SegMetrics {
        SegMetrics m;
        Gdiplus::FontFamily ff_line(seg.st.family.c_str());
        const Gdiplus::FontFamily& use_line = ff_line.IsAvailable() ? ff_line : arial;
        Gdiplus::Font fm(&use_line, static_cast<Gdiplus::REAL>(seg.st.em), seg.st.style,
                         Gdiplus::UnitPixel);
        m.width = measure_w(fm, seg.text);
        m.height = fm.GetHeight(&g);
        const auto emh = use_line.GetEmHeight(seg.st.style);
        const auto asc = use_line.GetCellAscent(seg.st.style);
        if (emh > 0) {
          m.ascent = seg.st.em * (static_cast<double>(asc) / static_cast<double>(emh));
          const auto des = use_line.GetCellDescent(seg.st.style);
          m.descent = seg.st.em * (static_cast<double>(des) / static_cast<double>(emh));
        } else {
          m.ascent = m.height * 0.8;
          m.descent = std::max(1.0, m.height - m.ascent);
        }
        return m;
      };

      auto build = [&](double em) -> Layout {
        Layout L;
        Gdiplus::Font f(&use, static_cast<Gdiplus::REAL>(em), style,
                        Gdiplus::UnitPixel);
        L.line_h = f.GetHeight(&g);

        if (!c.rich_paragraphs.empty()) {
          for (std::size_t pi = 0; pi < c.rich_paragraphs.size(); ++pi) {
            const auto& para = c.rich_paragraphs[pi];
            const double indent = pi < paragraph_indent.size() ? paragraph_indent[pi] : 0.0;
            const double avail = std::max(1.0, static_cast<double>(box.Width) - indent);
            Line cur; cur.para = pi;
            if (para.runs.empty()) {
              cur.height = L.line_h;
              L.lines.push_back(cur);
              continue;
            }
            for (const auto& run : para.runs) {
              const auto st = style_for_run(run, em / base_node_em);
              std::wstring txt = widen(run.text);
              std::size_t pos = 0;
              while (pos <= txt.size()) {
                std::size_t sp = txt.find(L' ', pos);
                std::wstring tok = txt.substr(pos, sp == std::wstring::npos ? std::wstring::npos : sp - pos);
                if (sp != std::wstring::npos) tok += L" ";
                if (tok.empty() && sp == std::wstring::npos) break;
                Seg seg{tok, pi, st, run.underline, run.strikethrough};
                auto m = measure_seg(seg);
                const double w = m.width;
                const double h = m.height;
                if (do_wrap && !cur.segs.empty() && (cur.width + w) > avail) {
                  L.lines.push_back(cur);
                  cur = Line{}; cur.para = pi;
                }
                cur.segs.push_back(seg);
                cur.width += w;
                cur.height = std::max(cur.height, h);
                if (sp == std::wstring::npos) break;
                pos = sp + 1;
              }
            }
            if (!cur.segs.empty() || para.runs.empty()) L.lines.push_back(cur);
          }
        } else {
          for (std::size_t pi = 0; pi < paragraphs.size(); ++pi) {
            const auto& para = paragraphs[pi];
            const double indent = pi < paragraph_indent.size() ? paragraph_indent[pi] : 0.0;
            const double avail = std::max(1.0, static_cast<double>(box.Width) - indent);
            Line cur; cur.para = pi;
            if (!do_wrap || para.empty()) {
              const auto st = style_for_para(pi, em / base_node_em);
              Seg seg{para, pi, st, false, false};
              auto m = measure_seg(seg);
              const double w = m.width;
              const double h = m.height;
              cur.segs.push_back(seg); cur.width = w; cur.height = h;
              L.lines.push_back(cur);
              continue;
            }
            std::wstring curw;
            std::size_t i = 0;
            while (i < para.size()) {
              std::size_t sp = para.find(L' ', i);
              const std::wstring word = para.substr(i, sp == std::wstring::npos ? std::wstring::npos : sp - i);
              const std::wstring cand = curw.empty() ? word : curw + L" " + word;
              const auto st = style_for_para(pi, em / base_node_em);
              Seg test{cand, pi, st, false, false};
              auto tm = measure_seg(test);
            const double tw = tm.width;
              if (curw.empty() || tw <= avail) {
                curw = cand;
              } else {
                Seg seg{curw, pi, st, false, false};
                auto m = measure_seg(seg);
                const double w = m.width;
                const double h = m.height;
                cur.segs.push_back(seg); cur.width = w; cur.height = h;
                L.lines.push_back(cur);
                cur = Line{}; cur.para = pi;
                curw = word;
              }
              if (sp == std::wstring::npos) break;
              i = sp + 1;
            }
            const auto st = style_for_para(pi, em / base_node_em);
            Seg seg{curw, pi, st, false, false};
            auto m = measure_seg(seg);
            const double w = m.width;
            const double h = m.height;
            cur.segs.push_back(seg); cur.width = w; cur.height = h;
            L.lines.push_back(cur);
          }
        }

        for (const auto& ln : L.lines) {
          L.block_h += ln.height > 0.0 ? ln.height : L.line_h;
          L.block_w = std::max(L.block_w, ln.width);
        }
        return L;
      };
      double em = base_node_em;
      double floor_em = std::max(1.0, c.shrink_floor_px * scale);
      double floor_factor = floor_em / std::max(1.0, base_node_em);
      if (!c.rich_paragraphs.empty() && c.shrink_floor_px > 0.0) {
        double min_run_px = 1.0e9;
        for (const auto& p : c.rich_paragraphs) {
          for (const auto& r : p.runs) {
            min_run_px = std::min(min_run_px, std::max(1.0, r.size_px * scale));
          }
        }
        if (min_run_px < 1.0e8) {
          floor_factor = std::max(0.0, (c.shrink_floor_px * scale) / min_run_px);
          floor_em = std::max(1.0, base_node_em * floor_factor);
        }
      }
      Layout lay = build(em);
      if (c.overflow == "shrink") {
        while ((lay.block_h > box.Height || lay.block_w > box.Width) &&
               em > floor_em) {
          const double next = em - std::max(0.5, em * 0.06);
          em = std::max(base_node_em * floor_factor, std::max(floor_em, next));
          lay = build(em);
        }
      }
      const bool overflowed = lay.block_h > static_cast<double>(box.Height) + 0.5 ||
                              lay.block_w > static_cast<double>(box.Width) + 0.5;
      if (overflowed) {
        if (c.overflow == "reject" || c.overflow == "shrink") {
          return Result<DrawResult, ContractError>::err(ContractError{
              ContractErrorCode::MergeOverflowError, "text",
              "text does not fit its box at the device font metrics"});
        }
        if (c.overflow == "clip") {
          push_notice_unique(result.notices, DegradationNotice{
              DegradationNoticeType::MergeClip, current_page_id,
              "text clipped to box", {}, {}});
        }
        // empty/none (static): truthful overflow, no error/notice.
      }

      double y = box.Y;
      if (c.align_v == "middle") {
        y = box.Y + (static_cast<double>(box.Height) - lay.block_h) / 2.0;
      } else if (c.align_v == "bottom") {
        y = box.Y + static_cast<double>(box.Height) - lay.block_h;
      }
      Gdiplus::GraphicsState clip_state = g.Save();
      if (c.overflow == "clip") {
        // INTERSECT with the per-tile clip (set at the Clip command above).
        // The default CombineModeReplace would DISCARD the tile clip, so
        // clipped text would print on every tile of a multi-tile poster
        // page (seam duplication).
        g.SetClip(box, Gdiplus::CombineModeIntersect);
      }
      for (std::size_t line_index = 0; line_index < lay.lines.size(); ++line_index) {
        const auto& line = lay.lines[line_index];
        const std::size_t pi = line.para;
        const double indent = pi < paragraph_indent.size() ? paragraph_indent[pi] : 0.0;
        const double avail_w = std::max(1.0, static_cast<double>(box.Width) - indent);
        double x = box.X + indent;
        const std::string h = pi < paragraph_align.size() ? paragraph_align[pi] : c.align_h;
        if (h == "center") x = box.X + indent + (avail_w - line.width) / 2.0;
        else if (h == "right") x = box.X + indent + avail_w - line.width;

        double line_max_ascent = 0.0;
        std::vector<SegMetrics> segm;
        segm.reserve(line.segs.size());
        for (const auto& seg : line.segs) {
          auto m = measure_seg(seg);
          line_max_ascent = std::max(line_max_ascent, m.ascent);
          segm.push_back(m);
        }
        for (std::size_t si = 0; si < line.segs.size(); ++si) {
          const auto& seg = line.segs[si];
          const auto& m = segm[si];
          Gdiplus::SolidBrush seg_brush(seg.st.color);
          Gdiplus::FontFamily seg_ff(seg.st.family.c_str());
          const bool seg_font_available = seg_ff.IsAvailable();
          const Gdiplus::FontFamily& seg_use = seg_font_available ? seg_ff : arial;
          if (!seg_font_available) {
            const std::string missing = narrow(seg.st.family);
            if (rich_missing_fonts.insert(missing).second) {
              push_notice_unique(result.notices, DegradationNotice{
                  DegradationNoticeType::FontSubstitution,
                  current_page_id,
                  "font substituted: " + missing + " -> Arial",
                  {},
                  {}});
            }
          }
          Gdiplus::Font seg_font(&seg_use, static_cast<Gdiplus::REAL>(seg.st.em), seg.st.style, Gdiplus::UnitPixel);
          const double dy = std::max(0.0, line_max_ascent - m.ascent);
          const double draw_y = y + dy;
          g.DrawString(seg.text.c_str(), -1, &seg_font,
                       Gdiplus::PointF(static_cast<Gdiplus::REAL>(x), static_cast<Gdiplus::REAL>(draw_y)),
                       fmt.get(), &seg_brush);
          const double thickness = std::max(1.0, seg.st.em * 0.06);
          Gdiplus::Pen deco_pen(seg.st.color, static_cast<Gdiplus::REAL>(thickness));
          const double baseline_y = draw_y + m.ascent;
          if (seg.underline) {
            const double uy = baseline_y + m.descent * 0.25;
            g.DrawLine(&deco_pen, static_cast<Gdiplus::REAL>(x), static_cast<Gdiplus::REAL>(uy),
                       static_cast<Gdiplus::REAL>(x + m.width), static_cast<Gdiplus::REAL>(uy));
          }
          if (seg.strikethrough) {
            const double sy = draw_y + m.ascent * 0.5;
            g.DrawLine(&deco_pen, static_cast<Gdiplus::REAL>(x), static_cast<Gdiplus::REAL>(sy),
                       static_cast<Gdiplus::REAL>(x + m.width), static_cast<Gdiplus::REAL>(sy));
          }
          x += m.width;
        }
        y += (line.height > 0.0 ? line.height : lay.line_h);
      }
      g.Restore(clip_state);
    } else if (c.kind == EmittedKind::Svg) {
      // SVG branch: try the external rasterizer behind the hand-owned ABI.
      // On success draw real pixels + emit `SvgArtworkRasterized`. On ANY
      // failure (no DLL, empty source, base64 garbage, foreignObject,
      // parse, unsupported, internal): loud crosshatch + a
      // `StubbedSvgArtwork` notice naming the reason. The engine no longer
      // emits the notice unconditionally, so the host's `raster_fail_detail`
      // MUST be set on every non-rasterized path; otherwise a missing DLL
      // would print a silently-unnoticed crosshatch.
      Gdiplus::RectF box(
          static_cast<Gdiplus::REAL>(c.device_box.x),
          static_cast<Gdiplus::REAL>(c.device_box.y),
          static_cast<Gdiplus::REAL>(c.device_box.w),
          static_cast<Gdiplus::REAL>(c.device_box.h));
      const std::uint32_t target_w =
          static_cast<std::uint32_t>(std::max(1, c.raster_width_px));
      const std::uint32_t target_h =
          static_cast<std::uint32_t>(std::max(1, c.raster_height_px));
      bool rasterized = false;
      std::string raster_fail_detail;
      if (svg_rasterizer == nullptr || !svg_rasterizer->available()) {
        raster_fail_detail =
            "no svg rasterizer backend loaded "
            "(drop svg_rasterizer.dll next to print_engine_host.exe)";
      } else if (c.svg_source.empty()) {
        raster_fail_detail = "svg_source is empty";
      } else {
        std::vector<std::uint8_t> svg_bytes;
        if (!decode_base64(c.svg_source, svg_bytes)) {
          raster_fail_detail = "svg_source is not valid base64";
        } else {
          const std::string decoded(
              reinterpret_cast<const char*>(svg_bytes.data()),
              svg_bytes.size());
          // Defense-in-depth WYSIWYG guard (mirrors the Rust shim's check):
          // resvg renders <foreignObject> as fully-transparent with no error
          // status, so a stale shim without the in-Rust guard would print a
          // BLANK box -- silent C1 violation. Detect upfront, never call the
          // shim, fall to loud crosshatch + named notice.
          const bool has_foreign_object =
              contains_foreign_object_element(decoded);
          if (has_foreign_object) {
            raster_fail_detail =
                "svg_source contains <foreignObject>; refusing loudly "
                "(host transcribes HTML labels before bake)";
          } else {
            const SvgRasterResult rr = svg_rasterizer->render(
                decoded, target_w, target_h, raster_dpi);
            // Promote to size_t BEFORE multiplying so a 64K x 64K SVG
            // cannot wrap uint32 (the ABI lets the backend return up-to-
            // 32-bit dimensions; the buffer is in host address space).
            const std::size_t out_w_sz =
                static_cast<std::size_t>(rr.raster.width);
            const std::size_t out_h_sz =
                static_cast<std::size_t>(rr.raster.height);
            if (rr.ok() && out_w_sz > 0u && out_h_sz > 0u &&
                rr.raster.rgba.size() == out_w_sz * out_h_sz * 4u) {
              const std::size_t pixel_count = out_w_sz * out_h_sz;
              std::vector<std::uint8_t> premul(pixel_count * 4u);
              straight_rgba_to_premul_bgra(rr.raster.rgba.data(),
                                           premul.data(), pixel_count);
              const INT stride = static_cast<INT>(out_w_sz) * 4;
              Gdiplus::Bitmap bitmap(static_cast<INT>(out_w_sz),
                                     static_cast<INT>(out_h_sz), stride,
                                     PixelFormat32bppPARGB, premul.data());
              if (bitmap.GetLastStatus() == Gdiplus::Ok) {
                const Gdiplus::RectF dst = image_destination(
                    c, static_cast<Gdiplus::REAL>(out_w_sz),
                    static_cast<Gdiplus::REAL>(out_h_sz));
                g.DrawImage(&bitmap, dst, 0.0f, 0.0f,
                            static_cast<Gdiplus::REAL>(out_w_sz),
                            static_cast<Gdiplus::REAL>(out_h_sz),
                            Gdiplus::UnitPixel);
                rasterized = true;
                push_notice_unique(
                    result.notices,
                    DegradationNotice{
                        DegradationNoticeType::SvgArtworkRasterized,
                        current_page_id,
                        "svg rendered via external rasterizer: " +
                            svg_rasterizer->backend_id(),
                        {},
                        {}});
              } else {
                raster_fail_detail = "GDI+ bitmap construction failed";
              }
            } else {
              raster_fail_detail = rr.message.empty()
                                       ? std::string("rasterizer failed")
                                       : rr.message;
            }
          }
        }
      }
      if (!rasterized) {
        // Loud crosshatch stub + named StubbedSvgArtwork notice. The engine
        // no longer emits an upstream stub notice, so this branch is the
        // ONLY place the operator hears that an SVG didn't render -- it
        // must always fire, never be silent. `raster_fail_detail` is set
        // on every non-rasterized path above.
        Gdiplus::HatchBrush hatch(Gdiplus::HatchStyleForwardDiagonal,
                                  Gdiplus::Color(255, 0, 0, 0),
                                  Gdiplus::Color(0, 255, 255, 255));
        g.FillRectangle(&hatch, box);
        g.DrawRectangle(&black_pen, box);
        Gdiplus::FontFamily arial(L"Arial");
        Gdiplus::Font font(&arial, 10.0f, Gdiplus::FontStyleRegular,
                           Gdiplus::UnitPixel);
        const std::wstring text = widen(c.label);
        g.DrawString(text.c_str(), -1, &font, box, nullptr, &black);
        if (raster_fail_detail.empty()) {
          // Defensive: every upstream branch sets a reason; if a future
          // edit forgets, emit a generic loud notice rather than a silent
          // crosshatch.
          raster_fail_detail = "svg rasterization failed for an unknown reason";
        }
        push_notice_unique(
            result.notices,
            DegradationNotice{DegradationNoticeType::StubbedSvgArtwork,
                              current_page_id,
                              "svg rasterizer fallback: " + raster_fail_detail,
                              {},
                              {}});
      }
    } else if (c.kind == EmittedKind::Barcode) {
      // Barcode stays a loud crosshatch stub — the real enLabel SDK adapter
      // is an external dependency (spec v1.1 §12).
      Gdiplus::RectF box(
          static_cast<Gdiplus::REAL>(c.device_box.x),
          static_cast<Gdiplus::REAL>(c.device_box.y),
          static_cast<Gdiplus::REAL>(c.device_box.w),
          static_cast<Gdiplus::REAL>(c.device_box.h));
      Gdiplus::HatchBrush hatch(Gdiplus::HatchStyleForwardDiagonal,
                                Gdiplus::Color(255, 0, 0, 0),
                                Gdiplus::Color(0, 255, 255, 255));
      g.FillRectangle(&hatch, box);
      g.DrawRectangle(&black_pen, box);
      Gdiplus::FontFamily arial(L"Arial");
      Gdiplus::Font font(&arial, 10.0f, Gdiplus::FontStyleRegular,
                         Gdiplus::UnitPixel);
      const std::wstring text = widen(c.label);
      g.DrawString(text.c_str(), -1, &font, box, nullptr, &black);
    } else if (c.kind == EmittedKind::Image) {
      Gdiplus::RectF box(
          static_cast<Gdiplus::REAL>(c.device_box.x),
          static_cast<Gdiplus::REAL>(c.device_box.y),
          static_cast<Gdiplus::REAL>(c.device_box.w),
          static_cast<Gdiplus::REAL>(c.device_box.h));
      std::vector<std::uint8_t> bytes;
      if (!decode_base64(c.image_data, bytes)) {
        return Result<DrawResult, ContractError>::err(ContractError{
            ContractErrorCode::ImageDecodeError, "image",
            "image data is not valid base64"});
      }
      HGLOBAL mem = GlobalAlloc(GMEM_MOVEABLE, bytes.size());
      if (mem == nullptr) {
        return Result<DrawResult, ContractError>::err(ContractError{
            ContractErrorCode::ImageDecodeError, "image",
            "image memory allocation failed"});
      }
      void* dest = GlobalLock(mem);
      std::memcpy(dest, bytes.data(), bytes.size());
      GlobalUnlock(mem);
      IStream* stream = nullptr;
      if (CreateStreamOnHGlobal(mem, TRUE, &stream) != S_OK) {
        GlobalFree(mem);
        return Result<DrawResult, ContractError>::err(ContractError{
            ContractErrorCode::ImageDecodeError, "image",
            "image stream creation failed"});
      }
      Gdiplus::Bitmap bitmap(stream);
      if (bitmap.GetLastStatus() != Gdiplus::Ok) {
        stream->Release();
        return Result<DrawResult, ContractError>::err(ContractError{
            ContractErrorCode::ImageDecodeError, "image",
            "GDI+ bitmap decode failed"});
      }
      Gdiplus::GraphicsState state = g.Save();
      if (c.flip_h || c.flip_v) {
        const Gdiplus::REAL cx = box.X + box.Width / 2.0f;
        const Gdiplus::REAL cy = box.Y + box.Height / 2.0f;
        g.TranslateTransform(cx, cy);
        g.ScaleTransform(c.flip_h ? -1.0f : 1.0f, c.flip_v ? -1.0f : 1.0f);
        g.TranslateTransform(-cx, -cy);
      }
      const Gdiplus::RectF dst = image_destination(
          c,
          static_cast<Gdiplus::REAL>(bitmap.GetWidth()),
          static_cast<Gdiplus::REAL>(bitmap.GetHeight()));
      g.DrawImage(&bitmap, dst, 0.0f, 0.0f,
                  static_cast<Gdiplus::REAL>(bitmap.GetWidth()),
                  static_cast<Gdiplus::REAL>(bitmap.GetHeight()),
                  Gdiplus::UnitPixel);
      g.Restore(state);
      stream->Release();
    }
  }
  return Result<DrawResult, ContractError>::ok(std::move(result));
}

struct TileTrace {
  std::string page_id;
  int tile_index = 0;
  RenderTrace trace;
};

std::vector<TileTrace> split_tiles(const RenderTrace& trace) {
  std::vector<TileTrace> tiles;
  TileTrace current;
  bool in_tile = false;
  std::string current_page;
  int current_page_tile_index = 0;
  for (const auto& command : trace.commands) {
    if (command.kind == EmittedKind::StartTile) {
      if (command.label != current_page) {
        current_page = command.label;
        current_page_tile_index = 0;
      }
      current = TileTrace{};
      current.page_id = command.label;
      current.tile_index = current_page_tile_index++;
      current.trace.notices = trace.notices;
      current.trace.commands.push_back(command);
      in_tile = true;
      continue;
    }
    if (!in_tile) {
      continue;
    }
    current.trace.commands.push_back(command);
    if (command.kind == EmittedKind::EndTile) {
      tiles.push_back(std::move(current));
      current = TileTrace{};
      in_tile = false;
    }
  }
  return tiles;
}

// Total device extent across all tiles (tiles stacked vertically for preview).
void trace_extent(const RenderTrace& trace, int& w, int& h) {
  double mw = 0.0, mh = 0.0;
  for (const auto& c : trace.commands) {
    if (c.kind == EmittedKind::StartTile || c.kind == EmittedKind::Clip ||
        c.kind == EmittedKind::EndTile || c.kind == EmittedKind::Path ||
        c.kind == EmittedKind::Text || c.kind == EmittedKind::Image ||
        c.kind == EmittedKind::Barcode || c.kind == EmittedKind::Svg) {
      mw = std::max(mw, c.device_box.x + c.device_box.w);
      mh = std::max(mh, c.device_box.y + c.device_box.h);
    }
  }
  w = std::max(1, static_cast<int>(std::lround(mw)));
  h = std::max(1, static_cast<int>(std::lround(mh)));
}

// Resolve the rasterizer DLL path the same way Windows does for
// LoadLibrary(bare-name): next to the host executable. We use the full path
// (not the bare name) so we never accidentally pick up a same-named DLL from
// the system search path — security + deterministic backend identity.
std::filesystem::path resolve_svg_rasterizer_path() {
  wchar_t buf[MAX_PATH];
  const DWORD got = ::GetModuleFileNameW(nullptr, buf, MAX_PATH);
  if (got == 0 || got >= MAX_PATH) {
    return std::filesystem::path();
  }
  std::filesystem::path exe(buf);
  return exe.parent_path() / L"svg_rasterizer.dll";
}

class Win32Services final : public EngineServices {
 public:
  Win32Services() {
    svg_rasterizer_ = SvgRasterizerDll::load(resolve_svg_rasterizer_path());
  }

  std::vector<PrinterInfo> enumerate_printers() override {
    std::vector<PrinterInfo> out;
    DWORD needed = 0, count = 0;
    EnumPrintersW(PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS, nullptr, 4,
                  nullptr, 0, &needed, &count);
    if (needed == 0) return out;
    std::vector<std::uint8_t> buf(needed);
    if (!EnumPrintersW(PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS, nullptr,
                       4, buf.data(), needed, &needed, &count)) {
      return out;
    }
    auto* info = reinterpret_cast<PRINTER_INFO_4W*>(buf.data());
    for (DWORD i = 0; i < count; ++i) {
      PrinterInfo p;
      p.name = narrow(info[i].pPrinterName);
      p.id = p.name;
      enumerate_stocks(info[i].pPrinterName, p);
      out.push_back(std::move(p));
    }
    return out;
  }

  Result<PreviewOutput, ContractError> render_preview(
      const BakedDocument& doc,
      const std::map<std::string, std::string>& merge, double dpi) override {
    return render_preview(doc, merge, dpi, PrintRenderOptions{});
  }

  // INV-5: preview rasterizes through the SAME draw_trace path with the SAME
  // per-job options as print (edge_crisp included), so a crisp job previews
  // exactly as it prints.
  Result<PreviewOutput, ContractError> render_preview(
      const BakedDocument& doc,
      const std::map<std::string, std::string>& merge, double dpi,
      const PrintRenderOptions& opts) override {
    const RenderTarget target{dpi > 0 ? dpi : 300.0, units_per_inch(doc.units)};
    auto rendered = render_to_trace(doc, target, merge, false);
    if (!rendered) {
      return Result<PreviewOutput, ContractError>::err(rendered.error());
    }
    const auto tiles = split_tiles(rendered.value());
    if (tiles.empty()) {
      return Result<PreviewOutput, ContractError>::err(ContractError{
          ContractErrorCode::PrintDeviceError, "preview",
          "render trace contained no previewable tiles"});
    }
    int w = 0;
    int h = 0;
    std::vector<int> tile_heights;
    tile_heights.reserve(tiles.size());
    for (const auto& tile : tiles) {
      int tile_w = 0;
      int tile_h = 0;
      trace_extent(tile.trace, tile_w, tile_h);
      w = std::max(w, tile_w);
      h += tile_h;
      tile_heights.push_back(tile_h);
    }

    Gdiplus::Bitmap bmp(w, h, PixelFormat32bppARGB);
    std::vector<DegradationNotice> device_notices;
    {
      Gdiplus::Graphics g(&bmp);
      g.Clear(Gdiplus::Color(255, 255, 255, 255));
      int y_offset = 0;
      for (std::size_t index = 0; index < tiles.size(); ++index) {
        Gdiplus::GraphicsState state = g.Save();
        g.TranslateTransform(0.0f, static_cast<Gdiplus::REAL>(y_offset));
        auto drawn = draw_trace(g, tiles[index].trace, svg_rasterizer_.get(),
                                dpi, opts.edge_crisp);
        g.Restore(state);
        if (!drawn) {
          return Result<PreviewOutput, ContractError>::err(drawn.error());
        }
        for (const auto& notice : drawn.value().notices) {
          push_notice_unique(device_notices, notice);
        }
        y_offset += tile_heights[index];
      }
    }

    IStream* stream = nullptr;
    if (CreateStreamOnHGlobal(nullptr, TRUE, &stream) != S_OK) {
      return Result<PreviewOutput, ContractError>::err(ContractError{
          ContractErrorCode::PrintDeviceError, "preview",
          "CreateStreamOnHGlobal failed"});
    }
    CLSID png{};
    if (png_encoder_clsid(png) < 0 ||
        bmp.Save(stream, &png, nullptr) != Gdiplus::Ok) {
      stream->Release();
      return Result<PreviewOutput, ContractError>::err(ContractError{
          ContractErrorCode::PrintDeviceError, "preview",
          "PNG encode failed"});
    }
    // Use the stream's real byte count, NOT GlobalSize: CreateStreamOnHGlobal
    // over-allocates the HGLOBAL, so GlobalSize would append trailing garbage
    // past the PNG's IEND.
    STATSTG st{};
    if (stream->Stat(&st, STATFLAG_NONAME) != S_OK) {
      stream->Release();
      return Result<PreviewOutput, ContractError>::err(ContractError{
          ContractErrorCode::PrintDeviceError, "preview",
          "stream Stat failed"});
    }
    const SIZE_T sz = static_cast<SIZE_T>(st.cbSize.QuadPart);
    HGLOBAL hg = nullptr;
    GetHGlobalFromStream(stream, &hg);
    PreviewOutput po;
    po.png.resize(sz);
    void* src = GlobalLock(hg);
    std::memcpy(po.png.data(), src, sz);
    GlobalUnlock(hg);
    stream->Release();
    po.width_px = w;
    po.height_px = h;
    po.notices.insert(po.notices.begin(), rendered.value().notices.begin(),
                      rendered.value().notices.end());
    po.notices.insert(po.notices.end(), device_notices.begin(),
                      device_notices.end());
    return Result<PreviewOutput, ContractError>::ok(std::move(po));
  }

  Result<PrintOutput, ContractError> print(
      const BakedDocument& doc,
      const std::map<std::string, std::string>& merge,
      const std::string& printer_id, const std::string& stock_id,
      int copies, PrintRenderOptions opts = {}) override {
    const std::wstring wname = widen(printer_id);
    const int n_copies = std::max(1, copies);
    auto devmode_buffer = merged_devmode_for(wname, stock_id);
    if (!devmode_buffer) {
      return Result<PrintOutput, ContractError>::err(devmode_buffer.error());
    }
    std::vector<std::uint8_t> devmode_data = devmode_buffer.value();
    auto* devmode = reinterpret_cast<DEVMODEW*>(devmode_data.data());
    HDC hdc = CreateDCW(L"WINSPOOL", wname.c_str(), nullptr, devmode);
    if (hdc == nullptr) {
      return Result<PrintOutput, ContractError>::err(ContractError{
          ContractErrorCode::PrintDeviceError, printer_id,
          "could not open printer device"});
    }
    const double dpi_x = GetDeviceCaps(hdc, LOGPIXELSX);
    const double dpi_y = GetDeviceCaps(hdc, LOGPIXELSY);
    // Printer DCs draw in PRINTABLE-AREA coordinates: device (0,0) sits
    // PHYSICALOFFSETX/Y pixels inside the paper corner. The contract page
    // is the PAPER, so every draw must be shifted by -offset or the whole
    // page prints displaced down-right and the bottom/right strip vanishes
    // -- silently, and differently from preview (INV-5).
    const double phys_off_x =
        std::max(0, GetDeviceCaps(hdc, PHYSICALOFFSETX));
    const double phys_off_y =
        std::max(0, GetDeviceCaps(hdc, PHYSICALOFFSETY));
    const RenderTarget target{dpi_x > 0 ? dpi_x : 300.0,
                              units_per_inch(doc.units)};
    auto rendered = render_to_trace(doc, target, merge, false);
    if (!rendered) {
      DeleteDC(hdc);
      return Result<PrintOutput, ContractError>::err(rendered.error());
    }

    // §3.4 D6: Collect referenced font faces for jobLog traceability.
    std::set<std::string> referenced_font_set;
    for (const auto& cmd : rendered.value().commands) {
      if (cmd.kind == EmittedKind::Text && !cmd.font_family.empty()) {
        referenced_font_set.insert(cmd.font_family);
      }
    }

    DOCINFOW di{};
    di.cbSize = sizeof(di);
    di.lpszDocName = L"draw.io native print";
    bool aborted = false;
    std::string fail_detail;
    std::vector<DegradationNotice> device_notices;
    const auto tiles = split_tiles(rendered.value());
    if (tiles.empty()) {
      DeleteDC(hdc);
      return Result<PrintOutput, ContractError>::err(ContractError{
          ContractErrorCode::PrintDeviceError, printer_id,
          "render trace contained no printable tiles"});
    }

    // Loud notice when content falls inside the hardware non-printable
    // margin (the band blit physically cannot reach it). Uses the engine's
    // own DeviceCaps model so the rule is testable off-Windows.
    {
      DeviceCaps caps{};
      caps.log_pixels_x = dpi_x > 0 ? dpi_x : 300.0;
      caps.log_pixels_y = dpi_y > 0 ? dpi_y : caps.log_pixels_x;
      caps.physical_offset_x = phys_off_x;
      caps.physical_offset_y = phys_off_y;
      caps.physical_width = GetDeviceCaps(hdc, PHYSICALWIDTH);
      caps.physical_height = GetDeviceCaps(hdc, PHYSICALHEIGHT);
      caps.horz_res = GetDeviceCaps(hdc, HORZRES);
      caps.vert_res = GetDeviceCaps(hdc, VERTRES);
      const NativePrintTarget npt{units_per_inch(doc.units)};
      if (caps.horz_res > 0 && caps.vert_res > 0) {
        for (const auto& page : doc.pages) {
          std::size_t tile_index = 0;
          for (const auto& tile : page.tiles) {
            if (tile_content_hits_hardware_margin(npt, caps, page, tile)) {
              push_notice_unique(device_notices, DegradationNotice{
                  DegradationNoticeType::HardwareMarginClip, page.id,
                  "content lies in the printer's non-printable margin",
                  {}, std::to_string(tile_index)});
            }
            ++tile_index;
          }
        }
      }
    }

    if (StartDocW(hdc, &di) <= 0) {
      DeleteDC(hdc);
      return Result<PrintOutput, ContractError>::err(ContractError{
          ContractErrorCode::PrintDeviceError, printer_id, "StartDoc failed"});
    }
    for (int copy = 0; copy < n_copies && !aborted; ++copy) {
      for (const auto& tile : tiles) {
        if (StartPage(hdc) <= 0) {
          aborted = true;
          fail_detail = "StartPage failed at copy=" + std::to_string(copy + 1) +
                        " page=" + tile.page_id +
                        " tile=" + std::to_string(tile.tile_index);
          break;
        }
        {
          // D6: Banded rasterization — render the page in horizontal bands so
          // peak memory is bounded regardless of DPI/media size. Each band is an
          // opaque 24-bit bitmap composited to the printer DC at the correct
          // Y offset. Pixels are identical to a full-page bitmap because:
          //   (a) the translation shifts draw_trace's world-space coordinates so
          //       page row `band_y` appears at band-bitmap row 0;
          //   (b) GDI+ clips content that falls outside the band bitmap bounds;
          //   (c) deduplication (push_notice_unique) handles repeated notices.
          // With kPrintBandHeightPx == ph (full-page) the result is exactly
          // equivalent to the pre-D6 single-bitmap path (INV: pixel identity).
          //
          // device_box coords are real device pixels; UnitPixel keeps true 1:1
          // (printer HDC GDI+ otherwise defaults to UnitDisplay=1/100").
          const int pw = std::max(1, GetDeviceCaps(hdc, HORZRES));
          const int ph = std::max(1, GetDeviceCaps(hdc, VERTRES));
          constexpr int kPrintBandHeightPx = 512;
          const int n_bands = (ph + kPrintBandHeightPx - 1) / kPrintBandHeightPx;
          for (int band = 0; band < n_bands && !aborted; ++band) {
            const int band_y = band * kPrintBandHeightPx;
            const int band_h = std::min(kPrintBandHeightPx, ph - band_y);
            Gdiplus::Bitmap band_bmp(pw, band_h, PixelFormat24bppRGB);
            Gdiplus::Graphics gb(&band_bmp);
            gb.Clear(Gdiplus::Color(255, 255, 255, 255));   // opaque white
            gb.SetPageUnit(Gdiplus::UnitPixel);
            // World -> band-device mapping:
            //  x' = x - phys_off_x
            //  y' = (dpi_y/dpi_x) * y - band_y - phys_off_y
            // The trace is rendered at dpi_x on both axes; the m22 factor
            // corrects anisotropic devices (e.g. 203x300 thermal heads)
            // that previously printed everything vertically distorted.
            const double aniso_y =
                (dpi_x > 0.0 && dpi_y > 0.0) ? dpi_y / dpi_x : 1.0;
            Gdiplus::Matrix world(
                1.0f, 0.0f, 0.0f, static_cast<Gdiplus::REAL>(aniso_y),
                static_cast<Gdiplus::REAL>(-phys_off_x),
                static_cast<Gdiplus::REAL>(-band_y - phys_off_y));
            gb.SetTransform(&world);
            auto drawn = draw_trace(gb, tile.trace, svg_rasterizer_.get(),
                                    dpi_x, opts.edge_crisp);
            if (!drawn) {
              aborted = true;
              fail_detail = "draw failed at copy=" + std::to_string(copy + 1) +
                            " page=" + tile.page_id +
                            " tile=" + std::to_string(tile.tile_index) +
                            " band=" + std::to_string(band) +
                            ": " + drawn.error().message;
              break;
            }
            for (const auto& notice : drawn.value().notices) {
              push_notice_unique(device_notices, notice);
            }
            Gdiplus::Graphics gp(hdc);
            gp.SetPageUnit(Gdiplus::UnitPixel);
            // Opaque blit -> crisp. Status checked: a failed band blit
            // (driver OOM) previously printed a blank 512px stripe with no
            // notice.
            const Gdiplus::Status blit =
                gp.DrawImage(&band_bmp, 0, band_y, pw, band_h);
            if (blit != Gdiplus::Ok) {
              aborted = true;
              fail_detail = "band composite failed at copy=" +
                            std::to_string(copy + 1) +
                            " page=" + tile.page_id +
                            " tile=" + std::to_string(tile.tile_index) +
                            " band=" + std::to_string(band);
              break;
            }
          }
        }
        if (EndPage(hdc) <= 0) {
          aborted = true;
          fail_detail = "EndPage failed at copy=" + std::to_string(copy + 1) +
                        " page=" + tile.page_id +
                        " tile=" + std::to_string(tile.tile_index);
          break;
        }
      }
    }
    if (aborted) {
      AbortDoc(hdc);  // never a silent partial (v2.0 §5.2)
      DeleteDC(hdc);
      return Result<PrintOutput, ContractError>::err(ContractError{
          ContractErrorCode::PrintDeviceError, printer_id, fail_detail});
    }
    // EndDoc can still fail (spooler/driver rejects the document); an
    // unchecked call reported success while nothing reached paper.
    if (EndDoc(hdc) <= 0) {
      DeleteDC(hdc);
      return Result<PrintOutput, ContractError>::err(ContractError{
          ContractErrorCode::PrintDeviceError, printer_id,
          "EndDoc failed (document rejected by spooler/driver)"});
    }
    DeleteDC(hdc);

    PrintOutput job;
    job.job_id = "win32-" + printer_id;
    job.notices = rendered.value().notices;
    job.notices.insert(job.notices.end(), device_notices.begin(),
                       device_notices.end());
    job.job_log = Json::object();
    job.job_log.set("engineVersion", Json::str("native-print-engine"));
    job.job_log.set("printerId", Json::str(printer_id));
    job.job_log.set("stockId", Json::str(stock_id));
    job.job_log.set("copies", Json::number(n_copies));
    // SVG rasterizer backend identity (regulated traceability). "none"
    // => no DLL loaded => any SVG fell
    // through to the loud crosshatch stub.
    job.job_log.set(
        "svgRasterizer",
        Json::str(svg_rasterizer_ && svg_rasterizer_->available()
                      ? svg_rasterizer_->backend_id()
                      : std::string("none")));
    // §3.4 D6: resolved font faces for determinism auditing.
    Json fonts = Json::array();
    for (const auto& f : referenced_font_set) fonts.push_back(Json::str(f));
    job.job_log.set("resolvedFonts", std::move(fonts));
    // Merged values are redaction-gated (default off, §7): keys only.
    Json keys = Json::array();
    for (const auto& kv : merge) keys.push_back(Json::str(kv.first));
    job.job_log.set("mergedFieldKeys", std::move(keys));
    return Result<PrintOutput, ContractError>::ok(std::move(job));
  }

 private:
  GdiplusScope gdiplus_;
  // Optional external SVG rasterizer behind the hand-owned C ABI. Lazy-loaded
  // in the constructor from <exe-dir>/svg_rasterizer.dll. nullptr (or load
  // failure) is fine -- draw_trace's Svg branch falls back to the loud
  // crosshatch stub. Same instance feeds both render_preview and print so the
  // exact same pixels appear in both sinks (INV-5).
  std::unique_ptr<ISvgRasterizer> svg_rasterizer_;

  static void enumerate_stocks(LPWSTR printer, PrinterInfo& p) {
    const int paper_count = DeviceCapabilitiesW(printer, nullptr, DC_PAPERNAMES,
                                                nullptr, nullptr);
    if (paper_count <= 0) return;
    std::vector<wchar_t> names(static_cast<std::size_t>(paper_count) * 64);
    std::vector<POINT> sizes(static_cast<std::size_t>(paper_count));
    DeviceCapabilitiesW(printer, nullptr, DC_PAPERNAMES, names.data(), nullptr);
    DeviceCapabilitiesW(printer, nullptr, DC_PAPERSIZE,
                        reinterpret_cast<LPWSTR>(sizes.data()), nullptr);
    HDC hdc = CreateDCW(L"WINSPOOL", printer, nullptr, nullptr);
    const double dpix = hdc ? GetDeviceCaps(hdc, LOGPIXELSX) : 300.0;
    const double dpiy = hdc ? GetDeviceCaps(hdc, LOGPIXELSY) : 300.0;
    if (hdc) DeleteDC(hdc);
    // Advertise EVERY paper the driver reports: the old 24-entry cap
    // silently hid stocks from the operator's picker (office drivers
    // commonly report 60+ named papers).
    for (int i = 0; i < paper_count; ++i) {
      StockInfo s;
      // DC_PAPERNAMES entries are 64-wchar fixed cells, NOT guaranteed
      // null-terminated when the name fills the cell — bound the length so
      // wstring does not over-read into the next entry.
      const wchar_t* cell = &names[static_cast<std::size_t>(i) * 64];
      s.name = narrow(std::wstring(cell, wcsnlen(cell, 64)));
      s.id = s.name;
      // DC_PAPERSIZE is in tenths of a millimetre -> microns (*100).
      s.width_microns = static_cast<long>(sizes[static_cast<std::size_t>(i)].x) * 100;
      s.height_microns = static_cast<long>(sizes[static_cast<std::size_t>(i)].y) * 100;
      s.dpi_x = dpix;
      s.dpi_y = dpiy;
      p.stocks.push_back(std::move(s));
    }
    if (!p.stocks.empty()) p.default_stock_id = p.stocks.front().id;
  }
};

}  // namespace

std::unique_ptr<EngineServices> make_engine_services() {
  return std::make_unique<Win32Services>();
}

}  // namespace print_engine::proto
