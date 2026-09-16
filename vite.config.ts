// Vite config for the browser app shell (Phase 2). The node-side golden harness
// keeps using tsc + dist/; the web build lands in dist-web/ so the two never mix.
//
// The msdfgen WASM glue is imported statically from build/wasm/ (see app/worker.ts),
// so there is no public-dir copy step: Vite bundles the glue and the ?url-imported
// .wasm wherever they end up.

import { defineConfig } from 'vite';

export default defineConfig({
    base: './',
    publicDir: false,
    build: {
        outDir: 'dist-web',
        sourcemap: false,
    },
    worker: {
        format: 'es',
    },
});
