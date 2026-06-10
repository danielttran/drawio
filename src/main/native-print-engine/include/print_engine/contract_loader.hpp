#pragma once

#include "print_engine/contract.hpp"
#include "print_engine/errors.hpp"
#include "print_engine/result.hpp"

#include <string>
#include <string_view>

namespace print_engine {

using ContractLoadResult = Result<BakedDocument, ContractError>;

[[nodiscard]] ContractLoadResult load_baked_contract(std::string_view json);

// Returns the number of contract units per inch for the given unit string.
// "px" => 96.0, "um" => 25400.0.  Callers must validate units before calling.
[[nodiscard]] double units_per_inch(const std::string& units) noexcept;

} // namespace print_engine
