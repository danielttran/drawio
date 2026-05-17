#include "print_engine/devmode.hpp"

#include <utility>

namespace print_engine {

DevModeResult build_merged_dev_mode(
    const DevModeSnapshot& driver_default,
    double paper_width_mm,
    double paper_height_mm) {
  if (paper_width_mm <= 0.0 || paper_height_mm <= 0.0) {
    return DevModeResult::err(ContractError{
      ContractErrorCode::PrintDeviceError,
      "DEVMODE",
      "custom paper dimensions must be positive"
    });
  }

  DevModeSnapshot merged = driver_default;
  merged.paper_size = DmPaperUser;
  merged.paper_width_mm = paper_width_mm;
  merged.paper_height_mm = paper_height_mm;
  return DevModeResult::ok(std::move(merged));
}

} // namespace print_engine
