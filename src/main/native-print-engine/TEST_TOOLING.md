# Test Tooling

Chosen framework: Catch2 v3.

Rationale:

- Header/library integration through CMake `FetchContent`.
- Compact syntax for contract and invariant tests.
- Good Windows support.

Do not mix in GoogleTest or another C++ test framework without a documented tooling migration.
