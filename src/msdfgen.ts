// Driver for the Emscripten build of msdfgen (unmodified upstream sources, invoked
// through callMain). Inputs are written into a MEMFS /in directory, outputs are read
// back from /out — mirroring how the Java tool shells out with relative paths.
//
// The glue is built with EXIT_RUNTIME=0, so callMain returns even when msdfgen calls
// exit(): a failed render is detected by the absence of the output file.

import type { RenderRequest } from './wrappedfont.js';

/** Minimal slice of the Emscripten FS API used here. */
export interface EmscriptenFs {
    mkdir(path: string): void;
    readdir(path: string): string[];
    readFile(path: string): Uint8Array;
    writeFile(path: string, data: Uint8Array | string): void;
    unlink(path: string): void;
    analyzePath(path: string): { exists: boolean };
}

/** Minimal slice of an Emscripten module. */
export interface EmscriptenModule {
    FS: EmscriptenFs;
    callMain(args: string[]): void;
    stackSave(): number;
    stackRestore(ptr: number): void;
}

export type ModuleFactory = (opts: Record<string, unknown>) => Promise<EmscriptenModule>;

const VFS_DIRS = ['/in', '/out'];

/** Result of one msdfgen invocation. */
export interface RenderOutcome {
    /** Bytes of the file named by `-o`, or null when nothing was produced (failure). */
    data: Uint8Array | null;
    /** stdout/stderr of this run (failure diagnostics). */
    logs: string[];
}

/**
 * Executor for msdfgen renders. Async so implementations can be either the
 * in-process WASM runner (node/harness) or a proxy to a Web Worker pool (app)
 * — the generation pipeline is written against this interface only.
 */
export interface MsdfgenExecutor {
    run(request: RenderRequest): Promise<RenderOutcome>;
}

export class MsdfgenRunner implements MsdfgenExecutor {
    private constructor(
        private readonly mod: EmscriptenModule,
        private readonly logs: string[],
    ) {}

    static async create(factory: ModuleFactory): Promise<MsdfgenRunner> {
        const logs: string[] = [];
        const mod = await factory({
            print: (s: unknown) => { logs.push(`[stdout] ${s}`); },
            printErr: (s: unknown) => { logs.push(`[stderr] ${s}`); },
        });
        for (const dir of VFS_DIRS) {
            try {
                mod.FS.mkdir(dir);
            } catch {
                // already exists
            }
        }
        return new MsdfgenRunner(mod, logs);
    }

    /**
     * Runs one msdfgen invocation synchronously inside this process' WASM
     * instance (the async signature lets the pipeline treat every executor
     * uniformly).
     */
    async run(request: RenderRequest): Promise<RenderOutcome> {
        this.logs.length = 0;
        this.resetVfs();
        for (const [path, data] of Object.entries(request.files)) {
            this.mod.FS.writeFile(path, data);
        }
        try {
            // callMain unshifts its own argv[0] and mutates the array — pass a copy.
            // Emscripten's implicit exit() after main returns does not restore the
            // wasm stack pointer, so repeated invocations slowly eat the stack;
            // save/restore it around each run to keep one module reusable forever.
            const sp = this.mod.stackSave();
            try {
                this.mod.callMain([...request.args]);
            } finally {
                this.mod.stackRestore(sp);
            }
        } catch {
            // abort() lands here; fall through to output detection
        }
        const outPath = extractOutPath(request.args);
        if (outPath !== null) {
            try {
                if (this.mod.FS.analyzePath(outPath).exists) {
                    return { data: this.mod.FS.readFile(outPath), logs: [...this.logs] };
                }
            } catch {
                // fall through
            }
        }
        return { data: null, logs: [...this.logs] };
    }

    private resetVfs(): void {
        for (const dir of VFS_DIRS) {
            for (const entry of this.mod.FS.readdir(dir)) {
                if (entry === '.' || entry === '..') continue;
                try {
                    this.mod.FS.unlink(`${dir}/${entry}`);
                } catch {
                    // directory or already gone
                }
            }
        }
    }
}

function extractOutPath(args: string[]): string | null {
    const i = args.indexOf('-o');
    return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
}
