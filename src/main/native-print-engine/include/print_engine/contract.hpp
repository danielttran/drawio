#pragma once

#include <string>
#include <optional>
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
  Merge,
  Rich
};

enum class BarcodeValueType {
  None,
  Static,
  Merge,
  Rich
};

enum class PaintType {
  None,
  Solid,
  Linear,
  Radial
};

struct Rgba {
  int r = 0;
  int g = 0;
  int b = 0;
  double a = 1.0;
};

struct PaintStop {
  double offset = 0.0;
  Rgba color;
};

struct Paint {
  PaintType type = PaintType::None;
  Rgba solid;
  std::vector<PaintStop> stops;
};

struct StrokeStyle {
  Paint paint;
  double width = 0.0;
  std::string cap;
  std::string join;
  double miter_limit = 0.0;
  std::vector<double> dash;
};

struct SchemaVersion {
  int major = 0;
  int minor = 0;
};



struct RichRun {
  std::string text;
  std::string font_family;
  double size_px = 0.0;
  int weight = 400;
  bool italic = false;
  bool underline = false;
  bool strikethrough = false;
  Rgba color;
};

struct RichParagraph {
  std::string align;
  double indent_px = 0.0;
  std::vector<RichRun> runs;
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
  int font_weight = 400;
  bool font_italic = false;
  bool font_underline = false;
  bool font_strikethrough = false;
  std::string align_h;
  std::string align_v;
  TextContentType text_content_type = TextContentType::None;
  std::vector<std::string> static_lines;
  std::vector<RichParagraph> rich_paragraphs;
  std::string merge_key;
  std::string merge_sample;
  int merge_max_len = 0;
  std::string merge_wrap;
  std::string merge_overflow;
  double shrink_floor_px = 0.0;
  BarcodeValueType barcode_value_type = BarcodeValueType::None;
  std::string barcode_symbology;
  std::string barcode_static_value;
  std::optional<Paint> fill;
  std::optional<StrokeStyle> stroke;
  Rgba font_color;
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
  bool has_rich_text = false;
};

} // namespace print_engine
