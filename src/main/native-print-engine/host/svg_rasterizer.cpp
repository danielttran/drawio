// svg_rasterizer.cpp -- Windows-only runtime loader for an SVG rasterizer
// backend cdylib that implements svg_rasterizer_abi.h. The host print path is
// GDI+ and therefore Windows-exclusive (same rule as win32_services.cpp), so
// the loader uses LoadLibraryW/GetProcAddress only -- no POSIX path. CMake
// compiles this TU on WIN32 just like win32_services.cpp. No backend concept
// is named here -- only the hand-owned ABI.

#include "svg_rasterizer.hpp"

#include "svg_rasterizer_abi.h"

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

namespace print_engine::host {
namespace {

// FARPROC -> typed function pointer. Single reinterpret_cast (function ptr to
// function ptr) is the warning-clean MSVC idiom; routing through void* is a
// function->object pointer cast that /W4 /WX /permissive- rejects.
template <typename Fn>
Fn resolve(HMODULE handle, const char* name) {
  return reinterpret_cast<Fn>(::GetProcAddress(handle, name));
}

SvgRasterStatus map_status(std::int32_t code) {
  switch (code) {
    case SPE_SVG_OK: return SvgRasterStatus::Ok;
    case SPE_SVG_ERR_PARSE: return SvgRasterStatus::ParseError;
    case SPE_SVG_ERR_UNSUPPORTED: return SvgRasterStatus::Unsupported;
    case SPE_SVG_ERR_BAD_ARGS:
    case SPE_SVG_ERR_BUFFER_TOO_SMALL:
    case SPE_SVG_ERR_INTERNAL:
    default:
      return SvgRasterStatus::Internal;
  }
}

}  // namespace

SvgRasterizerDll::~SvgRasterizerDll() {
  if (handle_ != nullptr) {
    ::FreeLibrary(reinterpret_cast<HMODULE>(handle_));
    handle_ = nullptr;
  }
}

std::unique_ptr<SvgRasterizerDll> SvgRasterizerDll::load(
    const std::filesystem::path& dll_path) {
  if (dll_path.empty()) {
    return nullptr;
  }
  HMODULE handle = ::LoadLibraryW(dll_path.wstring().c_str());
  if (handle == nullptr) {
    return nullptr;  // missing/unloadable -> caller emits loud SVG stub
  }

  auto self = std::unique_ptr<SvgRasterizerDll>(new SvgRasterizerDll());
  self->handle_ = reinterpret_cast<void*>(handle);

  self->fn_abi_version_ =
      resolve<std::int32_t (*)()>(handle, "spe_svg_abi_version");
  self->fn_backend_id_ =
      resolve<std::size_t (*)(char*, std::size_t)>(handle, "spe_svg_backend_id");
  self->fn_measure_ = resolve<std::int32_t (*)(
      const std::uint8_t*, std::size_t, std::uint32_t, std::uint32_t, double,
      std::uint32_t*, std::uint32_t*, std::size_t*)>(handle, "spe_svg_measure");
  self->fn_render_ = resolve<std::int32_t (*)(
      const std::uint8_t*, std::size_t, std::uint32_t, std::uint32_t, double,
      std::uint8_t*, std::size_t, char*, std::size_t)>(handle,
                                                       "spe_svg_render");

  // Hard handshake: every symbol present AND ABI version exact. Anything else
  // is a loud refuse (return nullptr) -- never best-effort.
  if (self->fn_abi_version_ == nullptr || self->fn_backend_id_ == nullptr ||
      self->fn_measure_ == nullptr || self->fn_render_ == nullptr) {
    return nullptr;
  }
  if (self->fn_abi_version_() != SPE_SVG_ABI_VERSION) {
    return nullptr;
  }

  char id[256] = {0};
  const std::size_t n = self->fn_backend_id_(id, sizeof(id));
  self->backend_id_.assign(id, (n < sizeof(id)) ? n : sizeof(id) - 1);

  return self;
}

SvgRasterResult SvgRasterizerDll::render(const std::string& svg_bytes,
                                         std::uint32_t target_w_px,
                                         std::uint32_t target_h_px,
                                         double dpi) {
  SvgRasterResult result;
  if (handle_ == nullptr) {
    result.status = SvgRasterStatus::Unavailable;
    return result;
  }
  if (svg_bytes.empty() || target_w_px == 0 || target_h_px == 0) {
    result.status = SvgRasterStatus::Internal;
    result.message = "empty SVG or zero target box";
    return result;
  }

  const auto* svg = reinterpret_cast<const std::uint8_t*>(svg_bytes.data());

  std::uint32_t out_w = 0;
  std::uint32_t out_h = 0;
  std::size_t out_len = 0;
  std::int32_t mst = fn_measure_(svg, svg_bytes.size(), target_w_px,
                                 target_h_px, dpi, &out_w, &out_h, &out_len);
  if (mst != SPE_SVG_OK) {
    result.status = map_status(mst);
    result.message = "svg measure failed";
    return result;
  }
  if (out_len == 0 ||
      out_len != static_cast<std::size_t>(out_w) * out_h * 4u) {
    result.status = SvgRasterStatus::Internal;
    result.message = "backend reported inconsistent buffer length";
    return result;
  }

  SvgRaster raster;
  raster.width = out_w;
  raster.height = out_h;
  raster.rgba.resize(out_len);

  char err[512] = {0};
  std::int32_t rst =
      fn_render_(svg, svg_bytes.size(), target_w_px, target_h_px, dpi,
                 raster.rgba.data(), raster.rgba.size(), err, sizeof(err));
  if (rst != SPE_SVG_OK) {
    result.status = map_status(rst);
    result.message = err[0] != '\0' ? std::string(err) : "svg render failed";
    return result;
  }

  result.status = SvgRasterStatus::Ok;
  result.raster = std::move(raster);
  return result;
}

}  // namespace print_engine::host
