#pragma once

#include "print_engine/errors.hpp"
#include "print_engine/result.hpp"

#include <vector>

namespace print_engine {

inline constexpr int DmPaperUser = 256;

struct DevModeSnapshot {
  std::vector<unsigned char> driver_extra;
  int paper_size = 0;
  double paper_width_mm = 0.0;
  double paper_height_mm = 0.0;
};

using DevModeResult = Result<DevModeSnapshot, ContractError>;

[[nodiscard]] DevModeResult build_merged_dev_mode(
  const DevModeSnapshot& driver_default,
  double paper_width_mm,
  double paper_height_mm);

} // namespace print_engine
