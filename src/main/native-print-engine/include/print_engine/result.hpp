#pragma once

#include <string>
#include <utility>
#include <variant>
#include <vector>

namespace print_engine {

enum class DegradationNoticeType {
  StubbedBarcode,
  StubbedSvgArtwork,
  HardwareMarginClip,
  FontSubstitution,
  MergeClip
};

struct DegradationNotice {
  DegradationNoticeType type;
  std::string page_id;
  std::string detail;
  std::string symbology;
  std::string resolved_value;
};

template <typename TValue, typename TError>
class Result {
public:
  [[nodiscard]] static Result ok(TValue value) {
    return Result(std::move(value));
  }

  [[nodiscard]] static Result err(TError error) {
    return Result(std::move(error));
  }

  [[nodiscard]] bool has_value() const {
    return std::holds_alternative<TValue>(value_);
  }

  [[nodiscard]] explicit operator bool() const {
    return has_value();
  }

  [[nodiscard]] const TValue& value() const {
    return std::get<TValue>(value_);
  }

  [[nodiscard]] const TError& error() const {
    return std::get<TError>(value_);
  }

private:
  explicit Result(TValue value) : value_(std::move(value)) {}
  explicit Result(TError error) : value_(std::move(error)) {}

  std::variant<TValue, TError> value_;
};

struct Unit {
};

} // namespace print_engine
