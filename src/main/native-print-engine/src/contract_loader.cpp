#include "print_engine/contract_loader.hpp"

#include "print_engine/path.hpp"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <initializer_list>
#include <map>
#include <optional>
#include <stdexcept>
#include <string>
#include <variant>
#include <vector>

namespace print_engine {
namespace {

struct JsonValue;

using JsonObject = std::map<std::string, JsonValue>;
using JsonArray = std::vector<JsonValue>;

struct JsonValue {
  using Storage = std::variant<std::nullptr_t, bool, double, std::string, JsonArray, JsonObject>;
  Storage storage;
};

class JsonParser {
public:
  explicit JsonParser(std::string_view input) : input_(input) {}

  [[nodiscard]] Result<JsonValue, ContractError> parse() {
    try {
      skip_ws();
      JsonValue value = parse_value();
      skip_ws();
      if (pos_ != input_.size()) {
        return syntax("unexpected trailing content");
      }
      return Result<JsonValue, ContractError>::ok(std::move(value));
    } catch (const std::runtime_error& error) {
      return syntax(error.what());
    }
  }

private:
  [[nodiscard]] Result<JsonValue, ContractError> syntax(const std::string& message) const {
    return Result<JsonValue, ContractError>::err(
      ContractError{ContractErrorCode::ContractSyntaxError, "$", message});
  }

  void skip_ws() {
    while (pos_ < input_.size() && std::isspace(static_cast<unsigned char>(input_[pos_]))) {
      ++pos_;
    }
  }

  [[nodiscard]] char peek() const {
    if (pos_ >= input_.size()) {
      throw std::runtime_error("unexpected end of input");
    }
    return input_[pos_];
  }

  char consume() {
    char ch = peek();
    ++pos_;
    return ch;
  }

  void expect(char expected) {
    char actual = consume();
    if (actual != expected) {
      throw std::runtime_error("expected different JSON delimiter");
    }
  }

  bool consume_literal(std::string_view literal) {
    if (input_.substr(pos_, literal.size()) == literal) {
      pos_ += literal.size();
      return true;
    }
    return false;
  }

  JsonValue parse_value() {
    skip_ws();
    const char ch = peek();
    if (ch == '{') {
      return JsonValue{parse_object()};
    }
    if (ch == '[') {
      return JsonValue{parse_array()};
    }
    if (ch == '"') {
      return JsonValue{parse_string()};
    }
    if (ch == '-' || std::isdigit(static_cast<unsigned char>(ch))) {
      return JsonValue{parse_number()};
    }
    if (consume_literal("true")) {
      return JsonValue{true};
    }
    if (consume_literal("false")) {
      return JsonValue{false};
    }
    if (consume_literal("null")) {
      return JsonValue{nullptr};
    }
    throw std::runtime_error("invalid JSON value");
  }

  JsonObject parse_object() {
    JsonObject object;
    expect('{');
    skip_ws();
    if (peek() == '}') {
      consume();
      return object;
    }

    while (true) {
      skip_ws();
      std::string key = parse_string();
      skip_ws();
      expect(':');
      JsonValue value = parse_value();
      object.emplace(std::move(key), std::move(value));
      skip_ws();
      const char next = consume();
      if (next == '}') {
        return object;
      }
      if (next != ',') {
        throw std::runtime_error("expected object comma");
      }
    }
  }

  JsonArray parse_array() {
    JsonArray array;
    expect('[');
    skip_ws();
    if (peek() == ']') {
      consume();
      return array;
    }

    while (true) {
      array.push_back(parse_value());
      skip_ws();
      const char next = consume();
      if (next == ']') {
        return array;
      }
      if (next != ',') {
        throw std::runtime_error("expected array comma");
      }
    }
  }

  std::string parse_string() {
    expect('"');
    std::string value;

    while (true) {
      const char ch = consume();
      if (ch == '"') {
        return value;
      }
      if (ch != '\\') {
        value.push_back(ch);
        continue;
      }

      const char escaped = consume();
      switch (escaped) {
        case '"':
        case '\\':
        case '/':
          value.push_back(escaped);
          break;
        case 'b':
          value.push_back('\b');
          break;
        case 'f':
          value.push_back('\f');
          break;
        case 'n':
          value.push_back('\n');
          break;
        case 'r':
          value.push_back('\r');
          break;
        case 't':
          value.push_back('\t');
          break;
        default:
          throw std::runtime_error("unsupported string escape");
      }
    }
  }

  double parse_number() {
    const std::size_t start = pos_;
    if (input_[pos_] == '-') {
      ++pos_;
    }
    while (pos_ < input_.size() && std::isdigit(static_cast<unsigned char>(input_[pos_]))) {
      ++pos_;
    }
    if (pos_ < input_.size() && input_[pos_] == '.') {
      ++pos_;
      while (pos_ < input_.size() && std::isdigit(static_cast<unsigned char>(input_[pos_]))) {
        ++pos_;
      }
    }
    if (pos_ < input_.size() && (input_[pos_] == 'e' || input_[pos_] == 'E')) {
      ++pos_;
      if (pos_ < input_.size() && (input_[pos_] == '+' || input_[pos_] == '-')) {
        ++pos_;
      }
      while (pos_ < input_.size() && std::isdigit(static_cast<unsigned char>(input_[pos_]))) {
        ++pos_;
      }
    }
    return std::stod(std::string(input_.substr(start, pos_ - start)));
  }

  std::string_view input_;
  std::size_t pos_ = 0;
};

[[nodiscard]] ContractError error(ContractErrorCode code, std::string path, std::string message) {
  return ContractError{code, std::move(path), std::move(message)};
}

[[nodiscard]] const JsonObject* as_object(const JsonValue& value) {
  return std::get_if<JsonObject>(&value.storage);
}

[[nodiscard]] const JsonArray* as_array(const JsonValue& value) {
  return std::get_if<JsonArray>(&value.storage);
}

[[nodiscard]] const std::string* as_string(const JsonValue& value) {
  return std::get_if<std::string>(&value.storage);
}

[[nodiscard]] const bool* as_bool(const JsonValue& value) {
  return std::get_if<bool>(&value.storage);
}

[[nodiscard]] const double* as_number(const JsonValue& value) {
  return std::get_if<double>(&value.storage);
}

[[nodiscard]] const JsonValue* find(const JsonObject& object, std::string_view key) {
  const auto it = object.find(std::string(key));
  if (it == object.end()) {
    return nullptr;
  }
  return &it->second;
}

[[nodiscard]] Result<const JsonObject*, ContractError> require_object(
    const JsonObject& parent,
    std::string_view key,
    std::string path) {
  const JsonValue* value = find(parent, key);
  if (value == nullptr) {
    return Result<const JsonObject*, ContractError>::err(
      error(ContractErrorCode::ContractShapeError, path, "required object is missing"));
  }
  const JsonObject* object = as_object(*value);
  if (object == nullptr) {
    return Result<const JsonObject*, ContractError>::err(
      error(ContractErrorCode::ContractShapeError, path, "expected object"));
  }
  return Result<const JsonObject*, ContractError>::ok(object);
}

[[nodiscard]] Result<const JsonArray*, ContractError> require_array(
    const JsonObject& parent,
    std::string_view key,
    std::string path) {
  const JsonValue* value = find(parent, key);
  if (value == nullptr) {
    return Result<const JsonArray*, ContractError>::err(
      error(ContractErrorCode::ContractShapeError, path, "required array is missing"));
  }
  const JsonArray* array = as_array(*value);
  if (array == nullptr) {
    return Result<const JsonArray*, ContractError>::err(
      error(ContractErrorCode::ContractShapeError, path, "expected array"));
  }
  return Result<const JsonArray*, ContractError>::ok(array);
}

[[nodiscard]] Result<std::string, ContractError> require_string(
    const JsonObject& parent,
    std::string_view key,
    std::string path) {
  const JsonValue* value = find(parent, key);
  if (value == nullptr) {
    return Result<std::string, ContractError>::err(
      error(ContractErrorCode::ContractShapeError, path, "required string is missing"));
  }
  const std::string* text = as_string(*value);
  if (text == nullptr) {
    return Result<std::string, ContractError>::err(
      error(ContractErrorCode::ContractShapeError, path, "expected string"));
  }
  return Result<std::string, ContractError>::ok(*text);
}

[[nodiscard]] Result<double, ContractError> require_number(
    const JsonObject& parent,
    std::string_view key,
    std::string path) {
  const JsonValue* value = find(parent, key);
  if (value == nullptr) {
    return Result<double, ContractError>::err(
      error(ContractErrorCode::ContractShapeError, path, "required number is missing"));
  }
  const double* number = as_number(*value);
  if (number == nullptr || !std::isfinite(*number)) {
    return Result<double, ContractError>::err(
      error(ContractErrorCode::ContractValueError, path, "expected finite number"));
  }
  return Result<double, ContractError>::ok(*number);
}

[[nodiscard]] Result<int, ContractError> require_int(
    const JsonObject& parent,
    std::string_view key,
    std::string path) {
  auto number = require_number(parent, key, path);
  if (!number) {
    return Result<int, ContractError>::err(number.error());
  }
  if (std::floor(number.value()) != number.value()) {
    return Result<int, ContractError>::err(
      error(ContractErrorCode::ContractValueError, std::string(path), "expected integer"));
  }
  return Result<int, ContractError>::ok(static_cast<int>(number.value()));
}

[[nodiscard]] Result<Unit, ContractError> require_bool(
    const JsonObject& parent,
    std::string_view key,
    std::string path) {
  const JsonValue* value = find(parent, key);
  if (value == nullptr) {
    return Result<Unit, ContractError>::err(
      error(ContractErrorCode::ContractShapeError, path, "required bool is missing"));
  }
  if (as_bool(*value) == nullptr) {
    return Result<Unit, ContractError>::err(
      error(ContractErrorCode::ContractShapeError, path, "expected bool"));
  }
  return Result<Unit, ContractError>::ok(Unit{});
}

[[nodiscard]] Result<bool, ContractError> read_bool(
    const JsonObject& parent,
    std::string_view key,
    std::string path) {
  const JsonValue* value = find(parent, key);
  if (value == nullptr) {
    return Result<bool, ContractError>::err(
      error(ContractErrorCode::ContractShapeError, path, "required bool is missing"));
  }
  const bool* parsed = as_bool(*value);
  if (parsed == nullptr) {
    return Result<bool, ContractError>::err(
      error(ContractErrorCode::ContractShapeError, path, "expected bool"));
  }
  return Result<bool, ContractError>::ok(*parsed);
}

// Optional bool: absent => false (additive/backward-compatible); present but
// not a bool => loud shape error. Used for font.underline / font.strikethrough
// so pre-existing contracts without them stay valid.
[[nodiscard]] Result<bool, ContractError> read_optional_bool(
    const JsonObject& parent,
    std::string_view key,
    std::string path) {
  const JsonValue* value = find(parent, key);
  if (value == nullptr) {
    return Result<bool, ContractError>::ok(false);
  }
  const bool* parsed = as_bool(*value);
  if (parsed == nullptr) {
    return Result<bool, ContractError>::err(
      error(ContractErrorCode::ContractShapeError, path, "expected bool"));
  }
  return Result<bool, ContractError>::ok(*parsed);
}

[[nodiscard]] bool is_base64_like(const std::string& value) {
  if (value.empty() || value.size() % 4 != 0) {
    return false;
  }
  for (const char ch : value) {
    const bool ok =
      std::isalnum(static_cast<unsigned char>(ch)) ||
      ch == '+' ||
      ch == '/' ||
      ch == '=';
    if (!ok) {
      return false;
    }
  }
  return true;
}

[[nodiscard]] std::optional<std::vector<unsigned char>> decode_base64(const std::string& value) {
  auto decode_char = [](char ch) -> int {
    if (ch >= 'A' && ch <= 'Z') {
      return ch - 'A';
    }
    if (ch >= 'a' && ch <= 'z') {
      return ch - 'a' + 26;
    }
    if (ch >= '0' && ch <= '9') {
      return ch - '0' + 52;
    }
    if (ch == '+') {
      return 62;
    }
    if (ch == '/') {
      return 63;
    }
    return -1;
  };

  if (!is_base64_like(value)) {
    return std::nullopt;
  }

  std::vector<unsigned char> bytes;
  for (std::size_t index = 0; index < value.size(); index += 4) {
    const int a = decode_char(value[index]);
    const int b = decode_char(value[index + 1]);
    const int c = value[index + 2] == '=' ? -1 : decode_char(value[index + 2]);
    const int d = value[index + 3] == '=' ? -1 : decode_char(value[index + 3]);
    if (a < 0 || b < 0 || (value[index + 2] != '=' && c < 0) || (value[index + 3] != '=' && d < 0)) {
      return std::nullopt;
    }

    bytes.push_back(static_cast<unsigned char>((a << 2) | (b >> 4)));
    if (value[index + 2] != '=') {
      bytes.push_back(static_cast<unsigned char>(((b & 0x0f) << 4) | (c >> 2)));
    }
    if (value[index + 3] != '=') {
      bytes.push_back(static_cast<unsigned char>(((c & 0x03) << 6) | d));
    }
  }

  return bytes;
}

[[nodiscard]] bool png_has_iccp_profile(const std::vector<unsigned char>& bytes) {
  constexpr unsigned char signature[] = {137, 80, 78, 71, 13, 10, 26, 10};
  if (bytes.size() < 12 || !std::equal(std::begin(signature), std::end(signature), bytes.begin())) {
    return false;
  }

  std::size_t pos = 8;
  while (pos + 8 <= bytes.size()) {
    const unsigned int length =
      (static_cast<unsigned int>(bytes[pos]) << 24) |
      (static_cast<unsigned int>(bytes[pos + 1]) << 16) |
      (static_cast<unsigned int>(bytes[pos + 2]) << 8) |
      static_cast<unsigned int>(bytes[pos + 3]);
    if (pos + 12ULL + length > bytes.size()) {
      return false;
    }

    const std::string type{
      static_cast<char>(bytes[pos + 4]),
      static_cast<char>(bytes[pos + 5]),
      static_cast<char>(bytes[pos + 6]),
      static_cast<char>(bytes[pos + 7])
    };
    if (type == "iCCP") {
      return true;
    }
    if (type == "IEND") {
      return false;
    }
    pos += 12ULL + length;
  }

  return false;
}

[[nodiscard]] bool has_key(const JsonObject& object, std::string_view key) {
  return find(object, key) != nullptr;
}

[[nodiscard]] bool is_one_of(const std::string& value, std::initializer_list<std::string_view> allowed) {
  for (const auto item : allowed) {
    if (value == item) {
      return true;
    }
  }
  return false;
}

[[nodiscard]] int hex_value(char ch) {
  if (ch >= '0' && ch <= '9') {
    return ch - '0';
  }
  if (ch >= 'a' && ch <= 'f') {
    return ch - 'a' + 10;
  }
  if (ch >= 'A' && ch <= 'F') {
    return ch - 'A' + 10;
  }
  return -1;
}

[[nodiscard]] Result<Rgba, ContractError> parse_hex_color(
    const std::string& value,
    double alpha,
    std::string path) {
  if (value.size() != 7 || value[0] != '#') {
    return Result<Rgba, ContractError>::err(
      error(ContractErrorCode::ContractValueError, std::move(path), "color must be #rrggbb"));
  }
  int values[6] = {};
  for (std::size_t index = 1; index < value.size(); ++index) {
    const int parsed = hex_value(value[index]);
    if (parsed < 0) {
      return Result<Rgba, ContractError>::err(
        error(ContractErrorCode::ContractValueError, std::move(path), "color must be #rrggbb"));
    }
    values[index - 1] = parsed;
  }
  return Result<Rgba, ContractError>::ok(Rgba{
    values[0] * 16 + values[1],
    values[2] * 16 + values[3],
    values[4] * 16 + values[5],
    alpha
  });
}

[[nodiscard]] Result<Unit, ContractError> reject_key(
    const JsonObject& object,
    std::string_view key,
    std::string path) {
  if (has_key(object, key)) {
    return Result<Unit, ContractError>::err(
      error(ContractErrorCode::ContractShapeError, std::move(path), "field is not allowed here"));
  }
  return Result<Unit, ContractError>::ok(Unit{});
}

[[nodiscard]] Result<Unit, ContractError> validate_box(const JsonObject& node, std::string path) {
  auto box = require_object(node, "box", path);
  if (!box) {
    return Result<Unit, ContractError>::err(box.error());
  }
  for (const char* key : {"x", "y", "w", "h"}) {
    auto number = require_number(*box.value(), key, path + "." + key);
    if (!number) {
      return Result<Unit, ContractError>::err(number.error());
    }
  }
  return Result<Unit, ContractError>::ok(Unit{});
}

[[nodiscard]] Result<Unit, ContractError> require_positive(double value, std::string path, std::string message) {
  if (value <= 0.0) {
    return Result<Unit, ContractError>::err(
      error(ContractErrorCode::ContractValueError, std::move(path), std::move(message)));
  }
  return Result<Unit, ContractError>::ok(Unit{});
}

[[nodiscard]] Result<Rect, ContractError> read_box(const JsonObject& node, std::string path) {
  auto box = require_object(node, "box", path);
  if (!box) {
    return Result<Rect, ContractError>::err(box.error());
  }

  auto x = require_number(*box.value(), "x", path + ".x");
  if (!x) {
    return Result<Rect, ContractError>::err(x.error());
  }
  auto y = require_number(*box.value(), "y", path + ".y");
  if (!y) {
    return Result<Rect, ContractError>::err(y.error());
  }
  auto w = require_number(*box.value(), "w", path + ".w");
  if (!w) {
    return Result<Rect, ContractError>::err(w.error());
  }
  auto h = require_number(*box.value(), "h", path + ".h");
  if (!h) {
    return Result<Rect, ContractError>::err(h.error());
  }
  return Result<Rect, ContractError>::ok(Rect{x.value(), y.value(), w.value(), h.value()});
}

[[nodiscard]] Result<Paint, ContractError> read_paint(const JsonObject& paint, std::string path) {
  auto type = require_string(paint, "type", path + ".type");
  if (!type) {
    return Result<Paint, ContractError>::err(type.error());
  }

  if (type.value() == "solid") {
    auto color = require_string(paint, "color", path + ".color");
    if (!color) {
      return Result<Paint, ContractError>::err(color.error());
    }
    auto alpha = require_number(paint, "alpha", path + ".alpha");
    if (!alpha) {
      return Result<Paint, ContractError>::err(alpha.error());
    }
    if (alpha.value() < 0.0 || alpha.value() > 1.0) {
      return Result<Paint, ContractError>::err(
        error(ContractErrorCode::ContractValueError, path + ".alpha", "alpha must be 0..1"));
    }
    auto rgba = parse_hex_color(color.value(), alpha.value(), path + ".color");
    if (!rgba) {
      return Result<Paint, ContractError>::err(rgba.error());
    }
    Paint result;
    result.type = PaintType::Solid;
    result.solid = rgba.value();
    return Result<Paint, ContractError>::ok(std::move(result));
  }

  if (type.value() == "linear" || type.value() == "radial") {
    auto stops = require_array(paint, "stops", path + ".stops");
    if (!stops) {
      return Result<Paint, ContractError>::err(stops.error());
    }
    if (stops.value()->empty()) {
      return Result<Paint, ContractError>::err(
        error(ContractErrorCode::ContractValueError, path + ".stops", "paint needs at least one stop"));
    }
    Paint result;
    result.type = type.value() == "linear" ? PaintType::Linear : PaintType::Radial;
    for (std::size_t index = 0; index < stops.value()->size(); ++index) {
      const std::string stop_path = path + ".stops[" + std::to_string(index) + "]";
      const JsonObject* stop = as_object((*stops.value())[index]);
      if (stop == nullptr) {
        return Result<Paint, ContractError>::err(
          error(ContractErrorCode::ContractShapeError, stop_path, "expected paint stop object"));
      }
      auto offset = require_number(*stop, "offset", stop_path + ".offset");
      if (!offset) {
        return Result<Paint, ContractError>::err(offset.error());
      }
      if (offset.value() < 0.0 || offset.value() > 1.0) {
        return Result<Paint, ContractError>::err(
          error(ContractErrorCode::ContractValueError, stop_path + ".offset", "stop offset must be 0..1"));
      }
      auto color = require_string(*stop, "color", stop_path + ".color");
      if (!color) {
        return Result<Paint, ContractError>::err(color.error());
      }
      double alpha_value = 1.0;
      if (const JsonValue* alpha = find(*stop, "alpha")) {
        const double* parsed = as_number(*alpha);
        if (parsed == nullptr || *parsed < 0.0 || *parsed > 1.0) {
          return Result<Paint, ContractError>::err(
            error(ContractErrorCode::ContractValueError, stop_path + ".alpha", "alpha must be 0..1"));
        }
        alpha_value = *parsed;
      }
      auto rgba = parse_hex_color(color.value(), alpha_value, stop_path + ".color");
      if (!rgba) {
        return Result<Paint, ContractError>::err(rgba.error());
      }
      result.stops.push_back(PaintStop{offset.value(), rgba.value()});
    }
    std::sort(result.stops.begin(), result.stops.end(), [](const PaintStop& a, const PaintStop& b) {
      return a.offset < b.offset;
    });
    return Result<Paint, ContractError>::ok(std::move(result));
  }

  return Result<Paint, ContractError>::err(
    error(ContractErrorCode::ContractEnumError, path + ".type", "unknown paint type"));
}

[[nodiscard]] Result<std::optional<StrokeStyle>, ContractError> read_optional_stroke(
    const JsonObject& node,
    std::string path) {
  const JsonValue* stroke_value = find(node, "stroke");
  if (stroke_value == nullptr || std::holds_alternative<std::nullptr_t>(stroke_value->storage)) {
    return Result<std::optional<StrokeStyle>, ContractError>::ok(std::nullopt);
  }
  const JsonObject* stroke = as_object(*stroke_value);
  if (stroke == nullptr) {
    return Result<std::optional<StrokeStyle>, ContractError>::err(
      error(ContractErrorCode::ContractShapeError, path, "expected stroke object or null"));
  }
  auto paint = require_object(*stroke, "paint", path + ".paint");
  if (!paint) {
    return Result<std::optional<StrokeStyle>, ContractError>::err(paint.error());
  }
  auto parsed_paint = read_paint(*paint.value(), path + ".paint");
  if (!parsed_paint) {
    return Result<std::optional<StrokeStyle>, ContractError>::err(parsed_paint.error());
  }
  auto width = require_number(*stroke, "width", path + ".width");
  if (!width) {
    return Result<std::optional<StrokeStyle>, ContractError>::err(width.error());
  }
  auto positive_width = require_positive(width.value(), path + ".width", "stroke width must be positive");
  if (!positive_width) {
    return Result<std::optional<StrokeStyle>, ContractError>::err(positive_width.error());
  }
  auto cap = require_string(*stroke, "cap", path + ".cap");
  if (!cap) {
    return Result<std::optional<StrokeStyle>, ContractError>::err(cap.error());
  }
  if (!is_one_of(cap.value(), {"butt", "round", "square"})) {
    return Result<std::optional<StrokeStyle>, ContractError>::err(
      error(ContractErrorCode::ContractEnumError, path + ".cap", "unknown stroke cap"));
  }
  auto join = require_string(*stroke, "join", path + ".join");
  if (!join) {
    return Result<std::optional<StrokeStyle>, ContractError>::err(join.error());
  }
  if (!is_one_of(join.value(), {"miter", "round", "bevel"})) {
    return Result<std::optional<StrokeStyle>, ContractError>::err(
      error(ContractErrorCode::ContractEnumError, path + ".join", "unknown stroke join"));
  }
  auto miter = require_number(*stroke, "miterLimit", path + ".miterLimit");
  if (!miter) {
    return Result<std::optional<StrokeStyle>, ContractError>::err(miter.error());
  }
  auto positive_miter = require_positive(miter.value(), path + ".miterLimit", "miterLimit must be positive");
  if (!positive_miter) {
    return Result<std::optional<StrokeStyle>, ContractError>::err(positive_miter.error());
  }
  const JsonValue* dash_value = find(*stroke, "dash");
  if (dash_value == nullptr) {
    return Result<std::optional<StrokeStyle>, ContractError>::err(
      error(ContractErrorCode::ContractShapeError, path + ".dash", "dash is required"));
  }
  std::vector<double> dash_values;
  if (!std::holds_alternative<std::nullptr_t>(dash_value->storage)) {
    const JsonArray* dash = as_array(*dash_value);
    if (dash == nullptr) {
      return Result<std::optional<StrokeStyle>, ContractError>::err(
        error(ContractErrorCode::ContractShapeError, path + ".dash", "dash must be an array or null"));
    }
    for (std::size_t index = 0; index < dash->size(); ++index) {
      const double* number = as_number((*dash)[index]);
      if (number == nullptr || *number <= 0.0 || !std::isfinite(*number)) {
        return Result<std::optional<StrokeStyle>, ContractError>::err(
          error(ContractErrorCode::ContractValueError, path + ".dash[" + std::to_string(index) + "]", "dash entries must be positive numbers"));
      }
      dash_values.push_back(*number);
    }
  }
  StrokeStyle style;
  style.paint = parsed_paint.value();
  style.width = width.value();
  style.cap = cap.value();
  style.join = join.value();
  style.miter_limit = miter.value();
  style.dash = std::move(dash_values);
  return Result<std::optional<StrokeStyle>, ContractError>::ok(std::move(style));
}

[[nodiscard]] Result<std::optional<Paint>, ContractError> read_optional_fill(const JsonObject& node, std::string path) {
  const JsonValue* fill_value = find(node, "fill");
  if (fill_value == nullptr || std::holds_alternative<std::nullptr_t>(fill_value->storage)) {
    return Result<std::optional<Paint>, ContractError>::ok(std::nullopt);
  }
  const JsonObject* fill = as_object(*fill_value);
  if (fill == nullptr) {
    return Result<std::optional<Paint>, ContractError>::err(
      error(ContractErrorCode::ContractShapeError, path, "expected fill object or null"));
  }
  auto parsed = read_paint(*fill, path);
  if (!parsed) {
    return Result<std::optional<Paint>, ContractError>::err(parsed.error());
  }
  return Result<std::optional<Paint>, ContractError>::ok(parsed.value());
}

[[nodiscard]] Result<std::vector<RichParagraph>, ContractError> read_rich_paragraphs(
    const JsonObject& content,
    std::string path);

[[nodiscard]] Result<Unit, ContractError> validate_text_content(
    const JsonObject& content,
    BakedDocument& document,
    std::string path) {
  auto type = require_string(content, "type", path + ".type");
  if (!type) {
    return Result<Unit, ContractError>::err(type.error());
  }

  if (type.value() == "static") {
    auto lines = require_array(content, "lines", path + ".lines");
    if (!lines) {
      return Result<Unit, ContractError>::err(lines.error());
    }
    for (const char* key : {"wrap", "overflow", "shrinkFloorPx", "key", "sample", "maxLen"}) {
      auto rejected = reject_key(content, key, path + "." + key);
      if (!rejected) {
        return rejected;
      }
    }
    return Result<Unit, ContractError>::ok(Unit{});
  }

  if (type.value() == "rich") {
    document.has_rich_text = true;
    auto paragraphs = read_rich_paragraphs(content, path);
    if (!paragraphs) return Result<Unit, ContractError>::err(paragraphs.error());
    for (const char* key : {"lines", "key", "sample", "maxLen", "wrap", "overflow", "shrinkFloorPx"}) {
      auto rejected = reject_key(content, key, path + "." + std::string(key));
      if (!rejected) return rejected;
    }
    return Result<Unit, ContractError>::ok(Unit{});
  }

  if (type.value() != "merge") {
    return Result<Unit, ContractError>::err(
      error(ContractErrorCode::ContractEnumError, path + ".type", "unknown text content type"));
  }

  document.has_merge_text = true;
  for (const char* key : {"key", "sample", "wrap", "overflow"}) {
    auto text = require_string(content, key, path + "." + key);
    if (!text) {
      return Result<Unit, ContractError>::err(text.error());
    }
  }
  auto max_len = require_int(content, "maxLen", path + ".maxLen");
  if (!max_len) {
    return Result<Unit, ContractError>::err(max_len.error());
  }
  if (max_len.value() < 0) {
    return Result<Unit, ContractError>::err(
      error(ContractErrorCode::ContractValueError, path + ".maxLen", "maxLen cannot be negative"));
  }

  const std::string wrap = require_string(content, "wrap", path + ".wrap").value();
  if (wrap != "none" && wrap != "word") {
    return Result<Unit, ContractError>::err(
      error(ContractErrorCode::ContractEnumError, path + ".wrap", "unknown wrap policy"));
  }

  const std::string overflow = require_string(content, "overflow", path + ".overflow").value();
  if (overflow != "reject" && overflow != "clip" && overflow != "shrink") {
    return Result<Unit, ContractError>::err(
      error(ContractErrorCode::ContractEnumError, path + ".overflow", "unknown overflow policy"));
  }
  if (overflow == "shrink") {
    auto floor = require_number(content, "shrinkFloorPx", path + ".shrinkFloorPx");
    if (!floor) {
      return Result<Unit, ContractError>::err(floor.error());
    }
    auto positive_floor = require_positive(floor.value(), path + ".shrinkFloorPx", "shrinkFloorPx must be positive");
    if (!positive_floor) {
      return positive_floor;
    }
  } else {
    auto rejected = reject_key(content, "shrinkFloorPx", path + ".shrinkFloorPx");
    if (!rejected) {
      return rejected;
    }
  }

  return Result<Unit, ContractError>::ok(Unit{});
}

[[nodiscard]] Result<std::vector<RichParagraph>, ContractError> read_rich_paragraphs(
    const JsonObject& content,
    std::string path) {
  auto paragraphs = require_array(content, "paragraphs", path + ".paragraphs");
  if (!paragraphs) {
    return Result<std::vector<RichParagraph>, ContractError>::err(paragraphs.error());
  }
  if (paragraphs.value()->empty()) {
    return Result<std::vector<RichParagraph>, ContractError>::err(
      error(ContractErrorCode::ContractValueError, path + ".paragraphs", "paragraphs must not be empty"));
  }
  std::vector<RichParagraph> out;
  for (std::size_t i = 0; i < paragraphs.value()->size(); ++i) {
    const auto item_path = path + ".paragraphs[" + std::to_string(i) + "]";
    const JsonObject* para = as_object((*paragraphs.value())[i]);
    if (para == nullptr) {
      return Result<std::vector<RichParagraph>, ContractError>::err(
        error(ContractErrorCode::ContractShapeError, item_path, "expected paragraph object"));
    }
    auto align = require_string(*para, "align", item_path + ".align");
    if (!align) return Result<std::vector<RichParagraph>, ContractError>::err(align.error());
    if (!is_one_of(align.value(), {"left", "center", "right"})) {
      return Result<std::vector<RichParagraph>, ContractError>::err(
        error(ContractErrorCode::ContractEnumError, item_path + ".align", "unknown paragraph alignment"));
    }
    RichParagraph rp; rp.align = align.value();
    const JsonValue* indent_v = find(*para, "indentPx");
    if (indent_v != nullptr) {
      const double* n = as_number(*indent_v);
      if (n == nullptr || *n < 0.0) {
        return Result<std::vector<RichParagraph>, ContractError>::err(
          error(ContractErrorCode::ContractValueError, item_path + ".indentPx", "indentPx must be >= 0"));
      }
      rp.indent_px = *n;
    }
    auto runs = require_array(*para, "runs", item_path + ".runs");
    if (!runs) return Result<std::vector<RichParagraph>, ContractError>::err(runs.error());
    for (std::size_t r = 0; r < runs.value()->size(); ++r) {
      const auto run_path = item_path + ".runs[" + std::to_string(r) + "]";
      const JsonObject* run = as_object((*runs.value())[r]);
      if (run == nullptr) {
        return Result<std::vector<RichParagraph>, ContractError>::err(
          error(ContractErrorCode::ContractShapeError, run_path, "expected run object"));
      }
      RichRun rr;
      auto text = require_string(*run, "text", run_path + ".text"); if (!text) return Result<std::vector<RichParagraph>, ContractError>::err(text.error()); rr.text = text.value();
      auto fam = require_string(*run, "fontFamily", run_path + ".fontFamily"); if (!fam) return Result<std::vector<RichParagraph>, ContractError>::err(fam.error()); rr.font_family = fam.value();
      auto sp = require_number(*run, "sizePx", run_path + ".sizePx"); if (!sp) return Result<std::vector<RichParagraph>, ContractError>::err(sp.error()); if (sp.value() <= 0.0) return Result<std::vector<RichParagraph>, ContractError>::err(error(ContractErrorCode::ContractValueError, run_path + ".sizePx", "sizePx must be positive")); rr.size_px = sp.value();
      auto wt = require_int(*run, "weight", run_path + ".weight"); if (!wt) return Result<std::vector<RichParagraph>, ContractError>::err(wt.error()); rr.weight = wt.value();
      auto it = read_bool(*run, "italic", run_path + ".italic"); if (!it) return Result<std::vector<RichParagraph>, ContractError>::err(it.error()); rr.italic = it.value();
      auto ul = read_bool(*run, "underline", run_path + ".underline"); if (!ul) return Result<std::vector<RichParagraph>, ContractError>::err(ul.error()); rr.underline = ul.value();
      auto st = read_bool(*run, "strikethrough", run_path + ".strikethrough"); if (!st) return Result<std::vector<RichParagraph>, ContractError>::err(st.error()); rr.strikethrough = st.value();
      auto col = require_string(*run, "color", run_path + ".color"); if (!col) return Result<std::vector<RichParagraph>, ContractError>::err(col.error());
      auto rgba = parse_hex_color(col.value(), 1.0, run_path + ".color"); if (!rgba) return Result<std::vector<RichParagraph>, ContractError>::err(rgba.error()); rr.color = rgba.value();
      rp.runs.push_back(std::move(rr));
    }
    out.push_back(std::move(rp));
  }
  return Result<std::vector<RichParagraph>, ContractError>::ok(std::move(out));
}

[[nodiscard]] Result<std::vector<std::string>, ContractError> read_static_lines(
    const JsonObject& content,
    std::string path) {
  auto lines = require_array(content, "lines", path + ".lines");
  if (!lines) {
    return Result<std::vector<std::string>, ContractError>::err(lines.error());
  }

  std::vector<std::string> result;
  for (std::size_t index = 0; index < lines.value()->size(); ++index) {
    const std::string item_path = path + ".lines[" + std::to_string(index) + "]";
    const std::string* line = as_string((*lines.value())[index]);
    if (line == nullptr) {
      return Result<std::vector<std::string>, ContractError>::err(
        error(ContractErrorCode::ContractShapeError, item_path, "expected string line"));
    }
    result.push_back(*line);
  }
  return Result<std::vector<std::string>, ContractError>::ok(std::move(result));
}

[[nodiscard]] Result<PaintNodeSummary, ContractError> validate_paint_node(
    const JsonObject& node,
    BakedDocument& document,
    std::string path) {
  auto kind = require_string(node, "kind", path + ".kind");
  if (!kind) {
    return Result<PaintNodeSummary, ContractError>::err(kind.error());
  }

  if (kind.value() == "path") {
    auto d = require_string(node, "d", path + ".d");
    if (!d) {
      return Result<PaintNodeSummary, ContractError>::err(d.error());
    }
    auto parsed = parse_absolute_svg_path(d.value());
    if (!parsed) {
      auto parse_error = parsed.error();
      parse_error.path = path + ".d";
      return Result<PaintNodeSummary, ContractError>::err(parse_error);
    }
    auto fill = read_optional_fill(node, path + ".fill");
    if (!fill) {
      return Result<PaintNodeSummary, ContractError>::err(fill.error());
    }
    auto stroke = read_optional_stroke(node, path + ".stroke");
    if (!stroke) {
      return Result<PaintNodeSummary, ContractError>::err(stroke.error());
    }
    PaintNodeSummary summary{};
    summary.kind = PaintKind::Path;
    summary.box = parsed.value().bounds;
    summary.path_data = d.value();
    summary.fill = fill.value();
    summary.stroke = stroke.value();
    return Result<PaintNodeSummary, ContractError>::ok(std::move(summary));
  }

  if (kind.value() == "text") {
    auto box = validate_box(node, path + ".box");
    if (!box) {
      return Result<PaintNodeSummary, ContractError>::err(box.error());
    }
    auto content = require_object(node, "content", path + ".content");
    if (!content) {
      return Result<PaintNodeSummary, ContractError>::err(content.error());
    }
    auto valid_content = validate_text_content(*content.value(), document, path + ".content");
    if (!valid_content) {
      return Result<PaintNodeSummary, ContractError>::err(valid_content.error());
    }
    auto font = require_object(node, "font", path + ".font");
    if (!font) {
      return Result<PaintNodeSummary, ContractError>::err(font.error());
    }
    auto family = require_string(*font.value(), "family", path + ".font.family");
    if (!family) {
      return Result<PaintNodeSummary, ContractError>::err(family.error());
    }
    auto size_px = require_number(*font.value(), "sizePx", path + ".font.sizePx");
    if (!size_px) {
      return Result<PaintNodeSummary, ContractError>::err(size_px.error());
    }
    auto positive_font = require_positive(size_px.value(), path + ".font.sizePx", "font size must be positive");
    if (!positive_font) {
      return Result<PaintNodeSummary, ContractError>::err(positive_font.error());
    }
    auto weight = require_int(*font.value(), "weight", path + ".font.weight");
    if (!weight) {
      return Result<PaintNodeSummary, ContractError>::err(weight.error());
    }
    auto italic = require_bool(*font.value(), "italic", path + ".font.italic");
    if (!italic) {
      return Result<PaintNodeSummary, ContractError>::err(italic.error());
    }
    const bool* italic_value = as_bool(*find(*font.value(), "italic"));
    auto underline = read_optional_bool(*font.value(), "underline",
                                        path + ".font.underline");
    if (!underline) {
      return Result<PaintNodeSummary, ContractError>::err(underline.error());
    }
    auto strikethrough = read_optional_bool(*font.value(), "strikethrough",
                                            path + ".font.strikethrough");
    if (!strikethrough) {
      return Result<PaintNodeSummary, ContractError>::err(strikethrough.error());
    }
    auto color = require_string(*font.value(), "color", path + ".font.color");
    if (!color) {
      return Result<PaintNodeSummary, ContractError>::err(color.error());
    }
    auto align = require_object(node, "align", path + ".align");
    if (!align) {
      return Result<PaintNodeSummary, ContractError>::err(align.error());
    }
    auto align_h = require_string(*align.value(), "h", path + ".align.h");
    if (!align_h) {
      return Result<PaintNodeSummary, ContractError>::err(align_h.error());
    }
    auto align_v = require_string(*align.value(), "v", path + ".align.v");
    if (!align_v) {
      return Result<PaintNodeSummary, ContractError>::err(align_v.error());
    }
    if (!is_one_of(align_h.value(), {"left", "center", "right"})) {
      return Result<PaintNodeSummary, ContractError>::err(
        error(ContractErrorCode::ContractEnumError, path + ".align.h", "unknown horizontal alignment"));
    }
    if (!is_one_of(align_v.value(), {"top", "middle", "bottom"})) {
      return Result<PaintNodeSummary, ContractError>::err(
        error(ContractErrorCode::ContractEnumError, path + ".align.v", "unknown vertical alignment"));
    }
    auto read = read_box(node, path + ".box");
    if (!read) {
      return Result<PaintNodeSummary, ContractError>::err(read.error());
    }
    PaintNodeSummary summary{};
    summary.kind = PaintKind::Text;
    summary.box = read.value();
    summary.font_family = family.value();
    summary.font_size_px = size_px.value();
    summary.font_weight = weight.value();
    summary.font_italic = italic_value != nullptr && *italic_value;
    summary.font_underline = underline.value();
    summary.font_strikethrough = strikethrough.value();
    summary.align_h = align_h.value();
    summary.align_v = align_v.value();
    auto font_rgba = parse_hex_color(color.value(), 1.0, path + ".font.color");
    if (!font_rgba) {
      return Result<PaintNodeSummary, ContractError>::err(font_rgba.error());
    }
    summary.font_color = font_rgba.value();

    auto content_type = require_string(*content.value(), "type", path + ".content.type");
    if (!content_type) {
      return Result<PaintNodeSummary, ContractError>::err(content_type.error());
    }
    if (content_type.value() == "static") {
      auto lines = read_static_lines(*content.value(), path + ".content");
      if (!lines) {
        return Result<PaintNodeSummary, ContractError>::err(lines.error());
      }
      summary.text_content_type = TextContentType::Static;
      summary.static_lines = lines.value();
    } else if (content_type.value() == "rich") {
      auto paras = read_rich_paragraphs(*content.value(), path + ".content");
      if (!paras) {
        return Result<PaintNodeSummary, ContractError>::err(paras.error());
      }
      summary.text_content_type = TextContentType::Rich;
      summary.rich_paragraphs = std::move(paras.value());
    } else if (content_type.value() == "merge") {
      summary.text_content_type = TextContentType::Merge;
      summary.merge_key = require_string(*content.value(), "key", path + ".content.key").value();
      summary.merge_sample = require_string(*content.value(), "sample", path + ".content.sample").value();
      summary.merge_max_len = require_int(*content.value(), "maxLen", path + ".content.maxLen").value();
      summary.merge_wrap = require_string(*content.value(), "wrap", path + ".content.wrap").value();
      summary.merge_overflow = require_string(*content.value(), "overflow", path + ".content.overflow").value();
      if (summary.merge_overflow == "shrink") {
        summary.shrink_floor_px = require_number(*content.value(), "shrinkFloorPx", path + ".content.shrinkFloorPx").value();
      }
    } else {
      return Result<PaintNodeSummary, ContractError>::err(
        error(ContractErrorCode::ContractEnumError, path + ".content.type", "unknown text content type"));
    }
    return Result<PaintNodeSummary, ContractError>::ok(summary);
  }

  if (kind.value() == "image") {
    auto box = validate_box(node, path + ".box");
    if (!box) {
      return Result<PaintNodeSummary, ContractError>::err(box.error());
    }
    for (const char* key : {"format", "data", "aspect"}) {
      auto text = require_string(node, key, path + "." + key);
      if (!text) {
        return Result<PaintNodeSummary, ContractError>::err(text.error());
      }
    }
    const auto format = require_string(node, "format", path + ".format");
    if (!format) {
      return Result<PaintNodeSummary, ContractError>::err(format.error());
    }
    if (format.value() != "png") {
      return Result<PaintNodeSummary, ContractError>::err(
        error(ContractErrorCode::ContractEnumError, path + ".format", "only png images are supported"));
    }
    const auto aspect = require_string(node, "aspect", path + ".aspect");
    if (!aspect) {
      return Result<PaintNodeSummary, ContractError>::err(aspect.error());
    }
    if (!is_one_of(aspect.value(), {"fill", "preserve"})) {
      return Result<PaintNodeSummary, ContractError>::err(
        error(ContractErrorCode::ContractEnumError, path + ".aspect", "unknown image aspect"));
    }
    auto flip_h = read_bool(node, "flipH", path + ".flipH");
    if (!flip_h) {
      return Result<PaintNodeSummary, ContractError>::err(flip_h.error());
    }
    auto flip_v = read_bool(node, "flipV", path + ".flipV");
    if (!flip_v) {
      return Result<PaintNodeSummary, ContractError>::err(flip_v.error());
    }
    const auto data = require_string(node, "data", path + ".data");
    if (!data) {
      return Result<PaintNodeSummary, ContractError>::err(data.error());
    }
    if (!is_base64_like(data.value())) {
      return Result<PaintNodeSummary, ContractError>::err(
        error(ContractErrorCode::ContractValueError, path + ".data", "image data must be base64"));
    }
    const auto decoded = decode_base64(data.value());
    if (!decoded) {
      return Result<PaintNodeSummary, ContractError>::err(
        error(ContractErrorCode::ContractValueError, path + ".data", "image data must be valid base64"));
    }
    if (png_has_iccp_profile(*decoded)) {
      return Result<PaintNodeSummary, ContractError>::err(
        error(ContractErrorCode::ImageColorError, path + ".data", "profiled/non-sRGB image payload refused"));
    }
    auto read = read_box(node, path + ".box");
    if (!read) {
      return Result<PaintNodeSummary, ContractError>::err(read.error());
    }
    PaintNodeSummary summary{};
    summary.kind = PaintKind::Image;
    summary.box = read.value();
    summary.image_format = format.value();
    summary.image_data = data.value();
    summary.image_aspect = aspect.value();
    summary.flip_h = flip_h.value();
    summary.flip_v = flip_v.value();
    return Result<PaintNodeSummary, ContractError>::ok(summary);
  }

  if (kind.value() == "svg") {
    auto box = validate_box(node, path + ".box");
    if (!box) {
      return Result<PaintNodeSummary, ContractError>::err(box.error());
    }
    for (const char* key : {"source", "aspect"}) {
      auto text = require_string(node, key, path + "." + key);
      if (!text) {
        return Result<PaintNodeSummary, ContractError>::err(text.error());
      }
    }
    auto source = require_string(node, "source", path + ".source");
    if (!source) {
      return Result<PaintNodeSummary, ContractError>::err(source.error());
    }
    const auto aspect = require_string(node, "aspect", path + ".aspect");
    if (!aspect) {
      return Result<PaintNodeSummary, ContractError>::err(aspect.error());
    }
    if (!is_one_of(aspect.value(), {"fill", "preserve"})) {
      return Result<PaintNodeSummary, ContractError>::err(
        error(ContractErrorCode::ContractEnumError, path + ".aspect", "unknown svg aspect"));
    }
    if (!is_base64_like(source.value())) {
      return Result<PaintNodeSummary, ContractError>::err(
        error(ContractErrorCode::ContractValueError, path + ".source", "svg source must be base64"));
    }
    auto read = read_box(node, path + ".box");
    if (!read) {
      return Result<PaintNodeSummary, ContractError>::err(read.error());
    }
    PaintNodeSummary summary{};
    summary.kind = PaintKind::Svg;
    summary.box = read.value();
    summary.svg_source = source.value();
    summary.svg_aspect = aspect.value();
    return Result<PaintNodeSummary, ContractError>::ok(summary);
  }

  if (kind.value() == "barcode") {
    document.has_barcode = true;
    auto box = validate_box(node, path + ".box");
    if (!box) {
      return Result<PaintNodeSummary, ContractError>::err(box.error());
    }
    auto symbology = require_string(node, "symbology", path + ".symbology");
    if (!symbology) {
      return Result<PaintNodeSummary, ContractError>::err(symbology.error());
    }
    auto value = require_object(node, "value", path + ".value");
    if (!value) {
      return Result<PaintNodeSummary, ContractError>::err(value.error());
    }
    auto type = require_string(*value.value(), "type", path + ".value.type");
    if (!type) {
      return Result<PaintNodeSummary, ContractError>::err(type.error());
    }
    if (type.value() != "static" && type.value() != "merge") {
      return Result<PaintNodeSummary, ContractError>::err(
        error(ContractErrorCode::ContractEnumError, path + ".value.type", "unknown barcode value type"));
    }
    if (type.value() == "merge") {
      for (const char* key : {"key", "sample"}) {
        auto text = require_string(*value.value(), key, path + ".value." + key);
        if (!text) {
          return Result<PaintNodeSummary, ContractError>::err(text.error());
        }
      }
      auto max_len = require_int(*value.value(), "maxLen", path + ".value.maxLen");
      if (!max_len) {
        return Result<PaintNodeSummary, ContractError>::err(max_len.error());
      }
      if (max_len.value() < 0) {
        return Result<PaintNodeSummary, ContractError>::err(
          error(ContractErrorCode::ContractValueError, path + ".value.maxLen", "maxLen cannot be negative"));
      }
      auto can_error = require_bool(*value.value(), "errorOnUnencodable", path + ".value.errorOnUnencodable");
      if (!can_error) {
        return Result<PaintNodeSummary, ContractError>::err(can_error.error());
      }
      const bool* error_on_unencodable = as_bool(*find(*value.value(), "errorOnUnencodable"));
      if (error_on_unencodable == nullptr || !*error_on_unencodable) {
        return Result<PaintNodeSummary, ContractError>::err(
          error(ContractErrorCode::ContractValueError, path + ".value.errorOnUnencodable", "barcode merge values must fail on unencodable data"));
      }
    } else {
      auto data = require_string(*value.value(), "data", path + ".value.data");
      if (!data) {
        return Result<PaintNodeSummary, ContractError>::err(data.error());
      }
    }
    auto read = read_box(node, path + ".box");
    if (!read) {
      return Result<PaintNodeSummary, ContractError>::err(read.error());
    }
    PaintNodeSummary summary{};
    summary.kind = PaintKind::Barcode;
    summary.box = read.value();
    summary.barcode_symbology = symbology.value();
    if (type.value() == "merge") {
      summary.barcode_value_type = BarcodeValueType::Merge;
      summary.merge_key = require_string(*value.value(), "key", path + ".value.key").value();
      summary.merge_sample = require_string(*value.value(), "sample", path + ".value.sample").value();
      summary.merge_max_len = require_int(*value.value(), "maxLen", path + ".value.maxLen").value();
    } else {
      summary.barcode_value_type = BarcodeValueType::Static;
      summary.barcode_static_value = require_string(*value.value(), "data", path + ".value.data").value();
    }
    return Result<PaintNodeSummary, ContractError>::ok(summary);
  }

  return Result<PaintNodeSummary, ContractError>::err(
    error(ContractErrorCode::ContractEnumError, path + ".kind", "unknown paint node kind"));
}

[[nodiscard]] ContractLoadResult validate_root(const JsonObject& root) {
  auto schema = require_object(root, "schema", "$.schema");
  if (!schema) {
    return ContractLoadResult::err(schema.error());
  }

  auto major = require_int(*schema.value(), "major", "$.schema.major");
  if (!major) {
    return ContractLoadResult::err(major.error());
  }
  auto minor = require_int(*schema.value(), "minor", "$.schema.minor");
  if (!minor) {
    return ContractLoadResult::err(minor.error());
  }
  if (major.value() != SupportedMajor) {
    return ContractLoadResult::err(
      error(ContractErrorCode::ContractVersionError, "$.schema.major", "unsupported schema major"));
  }

  BakedDocument document;
  document.schema = SchemaVersion{major.value(), minor.value()};
  document.has_degradation_notice = minor.value() > SupportedMinor;

  auto doc = require_object(root, "document", "$.document");
  if (!doc) {
    return ContractLoadResult::err(doc.error());
  }
  auto units = require_string(*doc.value(), "units", "$.document.units");
  if (!units) {
    return ContractLoadResult::err(units.error());
  }
  if (units.value() != "px") {
    return ContractLoadResult::err(
      error(ContractErrorCode::ContractEnumError, "$.document.units", "only px contract units are supported"));
  }
  document.units = units.value();

  auto pages = require_array(*doc.value(), "pages", "$.document.pages");
  if (!pages) {
    return ContractLoadResult::err(pages.error());
  }
  if (pages.value()->empty()) {
    return ContractLoadResult::err(
      error(ContractErrorCode::ContractValueError, "$.document.pages", "at least one page is required"));
  }

  for (std::size_t page_index = 0; page_index < pages.value()->size(); ++page_index) {
    const JsonObject* page = as_object((*pages.value())[page_index]);
    const std::string page_path = "$.document.pages[" + std::to_string(page_index) + "]";
    if (page == nullptr) {
      return ContractLoadResult::err(
        error(ContractErrorCode::ContractShapeError, page_path, "expected page object"));
    }

    PageSummary summary;
    auto id = require_string(*page, "id", page_path + ".id");
    if (!id) {
      return ContractLoadResult::err(id.error());
    }
    summary.id = id.value();

    auto size = require_object(*page, "size", page_path + ".size");
    if (!size) {
      return ContractLoadResult::err(size.error());
    }
    auto width = require_number(*size.value(), "w", page_path + ".size.w");
    if (!width) {
      return ContractLoadResult::err(width.error());
    }
    auto height = require_number(*size.value(), "h", page_path + ".size.h");
    if (!height) {
      return ContractLoadResult::err(height.error());
    }
    auto positive_page_w = require_positive(width.value(), page_path + ".size.w", "page width must be positive");
    if (!positive_page_w) {
      return ContractLoadResult::err(positive_page_w.error());
    }
    auto positive_page_h = require_positive(height.value(), page_path + ".size.h", "page height must be positive");
    if (!positive_page_h) {
      return ContractLoadResult::err(positive_page_h.error());
    }
    summary.width = width.value();
    summary.height = height.value();

    auto tiles = require_array(*page, "tiles", page_path + ".tiles");
    if (!tiles) {
      return ContractLoadResult::err(tiles.error());
    }
    if (tiles.value()->empty()) {
      return ContractLoadResult::err(
        error(ContractErrorCode::ContractValueError, page_path + ".tiles", "at least one tile is required"));
    }
    for (std::size_t tile_index = 0; tile_index < tiles.value()->size(); ++tile_index) {
      const JsonObject* tile = as_object((*tiles.value())[tile_index]);
      const std::string tile_path = page_path + ".tiles[" + std::to_string(tile_index) + "]";
      if (tile == nullptr) {
        return ContractLoadResult::err(
          error(ContractErrorCode::ContractShapeError, tile_path, "expected tile object"));
      }
      auto origin = require_object(*tile, "origin", tile_path + ".origin");
      if (!origin) {
        return ContractLoadResult::err(origin.error());
      }
      auto tile_size = require_object(*tile, "size", tile_path + ".size");
      if (!tile_size) {
        return ContractLoadResult::err(tile_size.error());
      }
      auto ox = require_number(*origin.value(), "x", tile_path + ".origin.x");
      if (!ox) {
        return ContractLoadResult::err(ox.error());
      }
      auto oy = require_number(*origin.value(), "y", tile_path + ".origin.y");
      if (!oy) {
        return ContractLoadResult::err(oy.error());
      }
      auto tw = require_number(*tile_size.value(), "w", tile_path + ".size.w");
      if (!tw) {
        return ContractLoadResult::err(tw.error());
      }
      auto th = require_number(*tile_size.value(), "h", tile_path + ".size.h");
      if (!th) {
        return ContractLoadResult::err(th.error());
      }
      auto positive_tile_w = require_positive(tw.value(), tile_path + ".size.w", "tile width must be positive");
      if (!positive_tile_w) {
        return ContractLoadResult::err(positive_tile_w.error());
      }
      auto positive_tile_h = require_positive(th.value(), tile_path + ".size.h", "tile height must be positive");
      if (!positive_tile_h) {
        return ContractLoadResult::err(positive_tile_h.error());
      }
      summary.tiles.push_back(TileSummary{Point{ox.value(), oy.value()}, Size{tw.value(), th.value()}});
    }

    auto paint = require_array(*page, "paint", page_path + ".paint");
    if (!paint) {
      return ContractLoadResult::err(paint.error());
    }
    for (std::size_t node_index = 0; node_index < paint.value()->size(); ++node_index) {
      const JsonObject* node = as_object((*paint.value())[node_index]);
      const std::string node_path = page_path + ".paint[" + std::to_string(node_index) + "]";
      if (node == nullptr) {
        return ContractLoadResult::err(
          error(ContractErrorCode::ContractShapeError, node_path, "expected paint node object"));
      }
      auto validated = validate_paint_node(*node, document, node_path);
      if (!validated) {
        return ContractLoadResult::err(validated.error());
      }
      summary.paint.push_back(validated.value());
    }

    document.pages.push_back(std::move(summary));
  }

  return ContractLoadResult::ok(std::move(document));
}

} // namespace

const char* to_string(ContractErrorCode code) noexcept {
  switch (code) {
    case ContractErrorCode::ContractSyntaxError:
      return "ContractSyntaxError";
    case ContractErrorCode::ContractVersionError:
      return "ContractVersionError";
    case ContractErrorCode::ContractShapeError:
      return "ContractShapeError";
    case ContractErrorCode::ContractEnumError:
      return "ContractEnumError";
    case ContractErrorCode::ContractValueError:
      return "ContractValueError";
    case ContractErrorCode::ImageColorError:
      return "ImageColorError";
    case ContractErrorCode::ImageDecodeError:
      return "ImageDecodeError";
    case ContractErrorCode::MergeResolveError:
      return "MergeResolveError";
    case ContractErrorCode::MergeOverflowError:
      return "MergeOverflowError";
    case ContractErrorCode::BarcodeEncodeError:
      return "BarcodeEncodeError";
    case ContractErrorCode::BarcodeRepresentationError:
      return "BarcodeRepresentationError";
    case ContractErrorCode::PrintDeviceError:
      return "PrintDeviceError";
  }
  return "UnknownContractError";
}

ContractLoadResult load_baked_contract(std::string_view json) {
  auto parsed = JsonParser(json).parse();
  if (!parsed) {
    return ContractLoadResult::err(parsed.error());
  }

  const JsonObject* root = as_object(parsed.value());
  if (root == nullptr) {
    return ContractLoadResult::err(
      error(ContractErrorCode::ContractShapeError, "$", "contract root must be an object"));
  }

  return validate_root(*root);
}

} // namespace print_engine
