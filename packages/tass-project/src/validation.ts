/**
 * The validation-record model (Modern Build Plan Section 3.5, `validation/`): human verdicts
 * and memos over match-level units, keyed by DETERMINISTIC content-derived IDs — a hash of
 * (document identity + category + term + occurrence index). Re-running identical inputs
 * re-derives identical IDs, so every verdict reattaches; changed inputs stop deriving the old
 * IDs, so those verdicts become VISIBLY orphaned ("from a previous run") — never silently lost.
 *
 * Document identity: the scored row's `id` column value when the scored CSV has an `id`
 * column, else the 0-based data-row index as a string. An explicit id column survives row
 * reordering and corpus growth; the index fallback is honest about being positional.
 *
 * The `validation/` member is reviewer-MUTABLE by design and therefore excluded from the
 * container's tamper hash (see container.ts); everything else stays integrity-checked.
 *
 * Determinism contract: no timestamps, no RNG, stable (codepoint) sorts, fixed JSON key
 * order. The review sample is a pure function of (scored CSV + lexicons + options).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
    TassError, parseCsv, analyze, kwic, compileLexicon, resolveLexicon, listBundled,
    safeName, METRICS, CompiledLexicon,
} from '@simdad/tass-core';
import { writeZip, readZip, ZipEntry } from './zip';

// ─────────────────────────────────────────────────────────────────────────────
// IDs and records
// ─────────────────────────────────────────────────────────────────────────────

export const VERDICTS = ['correct', 'incorrect', 'unsure'] as const;
export type Verdict = typeof VERDICTS[number];

export function isVerdict(s: string): s is Verdict {
    return (VERDICTS as readonly string[]).includes(s);
}

/** One human judgment about one match unit. No time fields — determinism. */
export interface ValidationRecord {
    /** validationId(docId, category, term, occurrence). */
    id: string;
    docId: string;
    /** Qualified category: `<lexiconId>:<categoryId>`. */
    category: string;
    /** The matched surface form (lower-cased word, or the phrase display form). */
    term: string;
    /** 0-based occurrence index of this term within the document (document order). */
    occurrence: number;
    verdict: Verdict;
    memo?: string;
    rater?: string;
}

/** The archive member holding the records. */
export const VALIDATION_MEMBER = 'validation/records.json';

/** True for archive entries that are reviewer-mutable (excluded from the tamper hash). */
export function isValidationMember(name: string): boolean {
    return name.startsWith('validation/');
}

/**
 * Stable content-derived ID: sha256 over the length-prefixed identity tuple, first 16 hex
 * chars (64 bits — ample for review-sheet scale, short enough to live in a spreadsheet cell).
 * Length-prefixing makes the encoding injective (no delimiter collisions).
 */
export function validationId(docId: string, category: string, term: string, occurrenceIndex: number): string {
    const parts = [docId, category, term, String(occurrenceIndex)];
    const canonical = parts.map(p => `${Buffer.byteLength(p, 'utf8')}:${p}`).join('|');
    return createHash('sha256').update('tassval1|' + canonical, 'utf8').digest('hex').slice(0, 16);
}

// ─────────────────────────────────────────────────────────────────────────────
// Read / write the validation/ member (zip rewrite preserving all other members)
// ─────────────────────────────────────────────────────────────────────────────

/** Fixed key order for serialization — same state, same bytes. */
function recordJson(r: ValidationRecord): Record<string, unknown> {
    const out: Record<string, unknown> = {
        id: r.id, docId: r.docId, category: r.category, term: r.term,
        occurrence: r.occurrence, verdict: r.verdict,
    };
    if (r.memo !== undefined) { out.memo = r.memo; }
    if (r.rater !== undefined) { out.rater = r.rater; }
    return out;
}

function checkRecord(r: ValidationRecord, where: string): void {
    if (typeof r.id !== 'string' || r.id === '') {
        throw TassError.usage('validation/bad-record', `${where}: record is missing its id`);
    }
    if (!isVerdict(r.verdict)) {
        throw TassError.usage('validation/bad-record',
            `${where}: verdict '${r.verdict}' is not one of ${VERDICTS.join(', ')}`);
    }
    if (!Number.isInteger(r.occurrence) || r.occurrence < 0) {
        throw TassError.usage('validation/bad-record', `${where}: occurrence must be a non-negative integer`);
    }
}

/** Read the validation records of a .tassproj ([] when none have been written yet). */
export function readValidation(projectPath: string): ValidationRecord[] {
    const entries = readZip(readFileSync(projectPath));
    const buf = entries.get(VALIDATION_MEMBER);
    if (!buf) { return []; }
    let parsed: unknown;
    try {
        parsed = JSON.parse(buf.toString('utf8'));
    } catch (e) {
        throw TassError.runtime('validation/corrupt',
            `${projectPath}: ${VALIDATION_MEMBER} is not valid JSON (${e instanceof Error ? e.message : e})`);
    }
    if (!Array.isArray(parsed)) {
        throw TassError.runtime('validation/corrupt', `${projectPath}: ${VALIDATION_MEMBER} must be a JSON array`);
    }
    return parsed as ValidationRecord[];
}

/**
 * Write records into the project's validation/ member, rewriting the archive with every
 * OTHER member byte-identical (the writer is deterministic STORE with fixed metadata, so
 * re-emitting the same entry bytes re-emits the same archive bytes). Entry order matches
 * saveProject: tassproj.json first, then all others sorted. tassproj.json is NOT touched —
 * validation/ is outside the tamper hash by design.
 */
export function writeValidation(projectPath: string, records: readonly ValidationRecord[]): void {
    const seen = new Set<string>();
    for (const r of records) {
        checkRecord(r, `record ${r.id ?? '(no id)'}`);
        if (seen.has(r.id)) {
            throw TassError.usage('validation/duplicate-id', `duplicate validation record id '${r.id}'`);
        }
        seen.add(r.id);
    }
    const sorted = [...records].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const json = Buffer.from(JSON.stringify(sorted.map(recordJson), null, 1) + '\n', 'utf8');

    const entries = readZip(readFileSync(projectPath));
    if (!entries.has('tassproj.json')) {
        throw TassError.runtime('project/corrupt', `${projectPath}: no tassproj.json — not a TASS project`);
    }
    entries.set(VALIDATION_MEMBER, json);
    const rest = [...entries.keys()].filter(n => n !== 'tassproj.json').sort();
    const zipEntries: ZipEntry[] = [
        { name: 'tassproj.json', data: entries.get('tassproj.json')! },
        ...rest.map(name => ({ name, data: entries.get(name)! })),
    ];
    writeFileSync(projectPath, writeZip(zipEntries));
}

// ─────────────────────────────────────────────────────────────────────────────
// Match units — the atoms a human validates
// ─────────────────────────────────────────────────────────────────────────────

/** One (document, category, term, occurrence) unit derivable from the current scored output. */
export interface MatchUnit {
    id: string;
    docId: string;
    /** Qualified `<lexiconId>:<categoryId>`. */
    category: string;
    term: string;
    occurrence: number;
    /** KWIC-style context around the occurrence (single line, whitespace collapsed). */
    excerpt: string;
    /** The category's metric value for this document (for ranking). 0 when blank. */
    metricValue: number;
    /** The metric cell exactly as the scored CSV holds it (byte-stable for output). */
    metricRaw: string;
}

export interface MatchUnitOptions {
    /** Scored-CSV column holding the document text (required — scoring passes it through). */
    textColumn: string;
    /** Lexicon specs (bundled ids and/or JSON paths); default: the full bundled set. */
    lexicons?: string[];
    /** Restrict to these categories — qualified `lex:cat` or bare category ids. */
    categories?: string[];
}

export interface SampleOptions extends MatchUnitOptions {
    /** Units to sample per category (default 10). */
    perCategory?: number;
}

/** Codepoint (locale-independent) string compare — determinism across hosts. */
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const EXCERPT_TOKEN_WINDOW = 7;   // matches the kwic default researchers already see
const EXCERPT_MAX_CHARS = 160;    // spreadsheet-cell friendly

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

function clip(s: string): string {
    return s.length <= EXCERPT_MAX_CHARS ? s : s.slice(0, EXCERPT_MAX_CHARS - 1) + '…';
}

/**
 * Derive every match unit from a scored CSV: for each document and each scored category,
 * the analyzer's matched forms expanded to per-occurrence units via the KWIC engine (term +
 * occurrence index + context). Multi-word phrase matches have no per-occurrence KWIC view,
 * so they fall back to occurrence index 0 per (doc, category, phrase) — one unit per
 * document, exactly the documented doc-level fallback.
 *
 * Categories are taken from the scored CSV itself: a (lexicon, category) participates only
 * if the CSV carries one of its metric columns (`<lex>_<cat>_<metric>`), so units always
 * correspond to the run being validated.
 */
export function deriveMatchUnits(scoredCsvPath: string, opts: MatchUnitOptions): MatchUnit[] {
    const rows = parseCsv(readFileSync(scoredCsvPath, 'utf8'));
    if (rows.length < 2) {
        throw TassError.usage('validation/empty-scored', `${scoredCsvPath}: needs a header row + at least one data row`);
    }
    const header = rows[0];
    const textIdx = header.indexOf(opts.textColumn);
    if (textIdx < 0) {
        throw TassError.usage('validation/text-column',
            `text column '${opts.textColumn}' not in ${scoredCsvPath} — columns: ${header.join(', ')}`,
            'TXT-mode scored CSVs carry no text; validation sampling needs a CSV corpus run');
    }
    const idIdx = header.indexOf('id');

    const lexSpecs = opts.lexicons ?? listBundled();
    const compiled: CompiledLexicon[] = lexSpecs.map(s => compileLexicon(resolveLexicon(s)));

    // Category plan: qualified name, analyzer index, and the metric column backing it.
    interface CatPlan { lexIdx: number; catIdx: number; category: string; metricIdx: number }
    const wanted = opts.categories;
    const plans: CatPlan[] = [];
    compiled.forEach((cl, li) => {
        cl.lexicon.categories.forEach((cat, ci) => {
            const qualified = `${cl.lexicon.id}:${cat.id}`;
            if (wanted && !wanted.includes(qualified) && !wanted.includes(cat.id)) { return; }
            for (const m of METRICS) {
                const col = header.indexOf(`${safeName(cl.lexicon.id)}_${safeName(cat.id)}_${m}`);
                if (col >= 0) { plans.push({ lexIdx: li, catIdx: ci, category: qualified, metricIdx: col }); return; }
            }
        });
    });
    if (plans.length === 0) {
        throw TassError.usage('validation/no-categories',
            `${scoredCsvPath}: no scored category columns match the given lexicons/categories`,
            'pass the same --lexicons the score run used (and check --categories spelling)');
    }

    const units: MatchUnit[] = [];
    for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        const text = row[textIdx] ?? '';
        const docId = idIdx >= 0 ? (row[idIdx] ?? '') : String(r - 1);
        const results = compiled.map(cl => analyze(text, cl));
        for (const plan of plans) {
            const cat = results[plan.lexIdx].categories[plan.catIdx];
            const metricRaw = row[plan.metricIdx] ?? '';
            const n = Number(metricRaw);
            const metricValue = metricRaw !== '' && Number.isFinite(n) ? n : 0;
            for (const form of cat.matchedForms) {
                const lines = form.includes(' ') ? [] : kwic(text, form, { window: EXCERPT_TOKEN_WINDOW });
                if (lines.length === 0) {
                    // Doc-level fallback (phrases, or forms kwic cannot re-find): occurrence 0.
                    const at = text.toLowerCase().indexOf(form);
                    const excerpt = at < 0 ? clip(collapse(text))
                        : clip(collapse(`${text.slice(Math.max(0, at - 60), at)}[${text.slice(at, at + form.length)}]${text.slice(at + form.length, at + form.length + 60)}`));
                    units.push({
                        id: validationId(docId, plan.category, form, 0),
                        docId, category: plan.category, term: form, occurrence: 0,
                        excerpt, metricValue, metricRaw,
                    });
                    continue;
                }
                lines.forEach((line, occ) => {
                    units.push({
                        id: validationId(docId, plan.category, form, occ),
                        docId, category: plan.category, term: form, occurrence: occ,
                        excerpt: clip(collapse(`${line.left} [${line.keyword}] ${line.right}`)),
                        metricValue, metricRaw,
                    });
                });
            }
        }
    }
    return units;
}

/** Within-category ranking: metric desc, then docId, term, occurrence (all codepoint order). */
function unitCompare(a: MatchUnit, b: MatchUnit): number {
    return (b.metricValue - a.metricValue)
        || cmp(a.docId, b.docId) || cmp(a.term, b.term) || (a.occurrence - b.occurrence);
}

/**
 * The deterministic review sample: per category, the top ceil(k/2) units by metric value
 * (the high-scoring matches most worth checking) plus an evenly-strided spread of floor(k/2)
 * over the remainder (coverage of the middle and tail). Stride index i of n picks
 * floor(i * (m-1) / (n-1)) into the m remaining units — no RNG anywhere; two runs over the
 * same inputs are byte-identical. Categories with k or fewer units are taken whole.
 */
export function sampleForValidation(scoredCsvPath: string, opts: SampleOptions): MatchUnit[] {
    const k = opts.perCategory ?? 10;
    if (!Number.isInteger(k) || k < 1) {
        throw TassError.usage('validation/bad-sample-size', 'perCategory must be a positive integer');
    }
    const byCategory = new Map<string, MatchUnit[]>();
    for (const u of deriveMatchUnits(scoredCsvPath, opts)) {
        byCategory.set(u.category, [...(byCategory.get(u.category) ?? []), u]);
    }
    const out: MatchUnit[] = [];
    for (const category of [...byCategory.keys()].sort(cmp)) {
        const units = byCategory.get(category)!.sort(unitCompare);
        if (units.length <= k) { out.push(...units); continue; }
        const topK = Math.ceil(k / 2);
        const need = k - topK;
        const picked = units.slice(0, topK);
        const rest = units.slice(topK);
        for (let i = 0; i < need; i++) {
            const idx = need === 1
                ? Math.floor((rest.length - 1) / 2)
                : Math.floor((i * (rest.length - 1)) / (need - 1));
            picked.push(rest[idx]);
        }
        out.push(...picked.sort(unitCompare));
    }
    return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Orphan detection — verdicts whose id no longer derives from the current output
// ─────────────────────────────────────────────────────────────────────────────

export interface ValidationPartition {
    /** Records whose id derives from the current scored output. */
    attached: ValidationRecord[];
    /** Records from a previous run: the current output no longer derives their id. */
    orphaned: ValidationRecord[];
}

/** Partition records against the current scored output's derivable unit ids. */
export function partitionValidation(
    records: readonly ValidationRecord[],
    currentUnits: readonly Pick<MatchUnit, 'id'>[],
): ValidationPartition {
    const live = new Set(currentUnits.map(u => u.id));
    const attached: ValidationRecord[] = [];
    const orphaned: ValidationRecord[] = [];
    for (const r of records) { (live.has(r.id) ? attached : orphaned).push(r); }
    return { attached, orphaned };
}
