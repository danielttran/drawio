#include "print_engine/proto.hpp"

#include <array>
#include <charconv>
#include <cmath>
#include <cstring>
#include <sstream>

namespace print_engine::proto {
namespace {

void put_u32_le(std::vector<std::uint8_t>& out, std::uint32_t v) {
  out.push_back(static_cast<std::uint8_t>(v & 0xFFu));
  out.push_back(static_cast<std::uint8_t>((v >> 8) & 0xFFu));
  out.push_back(static_cast<std::uint8_t>((v >> 16) & 0xFFu));
  out.push_back(static_cast<std::uint8_t>((v >> 24) & 0xFFu));
}

std::uint32_t get_u32_le(const std::uint8_t* p) {
  return static_cast<std::uint32_t>(p[0]) |
         (static_cast<std::uint32_t>(p[1]) << 8) |
         (static_cast<std::uint32_t>(p[2]) << 16) |
         (static_cast<std::uint32_t>(p[3]) << 24);
}

}  // namespace

// ---------------------------------------------------------------------------
// Frame codec
// ---------------------------------------------------------------------------
std::optional<std::vector<std::uint8_t>> encode_frame(
    FrameType type, std::uint32_t stream_id,
    const std::vector<std::uint8_t>& payload) {
  // Refuse BEFORE emission: a frameLen > kMaxFrameLen (or one that wrapped
  // uint32) would be flushed to the wire and kill the peer's decoder -- a
  // transport-fatal corruption the sender must surface as a typed error.
  if (payload.size() > kMaxFramePayload) {
    return std::nullopt;
  }
  // frameLen covers frameType(1) + streamId(4) + payload.
  const std::uint64_t frame_len =
      static_cast<std::uint64_t>(payload.size()) + 1u + 4u;
  std::vector<std::uint8_t> out;
  out.reserve(static_cast<std::size_t>(frame_len) + 4u);
  put_u32_le(out, static_cast<std::uint32_t>(frame_len));
  out.push_back(static_cast<std::uint8_t>(type));
  put_u32_le(out, stream_id);
  out.insert(out.end(), payload.begin(), payload.end());
  return out;
}

void FrameDecoder::feed(const std::uint8_t* data, std::size_t len) {
  if (failed_ || data == nullptr || len == 0) {
    return;
  }
  buf_.insert(buf_.end(), data, data + len);
}

void FrameDecoder::feed(const std::vector<std::uint8_t>& bytes) {
  feed(bytes.data(), bytes.size());
}

std::optional<Frame> FrameDecoder::next() {
  if (failed_) {
    return std::nullopt;
  }
  const std::size_t avail = buf_.size() - consumed_;
  if (avail < 4u) {
    return std::nullopt;
  }
  const std::uint8_t* base = buf_.data() + consumed_;
  const std::uint32_t frame_len = get_u32_le(base);

  // frameLen must at least cover frameType(1) + streamId(4); bound the rest so
  // a corrupt prefix cannot drive an unbounded allocation.
  if (frame_len < 5u || frame_len > kMaxFrameLen) {
    failed_ = true;
    error_ = "frame length out of range";
    return std::nullopt;
  }
  if (avail < static_cast<std::size_t>(frame_len) + 4u) {
    return std::nullopt;  // partial frame; wait for more bytes
  }

  const std::uint8_t type_byte = base[4];
  if (type_byte != static_cast<std::uint8_t>(FrameType::Control) &&
      type_byte != static_cast<std::uint8_t>(FrameType::Binary)) {
    failed_ = true;
    error_ = "unknown frame type";
    return std::nullopt;
  }

  Frame frame;
  frame.type = static_cast<FrameType>(type_byte);
  frame.stream_id = get_u32_le(base + 5);
  const std::size_t payload_len = static_cast<std::size_t>(frame_len) - 5u;
  frame.payload.assign(base + 9, base + 9 + payload_len);

  consumed_ += static_cast<std::size_t>(frame_len) + 4u;
  // Reclaim space once the consumed prefix dominates the buffer.
  if (consumed_ > 0 && consumed_ >= buf_.size()) {
    buf_.clear();
    consumed_ = 0;
  } else if (consumed_ > (1u << 20)) {
    buf_.erase(buf_.begin(), buf_.begin() + static_cast<std::ptrdiff_t>(consumed_));
    consumed_ = 0;
  }
  return frame;
}

// ---------------------------------------------------------------------------
// Error / notice / op string mapping
// ---------------------------------------------------------------------------
const char* to_wire(ProtoErrorKind kind) noexcept {
  switch (kind) {
    case ProtoErrorKind::ProtoHandshakeError:    return "ProtoHandshakeError";
    case ProtoErrorKind::ProtoVersionError:      return "ProtoVersionError";
    case ProtoErrorKind::ContractVersionError:   return "ContractVersionError";
    case ProtoErrorKind::ContractValidationError:return "ContractValidationError";
    case ProtoErrorKind::MergeOverflowError:     return "MergeOverflowError";
    case ProtoErrorKind::ImageDecodeError:       return "ImageDecodeError";
    case ProtoErrorKind::ImageColorError:        return "ImageColorError";
    case ProtoErrorKind::PrintDeviceError:       return "PrintDeviceError";
    case ProtoErrorKind::EngineBusyError:        return "EngineBusyError";
    case ProtoErrorKind::EngineInternalError:    return "EngineInternalError";
    case ProtoErrorKind::BarcodeEncodeError:     return "BarcodeEncodeError";
  }
  return "EngineInternalError";
}

ProtoErrorKind map_contract_error(ContractErrorCode code) noexcept {
  switch (code) {
    case ContractErrorCode::ContractVersionError:
      return ProtoErrorKind::ContractVersionError;
    case ContractErrorCode::ContractSyntaxError:
    case ContractErrorCode::ContractShapeError:
    case ContractErrorCode::ContractEnumError:
    case ContractErrorCode::ContractValueError:
      return ProtoErrorKind::ContractValidationError;
    case ContractErrorCode::ImageColorError:
      return ProtoErrorKind::ImageColorError;
    case ContractErrorCode::ImageDecodeError:
      return ProtoErrorKind::ImageDecodeError;
    case ContractErrorCode::MergeResolveError:
    case ContractErrorCode::MergeOverflowError:
      return ProtoErrorKind::MergeOverflowError;
    case ContractErrorCode::BarcodeEncodeError:
    case ContractErrorCode::BarcodeRepresentationError:
      return ProtoErrorKind::BarcodeEncodeError;
    case ContractErrorCode::PrintDeviceError:
      return ProtoErrorKind::PrintDeviceError;
  }
  return ProtoErrorKind::EngineInternalError;
}

const char* to_wire(NoticeKind kind) noexcept {
  switch (kind) {
    case NoticeKind::StubbedBarcode:    return "StubbedBarcode";
    case NoticeKind::StubbedSvgArtwork: return "StubbedSvgArtwork";
    case NoticeKind::HardwareMarginClip:return "HardwareMarginClip";
    case NoticeKind::FontSubstituted:   return "FontSubstituted";
    case NoticeKind::MergeClip:         return "MergeClip";
    case NoticeKind::SchemaMinorAhead:  return "SchemaMinorAhead";
    case NoticeKind::ProtoMinorAhead:   return "ProtoMinorAhead";
    case NoticeKind::SvgArtworkRasterized: return "SvgArtworkRasterized";
    case NoticeKind::TileCoverageGap:   return "TileCoverageGap";
  }
  return "StubbedBarcode";
}

NoticeKind map_notice(DegradationNoticeType type) noexcept {
  switch (type) {
    case DegradationNoticeType::StubbedBarcode:    return NoticeKind::StubbedBarcode;
    case DegradationNoticeType::StubbedSvgArtwork: return NoticeKind::StubbedSvgArtwork;
    case DegradationNoticeType::HardwareMarginClip:return NoticeKind::HardwareMarginClip;
    case DegradationNoticeType::FontSubstitution:  return NoticeKind::FontSubstituted;
    case DegradationNoticeType::MergeClip:         return NoticeKind::MergeClip;
    case DegradationNoticeType::SvgArtworkRasterized: return NoticeKind::SvgArtworkRasterized;
    case DegradationNoticeType::TileCoverageGap:   return NoticeKind::TileCoverageGap;
  }
  return NoticeKind::StubbedBarcode;
}

std::optional<Op> parse_op(std::string_view name) noexcept {
  if (name == "Hello") return Op::Hello;
  if (name == "Ping") return Op::Ping;
  if (name == "GetCapabilities") return Op::GetCapabilities;
  if (name == "GetContractFields") return Op::GetContractFields;
  if (name == "RenderPreview") return Op::RenderPreview;
  if (name == "Print") return Op::Print;
  if (name == "ReleaseContract") return Op::ReleaseContract;
  if (name == "Shutdown") return Op::Shutdown;
  return std::nullopt;
}

const char* to_wire(Op op) noexcept {
  switch (op) {
    case Op::Hello:             return "Hello";
    case Op::Ping:              return "Ping";
    case Op::GetCapabilities:   return "GetCapabilities";
    case Op::GetContractFields: return "GetContractFields";
    case Op::RenderPreview:     return "RenderPreview";
    case Op::Print:             return "Print";
    case Op::ReleaseContract:   return "ReleaseContract";
    case Op::Shutdown:          return "Shutdown";
  }
  return "Hello";
}

// ---------------------------------------------------------------------------
// Handshake / ordering gate
// ---------------------------------------------------------------------------
HandshakeOutcome ProtoSession::on_hello(ProtoVersion peer) {
  HandshakeOutcome out;
  if (peer.major != kProtoMajor) {
    version_rejected_ = true;
    out.ok = false;
    out.error = ProtoErrorKind::ProtoVersionError;
    return out;
  }
  handshaked_ = true;
  out.ok = true;
  out.minor_ahead = peer.minor > kProtoMinor;  // additive-only assumption
  return out;
}

std::optional<ProtoErrorKind> ProtoSession::gate(Op op) const {
  if (version_rejected_) {
    // Major mismatch already declared: refuse everything, loudly, no best-effort.
    return ProtoErrorKind::ProtoVersionError;
  }
  if (op == Op::Hello) {
    return std::nullopt;  // Hello is always allowed to be attempted
  }
  if (!handshaked_) {
    // Defined ordering: any non-Hello op before HelloOk is refused.
    return ProtoErrorKind::ProtoHandshakeError;
  }
  return std::nullopt;
}

// ---------------------------------------------------------------------------
// Minimal JSON
// ---------------------------------------------------------------------------
Json Json::boolean(bool v) {
  Json j;
  j.type_ = Type::Bool;
  j.bool_ = v;
  return j;
}
Json Json::number(double v) {
  Json j;
  j.type_ = Type::Number;
  j.number_ = v;
  return j;
}
Json Json::str(std::string v) {
  Json j;
  j.type_ = Type::String;
  j.string_ = std::move(v);
  return j;
}
Json Json::array() {
  Json j;
  j.type_ = Type::Array;
  return j;
}
Json Json::object() {
  Json j;
  j.type_ = Type::Object;
  return j;
}

Json& Json::set(const std::string& key, Json value) {
  type_ = Type::Object;
  for (auto& kv : object_) {
    if (kv.first == key) {
      kv.second = std::move(value);
      return kv.second;
    }
  }
  object_.emplace_back(key, std::move(value));
  return object_.back().second;
}

const Json* Json::get(const std::string& key) const {
  if (type_ != Type::Object) {
    return nullptr;
  }
  for (const auto& kv : object_) {
    if (kv.first == key) {
      return &kv.second;
    }
  }
  return nullptr;
}

Json& Json::push_back(Json value) {
  type_ = Type::Array;
  array_.push_back(std::move(value));
  return array_.back();
}

bool Json::as_bool(bool fallback) const {
  return type_ == Type::Bool ? bool_ : fallback;
}
double Json::as_number(double fallback) const {
  return type_ == Type::Number ? number_ : fallback;
}
std::string Json::as_string(std::string_view fallback) const {
  return type_ == Type::String ? string_ : std::string(fallback);
}

namespace {

void escape_to(std::string& out, const std::string& s) {
  out.push_back('"');
  for (const char c : s) {
    switch (c) {
      case '"':  out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\b': out += "\\b";  break;
      case '\f': out += "\\f";  break;
      case '\n': out += "\\n";  break;
      case '\r': out += "\\r";  break;
      case '\t': out += "\\t";  break;
      default:
        if (static_cast<unsigned char>(c) < 0x20) {
          std::array<char, 7> buf{};
          std::snprintf(buf.data(), buf.size(), "\\u%04x",
                        static_cast<unsigned int>(static_cast<unsigned char>(c)));
          out += buf.data();
        } else {
          out.push_back(c);
        }
    }
  }
  out.push_back('"');
}

void number_to(std::string& out, double v) {
  if (std::isnan(v) || std::isinf(v)) {
    out += "0";  // JSON has no NaN/Inf; loud-fail callers never produce these
    return;
  }
  // Emit whole numbers without a decimal point (stable, diff-friendly).
  if (v == std::floor(v) && std::fabs(v) < 1e15) {
    std::array<char, 32> buf{};
    std::snprintf(buf.data(), buf.size(), "%lld",
                  static_cast<long long>(v));
    out += buf.data();
    return;
  }
  // Shortest representation that round-trips exactly: %.10g lost precision
  // (near-DBL_MAX values re-parsed to a different double), while a flat
  // %.17g is noisy for common values (0.1 -> "0.10000000000000001").
  std::array<char, 64> buf{};
  for (int precision = 15; precision <= 17; ++precision) {
    std::snprintf(buf.data(), buf.size(), "%.*g", precision, v);
    double back = 0.0;
    const char* end = buf.data() + std::strlen(buf.data());
    const auto [ptr, ec] = std::from_chars(buf.data(), end, back);
    if (ec == std::errc() && ptr == end && back == v) {
      break;  // %.17g always round-trips, so the loop cannot fall through
    }
  }
  out += buf.data();
}

void serialize_to(std::string& out, const Json& j);

void serialize_to(std::string& out, const Json& j) {
  switch (j.type()) {
    case Json::Type::Null:
      out += "null";
      break;
    case Json::Type::Bool:
      out += j.as_bool() ? "true" : "false";
      break;
    case Json::Type::Number:
      number_to(out, j.as_number());
      break;
    case Json::Type::String:
      escape_to(out, j.as_string());
      break;
    case Json::Type::Array: {
      out.push_back('[');
      bool first = true;
      for (const auto& item : j.items()) {
        if (!first) out.push_back(',');
        first = false;
        serialize_to(out, item);
      }
      out.push_back(']');
      break;
    }
    case Json::Type::Object: {
      out.push_back('{');
      bool first = true;
      // Reach object pairs via the public key set we know we inserted.
      // (Object is insertion-ordered internally; re-serialize through get()
      //  would lose unknown keys, so we expose ordering through items()-like
      //  traversal below.)
      for (const auto& kv : j.object_pairs()) {
        if (!first) out.push_back(',');
        first = false;
        escape_to(out, kv.first);
        out.push_back(':');
        serialize_to(out, kv.second);
      }
      out.push_back('}');
      break;
    }
  }
}

// Recursion ceiling for the recursive-descent parser. Without it a payload of
// ~1M nested '[' overflows the stack and kills the process instead of failing
// with a typed parse error. 512 matches practical JSON.parse nesting limits;
// real control payloads are a handful of levels deep.
constexpr std::size_t kMaxNestingDepth = 512;

// Strict JSON number grammar (RFC 8259): rejects what std::stod silently
// prefix-parsed -- trailing garbage ("1-2", "1.2.3"), bare exponents ("1.5e"),
// leading zeros ("01") and '+' prefixes.
bool is_valid_json_number(std::string_view t) {
  std::size_t k = 0;
  if (k < t.size() && t[k] == '-') ++k;
  if (k >= t.size()) return false;
  if (t[k] == '0') {
    ++k;
  } else if (t[k] >= '1' && t[k] <= '9') {
    while (k < t.size() && t[k] >= '0' && t[k] <= '9') ++k;
  } else {
    return false;
  }
  if (k < t.size() && t[k] == '.') {
    ++k;
    if (k >= t.size() || t[k] < '0' || t[k] > '9') return false;
    while (k < t.size() && t[k] >= '0' && t[k] <= '9') ++k;
  }
  if (k < t.size() && (t[k] == 'e' || t[k] == 'E')) {
    ++k;
    if (k < t.size() && (t[k] == '+' || t[k] == '-')) ++k;
    if (k >= t.size() || t[k] < '0' || t[k] > '9') return false;
    while (k < t.size() && t[k] >= '0' && t[k] <= '9') ++k;
  }
  return k == t.size();
}

struct Parser {
  std::string_view s;
  std::size_t i = 0;
  std::size_t depth = 0;
  std::string err;

  void skip_ws() {
    while (i < s.size()) {
      const char c = s[i];
      if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
        ++i;
      } else {
        break;
      }
    }
  }

  bool fail(std::string m) {
    if (err.empty()) err = std::move(m);
    return false;
  }

  bool parse_value(Json& out);
  bool parse_value_inner(Json& out);

  bool read_hex4(unsigned int& cp) {
    if (i + 4 > s.size()) return fail("bad \\u");
    cp = 0;
    for (int k = 0; k < 4; ++k) {
      const char h = s[i++];
      cp <<= 4;
      if (h >= '0' && h <= '9') cp |= static_cast<unsigned>(h - '0');
      else if (h >= 'a' && h <= 'f') cp |= static_cast<unsigned>(h - 'a' + 10);
      else if (h >= 'A' && h <= 'F') cp |= static_cast<unsigned>(h - 'A' + 10);
      else return fail("bad hex");
    }
    return true;
  }

  bool parse_string(std::string& out) {
    if (i >= s.size() || s[i] != '"') return fail("expected string");
    ++i;
    while (i < s.size()) {
      const char c = s[i++];
      if (c == '"') return true;
      if (c == '\\') {
        if (i >= s.size()) return fail("bad escape");
        const char e = s[i++];
        switch (e) {
          case '"':  out.push_back('"');  break;
          case '\\': out.push_back('\\'); break;
          case '/':  out.push_back('/');  break;
          case 'b':  out.push_back('\b'); break;
          case 'f':  out.push_back('\f'); break;
          case 'n':  out.push_back('\n'); break;
          case 'r':  out.push_back('\r'); break;
          case 't':  out.push_back('\t'); break;
          case 'u': {
            unsigned int cp = 0;
            if (!read_hex4(cp)) return false;
            // JSON.stringify emits surrogate-pair \u escapes for any non-BMP
            // character (e.g. emoji in mergeData values); they must combine
            // into the supplementary code point, NOT be encoded as two
            // 3-byte CESU-8 units (byte-invalid UTF-8 for the engine).
            //
            // Lone surrogates: JSON.parse accepts them but they have no
            // valid UTF-8 encoding, so substitute U+FFFD (replacement
            // character) -- visibly degraded, never byte-invalid, matching
            // the contract loader's behaviour.
            if (cp >= 0xD800 && cp <= 0xDBFF) {
              if (i + 1 < s.size() && s[i] == '\\' && s[i + 1] == 'u') {
                const std::size_t saved = i;
                i += 2;
                unsigned int low = 0;
                if (!read_hex4(low)) return false;
                if (low >= 0xDC00 && low <= 0xDFFF) {
                  cp = 0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00);
                } else {
                  // Valid escape but not a low surrogate: leave it for the
                  // main loop and replace the lone high surrogate.
                  i = saved;
                  cp = 0xFFFD;
                }
              } else {
                cp = 0xFFFD;
              }
            } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
              cp = 0xFFFD;  // lone low surrogate
            }
            if (cp < 0x80) {
              out.push_back(static_cast<char>(cp));
            } else if (cp < 0x800) {
              out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
              out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
            } else if (cp < 0x10000) {
              out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
              out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
              out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
            } else {
              out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
              out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
              out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
              out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
            }
            break;
          }
          default:
            return fail("bad escape char");
        }
      } else {
        // Raw (unescaped) control characters are invalid JSON (RFC 8259);
        // JSON.parse rejects them and JSON.stringify always escapes them,
        // so accepting them here only masked producer corruption.
        if (static_cast<unsigned char>(c) < 0x20) {
          return fail("raw control character in string");
        }
        out.push_back(c);
      }
    }
    return fail("unterminated string");
  }

  bool literal(std::string_view lit) {
    if (s.substr(i, lit.size()) != lit) return fail("bad literal");
    i += lit.size();
    return true;
  }
};

bool Parser::parse_value(Json& out) {
  if (depth >= kMaxNestingDepth) return fail("nesting depth exceeded");
  ++depth;
  const bool ok = parse_value_inner(out);
  --depth;
  return ok;
}

bool Parser::parse_value_inner(Json& out) {
  skip_ws();
  if (i >= s.size()) return fail("unexpected end");
  const char c = s[i];
  if (c == '"') {
    std::string str;
    if (!parse_string(str)) return false;
    out = Json::str(std::move(str));
    return true;
  }
  if (c == '{') {
    ++i;
    out = Json::object();
    skip_ws();
    if (i < s.size() && s[i] == '}') { ++i; return true; }
    while (true) {
      skip_ws();
      std::string key;
      if (!parse_string(key)) return false;
      skip_ws();
      if (i >= s.size() || s[i] != ':') return fail("expected ':'");
      ++i;
      Json val;
      if (!parse_value(val)) return false;
      out.set(key, std::move(val));
      skip_ws();
      if (i >= s.size()) return fail("unterminated object");
      if (s[i] == ',') { ++i; continue; }
      if (s[i] == '}') { ++i; break; }
      return fail("expected ',' or '}'");
    }
    return true;
  }
  if (c == '[') {
    ++i;
    out = Json::array();
    skip_ws();
    if (i < s.size() && s[i] == ']') { ++i; return true; }
    while (true) {
      Json val;
      if (!parse_value(val)) return false;
      out.push_back(std::move(val));
      skip_ws();
      if (i >= s.size()) return fail("unterminated array");
      if (s[i] == ',') { ++i; continue; }
      if (s[i] == ']') { ++i; break; }
      return fail("expected ',' or ']'");
    }
    return true;
  }
  if (c == 't') { if (!literal("true")) return false; out = Json::boolean(true); return true; }
  if (c == 'f') { if (!literal("false")) return false; out = Json::boolean(false); return true; }
  if (c == 'n') { if (!literal("null")) return false; out = Json(); return true; }
  if (c == '-' || (c >= '0' && c <= '9')) {
    const std::size_t start = i;
    if (s[i] == '-') ++i;
    while (i < s.size() &&
           ((s[i] >= '0' && s[i] <= '9') || s[i] == '.' || s[i] == 'e' ||
            s[i] == 'E' || s[i] == '+' || s[i] == '-')) {
      ++i;
    }
    const std::string_view token = s.substr(start, i - start);
    // std::from_chars over the FULL token, NOT std::stod: stod parsed a
    // prefix and ignored trailing garbage ("1-2" -> 1, "1.5e" -> 1.5) and is
    // locale-sensitive. The grammar check additionally refuses non-JSON
    // shapes from_chars would accept ("01", leading '+').
    if (!is_valid_json_number(token)) return fail("bad number");
    double parsed = 0.0;
    const auto [ptr, ec] =
        std::from_chars(token.data(), token.data() + token.size(), parsed);
    if (ec != std::errc() || ptr != token.data() + token.size() ||
        !std::isfinite(parsed)) {
      return fail("bad number");
    }
    out = Json::number(parsed);
    return true;
  }
  return fail("unexpected token");
}

}  // namespace

std::string Json::serialize() const {
  std::string out;
  serialize_to(out, *this);
  return out;
}

Result<Json, std::string> Json::parse(std::string_view text) {
  Parser p;
  p.s = text;
  Json root;
  if (!p.parse_value(root)) {
    return Result<Json, std::string>::err(
        p.err.empty() ? std::string("parse error") : p.err);
  }
  p.skip_ws();
  if (p.i != p.s.size()) {
    return Result<Json, std::string>::err("trailing data after JSON value");
  }
  return Result<Json, std::string>::ok(std::move(root));
}

std::vector<std::uint8_t> encode_control(const Json& message) {
  const std::string text = message.serialize();
  return std::vector<std::uint8_t>(text.begin(), text.end());
}

Result<Json, std::string> decode_control(
    const std::vector<std::uint8_t>& payload) {
  const std::string_view text(reinterpret_cast<const char*>(payload.data()),
                              payload.size());
  return Json::parse(text);
}

}  // namespace print_engine::proto
