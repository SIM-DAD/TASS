/**
 * Corpus loading (R1 of the Modern Build Plan refactor): CSV (row = document) or TXT
 * (file = document) into the one corpus shape every consumer scores. Moved from the CLI so
 * statistics, project re-run, and the GUIs load corpora through the same code path with the
 * same validation — no surface reimplements column semantics.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseCsv } from './csv';
import { streamCsvRows } from './csv-stream';
import { TassError } from './errors';

export interface CorpusRow {
    /** Original CSV cells (or [file name] for TXT mode), in header order. */
    passthrough: string[];
    /** The document text to score. */
    text: string;
    /** Values of the requested group columns, if any. */
    groupValues?: string[];
    /** Numeric seconds from the requested time column, if any. */
    seconds?: number;
}

export interface Corpus {
    /** Header of passthrough columns (CSV originals, or ["file"] for TXT mode). */
    header: string[];
    rows: CorpusRow[];
}

/**
 * Classify score inputs into CSV-vs-TXT mode with the shared validation: exactly one CSV, or
 * one-or-more TXT files, never a mix. Exported so the streaming score path (M3) classifies
 * inputs through the same code — and throws the same errors — as {@link loadCorpus}.
 */
export function splitCorpusInputs(inputs: string[]): { csv?: string; txts: string[] } {
    const csvs = inputs.filter(p => p.toLowerCase().endsWith('.csv'));
    const txts = inputs.filter(p => !p.toLowerCase().endsWith('.csv'));
    if (csvs.length > 0 && txts.length > 0) {
        throw TassError.usage('corpus/mixed-input', 'mix of CSV and TXT inputs; score them in separate runs');
    }
    if (csvs.length > 1) {
        throw TassError.usage('corpus/multiple-csv', 'multiple CSV inputs; merge them first or run per file');
    }
    return { csv: csvs[0], txts };
}

/** Column resolution shared by the whole-file and streaming CSV corpus loaders. */
function csvColumns(
    header: string[],
    textColumn: string | undefined,
    groupColumns: string[],
    timeColumn: string | undefined,
): { textIdx: number; groupIdxs: number[]; timeIdx: number } {
    const colIdx = (name: string, what: string) => {
        const i = header.indexOf(name);
        if (i < 0) {
            throw TassError.usage('corpus/column-not-found',
                `${what} '${name}' not found; columns: ${header.join(', ')}`);
        }
        return i;
    };
    if (!textColumn) {
        throw TassError.usage('corpus/missing-text-column',
            `--text-column is required for CSV input; columns: ${header.join(', ')}`);
    }
    return {
        textIdx: colIdx(textColumn, 'text column'),
        groupIdxs: groupColumns.map(g => colIdx(g, 'group column')),
        timeIdx: timeColumn === undefined ? -1 : colIdx(timeColumn, 'time column'),
    };
}

/** Build one {@link CorpusRow} from raw CSV cells (the single source of the cell semantics). */
function toCorpusRow(
    r: string[],
    header: string[],
    textIdx: number,
    groupIdxs: number[],
    timeIdx: number,
    timeColumn: string | undefined,
): CorpusRow {
    let seconds: number | undefined;
    if (timeIdx >= 0) {
        seconds = Number(r[timeIdx]);
        if (!Number.isFinite(seconds)) {
            throw TassError.usage('corpus/bad-time-value',
                `time column '${timeColumn}' has a non-numeric value '${r[timeIdx]}'; use the numeric seconds column (ingest emits one)`);
        }
    }
    return {
        passthrough: header.map((_, i) => r[i] ?? ''),
        text: r[textIdx] ?? '',
        groupValues: groupIdxs.length ? groupIdxs.map(i => r[i] ?? '') : undefined,
        seconds,
    };
}

/**
 * Stream a CSV corpus row-at-a-time (M3 throughput): same validation, errors, and row
 * semantics as the CSV branch of {@link loadCorpus}, but memory stays O(one row).
 * `onHeader` fires once (after column validation) before the first data row; returns the
 * data-row count. Throws `corpus/empty-csv` — like loadCorpus — when the file has no header
 * or no data rows (note: by then `onHeader` may already have fired; callers that write
 * incrementally must clean up on throw).
 */
export function streamCsvCorpus(
    path: string,
    textColumn: string | undefined,
    groupColumns: string[],
    timeColumn: string | undefined,
    onHeader: (header: string[]) => void,
    onRow: (row: CorpusRow) => void,
): number {
    let header: string[] | undefined;
    let cols: { textIdx: number; groupIdxs: number[]; timeIdx: number } | undefined;
    let dataRows = 0;
    streamCsvRows(path, (r, index) => {
        if (index === 0) {
            header = r;
            cols = csvColumns(header, textColumn, groupColumns, timeColumn);
            onHeader(header);
            return;
        }
        dataRows++;
        onRow(toCorpusRow(r, header!, cols!.textIdx, cols!.groupIdxs, cols!.timeIdx, timeColumn));
    });
    if (header === undefined || dataRows === 0) {
        throw TassError.usage('corpus/empty-csv', `${path}: needs a header row + at least one data row`);
    }
    return dataRows;
}

/**
 * Load a corpus from one CSV file or one-or-more TXT files.
 *
 * CSV mode requires `textColumn`; `groupColumns`/`timeColumn` select optional metadata.
 * TXT mode treats each file as one document with the file name as its passthrough column.
 * Mixing the two modes in one call is an error (score them in separate runs).
 */
export function loadCorpus(
    inputs: string[],
    textColumn: string | undefined,
    groupColumns: string[],
    timeColumn?: string,
): Corpus {
    const { csv, txts } = splitCorpusInputs(inputs);
    const csvs = csv === undefined ? [] : [csv];

    if (csvs.length === 1) {
        const rows = parseCsv(readFileSync(csvs[0], 'utf8'));
        if (rows.length < 2) {
            throw TassError.usage('corpus/empty-csv', `${csvs[0]}: needs a header row + at least one data row`);
        }
        const header = rows[0];
        const { textIdx, groupIdxs, timeIdx } = csvColumns(header, textColumn, groupColumns, timeColumn);
        return {
            header,
            rows: rows.slice(1).map(r => toCorpusRow(r, header, textIdx, groupIdxs, timeIdx, timeColumn)),
        };
    }

    // TXT mode: each file is one document; the passthrough column is the file name.
    if (groupColumns.length) {
        throw TassError.usage('corpus/group-needs-csv', '--group-column requires CSV input');
    }
    if (timeColumn) {
        throw TassError.usage('corpus/time-needs-csv', '--time-column requires CSV input');
    }
    return {
        header: ['file'],
        rows: txts.map(p => ({ passthrough: [basename(p)], text: readFileSync(p, 'utf8') })),
    };
}
