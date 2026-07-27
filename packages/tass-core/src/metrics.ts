/**
 * Metric selection and deterministic formatting (R3/R4 of the Modern Build Plan refactor).
 * These are the load-bearing output contracts shared by every surface:
 *
 *  - {@link metricValue} is THE single implementation of the four reported metrics, including
 *    the rule that `mean` is undefined (never 0) when a category has no hits — AGENTS.md
 *    contract 5. It must never be re-derived elsewhere.
 *  - {@link fmt} is THE number formatter for every text artifact (CSV cells, summaries,
 *    manifests). Byte-stability of output = determinism guarantee; any change here is a
 *    versioned engine change.
 */
import { CategoryResult } from './index';

export const METRICS = ['percent', 'hits', 'weighted', 'mean'] as const;
export type Metric = typeof METRICS[number];

/** Type guard for user-supplied metric names. */
export function isMetric(s: string): s is Metric {
    return (METRICS as readonly string[]).includes(s);
}

/**
 * The value of one metric for one category result. `mean` is undefined when hits === 0 —
 * "no hits" is not "average weight of zero", and downstream aggregation must skip it.
 */
export function metricValue(r: CategoryResult, metric: Metric): number | undefined {
    switch (metric) {
        case 'percent': return r.percent;
        case 'hits': return r.hits;
        case 'weighted': return r.weighted;
        case 'mean': return r.hits === 0 ? undefined : r.weighted / r.hits;
    }
}

/** Column-safe name: lexicon/category ids may hold anything; R/pandas want [A-Za-z0-9_]. */
export function safeName(s: string): string {
    return s.replace(/[^A-Za-z0-9_]/g, '_');
}

/** Fixed-precision number formatting so output is byte-stable and diff-friendly. */
export function fmt(n: number | undefined): string {
    if (n === undefined) { return ''; }
    return Number.isInteger(n) ? String(n) : n.toFixed(4).replace(/\.?0+$/, '');
}

/** Seconds -> "M:SS" / "H:MM:SS" display stamp (trajectory window labels). */
export function secondsToStamp(s: number): string {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const mm = String(m).padStart(2, '0'), ss = String(sec).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/**
 * Running mean/SD accumulator that ignores undefined values ('mean' metric on 0-hit docs).
 * Seed of the future tass-stats descriptives; kept dependency-free and deterministic.
 */
export class Acc {
    n = 0;
    private sum = 0;
    private sumsq = 0;

    add(v: number | undefined): void {
        if (v !== undefined) { this.n++; this.sum += v; this.sumsq += v * v; }
    }

    mean(): number | undefined {
        return this.n === 0 ? undefined : this.sum / this.n;
    }

    /** Sample SD (ddof = 1, Bessel's correction); undefined below n = 2. */
    sd(): number | undefined {
        if (this.n < 2) { return undefined; }
        const variance = (this.sumsq - (this.sum * this.sum) / this.n) / (this.n - 1);
        return Math.sqrt(Math.max(0, variance));
    }
}
