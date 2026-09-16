// Main-thread worker pool implementing the same MsdfgenExecutor interface the
// node harness uses with an in-process runner. One Web Worker (and therefore
// one WASM msdfgen instance) per entry; renders queue up and are dispatched to
// idle workers. Input buffers are delivered to each worker once — repeat runs
// referencing the same Uint8Array identity omit them from the message.

import type { MsdfgenExecutor, RenderOutcome } from '../src/msdfgen.js';
import type { RenderRequest } from '../src/wrappedfont.js';

interface OutcomeMessage {
    kind: 'outcome';
    id: number;
    data: Uint8Array | null;
    logs: string[];
}

interface ReadyMessage {
    kind: 'ready';
}

type FromWorker = OutcomeMessage | ReadyMessage;

interface QueuedJob {
    request: RenderRequest;
    resolve: (outcome: RenderOutcome) => void;
    reject: (e: Error) => void;
}

class PoolWorker {
    readonly pending = new Map<number, QueuedJob>();
    /** Buffers already delivered to this worker (by identity). */
    readonly known = new WeakSet<Uint8Array>();

    constructor(public readonly worker: Worker) {}
}

export class MsdfgenPool implements MsdfgenExecutor {
    private readonly workers: PoolWorker[] = [];
    private readonly idle: PoolWorker[] = [];
    private queue: QueuedJob[] = [];
    private nextId = 1;

    private constructor() {}

    static async create(size: number): Promise<MsdfgenPool> {
        if (size < 1) throw new Error('pool size must be >= 1');
        const pool = new MsdfgenPool();
        await Promise.all(Array.from({ length: size }, () => pool.spawn()));
        return pool;
    }

    private spawn(): Promise<void> {
        return new Promise((resolveSpawn, rejectSpawn) => {
            let pw: PoolWorker | null = null;
            const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
            worker.onmessage = (e: MessageEvent<FromWorker>) => {
                if (pw === null) {
                    // First message from this worker signals a successful boot.
                    pw = new PoolWorker(worker);
                    this.workers.push(pw);
                    this.idle.push(pw);
                    this.pump();
                    resolveSpawn();
                }
                if (e.data.kind === 'outcome') this.onOutcome(pw, e.data);
            };
            worker.onerror = (e) => {
                const err = new Error(`msdfgen worker failed: ${e.message}`);
                if (pw === null) {
                    rejectSpawn(err);
                    return;
                }
                for (const job of pw.pending.values()) job.reject(err);
                pw.pending.clear();
                this.removeWorker(pw);
                // Re-dispatch queued jobs to the surviving workers; when none are
                // left, fail them so callers see an error instead of hanging.
                if (this.workers.length === 0) {
                    const orphaned = this.queue;
                    this.queue = [];
                    for (const job of orphaned) job.reject(new Error('all msdfgen workers failed'));
                } else {
                    this.pump();
                }
            };
        });
    }

    private removeWorker(pw: PoolWorker): void {
        const i = this.workers.indexOf(pw);
        if (i !== -1) this.workers.splice(i, 1);
        const j = this.idle.indexOf(pw);
        if (j !== -1) this.idle.splice(j, 1);
        pw.worker.terminate();
    }

    private onOutcome(pw: PoolWorker, msg: OutcomeMessage): void {
        const job = pw.pending.get(msg.id);
        if (!job) return;
        pw.pending.delete(msg.id);
        // One in-flight job per worker (pump only dispatches to idle workers).
        this.idle.push(pw);
        job.resolve({ data: msg.data, logs: msg.logs });
        this.pump();
    }

    private pump(): void {
        while (this.queue.length > 0 && this.idle.length > 0) {
            const pw = this.idle.shift()!;
            const job = this.queue.shift()!;

            // Attach only buffers this particular worker has not seen yet.
            const files: Record<string, Uint8Array> = {};
            for (const [path, data] of Object.entries(job.request.files)) {
                if (!pw.known.has(data)) {
                    files[path] = data;
                    pw.known.add(data);
                }
            }
            const id = this.nextId++;
            pw.pending.set(id, job);
            pw.worker.postMessage({ kind: 'run', id, request: { args: job.request.args, files } });
        }
    }

    run(request: RenderRequest): Promise<RenderOutcome> {
        return new Promise((resolve, reject) => {
            this.queue.push({ request, resolve, reject });
            this.pump();
        });
    }

    /** Shuts every worker down (a fresh pool is created per generation). */
    terminateAll(): void {
        for (const pw of [...this.workers]) {
            for (const job of pw.pending.values()) job.reject(new Error('pool terminated'));
            this.removeWorker(pw);
        }
        this.queue = [];
    }
}
