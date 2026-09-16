// Typed access to the Emscripten msdfgen glue. The generated JS has no type
// declarations, so the raw import is suppressed and re-exposed with the slice
// of the module API we use.

// @ts-ignore -- untyped generated file
import createModuleRaw from '../build/wasm/msdfgen.js';
import wasmUrl from '../build/wasm/msdfgen.wasm?url';

import type { ModuleFactory } from '../src/msdfgen.js';

/**
 * Factory for the callMain-driven msdfgen WASM module (see src/msdfgen.ts).
 * The glue cannot know where Vite emitted the .wasm asset, so locateFile
 * points it at the ?url-imported path.
 */
export function createMsdfgenModule(opts: Record<string, unknown> = {}): Promise<unknown> {
    return createModuleRaw({
        ...opts,
        locateFile: () => wasmUrl,
    });
}

export type { ModuleFactory };
