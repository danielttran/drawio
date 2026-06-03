// rasterize.cpp -- browser-free SVG -> raw RGBA using the PRODUCTION resvg
// cdylib (the same host/svg-rasterizer/ libsvg_rasterizer.so the Win32 print
// host loads behind svg_rasterizer_abi.h). It dlopens the shipped backend and
// calls the exact spe_svg_measure / spe_svg_render exports the printer path
// uses, so the pixels produced here are the pixels the printer receives for an
// SVG node (rasterizer identity, NOT a re-implementation).
//
// This is a verification/artifact tool only. It is NOT a pixel-comparison
// oracle (it never diffs against a reference image); it renders the contract so
// a human can inspect object-by-object fidelity, exactly as the Native Print
// "Verification Gate" design plan requires.
//
// Usage: rasterize <svg-file> <out-rgba-file> <target_w> <target_h> <dpi>
// stdout: "<w> <h>"   (actual raster dimensions)
//
// Output file layout: raw straight-RGBA8, top-down, stride = w*4, length w*h*4.

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include <dlfcn.h>

// Mirror of the hand-owned ABI we load (kept local so this tool depends only on
// the .so, never on the host headers).
extern "C" {
typedef int32_t (*abi_version_fn)(void);
typedef int32_t (*measure_fn)(const uint8_t*, size_t, uint32_t, uint32_t, double,
                              uint32_t*, uint32_t*, size_t*);
typedef int32_t (*render_fn)(const uint8_t*, size_t, uint32_t, uint32_t, double,
                             uint8_t*, size_t, char*, size_t);
}

static std::vector<uint8_t> read_file(const char* path) {
  FILE* f = std::fopen(path, "rb");
  if (!f) {
    std::fprintf(stderr, "rasterize: cannot open %s\n", path);
    std::exit(2);
  }
  std::fseek(f, 0, SEEK_END);
  long n = std::ftell(f);
  std::fseek(f, 0, SEEK_SET);
  std::vector<uint8_t> buf(n > 0 ? static_cast<size_t>(n) : 0);
  if (n > 0 && std::fread(buf.data(), 1, buf.size(), f) != buf.size()) {
    std::fprintf(stderr, "rasterize: short read on %s\n", path);
    std::exit(2);
  }
  std::fclose(f);
  return buf;
}

int main(int argc, char** argv) {
  if (argc != 6) {
    std::fprintf(stderr,
                 "usage: %s <svg-file> <out-rgba> <w> <h> <dpi>\n", argv[0]);
    return 2;
  }
  const char* svg_path = argv[1];
  const char* out_path = argv[2];
  const uint32_t tw = static_cast<uint32_t>(std::strtoul(argv[3], nullptr, 10));
  const uint32_t th = static_cast<uint32_t>(std::strtoul(argv[4], nullptr, 10));
  const double dpi = std::strtod(argv[5], nullptr);

  const char* lib_path = std::getenv("SVG_RASTERIZER_LIB");
  if (!lib_path || !*lib_path) {
    std::fprintf(stderr, "rasterize: SVG_RASTERIZER_LIB not set\n");
    return 3;
  }
  void* h = dlopen(lib_path, RTLD_NOW | RTLD_LOCAL);
  if (!h) {
    std::fprintf(stderr, "rasterize: dlopen failed: %s\n", dlerror());
    return 3;
  }
  auto ver = reinterpret_cast<abi_version_fn>(dlsym(h, "spe_svg_abi_version"));
  auto measure = reinterpret_cast<measure_fn>(dlsym(h, "spe_svg_measure"));
  auto render = reinterpret_cast<render_fn>(dlsym(h, "spe_svg_render"));
  if (!ver || !measure || !render) {
    std::fprintf(stderr, "rasterize: missing ABI exports\n");
    return 3;
  }
  if (ver() != 1) {
    std::fprintf(stderr, "rasterize: ABI version mismatch (%d)\n", ver());
    return 3;
  }

  std::vector<uint8_t> svg = read_file(svg_path);

  uint32_t ow = 0, oh = 0;
  size_t need = 0;
  int32_t st = measure(svg.data(), svg.size(), tw, th, dpi, &ow, &oh, &need);
  if (st != 0) {
    std::fprintf(stderr, "rasterize: measure failed (%d)\n", st);
    return 4;
  }
  std::vector<uint8_t> px(need);
  char err[256] = {0};
  st = render(svg.data(), svg.size(), tw, th, dpi, px.data(), px.size(),
              err, sizeof(err));
  if (st != 0) {
    std::fprintf(stderr, "rasterize: render failed (%d): %s\n", st, err);
    return 4;
  }

  FILE* o = std::fopen(out_path, "wb");
  if (!o) {
    std::fprintf(stderr, "rasterize: cannot write %s\n", out_path);
    return 5;
  }
  std::fwrite(px.data(), 1, px.size(), o);
  std::fclose(o);
  std::printf("%u %u\n", ow, oh);
  return 0;
}
