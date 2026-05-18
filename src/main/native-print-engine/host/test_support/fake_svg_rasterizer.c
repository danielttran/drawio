/*
 * fake_svg_rasterizer.c -- a trivial backend cdylib implementing the
 * hand-owned svg_rasterizer_abi.h. It ignores the SVG and returns a known
 * solid color. Its ONLY purpose is the §5 swap acceptance test: the host must
 * drive this with zero C++ change, proving the ABI is backend-agnostic (so
 * librsvg+cairo can later replace resvg by swapping the DLL only).
 *
 * Not built into any product artifact; test scaffolding only.
 */
#include "../svg_rasterizer_abi.h"

#include <string.h>

/* Recognizable straight-RGBA fill the test asserts byte-for-byte. */
#define FAKE_R 0x12
#define FAKE_G 0x34
#define FAKE_B 0x56
#define FAKE_A 0x78

int32_t spe_svg_abi_version(void) { return SPE_SVG_ABI_VERSION; }

size_t spe_svg_backend_id(char* name_buf, size_t name_buf_len) {
  static const char kId[] = "fake-solid 1.0";
  size_t n = sizeof(kId) - 1;
  if (name_buf == NULL || name_buf_len == 0) {
    return 0;
  }
  if (n > name_buf_len - 1) {
    n = name_buf_len - 1;
  }
  memcpy(name_buf, kId, n);
  name_buf[n] = '\0';
  return n;
}

int32_t spe_svg_measure(const uint8_t* svg, size_t svg_len,
                        uint32_t target_w_px, uint32_t target_h_px,
                        double dpi,
                        uint32_t* out_w, uint32_t* out_h,
                        size_t* out_byte_len) {
  (void)svg;
  (void)svg_len;
  (void)dpi;
  if (out_w == NULL || out_h == NULL || out_byte_len == NULL ||
      target_w_px == 0 || target_h_px == 0) {
    return SPE_SVG_ERR_BAD_ARGS;
  }
  *out_w = target_w_px;
  *out_h = target_h_px;
  *out_byte_len = (size_t)target_w_px * (size_t)target_h_px * 4u;
  return SPE_SVG_OK;
}

int32_t spe_svg_render(const uint8_t* svg, size_t svg_len,
                       uint32_t target_w_px, uint32_t target_h_px,
                       double dpi,
                       uint8_t* out_pixels, size_t out_pixels_len,
                       char* err_buf, size_t err_buf_len) {
  size_t need;
  size_t i;
  (void)svg;
  (void)svg_len;
  (void)dpi;
  if (out_pixels == NULL || target_w_px == 0 || target_h_px == 0) {
    if (err_buf != NULL && err_buf_len > 0) {
      err_buf[0] = '\0';
    }
    return SPE_SVG_ERR_BAD_ARGS;
  }
  need = (size_t)target_w_px * (size_t)target_h_px * 4u;
  if (out_pixels_len < need) {
    return SPE_SVG_ERR_BUFFER_TOO_SMALL;
  }
  for (i = 0; i < need; i += 4u) {
    out_pixels[i + 0u] = FAKE_R;
    out_pixels[i + 1u] = FAKE_G;
    out_pixels[i + 2u] = FAKE_B;
    out_pixels[i + 3u] = FAKE_A;
  }
  return SPE_SVG_OK;
}
