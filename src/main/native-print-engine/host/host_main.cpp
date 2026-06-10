// Standalone native print engine host executable.
//
// Transport choice (spec §3.1 open item, now decided & documented): the engine
// speaks the protocol over its own stdio — stdin carries inbound frames,
// stdout carries outbound frames. NOT a TCP port (no network surface;
// regulated/desktop). The frame format is frozen (§3.1); only the control
// payload schema is versioned. The engine is host-agnostic: this same binary
// is driven identically by the Node broker, a CLI, or a test harness.
//
// stderr is reserved for human diagnostics only — never protocol data.

#include "engine_services_factory.hpp"
#include "print_engine/proto.hpp"
#include "print_engine/proto_adapter.hpp"

#include <cstdio>
#include <vector>

#if defined(_WIN32)
#include <fcntl.h>
#include <io.h>
#else
#include <unistd.h>
#endif

namespace {

void write_all(const std::vector<std::uint8_t>& bytes) {
  if (!bytes.empty()) {
    std::fwrite(bytes.data(), 1, bytes.size(), stdout);
  }
  std::fflush(stdout);
}

// Read whatever is currently available (blocks only until >=1 byte, EOF, or
// error). fread(buf,1,N,...) would block until N bytes — fatal for a framed
// stream of small control messages.
int read_some(std::uint8_t* buf, unsigned int cap) {
#if defined(_WIN32)
  return _read(_fileno(stdin), buf, cap);
#else
  return static_cast<int>(::read(0, buf, cap));
#endif
}

}  // namespace

int main() {
#if defined(_WIN32)
  // Binary stdio: text-mode CRLF translation would corrupt framed bytes.
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
#endif

  using namespace print_engine::proto;

  auto services = make_engine_services();
  ProtoDispatcher dispatcher(*services);
  FrameDecoder decoder;

  std::vector<std::uint8_t> chunk(64 * 1024);

  for (;;) {
    const int got = read_some(chunk.data(),
                              static_cast<unsigned int>(chunk.size()));
    if (got <= 0) {
      break;  // EOF / broken pipe -> main owns lifecycle, just exit
    }
    decoder.feed(chunk.data(), static_cast<std::size_t>(got));

    bool shutting_down = false;
    while (auto frame = decoder.next()) {
      if (frame->type != FrameType::Control) {
        continue;  // engine never receives binary frames inbound
      }
      auto parsed = decode_control(frame->payload);
      if (!parsed.has_value()) {
        // Malformed control payload: loud, typed, never silent.
        Json err = Json::object();
        err.set("result", Json::str("Error"));
        err.set("error",
                Json::str(to_wire(ProtoErrorKind::EngineInternalError)));
        err.set("detail", Json::str("malformed control payload"));
        write_all(encode_frame(FrameType::Control, 0, encode_control(err)));
        continue;
      }

      DispatchResult out = dispatcher.handle(parsed.value());
      write_all(
          encode_frame(FrameType::Control, 0, encode_control(out.control)));
      if (out.has_binary) {
        write_all(encode_frame(FrameType::Binary, out.binary_stream_id,
                               out.binary));
      }
      if (out.shutdown) {
        shutting_down = true;
        break;
      }
    }

    if (shutting_down || decoder.failed()) {
      break;  // ShutdownAck sent, or transport corrupt -> exit loudly
    }
  }

  return 0;
}
