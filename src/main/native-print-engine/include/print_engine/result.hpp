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
  MergeClip,
  // §6 SVG escalation: device-side success-notice carrying backend identity
  // ("rendered via <backend>"). Loud-by-design so the operator always sees
  // which external rasterizer produced the pixels (for regulated traceability).
  // The engine's StubbedSvgArtwork notice stays unchanged until the spec owner
  // formally lifts that posture; this is additive (a softer success notice).
  SvgArtworkRasterized
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
