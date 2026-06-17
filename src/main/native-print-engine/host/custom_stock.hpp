// custom_stock.hpp -- cross-platform parser for the custom-stock stockId shape.
//
// v2.0 spec §5 calls for label stock selection via DMPAPER_USER + explicit
// physical paper dimensions (never a named-paper enum), since named-enum
// rounding is a known device-dot drift source. Most printers expose named
// stocks via DC_PAPERNAMES; for stock sizes that have no matching entry, the
// UI sends a synthetic stockId of the form
//
//   "custom:<width-microns>x<height-microns>"
//
// This is parsed into a CustomStock value; the Win32 host then sets
// DEVMODE.dmPaperSize = DMPAPER_USER and dmPaperWidth/Length to the exact
// physical dimensions (tenths of millimetre, the dmPaperWidth unit).
//
// The parser is intentionally pure C++ (no Win32) so it is testable on Linux
// CI — the host build's INV-1 scan never sees this header (host/ is outside
// the include/ + src/ engine library scope).
#ifndef PRINT_ENGINE_HOST_CUSTOM_STOCK_HPP
#define PRINT_ENGINE_HOST_CUSTOM_STOCK_HPP

#include <optional>
#include <string>

namespace print_engine::host {

struct CustomStock {
  long width_microns = 0;
  long height_microns = 0;
};

// Returns the parsed CustomStock when `stock_id` matches
// "custom:<wMicrons>x<hMicrons>" with both dimensions strictly positive and
// <= 3,276,700 microns (== SHRT_MAX tenths-of-mm, the largest paper
// dimension DEVMODE.dmPaperWidth/Length — a signed SHORT — can express);
// std::nullopt otherwise. Strict matcher: any extra prefix/suffix, sign,
// decimal, or zero dimension is a refusal, as is any dimension that would
// truncate the DEVMODE field. The caller is expected to fall back to
// named-stock lookup on nullopt — never silently to default paper.
[[nodiscard]] std::optional<CustomStock> parse_custom_stock_id(
    const std::string& stock_id);

// Convert a positive micron dimension to tenths of a millimetre (the
// DEVMODE.dmPaperWidth/Length unit), ROUNDED to nearest — never truncated.
// Integer `microns / 100` discards up to 99 um (~2.3 device px @600 dpi,
// ~4.7 px @1200 dpi), silently selecting paper slightly smaller than the
// operator requested; rounding keeps the selected sheet within half a
// tenth-mm of the request. parse_custom_stock_id caps microns at
// 3,276,700, so the rounded result is at most 32,767 (SHRT_MAX) — it can
// never overflow the signed-SHORT DEVMODE field.
[[nodiscard]] inline long microns_to_tenth_mm_rounded(long microns) {
  return (microns + 50) / 100;
}

}  // namespace print_engine::host

#endif  // PRINT_ENGINE_HOST_CUSTOM_STOCK_HPP
