// custom_stock.cpp -- pure parser for "custom:<wMicrons>x<hMicrons>" stockIds.
// Host-side, cross-platform (compiles + tests on Linux), zero Win32 surface.

#include "custom_stock.hpp"

#include <cctype>
#include <cstdint>
#include <limits>

namespace print_engine::host {

namespace {

// Strict positive-integer parser: digits only, at least one digit, no sign,
// no whitespace, no separators. On success writes to `out` and returns true.
// Refuses anything that would not survive the eventual conversion to
// DEVMODE.dmPaperWidth/Length (SHORT, tenths of mm). One micron == one
// micrometre; 1 tenth-of-mm == 100 microns; SHRT_MAX == 32767 tenths-of-mm
// == 32767 * 100 microns == 3,276,700 (~3.27 m, the largest physical paper
// Windows can express). Anything larger is a refusal — never silently
// truncate.
constexpr long kMaxStockMicrons = 32767L * 100L;  // == 3,276,700
bool parse_positive_int(const std::string& s, std::size_t start,
                        std::size_t end, long& out) {
  if (start >= end) return false;
  long value = 0;
  for (std::size_t i = start; i < end; ++i) {
    const char ch = s[i];
    if (ch < '0' || ch > '9') return false;
    const long digit = ch - '0';
    if (value > (std::numeric_limits<long>::max() / 10)) return false;
    value = value * 10 + digit;
  }
  if (value <= 0 || value > kMaxStockMicrons) {
    return false;
  }
  out = value;
  return true;
}

}  // namespace

std::optional<CustomStock> parse_custom_stock_id(const std::string& stock_id) {
  // Required prefix.
  constexpr const char kPrefix[] = "custom:";
  constexpr std::size_t kPrefixLen = sizeof(kPrefix) - 1;
  if (stock_id.size() <= kPrefixLen) return std::nullopt;
  if (stock_id.compare(0, kPrefixLen, kPrefix) != 0) return std::nullopt;

  // Lowercase 'x' separates W and H. Case-insensitive 'X' is intentionally
  // refused — the wire encoding is fixed so the host never has to guess.
  const std::size_t sep = stock_id.find('x', kPrefixLen);
  if (sep == std::string::npos) return std::nullopt;

  long w = 0;
  long h = 0;
  if (!parse_positive_int(stock_id, kPrefixLen, sep, w)) return std::nullopt;
  if (!parse_positive_int(stock_id, sep + 1, stock_id.size(), h)) {
    return std::nullopt;
  }

  CustomStock out;
  out.width_microns = w;
  out.height_microns = h;
  return out;
}

}  // namespace print_engine::host
