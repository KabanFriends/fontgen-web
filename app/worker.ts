// Worker entry: owns one WASM msdfgen instance and serves render requests.
// Reusable inputs (the font binary) are cached by virtual path: the first run
// carrying a buffer delivers it, later runs omit it. Per-run inputs (fresh
// shapedesc text) always arrive attached to the run message.

import { MsdfgenRunner } from '../src/msdfgen.js';
import type { RenderRequest } from '../src/wrappedfont.js';
import { createMsdfgenModule } from './wasm';

let runnerPromise: Promise<MsdfgenRunner> | null = null;

// Announce boot: the pool resolves its spawn handshake on a worker's first
// message, so without this ping pool creation would wait for the first job.
self.postMessage({ kind: 'ready' });

self.onmessage = async (e: MessageEvent<RunMessage>) => {
    const msg = e.data;
    try {
        // Merge this run's inputs into the persistent store. The runner wipes /in
        // before every run and writes the whole file set fresh each time.
        for (const [path, data] of Object.entries(msg.request.files)) {
            store.set(path, data);
        }

        const outcome = await (await getRunner()).run({
            args: msg.request.args,
            files: Object.fromEntries(store),
        });

        if (outcome.data !== null) {
            // Transfer the atlas bytes back; ownership moves to the main thread.
            self.postMessage(
                { kind: 'outcome', id: msg.id, data: outcome.data, logs: outcome.logs },
                [outcome.data.buffer],
            );
        } else {
            self.postMessage({ kind: 'outcome', id: msg.id, data: null, logs: outcome.logs });
        }
    } catch (err) {
        // A thrown run must still answer, or the pool would stall on this job forever.
        const message = err instanceof Error ? err.message : String(err);
        self.postMessage({ kind: 'outcome', id: msg.id, data: null, logs: [`[worker] ${message}`] });
    }
};

/** Inputs received so far, keyed by virtual path. */
const store = new Map<string, Uint8Array>();

interface RunMessage {
    kind: 'run';
    id: number;
    request: RenderRequest;
}

function getRunner(): Promise<MsdfgenRunner> {
    if (runnerPromise === null) {
        runnerPromise = MsdfgenRunner.create(
            createMsdfgenModule as unknown as Parameters<typeof MsdfgenRunner.create>[0],
        );
    }
    return runnerPromise;
}
