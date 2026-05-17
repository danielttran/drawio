#pragma once

#include <string>
#include <vector>

#include "print_engine/geometry.hpp"

namespace print_engine {

inline constexpr int SupportedMajor = 1;
inline constexpr int SupportedMinor = 0;

enum class PaintKind {
  Path,
  Text,
  Image,
  Svg,
  Barcode
};

enum class TextContentType {
  None,
  Static,
  Merge
};

enum class BarcodeValueType {
  None,
  Static,
  Merge
};

struct SchemaVersion {
  int major = 0;
  int minor = 0;
};

struct PaintNodeSummary {
  PaintKind kind;
  Rect box;
  std::string path_data;
  std::string image_format;
  std::string image_data;
  std::string image_aspect;
  bool flip_h = false;
  bool flip_v = false;
  std::string svg_source;
  std::string svg_aspect;
  std::string font_family;
  double font_size_px = 0.0;
  std::string align_h;
  std::string align_v;
  TextContentType text_content_type = TextContentType::None;
  std::vector<std::string> static_lines;
  std::string merge_key;
  std::string merge_sample;
  int merge_max_len = 0;
  std::string merge_wrap;
  std::string merge_overflow;
  double shrink_floor_px = 0.0;
  BarcodeValueType barcode_value_type = BarcodeValueType::None;
  std::string barcode_symbology;
  std::string barcode_static_value;
  bool has_fill = false;
  bool has_stroke = false;
  double stroke_width = 0.0;
};

struct TileSummary {
  Point origin;
  Size size;
};

struct PageSummary {
  std::string id;
  double width = 0.0;
  double height = 0.0;
  std::vector<TileSummary> tiles;
  std::vector<PaintNodeSummary> paint;
};

struct BakedDocument {
  SchemaVersion schema;
  std::string units;
  std::vector<PageSummary> pages;
  bool has_merge_text = false;
  bool has_barcode = false;
  bool has_degradation_notice = false;
};

} // namespace print_engine
