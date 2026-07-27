/**
 * @simdad/tass-core — the TASS text-analytics engine (S4 flagship; brief:
 * meta/sprint/tass-s4-brief.md). Pure, deterministic, dependency-free — same input ⇒ byte-identical
 * output, so results are reproducible across machines (a research-buyer requirement).
 *
 * Three pieces in this first slice:
 *  - LEXICON MODEL + COUNTING — LIWC-style category counting: a lexicon maps categories to terms,
 *    a term is a literal word or a `stem*` wildcard (the .dic convention), optionally weighted.
 *    {@link analyze} tokenizes and produces per-category counts + hit lists + a percent-of-words
 *    normalization (the number researchers actually report).
 *  - .DIC IMPORTER — {@link parseDic} reads the LIWC-format dictionary file (a FILE-FORMAT reader:
 *    users import dictionaries THEY licensed; TASS never bundles LIWC/NRC/GI — see the research
 *    landmine list). Round-trips the `%`-delimited header + category-id body.
 *  - KWIC — {@link kwic}: keyword-in-context concordance lines with configurable window, the
 *    corpus-linguistics table-stakes feature LIWC lacks.
 *
 * Tokenization here is the deterministic Unicode-word baseline every layer shares; the GUI may
 * later swap a wink-nlp-backed tokenizer through the same seam (pluggable, like wordlist-core's
 * NER backend), but counts must stay reproducible for a fixed tokenizer choice.
 */

/**
 * One lexicon entry: a literal word ("happy"), a stem wildcard ("happi*"), or — since 0.4 —
 * a PHRASE of space-separated words ("thank you", "sort of", "would you mind*"; only the last
 * word may carry the stem wildcard). A phrase hit counts as ONE hit. Optional weight.
 */
export interface LexiconTerm {
    term: string;
    /** Weight applied per hit (default 1 — plain counting). Weighted lexicons: VADER/labMT-style. */
    weight?: number;
}

/** A category (e.g. "posemo") → its terms. */
export interface LexiconCategory {
    id: string;
    /** Human label (e.g. "Positive emotion"). Defaults to the id. */
    label?: string;
    terms: LexiconTerm[];
}

/** A lexicon: named, cited (attribution surfaces in-app — every bundled lexicon carries one). */
export interface Lexicon {
    id: string;
    name: string;
    /** REQUIRED for anything bundled: the citation shown in the app + exports. */
    citation?: string;
    /** SPDX-ish license tag for the lexicon DATA (e.g. "MIT", "CC-BY-4.0"). */
    license?: string;
    /**
     * Redistribution class: 'commercial-ok' (verified shippable) or 'academic-only'
     * (user-imported restricted resources, e.g. NRC — never bundled, flagged in every run's
     * provenance so a commercial-compliance audit can tell the two apart mechanically).
     */
    licenseClass?: 'commercial-ok' | 'academic-only';
    categories: LexiconCategory[];
}

/** One token with its character offsets (offsets feed KWIC + future span views). */
export interface Token {
    text: string;
    start: number;
    end: number;
}

/**
 * Deterministic Unicode word tokenizer: letters/digits/apostrophes-inside-words. The baseline
 * every count shares; intentionally simple and locked (reproducibility beats cleverness here).
 */
export function tokenize(text: string): Token[] {
    const out: Token[] = [];
    // A word = letters/digits, allowing internal apostrophes (don't, l'homme). Unicode-aware.
    const re = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;
    for (const m of text.matchAll(re)) {
        out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
    }
    return out;
}

/** A compiled phrase: word sequence, last word optionally a stem. */
interface CompiledPhrase {
    words: string[];              // lower-cased; if lastIsStem, the final entry is the stem (no *)
    lastIsStem: boolean;
    weight: number;
    display: string;              // the original lower-cased phrase for matchedForms
}

/** Compiled matcher for one category: exact set + sorted stem list + sorted phrase list. */
interface CompiledCategory {
    id: string;
    exact: Map<string, number>;   // lower-cased literal -> weight
    stems: Array<{ stem: string; weight: number }>; // lower-cased, longest-first
    phrases: CompiledPhrase[];    // longest-first (by word count, then text) — greedy match
}

/** Compile a lexicon once; reuse across documents (pure data, no state). */
export function compileLexicon(lex: Lexicon): CompiledLexicon {
    const cats: CompiledCategory[] = lex.categories.map(c => {
        const exact = new Map<string, number>();
        const stems: Array<{ stem: string; weight: number }> = [];
        const phrases: CompiledPhrase[] = [];
        for (const t of c.terms) {
            const w = t.weight ?? 1;
            const term = t.term.toLowerCase().trim();
            if (term.includes(' ')) {
                const words = term.split(/\s+/);
                const lastIsStem = words[words.length - 1].endsWith('*');
                if (lastIsStem) {
                    const stem = words[words.length - 1].slice(0, -1);
                    if (stem.length === 0) { continue; } // "thank *" is malformed — skip
                    words[words.length - 1] = stem;
                }
                phrases.push({ words, lastIsStem, weight: w, display: term });
                continue;
            }
            if (term.endsWith('*')) {
                const stem = term.slice(0, -1);
                if (stem.length > 0) { stems.push({ stem, weight: w }); }
            } else if (term.length > 0) {
                exact.set(term, w);
            }
        }
        stems.sort((a, b) => b.stem.length - a.stem.length || a.stem.localeCompare(b.stem));
        phrases.sort((a, b) => b.words.length - a.words.length || a.display.localeCompare(b.display));
        return { id: c.id, exact, stems, phrases };
    });
    return { lexicon: lex, categories: cats };
}

export interface CompiledLexicon {
    lexicon: Lexicon;
    categories: CompiledCategory[];
}

/** Per-category result: raw hit count, weighted sum, % of document tokens, and the hit tokens. */
export interface CategoryResult {
    id: string;
    hits: number;
    weighted: number;
    /** hits / totalTokens * 100 — the LIWC-style normalization researchers report. 0 when empty. */
    percent: number;
    /** Distinct matched word forms (lower-cased), insertion-ordered — the "which words fired" view. */
    matchedForms: string[];
}

export interface AnalyzeResult {
    totalTokens: number;
    categories: CategoryResult[];
}

/**
 * Count one document against a compiled lexicon. A token can hit MULTIPLE categories (LIWC
 * semantics: "cried" is sad AND negemo) but within one category counts once per token occurrence.
 * Longest-stem-wins within a category is irrelevant for counting (any match counts), but exact
 * beats stem for WEIGHT when both match.
 *
 * Phrases (multi-word terms) match first within their category, greedily and longest-first,
 * non-overlapping; tokens consumed by a phrase are excluded from that category's single-token
 * pass (so "thank you" never double-counts against "thank*" in the SAME category). A phrase
 * hit counts as ONE hit; percent stays hits/totalTokens.
 */
export function analyze(text: string, compiled: CompiledLexicon): AnalyzeResult {
    const tokens = tokenize(text);
    const words = tokens.map(t => t.text.toLowerCase());
    const results: CategoryResult[] = compiled.categories.map(c => ({
        id: c.id, hits: 0, weighted: 0, percent: 0, matchedForms: [],
    }));
    const seenForms: Array<Set<string>> = compiled.categories.map(() => new Set());
    // Per category: token indexes consumed by a phrase match (skipped in the single-token pass).
    const consumed: Array<Set<number> | undefined> = compiled.categories.map(() => undefined);

    const addForm = (i: number, form: string) => {
        if (!seenForms[i].has(form)) {
            seenForms[i].add(form);
            results[i].matchedForms.push(form);
        }
    };

    // Phrase pass (rare — most categories have none).
    compiled.categories.forEach((cat, i) => {
        if (cat.phrases.length === 0) { return; }
        const taken = new Set<number>();
        for (let pos = 0; pos < words.length; pos++) {
            if (taken.has(pos)) { continue; }
            for (const p of cat.phrases) {
                const n = p.words.length;
                if (pos + n > words.length) { continue; }
                let ok = true;
                for (let k = 0; k < n; k++) {
                    if (taken.has(pos + k)) { ok = false; break; }
                    const w = words[pos + k];
                    const want = p.words[k];
                    const isLastStem = p.lastIsStem && k === n - 1;
                    if (isLastStem ? !w.startsWith(want) : w !== want) { ok = false; break; }
                }
                if (!ok) { continue; }
                results[i].hits++;
                results[i].weighted += p.weight;
                addForm(i, p.display);
                for (let k = 0; k < n; k++) { taken.add(pos + k); }
                pos += n - 1; // continue after the phrase
                break;        // longest-first: first match wins at this position
            }
        }
        if (taken.size > 0) { consumed[i] = taken; }
    });

    // Single-token pass.
    words.forEach((word, ti) => {
        compiled.categories.forEach((cat, i) => {
            if (consumed[i]?.has(ti)) { return; }
            let weight: number | undefined = cat.exact.get(word);
            if (weight === undefined) {
                const stem = cat.stems.find(s => word.startsWith(s.stem));
                if (stem) { weight = stem.weight; }
            }
            if (weight !== undefined) {
                results[i].hits++;
                results[i].weighted += weight;
                addForm(i, word);
            }
        });
    });

    const total = tokens.length;
    for (const r of results) {
        r.percent = total === 0 ? 0 : (r.hits / total) * 100;
    }
    return { totalTokens: total, categories: results };
}

// ─────────────────────────────────────────────────────────────────────────────
// LIWC-format .dic importer (file-format reader; the user supplies the licensed file)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse the LIWC .dic format:
 *
 *     %
 *     1   posemo
 *     2   negemo
 *     %
 *     happy    1
 *     happi*   1
 *     cried    2
 *
 * Header between the two `%` lines maps numeric ids → category names; body lines are
 * `term  id [id …]`. Returns a {@link Lexicon} (unweighted — .dic is membership-based).
 * Malformed ids/lines are SKIPPED, and the skip count is reported (never silently lost).
 */
export function parseDic(content: string, id = 'imported-dic', name = 'Imported dictionary'):
    { lexicon: Lexicon; skippedLines: number } {
    const lines = content.split(/\r?\n/);
    const catNames = new Map<string, string>();
    const catTerms = new Map<string, LexiconTerm[]>();
    let skipped = 0;

    let section: 'pre' | 'header' | 'body' = 'pre';
    for (const raw of lines) {
        const line = raw.trim();
        if (line === '') { continue; }
        if (line === '%') {
            section = section === 'pre' ? 'header' : 'body';
            continue;
        }
        if (section === 'pre') {
            // Content before the first % is not valid .dic — treat the file as body-only legacy?
            // No: count it skipped (fail visibly in the return, not silently).
            skipped++;
            continue;
        }
        const parts = line.split(/\s+/);
        if (section === 'header') {
            if (parts.length < 2) { skipped++; continue; }
            const [num, ...nameParts] = parts;
            if (!/^\d+$/.test(num)) { skipped++; continue; }
            catNames.set(num, nameParts.join(' '));
        } else {
            const [term, ...ids] = parts;
            if (!term || ids.length === 0) { skipped++; continue; }
            let anyValid = false;
            for (const cid of ids) {
                if (!catNames.has(cid)) { continue; } // unknown id — skip just that assignment
                anyValid = true;
                const list = catTerms.get(cid) ?? [];
                list.push({ term });
                catTerms.set(cid, list);
            }
            if (!anyValid) { skipped++; }
        }
    }

    const categories: LexiconCategory[] = [...catNames.entries()].map(([num, label]) => ({
        id: label, label, terms: catTerms.get(num) ?? [],
    }));
    return { lexicon: { id, name, categories }, skippedLines: skipped };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bundled-lexicon loading (data/lexicons/*.json, built by scripts/build-lexicons.mjs)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate parsed lexicon JSON into a {@link Lexicon}. Bundled data MUST carry `license` +
 * `citation` (the attribution manifest rule — every shipped dictionary is citable in-app);
 * user-imported lexicons may omit them (pass `bundled: false`). Throws with a precise message
 * on malformed shape — a broken dictionary must never silently count as "no hits".
 */
export function loadLexicon(json: unknown, opts: { bundled?: boolean } = {}): Lexicon {
    const bundled = opts.bundled ?? true;
    if (typeof json !== 'object' || json === null) { throw new Error('lexicon: not an object'); }
    const o = json as Record<string, unknown>;
    if (typeof o.id !== 'string' || !o.id) { throw new Error('lexicon: missing id'); }
    if (typeof o.name !== 'string' || !o.name) { throw new Error(`lexicon ${o.id}: missing name`); }
    if (bundled && (typeof o.license !== 'string' || !o.license)) {
        throw new Error(`lexicon ${o.id}: bundled lexicons must declare license`);
    }
    if (bundled && (typeof o.citation !== 'string' || !o.citation)) {
        throw new Error(`lexicon ${o.id}: bundled lexicons must declare citation`);
    }
    if (!Array.isArray(o.categories) || o.categories.length === 0) {
        throw new Error(`lexicon ${o.id}: no categories`);
    }
    const categories: LexiconCategory[] = o.categories.map((c, i) => {
        const cat = c as Record<string, unknown>;
        if (typeof cat.id !== 'string' || !cat.id) { throw new Error(`lexicon ${o.id}: category[${i}] missing id`); }
        if (!Array.isArray(cat.terms)) { throw new Error(`lexicon ${o.id}: category ${cat.id} missing terms`); }
        const terms: LexiconTerm[] = cat.terms.map((t, j) => {
            const term = t as Record<string, unknown>;
            if (typeof term.term !== 'string' || !term.term) {
                throw new Error(`lexicon ${o.id}: ${cat.id}.terms[${j}] missing term`);
            }
            if (term.weight !== undefined && typeof term.weight !== 'number') {
                throw new Error(`lexicon ${o.id}: ${cat.id}.${term.term} weight not a number`);
            }
            return { term: term.term, weight: term.weight as number | undefined };
        });
        return { id: cat.id, label: typeof cat.label === 'string' ? cat.label : undefined, terms };
    });
    let licenseClass: Lexicon['licenseClass'];
    if (o.licenseClass !== undefined) {
        if (o.licenseClass !== 'commercial-ok' && o.licenseClass !== 'academic-only') {
            throw new Error(`lexicon ${o.id}: licenseClass must be 'commercial-ok' or 'academic-only'`);
        }
        licenseClass = o.licenseClass;
    }
    return {
        id: o.id, name: o.name,
        license: typeof o.license === 'string' ? o.license : undefined,
        citation: typeof o.citation === 'string' ? o.citation : undefined,
        licenseClass,
        categories,
    };
}

// The bundled set is discovered at runtime from data/lexicons/ — see bundled.ts (single
// source of truth; the old hand-kept BUNDLED_LEXICONS constant was removed in the R2 refactor).

// ─────────────────────────────────────────────────────────────────────────────
// KWIC concordance
// ─────────────────────────────────────────────────────────────────────────────

/** One concordance line: the keyword occurrence with its left/right context strings. */
export interface KwicLine {
    /** The matched token exactly as it appears in the source. */
    keyword: string;
    left: string;
    right: string;
    /** Character offset of the keyword in the source text (for click-through). */
    start: number;
    end: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API barrel (docs/API.md is the semver contract for everything exported here)
// ─────────────────────────────────────────────────────────────────────────────

export { TassError } from './errors';
export type { TassErrorKind } from './errors';
export { parseCsv, stringifyCsv } from './csv';
export { streamCsvRows } from './csv-stream';
export { parseTranscript, parseChatLog } from './transcript';
export type { Turn } from './transcript';
export { loadCorpus, splitCorpusInputs, streamCsvCorpus } from './corpus';
export type { Corpus, CorpusRow } from './corpus';
export { bundledDir, listBundled, loadBundled, resolveLexicon, userLexiconDir, listInstalled } from './bundled';
export { METRICS, isMetric, metricValue, safeName, fmt, secondsToStamp, Acc } from './metrics';
export type { Metric } from './metrics';
export { parseLexiconCsv, LEXICON_CSV_TEMPLATE } from './lexicon-csv';
export type { LexiconCsvMeta, LexiconCsvResult } from './lexicon-csv';
export { prepareCorpus, parseFilterSpec } from './prepare';
export type { PrepareFilter, PrepareOptions, PrepareDrop, PrepareDropOp, PrepareReport } from './prepare';
export { MANIFEST_VERSION, sha256File, buildScoreManifest } from './manifest';
export type { ScoreManifestArgs } from './manifest';
export { ENGINE_VERSION, packageVersion } from './version';
export { vaderRuleScore, valenceMap } from './vader';
export type { VaderScores } from './vader';

export interface KwicOptions {
    /** Context window in TOKENS on each side (default 7 — the corpus-tool convention). */
    window?: number;
    /** Case-insensitive keyword matching (default true). */
    caseInsensitive?: boolean;
    /** Treat a trailing `*` on the query as a stem wildcard (default true — matches the lexicon). */
    allowWildcard?: boolean;
}

/**
 * Keyword-in-context lines for `query` over `text`. Deterministic, document order. Context is
 * reconstructed from the ORIGINAL text between token boundaries, so spacing/punctuation inside
 * the window is preserved exactly (what a corpus linguist expects to read).
 */
export function kwic(text: string, query: string, options: KwicOptions = {}): KwicLine[] {
    const window = options.window ?? 7;
    const ci = options.caseInsensitive ?? true;
    const wildcard = (options.allowWildcard ?? true) && query.endsWith('*');
    const q = ci ? query.toLowerCase() : query;
    const stem = wildcard ? q.slice(0, -1) : '';

    const tokens = tokenize(text);
    const out: KwicLine[] = [];
    tokens.forEach((tok, i) => {
        const w = ci ? tok.text.toLowerCase() : tok.text;
        const hit = wildcard ? (stem.length > 0 && w.startsWith(stem)) : w === q;
        if (!hit) { return; }
        const leftStart = tokens[Math.max(0, i - window)].start;
        const rightEnd = tokens[Math.min(tokens.length - 1, i + window)].end;
        out.push({
            keyword: tok.text,
            left: text.slice(leftStart, tok.start),
            right: text.slice(tok.end, rightEnd),
            start: tok.start,
            end: tok.end,
        });
    });
    return out;
}
