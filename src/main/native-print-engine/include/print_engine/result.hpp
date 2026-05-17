#pragma once

#include <string>
#include <utility>
#include <variant>

namespace print_engine {

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
