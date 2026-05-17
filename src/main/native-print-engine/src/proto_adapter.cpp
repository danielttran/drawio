#include "print_engine/proto_adapter.hpp"

#include "print_engine/contract_loader.hpp"

#include <chrono>
#include <fstream>
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

// mergeData object -> KEY/value string map (engine P3 IMergeSource input §4).
std::map<std::string, std::string> read_merge(const Json& request) {
  std::map<std::string, std::string> merge;
  const Json* md = request.get("mergeData");
  if (md != nullptr && md->is_object()) {
    for (const auto& kv : md->object_pairs()) {
      merge[kv.first] = kv.second.as_string();
    }
  }
  return merge;
}

const char* contract_kind_to_wire(const PaintNodeSummary& node) {
  return node.barcode_value_type == BarcodeValueType::Merge ? "barcode" : "text";
}

}  // namespace

Json notice_to_json(const DegradationNotice& n) {
  Json j = Json::object();
  j.set("kind", Json::str(to_wire(map_notice(n.type))));
  // pageId is optional by design (§3.7): present only when page-scoped.
  if (!n.page_id.empty()) {
    j.set("pageId", Json::str(n.page_id));
  } else {
    j.set("pageId", Json());  // explicit null for non-page-scoped notices
  }
  Json detail = Json::object();
  if (!n.detail.empty()) detail.set("detail", Json::str(n.detail));
  if (!n.symbology.empty()) detail.set("symbology", Json::str(n.symbology));
  if (!n.resolved_value.empty())
    detail.set("resolvedValue", Json::str(n.resolved_value));
  j.set("detail", std::move(detail));
  return j;
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
    r.control.set("id", *id);  // correlate to the request if it carried an id
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

  // Defined ordering / version gate (§3.2/§3.4) before any work.
  if (auto gated = session_.gate(*op); gated.has_value()) {
    return error_reply(request, *gated, "operation refused by protocol gate");
  }

  switch (*op) {
    case Op::Hello: {
      ProtoVersion peer;
      if (const Json* p = request.get("proto"); p != nullptr) {
        peer.major =
            static_cast<std::uint32_t>(p->get("major") ? p->get("major")->as_number() : 0);
        peer.minor =
            static_cast<std::uint32_t>(p->get("minor") ? p->get("minor")->as_number() : 0);
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
      Json fields = Json::array();
      std::map<std::string, bool> seen;
      for (const auto& page : doc.pages) {
        for (const auto& node : page.paint) {
          const bool is_merge =
              node.text_content_type == TextContentType::Merge ||
              node.barcode_value_type == BarcodeValueType::Merge;
          if (!is_merge || node.merge_key.empty() || seen[node.merge_key]) {
            continue;
          }
          seen[node.merge_key] = true;
          Json f = Json::object();
          f.set("key", Json::str(node.merge_key));
          f.set("kind", Json::str(contract_kind_to_wire(node)));
          f.set("maxLen", Json::number(node.merge_max_len));
          f.set("sampleValue", Json::str(node.merge_sample));
          fields.push_back(std::move(f));
        }
      }
      r.control.set("fields", std::move(fields));
      Json notices = Json::array();
      if (doc.schema.minor > SupportedMinor) {
        Json n = Json::object();
        n.set("kind", Json::str(to_wire(NoticeKind::SchemaMinorAhead)));
        n.set("pageId", Json());
        Json d = Json::object();
        d.set("fileVersion", Json::number(doc.schema.minor));
        d.set("supported", Json::number(SupportedMinor));
        n.set("detail", std::move(d));
        notices.push_back(std::move(n));
      }
      r.control.set("notices", std::move(notices));
      r.control.set("proto", proto_echo());
      return r;
    }

    case Op::RenderPreview: {
      // A regulated print in progress must not contend with a preview (§3.4).
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
      const double dpi =
          request.get("dpi") ? request.get("dpi")->as_number(300.0) : 300.0;
      auto out =
          services_.render_preview(loaded.value(), read_merge(request), dpi);
      if (!out.has_value()) {
        return error_reply(request, map_contract_error(out.error().code),
                           out.error().message);
      }
      const PreviewOutput& po = out.value();
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
      const std::string printer_id =
          request.get("printerId") ? request.get("printerId")->as_string() : "";
      const std::string stock_id =
          request.get("stockId") ? request.get("stockId")->as_string() : "";
      const int copies = static_cast<int>(
          request.get("copies") ? request.get("copies")->as_number(1.0) : 1.0);

      print_in_flight_ = true;  // single-flight (§3.4); serial dispatcher
      auto out = services_.print(loaded.value(), read_merge(request),
                                 printer_id, stock_id, copies);
      print_in_flight_ = false;
      if (!out.has_value()) {
        // AbortDoc discipline: never a silent partial; report failure loudly.
        return error_reply(request, map_contract_error(out.error().code),
                           out.error().message);
      }
      const PrintOutput& job = out.value();
      DispatchResult r;
      r.control = Json::object();
      r.control.set("result", Json::str("PrintResult"));
      r.control.set("jobId", Json::str(job.job_id));
      Json notices = Json::array();
      for (const auto& n : job.notices) notices.push_back(notice_to_json(n));
      r.control.set("notices", std::move(notices));
      r.control.set("jobLog", job.job_log);
      r.control.set("proto", proto_echo());
      return r;
    }

    case Op::ReleaseContract: {
      // The dispatcher reads a contractRef fully per op and holds no handle,
      // so it can acknowledge immediately (resolves the mid-read race; §6).
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
