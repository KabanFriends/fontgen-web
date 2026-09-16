#!/usr/bin/env bash
# Builds the native msdfgen CLI reference binary (out-of-source, never touches the msdfgen tree).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MSDFGEN_DIR="${MSDFGEN_DIR:-$ROOT/../msdfgen}"

EXPECTED_SHA="e06c7ea"
ACTUAL_SHA="$(git -C "$MSDFGEN_DIR" rev-parse --short=7 HEAD 2>/dev/null || echo unknown)"
if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
    echo "WARNING: msdfgen tree is at $ACTUAL_SHA, expected $EXPECTED_SHA — parity results may not match the pinned commit" >&2
fi

cmake -S "$MSDFGEN_DIR" -B "$ROOT/build/native" -G Ninja \
    -DMSDFGEN_USE_VCPKG=OFF \
    -DMSDFGEN_USE_SKIA=OFF \
    -DMSDFGEN_DISABLE_SVG=ON \
    -DMSDFGEN_DISABLE_PNG=OFF \
    -DCMAKE_BUILD_TYPE=Release
cmake --build "$ROOT/build/native" --target msdfgen

echo "Native binary: $ROOT/build/native/msdfgen"
