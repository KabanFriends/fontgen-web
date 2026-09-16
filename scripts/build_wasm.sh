#!/usr/bin/env bash
# Compiles the UNMODIFIED msdfgen CLI (main.cpp) to WASM.
# Mirrors the CMake configuration used by build_native.sh:
#   MSDFGEN_USE_SKIA=OFF, MSDFGEN_DISABLE_SVG=ON, PNG enabled, extensions enabled.
# FreeType and libpng come from Emscripten's ports (-sUSE_FREETYPE=1 -sUSE_LIBPNG=1),
# the same libraries msdfgen links natively.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MSDFGEN_DIR="${MSDFGEN_DIR:-$ROOT/msdfgen}"

EXPECTED_SHA="e06c7ea"
ACTUAL_SHA="$(git -C "$MSDFGEN_DIR" rev-parse --short=7 HEAD 2>/dev/null || echo unknown)"
if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
    echo "WARNING: msdfgen tree is at $ACTUAL_SHA, expected $EXPECTED_SHA — parity results may not match the pinned commit" >&2
fi

EMCXX="${EMCXX:-}"
if [ -z "$EMCXX" ]; then
    if command -v em++ >/dev/null 2>&1; then EMCXX=em++
    elif [ -x /usr/lib/emscripten/em++ ]; then EMCXX=/usr/lib/emscripten/em++
    else echo "error: em++ not found (set EMCXX)" >&2; exit 1; fi
fi

mkdir -p "$ROOT/build/wasm"

# Version defines mirror cmake/version.cmake reading vcpkg.json ("1.13.0").
"$EMCXX" -O2 -std=c++11 \
    -DMSDFGEN_VERSION='"1.13.0"' \
    -DMSDFGEN_VERSION_MAJOR=1 \
    -DMSDFGEN_VERSION_MINOR=13 \
    -DMSDFGEN_VERSION_REVISION=0 \
    -DMSDFGEN_COPYRIGHT_YEAR=2026 \
    -DMSDFGEN_VERSION_UNDERLINE='"------"' \
    -DMSDFGEN_USE_CPP11 \
    -DMSDFGEN_PUBLIC= \
    -DMSDFGEN_EXT_PUBLIC= \
    -DMSDFGEN_EXTENSIONS \
    -DMSDFGEN_DISABLE_SVG \
    -DMSDFGEN_USE_LIBPNG \
    -DMSDFGEN_STANDALONE \
    -I"$MSDFGEN_DIR" \
    "$MSDFGEN_DIR"/core/*.cpp \
    "$MSDFGEN_DIR"/ext/*.cpp \
    "$MSDFGEN_DIR"/main.cpp \
    -sUSE_FREETYPE=1 \
    -sUSE_LIBPNG=1 \
    -sALLOW_MEMORY_GROWTH=1 \
    -sINVOKE_RUN=0 \
    -sEXIT_RUNTIME=0 \
    -sMODULARIZE=1 \
    -sEXPORT_NAME=createMsdfgenModule \
    -sEXPORT_ES6=1 \
    -sEXPORTED_RUNTIME_METHODS=callMain,FS,HEAPU8,stackSave,stackRestore \
    -o "$ROOT/build/wasm/msdfgen.js"

echo "WASM module: $ROOT/build/wasm/msdfgen.js"
