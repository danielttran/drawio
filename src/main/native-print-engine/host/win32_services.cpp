// Production EngineServices for Windows: real printer enumeration (winspool),
// real GDI+ raster for the preview (INV-5: the preview is the SAME render
// trace as print, only sink + DPI differ), and a real printer DC for Print
// with StartDoc/StartPage/EndPage/EndDoc and AbortDoc-on-failure discipline
// (v2.0 §5.2 — never a silent partial). Replaces host_stub_services.cpp via
// make_engine_services(); the engine library itself stays device-free (INV-1).

#include "engine_services_factory.hpp"

#include "print_engine/renderer.hpp"

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
#include <cwchar>
#include <memory>
#include <string>
#include <vector>

namespace print_engine::proto {
namespace {

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
      // Degenerate arc -> chord; full arc support is out of the native subset.
      if (v.size() >= 7) {
        Gdiplus::PointF p = a.map(v[5], v[6]);
        path.AddLine(cur, p);
        cur = p;
      }
      break;
    case PathCommandKind::Close:
      path.CloseFigure();
      cur = start;
      break;
  }
}

// Draw one render trace onto a Graphics already translated so device (0,0) is
// the page origin. Shared by preview and print so they cannot diverge (INV-5).
void draw_trace(Gdiplus::Graphics& g, const RenderTrace& trace) {
  g.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
  g.SetTextRenderingHint(Gdiplus::TextRenderingHintAntiAlias);
  Gdiplus::SolidBrush black(Gdiplus::Color(255, 0, 0, 0));
  Gdiplus::Pen pen(Gdiplus::Color(255, 0, 0, 0), 1.0f);

  for (const auto& c : trace.commands) {
    if (c.kind == EmittedKind::Path) {
      const Affine a = affine_for(c.contract_box, c.device_box);
      Gdiplus::GraphicsPath path;
      Gdiplus::PointF cur(0, 0), start(0, 0);
      for (const auto& pc : c.path_commands) {
        add_path_command(path, pc, a, cur, start);
      }
      if (c.style_signature == "path-stroked") {
        g.DrawPath(&pen, &path);
      } else {
        g.DrawPath(&pen, &path);
      }
    } else if (c.kind == EmittedKind::Text) {
      const double scale =
          c.contract_box.w != 0.0 ? c.device_box.w / c.contract_box.w : 1.0;
      const std::wstring family =
          widen(c.font_family.empty() ? std::string("Arial") : c.font_family);
      Gdiplus::FontFamily ff(family.c_str());
      Gdiplus::FontFamily arial(L"Arial");
      const Gdiplus::FontFamily& use =
          ff.IsAvailable() ? ff : arial;
      const Gdiplus::REAL em = static_cast<Gdiplus::REAL>(
          std::max(1.0, c.font_size_px * scale));
      Gdiplus::Font font(&use, em, Gdiplus::FontStyleRegular,
                         Gdiplus::UnitPixel);
      Gdiplus::RectF box(
          static_cast<Gdiplus::REAL>(c.device_box.x),
          static_cast<Gdiplus::REAL>(c.device_box.y),
          static_cast<Gdiplus::REAL>(c.device_box.w),
          static_cast<Gdiplus::REAL>(c.device_box.h));
      const std::wstring text = widen(c.label);
      g.DrawString(text.c_str(), -1, &font, box, nullptr, &black);
    } else if (c.kind == EmittedKind::Barcode || c.kind == EmittedKind::Svg) {
      // Loud stub: hatched box + the stub label so the operator sees it is
      // NOT real artwork (the matching DegradationNotice is in trace.notices).
      Gdiplus::RectF box(
          static_cast<Gdiplus::REAL>(c.device_box.x),
          static_cast<Gdiplus::REAL>(c.device_box.y),
          static_cast<Gdiplus::REAL>(c.device_box.w),
          static_cast<Gdiplus::REAL>(c.device_box.h));
      Gdiplus::HatchBrush hatch(Gdiplus::HatchStyleForwardDiagonal,
                                Gdiplus::Color(255, 0, 0, 0),
                                Gdiplus::Color(0, 255, 255, 255));
      g.FillRectangle(&hatch, box);
      g.DrawRectangle(&pen, box);
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
      g.DrawRectangle(&pen, box);  // raster bytes not in trace; subset = box
    }
  }
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

class Win32Services final : public EngineServices {
 public:
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
    const RenderTarget target{dpi > 0 ? dpi : 300.0, 96.0};
    auto rendered = render_to_trace(doc, target, merge, false);
    if (!rendered) {
      return Result<PreviewOutput, ContractError>::err(rendered.error());
    }
    int w = 0, h = 0;
    trace_extent(rendered.value(), w, h);

    Gdiplus::Bitmap bmp(w, h, PixelFormat32bppARGB);
    {
      Gdiplus::Graphics g(&bmp);
      g.Clear(Gdiplus::Color(255, 255, 255, 255));
      draw_trace(g, rendered.value());
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
    po.notices = rendered.value().notices;
    return Result<PreviewOutput, ContractError>::ok(std::move(po));
  }

  Result<PrintOutput, ContractError> print(
      const BakedDocument& doc,
      const std::map<std::string, std::string>& merge,
      const std::string& printer_id, const std::string& stock_id,
      int copies) override {
    const std::wstring wname = widen(printer_id);
    HDC hdc = CreateDCW(L"WINSPOOL", wname.c_str(), nullptr, nullptr);
    if (hdc == nullptr) {
      return Result<PrintOutput, ContractError>::err(ContractError{
          ContractErrorCode::PrintDeviceError, printer_id,
          "could not open printer device"});
    }
    const double dpi = GetDeviceCaps(hdc, LOGPIXELSX);
    const RenderTarget target{dpi > 0 ? dpi : 300.0, 96.0};
    auto rendered = render_to_trace(doc, target, merge, false);
    if (!rendered) {
      DeleteDC(hdc);
      return Result<PrintOutput, ContractError>::err(rendered.error());
    }

    DOCINFOW di{};
    di.cbSize = sizeof(di);
    di.lpszDocName = L"draw.io native print";
    const int n_copies = std::max(1, copies);
    bool aborted = false;
    std::string fail_detail;

    if (StartDocW(hdc, &di) <= 0) {
      DeleteDC(hdc);
      return Result<PrintOutput, ContractError>::err(ContractError{
          ContractErrorCode::PrintDeviceError, printer_id, "StartDoc failed"});
    }
    for (int copy = 0; copy < n_copies && !aborted; ++copy) {
      if (StartPage(hdc) <= 0) {
        aborted = true;
        fail_detail = "StartPage failed";
        break;
      }
      {
        Gdiplus::Graphics g(hdc);
        draw_trace(g, rendered.value());
      }
      if (EndPage(hdc) <= 0) {
        aborted = true;
        fail_detail = "EndPage failed";
        break;
      }
    }
    if (aborted) {
      AbortDoc(hdc);  // never a silent partial (v2.0 §5.2)
      DeleteDC(hdc);
      return Result<PrintOutput, ContractError>::err(ContractError{
          ContractErrorCode::PrintDeviceError, printer_id, fail_detail});
    }
    EndDoc(hdc);
    DeleteDC(hdc);

    PrintOutput job;
    job.job_id = "win32-" + printer_id;
    job.notices = rendered.value().notices;
    job.job_log = Json::object();
    job.job_log.set("engineVersion", Json::str("native-print-engine"));
    job.job_log.set("printerId", Json::str(printer_id));
    job.job_log.set("stockId", Json::str(stock_id));
    job.job_log.set("copies", Json::number(n_copies));
    // Merged values are redaction-gated (default off, §7): keys only.
    Json keys = Json::array();
    for (const auto& kv : merge) keys.push_back(Json::str(kv.first));
    job.job_log.set("mergedFieldKeys", std::move(keys));
    return Result<PrintOutput, ContractError>::ok(std::move(job));
  }

 private:
  GdiplusScope gdiplus_;

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
    const int show = std::min(paper_count, 24);
    for (int i = 0; i < show; ++i) {
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
