#pragma once

// The standalone host executable obtains its device-touching EngineServices
// through this factory. The seam lets the production Win32/GDI+ implementation
// replace the placeholder with zero change to the dispatcher or transport
// (spec §10.2 "thin adapter" + §1 "printer/stock enumeration lives in the
// engine"). The engine *library* never references this — it stays device-free
// so it builds and tests with zero host present (INV-1).

#include "print_engine/proto_adapter.hpp"

#include <memory>

namespace print_engine::proto {

[[nodiscard]] std::unique_ptr<EngineServices> make_engine_services();

}  // namespace print_engine::proto
