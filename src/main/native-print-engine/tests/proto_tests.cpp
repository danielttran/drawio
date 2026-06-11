// Layer 1 — protocol spine. Tested with a mock host and a mock engine only:
// no Electron, no real engine, no transport. Asserts the frozen frame codec,
// the Hello-first ordering / version gate, and the typed-error + notice
// mapping. The IPC protocol is now defined entirely in code (proto.hpp/cpp).

#include "print_engine/proto.hpp"

#include "print_engine/contract.hpp"

#include <catch2/catch_test_macros.hpp>

#include <string>
#include <vector>

using namespace print_engine;
using proto::Frame;
using proto::FrameDecoder;
using proto::FrameType;
using proto::Json;

namespace {

std::vector<std::uint8_t> bytes(const std::string& s) {
  return std::vector<std::uint8_t>(s.begin(), s.end());
}

}  // namespace

TEST_CASE("frame codec round-trips control and binary frames", "[proto][frame]") {
  const auto payload = bytes("{\"op\":\"Ping\"}");
  const auto wire = proto::encode_frame(FrameType::Control, 0, payload);

  // [uint32 frameLen][uint8 type][uint32 streamId][payload]; frameLen covers
  // type + streamId + payload.
  REQUIRE(wire.size() == payload.size() + 1 + 4 + 4);

  FrameDecoder dec;
  dec.feed(wire);
  auto f = dec.next();
  REQUIRE(f.has_value());
  CHECK(f->type == FrameType::Control);
  CHECK(f->stream_id == 0u);
  CHECK(f->payload == payload);
  CHECK_FALSE(dec.next().has_value());
}

TEST_CASE("binary frame correlates by streamId", "[proto][frame]") {
  const std::vector<std::uint8_t> png = {0x89, 'P', 'N', 'G', 0x0D, 0x0A};
  const auto wire = proto::encode_frame(FrameType::Binary, 42, png);
  FrameDecoder dec;
  dec.feed(wire);
  auto f = dec.next();
  REQUIRE(f.has_value());
  CHECK(f->type == FrameType::Binary);
  CHECK(f->stream_id == 42u);  // ties to a PreviewResult.imageStreamId
  CHECK(f->payload == png);
}

TEST_CASE("decoder reassembles frames split across feeds", "[proto][frame]") {
  const auto a = proto::encode_frame(FrameType::Control, 1, bytes("\"a\""));
  const auto b = proto::encode_frame(FrameType::Control, 2, bytes("\"bb\""));
  std::vector<std::uint8_t> stream;
  stream.insert(stream.end(), a.begin(), a.end());
  stream.insert(stream.end(), b.begin(), b.end());

  FrameDecoder dec;
  // Feed one byte at a time — the stdio message-boundary defect class.
  for (std::size_t i = 0; i < stream.size(); ++i) {
    dec.feed(&stream[i], 1);
  }
  auto f1 = dec.next();
  auto f2 = dec.next();
  REQUIRE(f1.has_value());
  REQUIRE(f2.has_value());
  CHECK(f1->stream_id == 1u);
  CHECK(f2->stream_id == 2u);
  CHECK_FALSE(dec.next().has_value());
  CHECK_FALSE(dec.failed());
}

TEST_CASE("decoder rejects out-of-range and unknown frames loudly",
          "[proto][frame]") {
  SECTION("oversized length prefix") {
    std::vector<std::uint8_t> bad = {0xFF, 0xFF, 0xFF, 0xFF};  // ~4 GiB
    FrameDecoder dec;
    dec.feed(bad);
    CHECK_FALSE(dec.next().has_value());
    CHECK(dec.failed());
  }
  SECTION("frame length too small to hold the header") {
    std::vector<std::uint8_t> bad = {0x01, 0x00, 0x00, 0x00};  // frameLen = 1
    FrameDecoder dec;
    dec.feed(bad);
    CHECK_FALSE(dec.next().has_value());
    CHECK(dec.failed());
  }
  SECTION("unknown frame type") {
    auto wire = proto::encode_frame(FrameType::Control, 0, bytes("x"));
    wire[4] = 0x09;  // corrupt the type byte
    FrameDecoder dec;
    dec.feed(wire);
    CHECK_FALSE(dec.next().has_value());
    CHECK(dec.failed());
  }
}

TEST_CASE("JSON round-trips control payloads", "[proto][json]") {
  Json msg = Json::object();
  msg.set("op", Json::str("RenderPreview"));
  Json pv = Json::object();
  pv.set("major", Json::number(1));
  pv.set("minor", Json::number(0));
  msg.set("proto", std::move(pv));
  msg.set("dpi", Json::number(300));
  msg.set("escaped", Json::str("line\nwith \"quotes\" \\ and tab\t"));
  msg.set("flag", Json::boolean(true));

  const auto enc = proto::encode_control(msg);
  auto round = proto::decode_control(enc);
  REQUIRE(round.has_value());
  const Json& got = round.value();
  CHECK(got.get("op")->as_string() == "RenderPreview");
  CHECK(got.get("proto")->get("major")->as_number() == 1.0);
  CHECK(got.get("dpi")->as_number() == 300.0);
  CHECK(got.get("escaped")->as_string() == "line\nwith \"quotes\" \\ and tab\t");
  CHECK(got.get("flag")->as_bool() == true);
}

TEST_CASE("JSON parser is loud on malformed and trailing input",
          "[proto][json]") {
  CHECK_FALSE(Json::parse("{\"a\":}").has_value());
  CHECK_FALSE(Json::parse("{\"a\":1").has_value());
  CHECK_FALSE(Json::parse("{} junk").has_value());  // trailing data
  CHECK(Json::parse("{\"ok\":true}").has_value());
}

TEST_CASE("error taxonomy maps engine codes to named wire values",
          "[proto][errors]") {
  using proto::map_contract_error;
  using proto::ProtoErrorKind;
  CHECK(map_contract_error(ContractErrorCode::ContractVersionError) ==
        ProtoErrorKind::ContractVersionError);
  CHECK(map_contract_error(ContractErrorCode::ContractShapeError) ==
        ProtoErrorKind::ContractValidationError);
  CHECK(map_contract_error(ContractErrorCode::MergeOverflowError) ==
        ProtoErrorKind::MergeOverflowError);
  CHECK(map_contract_error(ContractErrorCode::PrintDeviceError) ==
        ProtoErrorKind::PrintDeviceError);
  // BarcodeEncodeError is reserved but must still map (forward-complete switch).
  CHECK(map_contract_error(ContractErrorCode::BarcodeEncodeError) ==
        ProtoErrorKind::BarcodeEncodeError);
  CHECK(std::string(proto::to_wire(ProtoErrorKind::EngineBusyError)) ==
        "EngineBusyError");
}

TEST_CASE("notice kinds map engine notices and add boundary-only kinds",
          "[proto][notice]") {
  using proto::map_notice;
  using proto::NoticeKind;
  CHECK(map_notice(DegradationNoticeType::StubbedBarcode) ==
        NoticeKind::StubbedBarcode);
  CHECK(map_notice(DegradationNoticeType::FontSubstitution) ==
        NoticeKind::FontSubstituted);
  CHECK(std::string(proto::to_wire(NoticeKind::ProtoMinorAhead)) ==
        "ProtoMinorAhead");
  CHECK(std::string(proto::to_wire(NoticeKind::SchemaMinorAhead)) ==
        "SchemaMinorAhead");
  // SvgArtworkRasterized: device-side success notice (loud). Host emits it
  // when the external rasterizer succeeded; carries backend identity.
  CHECK(map_notice(DegradationNoticeType::SvgArtworkRasterized) ==
        NoticeKind::SvgArtworkRasterized);
  CHECK(std::string(proto::to_wire(NoticeKind::SvgArtworkRasterized)) ==
        "SvgArtworkRasterized");
  // StubbedSvgArtwork: host emits this only on rasterizer failure (no DLL,
  // foreignObject, parse error, etc.) with the failure reason in `detail`.
  // The engine no longer emits it unconditionally for every SVG node.
  CHECK(map_notice(DegradationNoticeType::StubbedSvgArtwork) ==
        NoticeKind::StubbedSvgArtwork);
  CHECK(std::string(proto::to_wire(NoticeKind::StubbedSvgArtwork)) ==
        "StubbedSvgArtwork");
}

TEST_CASE("handshake enforces Hello-first ordering", "[proto][handshake]") {
  proto::ProtoSession s;
  // Any non-Hello op before HelloOk is refused with ProtoHandshakeError.
  auto gated = s.gate(proto::Op::RenderPreview);
  REQUIRE(gated.has_value());
  CHECK(*gated == proto::ProtoErrorKind::ProtoHandshakeError);
  // Hello itself is always allowed to be attempted.
  CHECK_FALSE(s.gate(proto::Op::Hello).has_value());

  auto out = s.on_hello({proto::kProtoMajor, proto::kProtoMinor});
  CHECK(out.ok);
  CHECK_FALSE(out.minor_ahead);
  CHECK(s.handshaked());
  CHECK_FALSE(s.gate(proto::Op::RenderPreview).has_value());
}

TEST_CASE("handshake rejects major mismatch and refuses all further ops",
          "[proto][handshake]") {
  proto::ProtoSession s;
  auto out = s.on_hello({proto::kProtoMajor + 1, 0});
  CHECK_FALSE(out.ok);
  CHECK(out.error == proto::ProtoErrorKind::ProtoVersionError);
  CHECK(s.version_rejected());
  // No best-effort: even Hello and Ping are now refused, loudly.
  auto g1 = s.gate(proto::Op::Ping);
  auto g2 = s.gate(proto::Op::Hello);
  REQUIRE(g1.has_value());
  REQUIRE(g2.has_value());
  CHECK(*g1 == proto::ProtoErrorKind::ProtoVersionError);
  CHECK(*g2 == proto::ProtoErrorKind::ProtoVersionError);
}

TEST_CASE("handshake proceeds on minor-ahead with a ProtoMinorAhead signal",
          "[proto][handshake]") {
  proto::ProtoSession s;
  auto out = s.on_hello({proto::kProtoMajor, proto::kProtoMinor + 3});
  CHECK(out.ok);
  CHECK(out.minor_ahead);  // host emits a ProtoMinorAhead DegradationNotice
  CHECK(s.handshaked());
}

// Mock-engine / mock-host loopback: a full Hello -> HelloOk exchange driven
// only through the codec + session, proving the spine works end to end with
// neither a real engine nor a transport (spec §10.1).
TEST_CASE("mock host and mock engine complete a handshake over the codec",
          "[proto][loopback]") {
  // Host builds Hello and frames it.
  Json hello = Json::object();
  hello.set("op", Json::str("Hello"));
  Json pv = Json::object();
  pv.set("major", Json::number(proto::kProtoMajor));
  pv.set("minor", Json::number(proto::kProtoMinor));
  hello.set("proto", std::move(pv));
  const auto host_out =
      proto::encode_frame(FrameType::Control, 0, proto::encode_control(hello));

  // Engine decodes, gates, handshakes.
  FrameDecoder engine_dec;
  engine_dec.feed(host_out);
  auto frame = engine_dec.next();
  REQUIRE(frame.has_value());
  auto parsed = proto::decode_control(frame->payload);
  REQUIRE(parsed.has_value());
  const Json& req = parsed.value();
  auto op = proto::parse_op(req.get("op")->as_string());
  REQUIRE(op.has_value());
  CHECK(*op == proto::Op::Hello);

  proto::ProtoSession session;
  REQUIRE_FALSE(session.gate(*op).has_value());
  proto::ProtoVersion peer{
      static_cast<std::uint32_t>(req.get("proto")->get("major")->as_number()),
      static_cast<std::uint32_t>(req.get("proto")->get("minor")->as_number())};
  auto hs = session.on_hello(peer);
  REQUIRE(hs.ok);

  // Engine builds HelloOk and frames it back.
  Json ok = Json::object();
  ok.set("result", Json::str("HelloOk"));
  ok.set("engineVersion", Json::str("native-print-engine"));
  Json okp = Json::object();
  okp.set("major", Json::number(proto::kProtoMajor));
  okp.set("minor", Json::number(proto::kProtoMinor));
  ok.set("proto", std::move(okp));
  ok.set("supportedSchemaMajor", Json::number(SupportedMajor));
  ok.set("supportedSchemaMinor", Json::number(SupportedMinor));
  const auto engine_out =
      proto::encode_frame(FrameType::Control, 0, proto::encode_control(ok));

  // Host decodes HelloOk.
  FrameDecoder host_dec;
  host_dec.feed(engine_out);
  auto reply = host_dec.next();
  REQUIRE(reply.has_value());
  auto reply_json = proto::decode_control(reply->payload);
  REQUIRE(reply_json.has_value());
  CHECK(reply_json.value().get("result")->as_string() == "HelloOk");
  CHECK(reply_json.value().get("supportedSchemaMajor")->as_number() ==
        static_cast<double>(SupportedMajor));
}

TEST_CASE("JSON parser refuses deep nesting with a typed error, not a crash",
          "[proto][json][hardening]") {
  // 100k nested arrays: without a depth guard this recursion overflows the
  // stack and kills the engine process instead of failing loudly.
  const std::string deep(100000, '[');
  const auto r = Json::parse(deep);
  REQUIRE_FALSE(r.has_value());
  CHECK(r.error() == "nesting depth exceeded");

  // Ordinary nesting depth still parses.
  std::string shallow(100, '[');
  shallow += "1";
  shallow += std::string(100, ']');
  CHECK(Json::parse(shallow).has_value());
}

TEST_CASE("JSON parser refuses malformed numbers instead of prefix-parsing",
          "[proto][json][hardening]") {
  // std::stod parsed a prefix and ignored the rest ("1-2" -> 1, "1.5e" ->
  // 1.5); each of these must now be a loud parse error.
  for (const std::string bad :
       {"[1-2]", "[1.5e]", "[01]", "[1.2.3]", "[-]", "[1e]", "[1.]",
        "[00]", "[1e+]", "[--1]", "[1e999]"}) {
    INFO("input: " << bad);
    CHECK_FALSE(Json::parse(bad).has_value());
  }

  // Valid JSON numbers still parse to exact values.
  const auto good = Json::parse("[-0.5e+2,0,1e3,0.25,-0]");
  REQUIRE(good.has_value());
  CHECK(good.value().items()[0].as_number() == -50.0);
  CHECK(good.value().items()[1].as_number() == 0.0);
  CHECK(good.value().items()[2].as_number() == 1000.0);
  CHECK(good.value().items()[3].as_number() == 0.25);
}
