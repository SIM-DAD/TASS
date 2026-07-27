/**
 * Corpus preparation (the Prepare capability): deterministic, provenance-first cleaning of a
 * CSV corpus BEFORE scoring. Operations apply in ONE FIXED ORDER (each over the survivors of
 * the previous one):
 *
 *   1. trim        trim leading/trailing whitespace and collapse internal whitespace runs to
 *                  one space, in the text column only
 *   2. drop-blank  drop rows whose text is blank. Whitespace-only counts as blank whether or
 *                  not trim is selected (a cell of spaces is not a document); trim
 *                  additionally REWRITES surviving cells
 *   3. min-tokens  drop rows with fewer than N tokens (the engine tokenizer, so the count
 *                  matches what score would see)
 *   4. filter      include/exclude rows by EXACT column value: multiple includes on the same
 *                  column OR together, includes on different columns AND, excludes always
 *                  apply
 *   5. dedup       drop rows whose text exactly duplicates an earlier row's (keep first;
 *                  comparison is over the text as it stands here, i.e. AFTER trim when trim
 *                  is on)
 *
 * Output preserves the input columns and their order; nothing is added. The report records
 * rows in/out and, per dropping operation, the drop count plus up to 20 example dropped row
 * indexes (0-based over the INPUT data rows, header excluded). Pure and deterministic: no
 * clocks, no randomness, stable order.
 */
import { TassError } from './errors';
import { tokenize } from './index';

/** One parsed filter spec: keep (include) or drop (exclude) rows where column === value. */
export interface PrepareFilter {
    column: string;
    value: string;
    exclude: boolean;
}

export interface PrepareOptions {
    trim?: boolean;
    dropBlank?: boolean;
    /** Drop rows with fewer than this many tokens (positive integer). Omit = off. */
    minTokens?: number;
    filters?: PrepareFilter[];
    dedup?: boolean;
}

/** The dropping operations, in the fixed application order (trim never drops). */
export type PrepareDropOp = 'drop-blank' | 'min-tokens' | 'filter' | 'dedup';

export interface PrepareDrop {
    op: PrepareDropOp;
    dropped: number;
    /** Up to 20 example dropped row indexes (0-based over the input data rows). */
    exampleRowIndexes: number[];
}

export interface PrepareReport {
    rowsIn: number;
    rowsOut: number;
    /** Whether the trim rewrite was applied (it drops nothing, so it has no drop entry). */
    trimApplied: boolean;
    /** One entry per SELECTED dropping operation, in the fixed order, even when 0 dropped. */
    drops: PrepareDrop[];
}

const MAX_EXAMPLES = 20;

/**
 * Parse a `--filter` spec: `col=value` (include) or `col!=value` (exclude). The value may
 * itself contain `=`; the column name may not. Throws a usage TassError on a malformed spec.
 */
export function parseFilterSpec(spec: string): PrepareFilter {
    const ne = spec.indexOf('!=');
    const eq = spec.indexOf('=');
    if (ne >= 0 && ne <= eq - 1) {
        // "!=" found before (or at) the first "=": the "=" belongs to the "!=".
        const column = spec.slice(0, ne);
        if (!column) { throw TassError.usage('prepare/bad-filter', `filter '${spec}': empty column name; use col=value or col!=value`); }
        return { column, value: spec.slice(ne + 2), exclude: true };
    }
    if (eq < 0) {
        throw TassError.usage('prepare/bad-filter', `filter '${spec}': expected col=value (include) or col!=value (exclude)`);
    }
    const column = spec.slice(0, eq);
    if (!column) { throw TassError.usage('prepare/bad-filter', `filter '${spec}': empty column name; use col=value or col!=value`); }
    return { column, value: spec.slice(eq + 1), exclude: false };
}

/** Blank = no non-whitespace characters (so whitespace-only counts as blank, always). */
const isBlank = (s: string) => s.trim() === '';

/** The trim operation's rewrite: trim ends, collapse internal whitespace runs to one space. */
const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Clean a loaded CSV corpus (header + data rows, as {@link parseCsv} returns them, header
 * excluded from `rows`). Returns the surviving rows (same columns, original order) and the
 * report. At least one operation must be selected.
 */
export function prepareCorpus(
    header: string[],
    rows: ReadonlyArray<ReadonlyArray<string>>,
    textColumn: string,
    options: PrepareOptions,
): { rows: string[][]; report: PrepareReport } {
    const anyOp = Boolean(options.trim) || Boolean(options.dropBlank) ||
        options.minTokens !== undefined || (options.filters?.length ?? 0) > 0 || Boolean(options.dedup);
    if (!anyOp) {
        throw TassError.usage('prepare/no-operations',
            'no operations selected; pick at least one of: trim, drop-blank, min-tokens, filter, dedup');
    }
    const colIdx = (name: string, what: string) => {
        const i = header.indexOf(name);
        if (i < 0) {
            throw TassError.usage('prepare/column-not-found',
                `${what} '${name}' not found; columns: ${header.join(', ')}`);
        }
        return i;
    };
    const textIdx = colIdx(textColumn, 'text column');
    if (options.minTokens !== undefined && (!Number.isInteger(options.minTokens) || options.minTokens < 1)) {
        throw TassError.usage('prepare/bad-min-tokens', 'min-tokens must be a positive integer');
    }
    const filters = options.filters ?? [];
    const filterIdx = new Map<string, number>();
    for (const f of filters) {
        if (!filterIdx.has(f.column)) { filterIdx.set(f.column, colIdx(f.column, 'filter column')); }
    }

    // Live rows carry their original 0-based data-row index for the example lists.
    let live = rows.map((r, index) => ({ cells: r.slice() as string[], index }));
    const text = (r: { cells: string[] }) => r.cells[textIdx] ?? '';
    const drops: PrepareDrop[] = [];
    const applyDrop = (op: PrepareDropOp, keep: (r: { cells: string[]; index: number }) => boolean) => {
        const exampleRowIndexes: number[] = [];
        let dropped = 0;
        live = live.filter(r => {
            if (keep(r)) { return true; }
            dropped++;
            if (exampleRowIndexes.length < MAX_EXAMPLES) { exampleRowIndexes.push(r.index); }
            return false;
        });
        drops.push({ op, dropped, exampleRowIndexes });
    };

    // 1. trim (rewrite only; short rows are padded up to the text column so the cell exists).
    if (options.trim) {
        for (const r of live) {
            while (r.cells.length <= textIdx) { r.cells.push(''); }
            r.cells[textIdx] = collapse(r.cells[textIdx]);
        }
    }

    // 2. drop-blank.
    if (options.dropBlank) {
        applyDrop('drop-blank', r => !isBlank(text(r)));
    }

    // 3. min-tokens.
    if (options.minTokens !== undefined) {
        const n = options.minTokens;
        applyDrop('min-tokens', r => tokenize(text(r)).length >= n);
    }

    // 4. filter: includes grouped per column (OR within a column, AND across columns);
    //    excludes always apply.
    if (filters.length > 0) {
        const includes = new Map<string, Set<string>>();
        for (const f of filters) {
            if (f.exclude) { continue; }
            let set = includes.get(f.column);
            if (!set) { set = new Set(); includes.set(f.column, set); }
            set.add(f.value);
        }
        const excludes = filters.filter(f => f.exclude);
        applyDrop('filter', r => {
            for (const [column, values] of includes) {
                if (!values.has(r.cells[filterIdx.get(column)!] ?? '')) { return false; }
            }
            return !excludes.some(f => (r.cells[filterIdx.get(f.column)!] ?? '') === f.value);
        });
    }

    // 5. dedup (keep first; text as it stands here, i.e. post-trim when trim is on).
    if (options.dedup) {
        const seen = new Set<string>();
        applyDrop('dedup', r => {
            const t = text(r);
            if (seen.has(t)) { return false; }
            seen.add(t);
            return true;
        });
    }

    return {
        rows: live.map(r => r.cells),
        report: {
            rowsIn: rows.length,
            rowsOut: live.length,
            trimApplied: Boolean(options.trim),
            drops,
        },
    };
}
