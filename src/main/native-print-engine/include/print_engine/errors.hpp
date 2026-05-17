#pragma once

#include <string>

namespace print_engine {

enum class ContractErrorCode {
  ContractSyntaxError,
  ContractVersionError,
  ContractShapeError,
  ContractEnumError,
  ContractValueError,
  ImageColorError,
  MergeResolveError,
  MergeOverflowError,
  BarcodeEncodeError,
  BarcodeRepresentationError
};

struct ContractError {
  ContractErrorCode code;
  std::string path;
  std::string message;
};

[[nodiscard]] const char* to_string(ContractErrorCode code) noexcept;

} // namespace print_engine
