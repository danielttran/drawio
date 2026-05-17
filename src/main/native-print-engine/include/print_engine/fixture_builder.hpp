#pragma once

#include <sstream>
#include <string>

namespace print_engine::fixtures {

class FixtureBuilder {
public:
  FixtureBuilder& schema(int major, int minor) {
    major_ = major;
    minor_ = minor;
    return *this;
  }

  FixtureBuilder& empty_page() {
    page_body_ =
      R"({"id":"page-1","size":{"w":100,"h":50},"tiles":[{"origin":{"x":0,"y":0},"size":{"w":100,"h":50}}],"paint":[]})";
    return *this;
  }

  FixtureBuilder& merge_text_and_barcode_page() {
    page_body_ =
      R"({"id":"page-1","size":{"w":100,"h":50},"tiles":[{"origin":{"x":0,"y":0},"size":{"w":100,"h":50}}],"paint":[)"
      R"({"kind":"text","box":{"x":1,"y":2,"w":40,"h":10},"font":{"family":"Arial","sizePx":8,"weight":400,"italic":false,"color":"#000000"},"align":{"h":"left","v":"top"},"content":{"type":"merge","key":"NAME","sample":"Sample","maxLen":20,"wrap":"word","overflow":"shrink","shrinkFloorPx":5}},)"
      R"({"kind":"barcode","box":{"x":1,"y":20,"w":40,"h":20},"symbology":"stub","params":{},"value":{"type":"merge","key":"CODE","sample":"12345","maxLen":32,"errorOnUnencodable":true}})"
      R"(]})";
    return *this;
  }

  [[nodiscard]] std::string build() const {
    std::ostringstream out;
    out << R"({"schema":{"major":)" << major_ << R"(,"minor":)" << minor_
        << R"(},"document":{"units":"px","pages":[)" << page_body_ << R"(]}})";
    return out.str();
  }

private:
  int major_ = 1;
  int minor_ = 0;
  std::string page_body_ =
    R"({"id":"page-1","size":{"w":100,"h":50},"tiles":[{"origin":{"x":0,"y":0},"size":{"w":100,"h":50}}],"paint":[]})";
};

} // namespace print_engine::fixtures
