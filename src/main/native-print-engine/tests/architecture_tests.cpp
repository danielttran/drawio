#include <catch2/catch_test_macros.hpp>

#include <array>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

namespace {

[[nodiscard]] std::string read_all(const std::filesystem::path& path) {
  std::ifstream in(path);
  std::ostringstream out;
  out << in.rdbuf();
  return out.str();
}

[[nodiscard]] bool is_source_file(const std::filesystem::path& path) {
  const auto ext = path.extension().string();
  return ext == ".cpp" || ext == ".hpp" || ext == ".h" || ext == ".cc" || ext == ".cxx";
}

} // namespace

TEST_CASE("INV-1 engine sources do not depend on drawio or mxGraph concepts") {
  const std::filesystem::path root = PRINT_ENGINE_SOURCE_ROOT;
  const std::array<std::filesystem::path, 2> scanned_roots = {
    root / "include",
    root / "src"
  };
  const std::array<std::string, 13> forbidden_tokens = {
    "draw.io",
    "drawio",
    "mxGraph",
    "mxCell",
    "mxGeometry",
    "mxPerimeter",
    "mxGraphModel",
    "palette",
    "perimeter",
    "edgeRouting",
    "routeEdge",
    "layoutSolver",
    "zOrder"
  };

  for (const auto& scanned_root : scanned_roots) {
    REQUIRE(std::filesystem::exists(scanned_root));

    for (const auto& entry : std::filesystem::recursive_directory_iterator(scanned_root)) {
      if (!entry.is_regular_file() || !is_source_file(entry.path())) {
        continue;
      }

      const std::string contents = read_all(entry.path());
      for (const auto& token : forbidden_tokens) {
        INFO("file: " << entry.path().string());
        INFO("token: " << token);
        CHECK(contents.find(token) == std::string::npos);
      }
    }
  }
}
