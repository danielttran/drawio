cmake_minimum_required(VERSION 3.24)

project(native_print_engine LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(MSVC)
  add_compile_options(/W4 /WX /permissive-)
else()
  # Canonical build is MSVC /W4 /WX. -Wmissing-field-initializers (an opinionated
  # -Wextra warning, not in -Wall) fires on partial aggregate inits where omitted
  # members are deterministically value-initialized; MSVC /W4 does not flag this.
  # Suppress it for GCC/Clang parity rather than diverge the two toolchains.
  add_compile_options(-Wall -Wextra -Wpedantic -Werror -Wno-missing-field-initializers)
endif()

add_library(print_engine_contract
  src/contract_loader.cpp
  src/devmode.cpp
  src/native_print.cpp
  src/path_parser.cpp
  src/proto.cpp
  src/proto_adapter.cpp
  src/renderer.cpp
)

# Host-side helpers that are pure C++ (no Win32) and therefore testable on
# every CI runner. Kept in a tiny static library so its source files live
# under host/ (outside the INV-1 architecture scan, which inspects only
# include/ + src/) while still being linkable into the cross-platform tests.
add_library(print_engine_host_portable STATIC host/custom_stock.cpp)
target_include_directories(print_engine_host_portable
  PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/host)

target_include_directories(print_engine_contract
  PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)

# Standalone host executable. Host sources live OUTSIDE include/ + src/ so the
# INV-1 architecture scan never sees host concepts; the engine library stays
# device-free. Windows builds the real Win32/GDI+ services; other platforms
# get the device-free stub (engine still builds/tests with zero host present).
if(WIN32)
  set(PRINT_ENGINE_HOST_SERVICES host/win32_services.cpp)
else()
  set(PRINT_ENGINE_HOST_SERVICES host/stub_services.cpp)
endif()

# Windows-only SVG-rasterizer ABI loader. The host print path is GDI+ and
# therefore Windows-exclusive, so the loader (LoadLibraryW) compiles only on
# WIN32, exactly like win32_services.cpp.
if(WIN32)
  add_library(print_engine_host_svg STATIC host/svg_rasterizer.cpp)
  target_include_directories(print_engine_host_svg PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/host)
  target_link_libraries(print_engine_host_svg PUBLIC print_engine_contract)
endif()

add_executable(print_engine_host
  host/host_main.cpp
  ${PRINT_ENGINE_HOST_SERVICES}
)
target_include_directories(print_engine_host PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/host)
target_link_libraries(print_engine_host PRIVATE print_engine_contract print_engine_host_portable)
if(WIN32)
  target_link_libraries(print_engine_host PRIVATE print_engine_host_svg)
  target_link_libraries(print_engine_host PRIVATE gdiplus winspool gdi32 user32 ole32)

  # Fake backend cdylib implementing svg_rasterizer_abi.h: the §5 swap
  # acceptance fixture (proves the ABI is backend-agnostic). Test scaffolding
  # only -- never shipped.
  enable_language(C)
  add_library(fake_svg_rasterizer MODULE host/test_support/fake_svg_rasterizer.c)
  set_target_properties(fake_svg_rasterizer PROPERTIES
    PREFIX ""
    # Windows DLLs export nothing unless explicitly decorated. The ABI
    # header carries no __declspec(dllexport) (it has to be neutral so
    # the Rust shim can build with #[no_mangle] only), so we let CMake
    # auto-generate the export table from the symbol table at link
    # time. Without this the windows-2025 runner image's MSVC produces
    # a DLL with zero exports -- LoadLibrary succeeds, GetProcAddress
    # returns null on every symbol, and the loader returns nullptr.
    WINDOWS_EXPORT_ALL_SYMBOLS ON)
endif()

include(CTest)

if(BUILD_TESTING)
  include(FetchContent)
  FetchContent_Declare(
    Catch2
    GIT_REPOSITORY https://github.com/catchorg/Catch2.git
    GIT_TAG v3.7.1
  )
  FetchContent_MakeAvailable(Catch2)

  add_executable(print_engine_contract_tests
    tests/architecture_tests.cpp
    tests/contract_validation_tests.cpp
    tests/contract_loader_tests.cpp
    tests/custom_stock_tests.cpp
    tests/phase1_emit_tests.cpp
    tests/phase2_static_text_tests.cpp
    tests/phase3_raster_svg_tests.cpp
    tests/phase4_merge_barcode_tests.cpp
    tests/phase5_targets_preview_tests.cpp
    tests/phase6_hardening_tests.cpp
    tests/phase7_v2_native_bridge_tests.cpp
    tests/paper_size_tests.cpp
    tests/proto_tests.cpp
    tests/proto_adapter_tests.cpp
    tests/svg_pixel_determinism_tests.cpp
    tests/wysiwyg_parity_tests.cpp
    tests/correctness_extended_tests.cpp
    tests/audit_fidelity_tests.cpp
  )

  # Cross-platform SVG pixel-golden test: configured to a path it loads at
  # runtime via dlopen / LoadLibrary. Empty path => tests SKIP (still pass);
  # CI sets this when the Rust crate has been built first.
  set(SVG_RASTERIZER_LIB "" CACHE FILEPATH
      "Absolute path to the SVG rasterizer cdylib for pixel-golden tests")
  target_compile_definitions(print_engine_contract_tests
    PRIVATE
      SVG_RASTERIZER_LIB="${SVG_RASTERIZER_LIB}"
  )
  if(NOT WIN32)
    # dlopen needs libdl on Linux (no-op on macOS/BSD; harmless).
    target_link_libraries(print_engine_contract_tests PRIVATE ${CMAKE_DL_LIBS})
  endif()

  target_compile_definitions(print_engine_contract_tests
    PRIVATE
      PRINT_ENGINE_SOURCE_ROOT="${CMAKE_CURRENT_SOURCE_DIR}"
  )

  target_link_libraries(print_engine_contract_tests
    PRIVATE
      print_engine_contract
      print_engine_host_portable
      Catch2::Catch2WithMain
  )

  include(Catch)
  catch_discover_tests(print_engine_contract_tests)

  # Windows-only: ABI handshake + fake-shim swap acceptance test for the SVG
  # rasterizer loader. Not built on non-Windows (the loader is Win32-only).
  if(WIN32)
    add_executable(print_engine_host_tests tests/svg_rasterizer_abi_tests.cpp)
    target_include_directories(print_engine_host_tests PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/host)
    target_link_libraries(print_engine_host_tests
      PRIVATE print_engine_host_svg Catch2::Catch2WithMain)
    add_dependencies(print_engine_host_tests fake_svg_rasterizer)
    # Copy the fake backend next to the test exe and load it by bare name.
    # (Baking $<TARGET_FILE> into a C string macro would inject Windows-path
    # backslashes as invalid escape sequences under MSVC.)
    add_custom_command(TARGET print_engine_host_tests POST_BUILD
      COMMAND ${CMAKE_COMMAND} -E copy_if_different
        $<TARGET_FILE:fake_svg_rasterizer>
        $<TARGET_FILE_DIR:print_engine_host_tests>)
    catch_discover_tests(print_engine_host_tests)
  endif()
endif()
