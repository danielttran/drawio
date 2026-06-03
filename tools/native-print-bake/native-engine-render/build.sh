#!/usr/bin/env bash
# Build the PRODUCTION resvg cdylib + the rasterize CLI used by the Native Print
# end-to-end verification gate, then print the SVG_RASTERIZER_LIB export line.
# Browser-free; needs cargo + a C++17 compiler (the same toolchain the engine
# build uses). Idempotent.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
crate="$here/../../../src/main/native-print-engine/host/svg-rasterizer"

echo "==> cargo build --release (resvg cdylib)"
( cd "$crate" && cargo build --release )

lib="$(ls "$crate"/target/release/libsvg_rasterizer.so 2>/dev/null \
   || ls "$crate"/target/release/svg_rasterizer.dll 2>/dev/null \
   || ls "$crate"/target/release/libsvg_rasterizer.dylib 2>/dev/null)"

echo "==> g++ rasterize CLI"
g++ -std=c++17 -O2 -Wall -o "$here/rasterize" "$here/rasterize.cpp" -ldl

echo "==> done"
echo "export SVG_RASTERIZER_LIB=\"$(readlink -f "$lib")\""
