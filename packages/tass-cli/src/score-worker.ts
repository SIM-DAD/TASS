/**
 * Worker-thread entry for `tass score --workers N` (M3 throughput, Modern Build Plan
 * Section 3.4). Each worker receives the lexicon SOURCE data once at startup (lexicon JSON
 * objects + the vader-rules flag + the score-column plan), compiles locally, and then scores
 * batches of raw texts. Batches carry ONLY texts; results carry only numbers. The main thread
 * reassembles results in input order, so `--workers` output is byte-identical to
 * single-threaded by construction.
 *
 * Results are posted on a dedicated MessagePort and signalled through a shared Int32Array so
 * the (synchronous) CLI main thread can collect them with receiveMessageOnPort + Atomics.wait
 * — no event-loop turn needed, no async contamination of `main(argv, io)`.
 */
import { parentPort, workerData } from 'node:worker_threads';
import {
    Lexicon, Metric, compileLexicon, analyze, metricValue, vaderRuleScore, valenceMap, loadBundled,
} from '@simdad/tass-core';

interface WorkerInit {
    lexicons: Lexicon[];
    scoreCols: Array<{ lex: number; cat: number; metric: Metric }>;
    vaderRules: boolean;
    port: import('node:worker_threads').MessagePort;
    sig: Int32Array;
}

/** One scored batch: per-row token counts and metric values (undefined travels as null). */
export interface ScoreBatchResult {
    tokens: number[];
    values: Array<Array<number | null>>;
    error?: string;
}

const { lexicons, scoreCols, vaderRules, port, sig } = workerData as WorkerInit;
const compiled = lexicons.map(compileLexicon);
const vmap = vaderRules
    ? valenceMap(loadBundled('vader').categories.flatMap(c => c.terms))
    : undefined;

parentPort!.on('message', (msg: { texts: string[] }) => {
    let result: ScoreBatchResult;
    try {
        const tokens: number[] = [];
        const values: Array<Array<number | null>> = [];
        for (const text of msg.texts) {
            const results = compiled.map(cl => analyze(text, cl));
            tokens.push(results[0]?.totalTokens ?? 0);
            const v: Array<number | null> = scoreCols.map(c => {
                const x = metricValue(results[c.lex].categories[c.cat], c.metric);
                return x === undefined ? null : x;
            });
            if (vmap) {
                const vr = vaderRuleScore(text, vmap);
                v.push(vr.compound, vr.positive, vr.negative, vr.neutral);
            }
            values.push(v);
        }
        result = { tokens, values };
    } catch (e) {
        result = { tokens: [], values: [], error: e instanceof Error ? e.message : String(e) };
    }
    port.postMessage(result);
    Atomics.add(sig, 0, 1);
    Atomics.notify(sig, 0);
});
