// svg_rasterizer.hpp -- host-side consumer of the hand-owned SVG rasterizer
// ABI. Lives under host/ (the INV-1 scan never sees this); the engine library
// never names a rasterizer. Exactly one ABI consumer: SvgRasterizerDll, which
// LoadLibrary/dlopen-resolves a backend cdylib that implements
// svg_rasterizer_abi.h. Swapping resvg -> librsvg is swapping the DLL path.
#ifndef PRINT_ENGINE_HOST_SVG_RASTERIZER_HPP
#define PRINT_ENGINE_HOST_SVG_RASTERIZER_HPP

#include <cstdint>
#include <filesystem>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace print_engine::host {

enum class SvgRasterStatus {
  Ok,
  Unavailable,   // no/incompatible backend -> caller emits the loud SVG stub
  ParseError,
  Unsupported,   // foreignObject/script/animation -> loud DegradationNotice
  Internal
};

struct SvgRaster {
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  // Straight (non-premultiplied) RGBA8, top-down, stride == width*4.
  // Per svg_rasterizer_abi.h the HOST converts to premultiplied BGRA for GDI+.
  std::vector<std::uint8_t> rgba;
};

struct SvgRasterResult {
  SvgRasterStatus status = SvgRasterStatus::Unavailable;
  std::string message;
  SvgRaster raster;

  [[nodiscard]] bool ok() const { return status == SvgRasterStatus::Ok; }
};

// D3 text metrics: font-metric measurements shared by the bake (static text
// sizing) and the Win32 host (variable/merge text layout at render time).
// Matches spe_text_metrics_t from svg_rasterizer_abi.h.
struct TextMetrics {
  float advance_px    = 0.0f;
  float ascent_px     = 0.0f;
  float descent_px    = 0.0f;
  float line_height_px = 0.0f;
};

class ISvgRasterizer {
public:
  virtual ~ISvgRasterizer() = default;
  [[nodiscard]] virtual bool available() const = 0;
  [[nodiscard]] virtual std::string backend_id() const = 0;
  // Decoded SVG bytes (NOT base64) -> RGBA at the device pixel box + DPI.
  [[nodiscard]] virtual SvgRasterResult render(const std::string& svg_bytes,
                                               std::uint32_t target_w_px,
                                               std::uint32_t target_h_px,
                                               double dpi) = 0;
  // D3: measure a text run using the same font engine as rasterization.
  // Returns std::nullopt if the backend is unavailable or the font is missing.
  [[nodiscard]] virtual std::optional<TextMetrics> measure_text(
      const std::string& family, int weight, bool italic,
      float size_px, const std::string& text) = 0;
};

// Runtime-loaded backend. load() performs the ABI-version handshake and
// resolves every symbol; ANY failure (missing file, bad version, missing
// symbol) returns nullptr so the caller falls back to the loud SVG stub --
// never a silent vanish, never a crash.
class SvgRasterizerDll final : public ISvgRasterizer {
public:
  ~SvgRasterizerDll() override;
  SvgRasterizerDll(const SvgRasterizerDll&) = delete;
  SvgRasterizerDll& operator=(const SvgRasterizerDll&) = delete;

  static std::unique_ptr<SvgRasterizerDll> load(
      const std::filesystem::path& dll_path);

  [[nodiscard]] bool available() const override { return handle_ != nullptr; }
  [[nodiscard]] std::string backend_id() const override { return backend_id_; }
  [[nodiscard]] SvgRasterResult render(const std::string& svg_bytes,
                                       std::uint32_t target_w_px,
                                       std::uint32_t target_h_px,
                                       double dpi) override;
  [[nodiscard]] std::optional<TextMetrics> measure_text(
      const std::string& family, int weight, bool italic,
      float size_px, const std::string& text) override;

private:
  SvgRasterizerDll() = default;

  void* handle_ = nullptr;
  std::string backend_id_;

  // Resolved ABI entry points (signatures mirror svg_rasterizer_abi.h).
  std::int32_t (*fn_abi_version_)() = nullptr;
  std::size_t (*fn_backend_id_)(char*, std::size_t) = nullptr;
  std::int32_t (*fn_measure_)(const std::uint8_t*, std::size_t,
                              std::uint32_t, std::uint32_t, double,
                              std::uint32_t*, std::uint32_t*,
                              std::size_t*) = nullptr;
  std::int32_t (*fn_render_)(const std::uint8_t*, std::size_t,
                             std::uint32_t, std::uint32_t, double,
                             std::uint8_t*, std::size_t,
                             char*, std::size_t) = nullptr;
  // D3: optional — may be null if the backend predates this ABI entry.
  std::int32_t (*fn_text_measure_)(const char*, std::int32_t, std::int32_t,
                                   float, const std::uint8_t*, std::size_t,
                                   void*) = nullptr;
};

}  // namespace print_engine::host

#endif  // PRINT_ENGINE_HOST_SVG_RASTERIZER_HPP
