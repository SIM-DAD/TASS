/**
 * Synchronous worker pool for `tass score --workers N` (M3 throughput). Batches are
 * dispatched round-robin and collected strictly IN DISPATCH ORDER, so the caller writes
 * results in input order and `--workers` output stays byte-identical to single-threaded.
 *
 * Why synchronous: the whole CLI is `main(argv, io): number` — tests call it in-process and
 * expect every artifact written on return. Each worker therefore posts results on its own
 * MessagePort and bumps a shared Int32Array counter; the main thread collects with
 * receiveMessageOnPort + Atomics.wait (the standard sync-worker pattern, node builtins only).
 * A worker's port delivers results in the order its batches were sent, and batch j always
 * goes to worker j % N, so collecting batch j from worker j % N is order-correct.
 */
import { Worker, MessageChannel, MessagePort, receiveMessageOnPort } from 'node:worker_threads';
import { join } from 'node:path';
import { Lexicon, Metric, TassError } from '@simdad/tass-core';
import type { ScoreBatchResult } from './score-worker';

interface Slot {
    worker: Worker;
    port: MessagePort;
    sig: Int32Array;
}

export class ScorePool {
    private readonly slots: Slot[] = [];
    private dispatched = 0;
    private collected = 0;

    constructor(workers: number, init: {
        lexicons: Lexicon[];
        scoreCols: Array<{ lex: number; cat: number; metric: Metric }>;
        vaderRules: boolean;
    }) {
        // Resolved against the BUILT lib/ directory — score-worker.js sits beside this file.
        const entry = join(__dirname, 'score-worker.js');
        for (let i = 0; i < workers; i++) {
            const { port1, port2 } = new MessageChannel();
            const sig = new Int32Array(new SharedArrayBuffer(4));
            const worker = new Worker(entry, {
                workerData: { ...init, port: port2, sig },
                transferList: [port2],
            });
            // Never hold the parent's event loop open: the pool's lifetime is the synchronous
            // score run; terminate() below (or process exit) ends the threads.
            worker.unref();
            this.slots.push({ worker, port: port1, sig });
        }
    }

    /** Number of dispatched batches not yet collected. */
    get inFlight(): number { return this.dispatched - this.collected; }

    /** Send one batch of texts to the next worker (round-robin). */
    dispatch(texts: string[]): void {
        this.slots[this.dispatched % this.slots.length].worker.postMessage({ texts });
        this.dispatched++;
    }

    /** Block until the oldest in-flight batch's result arrives; return it (dispatch order). */
    collect(): ScoreBatchResult {
        const slot = this.slots[this.collected % this.slots.length];
        for (;;) {
            const m = receiveMessageOnPort(slot.port);
            if (m !== undefined) {
                this.collected++;
                const result = m.message as ScoreBatchResult;
                if (result.error !== undefined) {
                    throw TassError.runtime('score/worker-failed', `worker scoring failed: ${result.error}`);
                }
                return result;
            }
            // Timed wait: the worker bumps sig after posting, so we wake promptly; the
            // timeout is a liveness guard (a missed notify degrades to a 50 ms poll).
            Atomics.wait(slot.sig, 0, Atomics.load(slot.sig, 0), 50);
        }
    }

    /** Tear the threads down (fire-and-forget; workers are unref'd anyway). */
    close(): void {
        for (const s of this.slots) {
            s.port.close();
            void s.worker.terminate();
        }
    }
}
