/**
 * Incremental RFC-4180 CSV reader (M3 throughput, Modern Build Plan Section 3.4). The
 * streaming sibling of {@link parseCsv} in csv.ts: SAME parsing semantics (quoted fields with
 * embedded commas/quotes/newlines, CRLF and LF, optional UTF-8 BOM, trailing newline, and the
 * same TassError codes on structurally broken quoting), but the file is read in fixed-size
 * chunks off a file descriptor, so memory stays O(one row) instead of O(whole file). csv.ts
 * remains the whole-file reference implementation; any semantic change must land in BOTH and
 * keep the parity test green.
 */
import { openSync, readSync, closeSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { TassError } from './errors';

/** Read chunk size: 1 MiB — large enough to amortize syscalls, small enough to stay cheap. */
const CHUNK_BYTES = 1 << 20;

/**
 * Stream the CSV file at `path`, invoking `onRow` for every parsed row (index 0 = the first
 * row, i.e. the header in a headed file) in file order. Throws exactly like {@link parseCsv}
 * on broken quoting: `csv/quote-mid-field` (with the same post-BOM character offset in the
 * message) and `csv/unterminated-quote`.
 */
export function streamCsvRows(path: string, onRow: (row: string[], index: number) => void): void {
    const fd = openSync(path, 'r');
    try {
        const decoder = new StringDecoder('utf8');
        const buf = Buffer.alloc(CHUNK_BYTES);

        // Parser state, carried across chunks (mirrors the parseCsv state machine).
        let row: string[] = [];
        let field = '';
        let inQuotes = false;
        let pendingQuote = false;   // inside quotes, saw '"': escaped pair or closing quote?
        let pendingCR = false;      // saw '\r': swallow one following '\n'
        let bomPending = true;      // strip a leading U+FEFF from the first decoded characters
        let offset = 0;             // post-BOM character offset (parseCsv error-message parity)
        let index = 0;

        const pushField = () => { row.push(field); field = ''; };
        const pushRow = () => { pushField(); onRow(row, index++); row = []; };

        const feed = (chunk: string) => {
            let i = 0;
            if (bomPending) {
                if (chunk.length === 0) { return; }
                if (chunk.charCodeAt(0) === 0xfeff) { i = 1; }
                bomPending = false;
            }
            for (; i < chunk.length; i++) {
                const ch = chunk[i];
                if (pendingQuote) {
                    pendingQuote = false;
                    if (ch === '"') { field += '"'; offset++; continue; } // escaped quote
                    inQuotes = false; // closing quote; ch falls through to normal handling
                }
                if (pendingCR) {
                    pendingCR = false;
                    if (ch === '\n') { offset++; continue; } // the \n of a CRLF
                }
                if (inQuotes) {
                    if (ch === '"') { pendingQuote = true; offset++; continue; }
                    field += ch; offset++; continue;
                }
                if (ch === '"') {
                    if (field !== '') { throw TassError.runtime('csv/quote-mid-field', `csv: unexpected quote mid-field at offset ${offset}`); }
                    inQuotes = true; offset++; continue;
                }
                if (ch === ',') { pushField(); offset++; continue; }
                if (ch === '\r') { pushRow(); pendingCR = true; offset++; continue; }
                if (ch === '\n') { pushRow(); offset++; continue; }
                field += ch; offset++;
            }
        };

        let bytes: number;
        while ((bytes = readSync(fd, buf, 0, buf.length, null)) > 0) {
            feed(decoder.write(buf.subarray(0, bytes)));
        }
        feed(decoder.end());

        // End of input: a pending quote at EOF is a closing quote (parseCsv leaves the loop
        // with inQuotes already false in that case).
        if (pendingQuote) { inQuotes = false; }
        if (inQuotes) { throw TassError.runtime('csv/unterminated-quote', 'csv: unterminated quoted field at end of input'); }
        // Final field/row unless the text ended exactly on a row boundary.
        if (field !== '' || row.length > 0) { pushRow(); }
    } finally {
        closeSync(fd);
    }
}
