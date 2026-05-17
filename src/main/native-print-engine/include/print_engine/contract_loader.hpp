#pragma once

#include "print_engine/contract.hpp"
#include "print_engine/errors.hpp"
#include "print_engine/result.hpp"

#include <string_view>

namespace print_engine {

using ContractLoadResult = Result<BakedDocument, ContractError>;

[[nodiscard]] ContractLoadResult load_baked_contract(std::string_view json);

} // namespace print_engine
