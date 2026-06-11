#include "print_engine/proto_adapter.hpp"

#include "print_engine/contract_loader.hpp"

#include <chrono>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <optional>
#include <sstream>
#include <utility>

namespace print_engine::proto {
namespace {

std::chrono::steady_clock::time_point g_start = std::chrono::steady_clock::now();

double uptime_ms() {
  const auto now = std::chrono::steady_clock::now();
  return std::chrono::duration<double, std::milli>(now - g_start).count();
}

Json proto_echo() {
  Json p = Json::object();
  p.set("major", Json::number(kProtoMajor));
  p.set("minor", Json::number(kProtoMinor));
  return p;
}

// Range-checked wire-number reader. as_number() values come straight off the
// wire; static_cast of an out-of-range double to an integer type is UB, so
// every numeric request field must pass through here before any cast.
// nullopt => caller refuses loudly with a typed error (C1: never coerce).
std::optional<double> checked_wire_number(const Json& value, double min_value,
                                          double max_value,
                                          bool require_integral) {
  if (value.type() != Json::Type::Number) {
    return std::nullopt;
  }
  const double n = value.as_number();
  if (!std::isfinite(n) || n < min_value || n > max_value) {
    return std::nullopt;
  }
  if (require_integral && std::floor(n) != n) {
    return std::nullopt;
  }
  return n;
}

// mergeData object -> KEY/value string map (engine P3 IMergeSource input §4).
// Non-string values are refused loudly: as_string()'s "" fallback turned
// {"qty":5} into a silent blank print (the C1 class).
Result<std::map<std::string, std::string>, std::string> read_merge(
    const Json& request) {
  using R = Result<std::map<std::string, std::string>, std::string>;
  std::map<std::string, std::string> merge;
  const Json* md = request.get("mergeData");
  if (md == nullptr || md->type() == Json::Type::Null) {
    return R::ok(std::move(merge));  // absent/null: unambiguously "no data"
  }
  if (!md->is_object()) {
    return R::err("mergeData must be an object of string values");
  }
  for (const auto& kv : md->object_pairs()) {
    if (kv.second.type() != Json::Type::String) {
      return R::err("mergeData value for key \"" + kv.first +
                    "\" must be a string");
    }
    merge[kv.first] = kv.second.as_string();
  }
  return R::ok(std::move(merge));
}

const char* contract_kind_to_wire(const PaintNodeSummary& node) {
  return node.barcode_value_type == BarcodeValueType::Merge ? "barcode" : "text";
}

// Optional string request field: absent => empty fallback; present but not a
// string => typed refusal. as_string()'s "" fallback silently routed a
// {"printerId":7} job to the default printer (the C1 coerce class).
// (value is wrapped in std::optional so the Result's value and error types
// stay distinct; absent maps to the empty-string default at the call site.)
Result<std::optional<std::string>, std::string> read_optional_string(
    const Json& request, const char* key) {
  using R = Result<std::optional<std::string>, std::string>;
  const Json* v = request.get(key);
  if (v == nullptr) {
    return R::ok(std::nullopt);
  }
  if (v->type() != Json::Type::String) {
    return R::err(std::string(key) + " must be a string when present");
  }
  return R::ok(v->as_string());
}

// "aa" render option: absent => AA on; otherwise exactly "on" or "crisp".
// The old as_string() fallback made {"aa":true} or {"aa":"CRISP"} silently
// mean AA-on -- a thermal-head job rasterized antialiased without a word.
Result<bool, std::string> read_aa_option(const Json& request) {
  using R = Result<bool, std::string>;
  const Json* aa = request.get("aa");
  if (aa == nullptr) {
    return R::ok(false);
  }
  if (aa->type() == Json::Type::String) {
    const std::string v = aa->as_string();
    if (v == "on") return R::ok(false);
    if (v == "crisp") return R::ok(true);
  }
  return R::err("aa must be \"on\" or \"crisp\" when present");
}

}  // namespace

Json notice_to_json(const DegradationNotice& n) {
  Json j = Json::object();
  j.set("kind", Json::str(to_wire(map_notice(n.type))));
  if (!n.page_id.empty()) {
    j.set("pageId", Json::str(n.page_id));
  } else {
    j.set("pageId", Json());
  }
  Json detail = Json::object();
  if (!n.detail.empty()) detail.set("detail", Json::str(n.detail));
  if (!n.symbology.empty()) detail.set("symbology", Json::str(n.symbology));
  if (!n.resolved_value.empty())
    detail.set("resolvedValue", Json::str(n.resolved_value));
  j.set("detail", std::move(detail));
  return j;
}

// Minor-ahead contracts may carry additive paint properties this engine
// ignores; the operator must see that on EVERY render/print path, not only
// when the app happens to call GetContractFields first (silent feature loss
// otherwise -- the C1 class).
void append_schema_minor_ahead(Json& notices, const BakedDocument& doc) {
  if (doc.schema.minor <= SupportedMinor) {
    return;
  }
  Json n = Json::object();
  n.set("kind", Json::str(to_wire(NoticeKind::SchemaMinorAhead)));
  n.set("pageId", Json());
  Json d = Json::object();
  d.set("fileVersion", Json::number(doc.schema.minor));
  d.set("supported", Json::number(SupportedMinor));
  n.set("detail", std::move(d));
  notices.push_back(std::move(n));
}

Result<std::string, ContractError> read_contract_ref(
    const Json& contract_ref) {
  using R = Result<std::string, ContractError>;
  const auto fail = [](const std::string& msg) {
    return R::err(ContractError{ContractErrorCode::ContractShapeError,
                                "contractRef", msg});
  };
  if (!contract_ref.is_object()) {
    return fail("contractRef must be an object {path|inline}");
  }
  if (const Json* inl = contract_ref.get("inline");
      inl != nullptr && inl->type() == Json::Type::String) {
    return R::ok(inl->as_string());
  }
  if (const Json* path = contract_ref.get("path");
      path != nullptr && path->type() == Json::Type::String) {
    std::ifstream in(path->as_string(), std::ios::binary);
    if (!in) {
      return fail("cannot open contract file");
    }
    std::ostringstream ss;
    ss << in.rdbuf();
    return R::ok(ss.str());
  }
  return fail("contractRef missing path or inline");
}

ProtoDispatcher::ProtoDispatcher(EngineServices& services)
    : services_(services) {}

DispatchResult ProtoDispatcher::error_reply(const Json& request,
                                            ProtoErrorKind kind,
                                            const std::string& detail) const {
  DispatchResult r;
  r.control = Json::object();
  r.control.set("result", Json::str("Error"));
  r.control.set("error", Json::str(to_wire(kind)));
  if (!detail.empty()) r.control.set("detail", Json::str(detail));
  if (const Json* id = request.get("id"); id != nullptr) {
    r.control.set("id", *id);
  }
  r.control.set("proto", proto_echo());
  return r;
}

DispatchResult ProtoDispatcher::handle(const Json& request) {
  const Json* op_field = request.get("op");
  if (op_field == nullptr || op_field->type() != Json::Type::String) {
    return error_reply(request, ProtoErrorKind::EngineInternalError,
                       "missing op");
  }
  const auto op = parse_op(op_field->as_string());
  if (!op.has_value()) {
    return error_reply(request, ProtoErrorKind::EngineInternalError,
                       "unknown op");
  }

  if (auto gated = session_.gate(*op); gated.has_value()) {
    return error_reply(request, *gated, "operation refused by protocol gate");
  }

  switch (*op) {
    case Op::Hello: {
      ProtoVersion peer;
      if (const Json* p = request.get("proto"); p != nullptr) {
        constexpr double kMaxVersion = 2147483647.0;  // 0..INT32_MAX
        const Json* major = p->get("major");
        const Json* minor = p->get("minor");
        const auto major_n = major != nullptr
                                 ? checked_wire_number(*major, 0.0, kMaxVersion, true)
                                 : std::optional<double>(0.0);
        const auto minor_n = minor != nullptr
                                 ? checked_wire_number(*minor, 0.0, kMaxVersion, true)
                                 : std::optional<double>(0.0);
        if (!major_n.has_value() || !minor_n.has_value()) {
          return error_reply(request, ProtoErrorKind::ProtoHandshakeError,
                             "proto.major/minor must be integers in 0..2147483647");
        }
        peer.major = static_cast<std::uint32_t>(*major_n);
        peer.minor = static_cast<std::uint32_t>(*minor_n);
      }
      const auto hs = session_.on_hello(peer);
      if (!hs.ok) {
        return error_reply(request, hs.error,
                           "engine/app protocol major mismatch");
      }
      DispatchResult r;
      r.control = Json::object();
      r.control.set("result", Json::str("HelloOk"));
      r.control.set("engineVersion", Json::str("native-print-engine"));
      r.control.set("proto", proto_echo());
      r.control.set("supportedSchemaMajor", Json::number(SupportedMajor));
      r.control.set("supportedSchemaMinor", Json::number(SupportedMinor));
      Json notices = Json::array();
      if (hs.minor_ahead) {
        Json n = Json::object();
        n.set("kind", Json::str(to_wire(NoticeKind::ProtoMinorAhead)));
        n.set("pageId", Json());
        Json d = Json::object();
        d.set("peerVersion", Json::number(peer.minor));
        d.set("supported", Json::number(kProtoMinor));
        n.set("detail", std::move(d));
        notices.push_back(std::move(n));
      }
      r.control.set("notices", std::move(notices));
      return r;
    }

    case Op::Ping: {
      DispatchResult r;
      r.control = Json::object();
      r.control.set("result", Json::str("Pong"));
      r.control.set("engineUptimeMs", Json::number(uptime_ms()));
      r.control.set("proto", proto_echo());
      return r;
    }

    case Op::GetCapabilities: {
      DispatchResult r;
      r.control = Json::object();
      r.control.set("result", Json::str("Capabilities"));
      Json printers = Json::array();
      for (const auto& p : services_.enumerate_printers()) {
        Json pj = Json::object();
        pj.set("id", Json::str(p.id));
        pj.set("name", Json::str(p.name));
        pj.set("defaultStockId", Json::str(p.default_stock_id));
        Json stocks = Json::array();
        for (const auto& s : p.stocks) {
          Json sj = Json::object();
          sj.set("id", Json::str(s.id));
          sj.set("name", Json::str(s.name));
          sj.set("widthMicrons", Json::number(static_cast<double>(s.width_microns)));
          sj.set("heightMicrons", Json::number(static_cast<double>(s.height_microns)));
          sj.set("dpiX", Json::number(s.dpi_x));
          sj.set("dpiY", Json::number(s.dpi_y));
          stocks.push_back(std::move(sj));
        }
        pj.set("stocks", std::move(stocks));
        printers.push_back(std::move(pj));
      }
      r.control.set("printers", std::move(printers));
      r.control.set("engineFeatures", Json::array());
      r.control.set("proto", proto_echo());
      return r;
    }

    case Op::GetContractFields: {
      const Json* cref = request.get("contractRef");
      if (cref == nullptr) {
        return error_reply(request, ProtoErrorKind::ContractValidationError,
                           "missing contractRef");
      }
      auto text = read_contract_ref(*cref);
      if (!text.has_value()) {
        return error_reply(request, ProtoErrorKind::ContractValidationError,
                           text.error().message);
      }
      auto loaded = load_baked_contract(text.value());
      if (!loaded.has_value()) {
        return error_reply(request, map_contract_error(loaded.error().code),
                           loaded.error().message);
      }
      const BakedDocument& doc = loaded.value();
      DispatchResult r;
      r.control = Json::object();
      r.control.set("result", Json::str("ContractFields"));
      Json sv = Json::object();
      sv.set("major", Json::number(doc.schema.major));
      sv.set("minor", Json::number(doc.schema.minor));
      r.control.set("schemaVersion", std::move(sv));
      // Several nodes may bind the same merge key with different maxLen. The
      // renderer enforces each node's OWN limit, so the binding constraint
      // for the field is the MINIMUM across its nodes -- first-wins dedupe
      // reported a maxLen the app could overflow on another node.
      struct FieldInfo {
        std::string kind;
        int max_len = 0;
        std::string sample;
      };
      std::vector<std::string> field_order;
      std::map<std::string, FieldInfo> field_by_key;
      for (const auto& page : doc.pages) {
        for (const auto& node : page.paint) {
          const bool is_merge =
              node.text_content_type == TextContentType::Merge ||
              node.barcode_value_type == BarcodeValueType::Merge;
          if (!is_merge || node.merge_key.empty()) {
            continue;
          }
          const auto found = field_by_key.find(node.merge_key);
          if (found == field_by_key.end()) {
            field_order.push_back(node.merge_key);
            field_by_key.emplace(
                node.merge_key,
                FieldInfo{contract_kind_to_wire(node), node.merge_max_len,
                          node.merge_sample});
          } else if (node.merge_max_len < found->second.max_len) {
            found->second.max_len = node.merge_max_len;
          }
        }
      }
      Json fields = Json::array();
      for (const auto& key : field_order) {
        const FieldInfo& info = field_by_key.at(key);
        Json f = Json::object();
        f.set("key", Json::str(key));
        f.set("kind", Json::str(info.kind));
        f.set("maxLen", Json::number(info.max_len));
        f.set("sampleValue", Json::str(info.sample));
        fields.push_back(std::move(f));
      }
      r.control.set("fields", std::move(fields));
      Json notices = Json::array();
      append_schema_minor_ahead(notices, doc);
      r.control.set("notices", std::move(notices));
      r.control.set("proto", proto_echo());
      return r;
    }

    case Op::RenderPreview: {
      if (print_in_flight_) {
        return error_reply(request, ProtoErrorKind::EngineBusyError,
                           "print in progress");
      }
      const Json* cref = request.get("contractRef");
      if (cref == nullptr) {
        return error_reply(request, ProtoErrorKind::ContractValidationError,
                           "missing contractRef");
      }
      auto text = read_contract_ref(*cref);
      if (!text.has_value()) {
        return error_reply(request, ProtoErrorKind::ContractValidationError,
                           text.error().message);
      }
      auto loaded = load_baked_contract(text.value());
      if (!loaded.has_value()) {
        return error_reply(request, map_contract_error(loaded.error().code),
                           loaded.error().message);
      }
      double dpi = 300.0;
      if (const Json* dpi_field = request.get("dpi")) {
        // Positive and bounded: a wire value like 1e300 must not reach the
        // renderer's pixel-size math.
        const auto checked = checked_wire_number(*dpi_field, 1.0, 10000.0, false);
        if (!checked.has_value()) {
          return error_reply(request, ProtoErrorKind::ContractValidationError,
                             "dpi must be a number in 1..10000");
        }
        dpi = *checked;
      }
      auto merge = read_merge(request);
      if (!merge.has_value()) {
        return error_reply(request, ProtoErrorKind::ContractValidationError,
                           merge.error());
      }
      // INV-5: the preview honors the same per-job render options as Print
      // ("aa":"crisp"), or a crisp job previews antialiased while the paper
      // is gridfit/thresholded.
      PrintRenderOptions preview_opts;
      const auto aa = read_aa_option(request);
      if (!aa.has_value()) {
        return error_reply(request, ProtoErrorKind::ContractValidationError,
                           aa.error());
      }
      preview_opts.edge_crisp = aa.value();
      auto out = services_.render_preview(loaded.value(), merge.value(), dpi,
                                          preview_opts);
      if (!out.has_value()) {
        return error_reply(request, map_contract_error(out.error().code),
                           out.error().message);
      }
      const PreviewOutput& po = out.value();
      // Refuse BEFORE framing: a binary payload over the frame ceiling would
      // encode a frame the peer's decoder kills the transport on.
      if (po.png.size() > kMaxFramePayload) {
        return error_reply(request, ProtoErrorKind::EngineInternalError,
                           "preview image exceeds frame limit");
      }
      DispatchResult r;
      r.has_binary = true;
      r.binary_stream_id = next_stream_id_++;
      r.binary = po.png;
      r.control = Json::object();
      r.control.set("result", Json::str("PreviewResult"));
      r.control.set("imageStreamId", Json::number(r.binary_stream_id));
      r.control.set("widthPx", Json::number(po.width_px));
      r.control.set("heightPx", Json::number(po.height_px));
      r.control.set("imageFormat", Json::str("png"));
      Json sv = Json::object();
      sv.set("major", Json::number(loaded.value().schema.major));
      sv.set("minor", Json::number(loaded.value().schema.minor));
      r.control.set("schemaVersion", std::move(sv));
      Json notices = Json::array();
      append_schema_minor_ahead(notices, loaded.value());
      for (const auto& n : po.notices) notices.push_back(notice_to_json(n));
      r.control.set("notices", std::move(notices));
      r.control.set("proto", proto_echo());
      return r;
    }

    case Op::Print: {
      const Json* cref = request.get("contractRef");
      if (cref == nullptr) {
        return error_reply(request, ProtoErrorKind::ContractValidationError,
                           "missing contractRef");
      }
      auto text = read_contract_ref(*cref);
      if (!text.has_value()) {
        return error_reply(request, ProtoErrorKind::ContractValidationError,
                           text.error().message);
      }
      auto loaded = load_baked_contract(text.value());
      if (!loaded.has_value()) {
        return error_reply(request, map_contract_error(loaded.error().code),
                           loaded.error().message);
      }
      const auto printer_id = read_optional_string(request, "printerId");
      if (!printer_id.has_value()) {
        return error_reply(request, ProtoErrorKind::ContractValidationError,
                           printer_id.error());
      }
      const auto stock_id = read_optional_string(request, "stockId");
      if (!stock_id.has_value()) {
        return error_reply(request, ProtoErrorKind::ContractValidationError,
                           stock_id.error());
      }
      int copies = 1;
      if (const Json* copies_field = request.get("copies")) {
        // >=1 and sanely bounded: an out-of-int-range double cast is UB and
        // a million-copy request is never intentional.
        const auto checked = checked_wire_number(*copies_field, 1.0, 999.0, true);
        if (!checked.has_value()) {
          return error_reply(request, ProtoErrorKind::ContractValidationError,
                             "copies must be an integer in 1..999");
        }
        copies = static_cast<int>(*checked);
      }
      PrintRenderOptions opts;
      const auto aa = read_aa_option(request);
      if (!aa.has_value()) {
        return error_reply(request, ProtoErrorKind::ContractValidationError,
                           aa.error());
      }
      opts.edge_crisp = aa.value();
      auto merge = read_merge(request);
      if (!merge.has_value()) {
        return error_reply(request, ProtoErrorKind::ContractValidationError,
                           merge.error());
      }

      print_in_flight_ = true;
      auto out = services_.print(loaded.value(), merge.value(),
                                 printer_id.value().value_or(""),
                                 stock_id.value().value_or(""),
                                 copies, opts);
      print_in_flight_ = false;
      if (!out.has_value()) {
        return error_reply(request, map_contract_error(out.error().code),
                           out.error().message);
      }
      const PrintOutput& job = out.value();
      DispatchResult r;
      r.control = Json::object();
      r.control.set("result", Json::str("PrintResult"));
      r.control.set("jobId", Json::str(job.job_id));
      Json notices = Json::array();
      append_schema_minor_ahead(notices, loaded.value());
      for (const auto& n : job.notices) notices.push_back(notice_to_json(n));
      r.control.set("notices", std::move(notices));
      r.control.set("jobLog", job.job_log);
      r.control.set("proto", proto_echo());
      return r;
    }

    case Op::ReleaseContract: {
      DispatchResult r;
      r.control = Json::object();
      r.control.set("result", Json::str("Released"));
      r.control.set("proto", proto_echo());
      return r;
    }

    case Op::Shutdown: {
      DispatchResult r;
      r.control = Json::object();
      r.control.set("result", Json::str("ShutdownAck"));
      r.control.set("proto", proto_echo());
      r.shutdown = true;
      return r;
    }
  }

  return error_reply(request, ProtoErrorKind::EngineInternalError,
                     "unreachable op");
}

}  // namespace print_engine::proto
