#pragma once

// Host integration IPC protocol — Layer 1 (frozen by code; legacy spec doc removed).
//
// This module is the FROZEN frame codec plus the versioned control layer:
//  - frame format never changes across protocol versions (§3.1);
//  - only the control payload schema is versioned (§3.2);
//  - Hello-first ordering and the major/minor version gate are enforced here (§3.2/§3.4);
//  - the typed-error taxonomy (§3.6) and DegradationNotice kinds (§3.7) cross the
//    boundary as named values, mapped from the engine's internal types.
//
// INV-1: this header pulls in only engine types. It carries no host / editor /
// diagram concept whatsoever. The engine builds and tests with zero host
// present; its only external surface is this versioned protocol.

#include "print_engine/errors.hpp"
#include "print_engine/result.hpp"

#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace print_engine::proto {

// ---------------------------------------------------------------------------
// Protocol version (independent from the contract-schema version; §3.2).
// ---------------------------------------------------------------------------
inline constexpr std::uint32_t kProtoMajor = 1;
inline constexpr std::uint32_t kProtoMinor = 0;

struct ProtoVersion {
  std::uint32_t major = 0;
  std::uint32_t minor = 0;
};

// ---------------------------------------------------------------------------
// Frame codec — FROZEN for all protocol majors (§3.1).
// Wire: [uint32 frameLen][uint8 frameType][uint32 streamId][payload], LE,
// frameLen covering frameType + streamId + payload.
// ---------------------------------------------------------------------------
enum class FrameType : std::uint8_t {
  Control = 0x01,  // UTF-8 JSON control payload
  Binary = 0x02    // binary blob (e.g. preview PNG bytes)
};

struct Frame {
  FrameType type = FrameType::Control;
  std::uint32_t stream_id = 0;
  std::vector<std::uint8_t> payload;
};

// Hard ceiling so a corrupt length prefix cannot make the decoder allocate
// without bound. Control frames are always tiny; preview PNGs are a few MB.
inline constexpr std::uint32_t kMaxFrameLen = 64u * 1024u * 1024u;

// Largest payload encode_frame accepts: frameLen covers frameType(1) +
// streamId(4) + payload, so anything bigger would emit a frame the peer's
// decoder kills the transport on. Enforced BEFORE emission, never after.
inline constexpr std::size_t kMaxFramePayload =
    static_cast<std::size_t>(kMaxFrameLen) - 5u;

// std::nullopt <=> payload > kMaxFramePayload. Callers must refuse loudly
// (typed Error control frame / fatal diagnostic) instead of emitting a frame
// that corrupts the transport for the peer.
[[nodiscard]] std::optional<std::vector<std::uint8_t>> encode_frame(
    FrameType type, std::uint32_t stream_id,
    const std::vector<std::uint8_t>& payload);

// Streaming decoder: feed arbitrary byte runs, pop whole frames. Resolves the
// stdio message-boundary defect class — length-prefixing, never delimiter.
class FrameDecoder {
 public:
  void feed(const std::uint8_t* data, std::size_t len);
  void feed(const std::vector<std::uint8_t>& bytes);

  // Pops one complete frame, or std::nullopt if none buffered yet.
  [[nodiscard]] std::optional<Frame> next();

  [[nodiscard]] bool failed() const { return failed_; }
  [[nodiscard]] const std::string& error() const { return error_; }

 private:
  std::vector<std::uint8_t> buf_;
  std::size_t consumed_ = 0;
  bool failed_ = false;
  std::string error_;
};

// ---------------------------------------------------------------------------
// Typed error taxonomy (§3.6) — named across the boundary, never stringly.
// BarcodeEncodeError is reserved (loud barcode stub era, v2.0 §3.1): listed so
// the host switch is forward-complete, not raised today.
// ---------------------------------------------------------------------------
enum class ProtoErrorKind {
  ProtoHandshakeError,
  ProtoVersionError,
  ContractVersionError,
  ContractValidationError,
  MergeOverflowError,
  ImageDecodeError,
  ImageColorError,
  PrintDeviceError,
  EngineBusyError,
  EngineInternalError,
  BarcodeEncodeError  // reserved; not raised in stub era
};

[[nodiscard]] const char* to_wire(ProtoErrorKind kind) noexcept;

// Engine internal Result error -> boundary error name (§3.6).
[[nodiscard]] ProtoErrorKind map_contract_error(ContractErrorCode code) noexcept;

// ---------------------------------------------------------------------------
// DegradationNotice kinds (§3.7). Engine carries StubbedBarcode/StubbedSvg/
// HardwareMarginClip/FontSubstitution/MergeClip; the boundary additionally
// carries SchemaMinorAhead / ProtoMinorAhead (not engine-emitted; raised by
// the schema/proto version gates).
// ---------------------------------------------------------------------------
enum class NoticeKind {
  StubbedBarcode,
  StubbedSvgArtwork,
  HardwareMarginClip,
  FontSubstituted,
  MergeClip,
  SchemaMinorAhead,
  ProtoMinorAhead,
  // Device-side success notice for embedded SVG that was rasterized by an
  // external backend. Carries backend identity in `detail`; never silent.
  SvgArtworkRasterized
};

[[nodiscard]] const char* to_wire(NoticeKind kind) noexcept;
[[nodiscard]] NoticeKind map_notice(DegradationNoticeType type) noexcept;

// ---------------------------------------------------------------------------
// Operation taxonomy (§3.3) and the ordering / version gate (§3.2/§3.4).
// ---------------------------------------------------------------------------
enum class Op {
  Hello,
  Ping,
  GetCapabilities,
  GetContractFields,
  RenderPreview,
  Print,
  ReleaseContract,
  Shutdown
};

// Parse the "op" string of a control message; std::nullopt if unknown.
[[nodiscard]] std::optional<Op> parse_op(std::string_view name) noexcept;
[[nodiscard]] const char* to_wire(Op op) noexcept;

struct HandshakeOutcome {
  bool ok = false;
  ProtoErrorKind error = ProtoErrorKind::ProtoVersionError;  // valid when !ok
  bool minor_ahead = false;  // peer minor > supported -> ProtoMinorAhead notice
};

// Per-connection state machine. Enforces:
//  - Hello MUST be first; any other op before HelloOk -> ProtoHandshakeError;
//  - proto.major mismatch -> ProtoVersionError, all further ops refused;
//  - proto.minor ahead -> proceed + ProtoMinorAhead notice (additive-only
//    assumption, mirrors the schema-minor rule).
// Ordering is defined here, not left implementation-dependent.
class ProtoSession {
 public:
  [[nodiscard]] HandshakeOutcome on_hello(ProtoVersion peer);

  // std::nullopt => op permitted. Otherwise the proto error to return now.
  [[nodiscard]] std::optional<ProtoErrorKind> gate(Op op) const;

  [[nodiscard]] bool handshaked() const { return handshaked_; }
  [[nodiscard]] bool version_rejected() const { return version_rejected_; }

 private:
  bool handshaked_ = false;
  bool version_rejected_ = false;
};

// ---------------------------------------------------------------------------
// Minimal JSON for control payloads (§3.1: "control payloads are always
// small"). Self-contained so proto carries no third-party dependency.
// ---------------------------------------------------------------------------
class Json {
 public:
  enum class Type { Null, Bool, Number, String, Array, Object };

  Json() : type_(Type::Null) {}
  static Json boolean(bool v);
  static Json number(double v);
  static Json str(std::string v);
  static Json array();
  static Json object();

  [[nodiscard]] Type type() const { return type_; }
  [[nodiscard]] bool is_object() const { return type_ == Type::Object; }
  [[nodiscard]] bool is_array() const { return type_ == Type::Array; }

  // Object access. set() upserts; get() returns nullptr if absent/not object.
  Json& set(const std::string& key, Json value);
  [[nodiscard]] const Json* get(const std::string& key) const;

  // Array access.
  Json& push_back(Json value);
  [[nodiscard]] const std::vector<Json>& items() const { return array_; }

  // Insertion-ordered object pairs (used for stable serialization and for the
  // engine adapter to iterate inbound fields it does not statically name).
  [[nodiscard]] const std::vector<std::pair<std::string, Json>>& object_pairs()
      const {
    return object_;
  }

  // Scalar readers (typed, defensive — never throw).
  [[nodiscard]] bool as_bool(bool fallback = false) const;
  [[nodiscard]] double as_number(double fallback = 0.0) const;
  [[nodiscard]] std::string as_string(std::string_view fallback = "") const;

  [[nodiscard]] std::string serialize() const;
  [[nodiscard]] static Result<Json, std::string> parse(std::string_view text);

 private:
  Type type_;
  bool bool_ = false;
  double number_ = 0.0;
  std::string string_;
  std::vector<Json> array_;
  // insertion-ordered object (stable wire output aids golden tests / diffs)
  std::vector<std::pair<std::string, Json>> object_;
};

// Control frame helpers: JSON object <-> Control(0x01) frame payload bytes.
[[nodiscard]] std::vector<std::uint8_t> encode_control(const Json& message);
[[nodiscard]] Result<Json, std::string> decode_control(
    const std::vector<std::uint8_t>& payload);

}  // namespace print_engine::proto
