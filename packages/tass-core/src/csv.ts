/**
 * Minimal RFC-4180 CSV reader/writer for the TASS engine (moved from the CLI in the R1
 * refactor — it is engine-grade IO, and every surface parses corpora through it). Handles
 * quoted fields with embedded commas/quotes/newlines, CRLF and LF, an optional UTF-8 BOM, and
 * a trailing newline. NOT a streaming parser — the M3 streaming score path reads through the
 * incremental reader in csv-stream.ts; this stays the whole-file reference implementation,
 * and the two must keep identical semantics (the M3 parity test enforces it).
 */
import { TassError } from './errors';

/** Parse CSV text into rows of string fields. Throws on structurally broken quoting. */
export function parseCsv(text: string): string[][] {
    // Strip a UTF-8 BOM so the first header cell never carries it into column names.
    if (text.charCodeAt(0) === 0xfeff) { text = text.slice(1); }

    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let inQuotes = false;
    let i = 0;

    const pushField = () => { row.push(field); field = ''; };
    const pushRow = () => { pushField(); rows.push(row); row = []; };

    while (i < text.length) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') { field += '"'; i += 2; continue; } // escaped quote
                inQuotes = false; i++; continue;
            }
            field += ch; i++; continue;
        }
        if (ch === '"') {
            if (field !== '') { throw TassError.runtime('csv/quote-mid-field', `csv: unexpected quote mid-field at offset ${i}`); }
            inQuotes = true; i++; continue;
        }
        if (ch === ',') { pushField(); i++; continue; }
        if (ch === '\r') { if (text[i + 1] === '\n') { i++; } pushRow(); i++; continue; }
        if (ch === '\n') { pushRow(); i++; continue; }
        field += ch; i++;
    }
    if (inQuotes) { throw TassError.runtime('csv/unterminated-quote', 'csv: unterminated quoted field at end of input'); }
    // Final field/row unless the text ended exactly on a row boundary.
    if (field !== '' || row.length > 0) { pushRow(); }
    return rows;
}

/** Quote a field only when it needs it (comma, quote, newline, or leading/trailing space). */
function encodeField(value: string): string {
    if (/[",\r\n]/.test(value) || value !== value.trim()) {
        return '"' + value.replace(/"/g, '""') + '"';
    }
    return value;
}

/** Serialize rows to CSV text (LF line endings, trailing newline — R/pandas friendly). */
export function stringifyCsv(rows: ReadonlyArray<ReadonlyArray<string>>): string {
    return rows.map(r => r.map(encodeField).join(',')).join('\n') + '\n';
}
