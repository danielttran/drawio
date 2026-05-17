cmake_minimum_required(VERSION 3.24)

project(native_print_engine LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(MSVC)
  add_compile_options(/W4 /WX /permissive-)
else()
  add_compile_options(-Wall -Wextra -Wpedantic -Werror)
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

add_executable(print_engine_host
  host/host_main.cpp
  ${PRINT_ENGINE_HOST_SERVICES}
)
target_include_directories(print_engine_host PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/host)
target_link_libraries(print_engine_host PRIVATE print_engine_contract)
if(WIN32)
  target_link_libraries(print_engine_host PRIVATE gdiplus winspool gdi32 user32 ole32)
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
    tests/phase1_emit_tests.cpp
    tests/phase2_static_text_tests.cpp
    tests/phase3_raster_svg_tests.cpp
    tests/phase4_merge_barcode_tests.cpp
    tests/phase5_targets_preview_tests.cpp
    tests/phase6_hardening_tests.cpp
    tests/phase7_v2_native_bridge_tests.cpp
    tests/proto_tests.cpp
    tests/proto_adapter_tests.cpp
    tests/wysiwyg_parity_tests.cpp
  )

  target_compile_definitions(print_engine_contract_tests
    PRIVATE
      PRINT_ENGINE_SOURCE_ROOT="${CMAKE_CURRENT_SOURCE_DIR}"
  )

  target_link_libraries(print_engine_contract_tests
    PRIVATE
      print_engine_contract
      Catch2::Catch2WithMain
  )

  include(Catch)
  catch_discover_tests(print_engine_contract_tests)
endif()
