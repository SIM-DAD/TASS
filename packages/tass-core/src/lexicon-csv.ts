/**
 * Spreadsheet dictionary authoring (Modern Build Plan Section 8.3, the Constraint-8 path):
 * researchers author dictionaries in Excel/Sheets, save as CSV, and TASS converts to the
 * internal lexicon JSON with validation errors a non-programmer can act on (row-numbered,
 * ALL collected before failing, never just the first).
 *
 * Schema (UTF-8 CSV, comma or semicolon delimited, header required):
 *   category, term, weight (optional numeric), category_label (optional)
 * One row per term. Terms follow the engine rules: literal word, `stem*` wildcard, or a
 * multi-word phrase whose FINAL word may carry the wildcard.
 *
 * Dictionary-level metadata comes from an optional leading block of comment lines
 * (`#key: value`, ignored by Excel formulas and by this parser's CSV stage):
 *   #id, #name, #license, #citation, #language, #description
 * CLI flags / GUI fields override the file's block. License + citation are required before a
 * dictionary can be PUBLISHED to the registry (local private use may omit them; the run
 * manifest then records license 'unspecified').
 */
import { parseCsv } from './csv';
import { Lexicon, LexiconCategory, LexiconTerm } from './index';
import { TassError } from './errors';

export interface LexiconCsvMeta {
    id?: string;
    name?: string;
    license?: string;
    citation?: string;
    language?: string;
    description?: string;
}

export interface LexiconCsvResult {
    lexicon: Lexicon;
    /** Non-fatal issues (duplicates deduplicated, mixed weighting) — surface, don't hide. */
    warnings: string[];
}

const META_KEYS = new Set(['id', 'name', 'license', 'citation', 'language', 'description']);
const COLUMNS = new Set(['category', 'term', 'weight', 'category_label']);

/**
 * Parse a spreadsheet-authored dictionary CSV. `overrides` (CLI flags / GUI fields) win over
 * the file's `#key: value` metadata block. Throws ONE TassError carrying every validation
 * error found (usage kind, code 'lexicon-csv/invalid'), so the author fixes the sheet once.
 */
export function parseLexiconCsv(content: string, overrides: LexiconCsvMeta = {}): LexiconCsvResult {
    // Strip a UTF-8 BOM before looking at comment lines (parseCsv would strip it later anyway).
    if (content.charCodeAt(0) === 0xfeff) { content = content.slice(1); }

    // Metadata block: leading lines starting with '#'. `#key: value` feeds meta; other
    // '#' lines are plain comments. The block ends at the first non-'#' line.
    const meta: LexiconCsvMeta = {};
    const lines = content.split(/\r?\n/);
    let body = 0;
    // Track the 1-based line number where the CSV body starts (for row-numbered errors).
    while (body < lines.length) {
        const line = lines[body].trim();
        if (line === '' || line.startsWith('#')) {
            const m = /^#\s*([A-Za-z_]+)\s*:\s*(.+)$/.exec(line);
            if (m && META_KEYS.has(m[1].toLowerCase())) {
                (meta as Record<string, string>)[m[1].toLowerCase()] = m[2].trim();
            }
            body++;
            continue;
        }
        break;
    }
    const csvText = lines.slice(body).join('\n');
    const lineOf = (csvRow: number) => body + csvRow + 1; // 1-based file line of a parsed row

    // Delimiter sniffing: semicolon spreadsheets exist (EU Excel). Decide from the header.
    const headerLine = lines[body] ?? '';
    const useSemicolon = !headerLine.includes(',') && headerLine.includes(';');
    const rows = parseCsv(useSemicolon ? csvText.replace(/;/g, ',') : csvText);
    const errors: string[] = [];
    const warnings: string[] = [];
    if (useSemicolon) { warnings.push('semicolon-delimited CSV detected (parsed with ; as the separator)'); }

    if (rows.length === 0) {
        throw TassError.usage('lexicon-csv/empty', 'dictionary CSV has no header row; expected columns: category, term[, weight, category_label]');
    }
    const header = rows[0].map(h => h.trim().toLowerCase());
    const idx = (name: string) => header.indexOf(name);
    if (idx('category') < 0 || idx('term') < 0) {
        errors.push(`line ${lineOf(0)}: header must include 'category' and 'term' (found: ${header.join(', ') || '(none)'})`);
    }
    for (const h of header) {
        if (h !== '' && !COLUMNS.has(h)) {
            errors.push(`line ${lineOf(0)}: unknown column '${h}'; valid: category, term, weight, category_label`);
        }
    }
    if (errors.length) {
        throw TassError.usage('lexicon-csv/invalid', `dictionary CSV is invalid:\n  ${errors.join('\n  ')}`);
    }

    const catIdx = idx('category'), termIdx = idx('term'), weightIdx = idx('weight'), labelIdx = idx('category_label');
    const categories = new Map<string, { label?: string; terms: LexiconTerm[]; seen: Set<string>; weighted: number; unweighted: number }>();

    for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        if (row.every(c => c.trim() === '')) { continue; } // blank spreadsheet row
        const line = lineOf(r);
        const category = (row[catIdx] ?? '').trim();
        const term = (row[termIdx] ?? '').trim().toLowerCase();
        if (!category) { errors.push(`line ${line}: empty category`); continue; }
        if (!term) { errors.push(`line ${line}: empty term`); continue; }

        // Wildcard rules: '*' only as the final character of the final word.
        const words = term.split(/\s+/);
        words.forEach((w, wi) => {
            const star = w.indexOf('*');
            if (star < 0) { return; }
            if (wi < words.length - 1) {
                errors.push(`line ${line}: '${term}': only the FINAL word of a phrase may carry the * wildcard`);
            } else if (star !== w.length - 1 || w.length === 1) {
                errors.push(`line ${line}: '${term}': * is only valid as a trailing stem wildcard (like happi*)`);
            }
        });

        let weight: number | undefined;
        const weightCell = weightIdx < 0 ? '' : (row[weightIdx] ?? '').trim();
        if (weightCell !== '') {
            weight = Number(weightCell);
            if (!Number.isFinite(weight)) {
                errors.push(`line ${line}: weight '${weightCell}' is not a number (leave blank for unweighted)`);
                continue;
            }
        }

        let cat = categories.get(category);
        if (!cat) {
            cat = { terms: [], seen: new Set(), weighted: 0, unweighted: 0 };
            categories.set(category, cat);
        }
        const label = labelIdx < 0 ? '' : (row[labelIdx] ?? '').trim();
        if (label && !cat.label) { cat.label = label; }
        if (cat.seen.has(term)) {
            warnings.push(`line ${line}: duplicate term '${term}' in category '${category}'; kept the first occurrence`);
            continue;
        }
        cat.seen.add(term);
        cat.terms.push(weight === undefined ? { term } : { term, weight });
        if (weight === undefined) { cat.unweighted++; } else { cat.weighted++; }
    }

    if (categories.size === 0 && errors.length === 0) {
        errors.push('no term rows found below the header');
    }
    if (errors.length) {
        throw TassError.usage('lexicon-csv/invalid', `dictionary CSV is invalid:\n  ${errors.join('\n  ')}`);
    }
    for (const [id, cat] of categories) {
        if (cat.weighted > 0 && cat.unweighted > 0) {
            warnings.push(`category '${id}' mixes weighted (${cat.weighted}) and unweighted (${cat.unweighted}) terms; unweighted terms count as weight 1, which skews weighted/mean metrics`);
        }
    }

    const merged: Required<Pick<LexiconCsvMeta, 'id' | 'name'>> & LexiconCsvMeta = {
        ...meta, ...definedOnly(overrides),
        id: overrides.id ?? meta.id ?? 'authored-dictionary',
        name: overrides.name ?? meta.name ?? 'Authored dictionary',
    };
    const cats: LexiconCategory[] = [...categories.entries()]
        .map(([id, c]) => ({ id, label: c.label, terms: c.terms }));
    const lexicon: Lexicon = {
        id: merged.id,
        name: merged.name,
        license: merged.license,
        citation: merged.citation,
        categories: cats,
    };
    if (!merged.license || !merged.citation) {
        warnings.push('license and/or citation metadata missing: fine for private use; REQUIRED before publishing to the registry (runs will record license as unspecified)');
    }
    return { lexicon, warnings };
}

function definedOnly<T extends object>(o: T): Partial<T> {
    return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** The downloadable authoring template (also shipped at the registry and on the site). */
export const LEXICON_CSV_TEMPLATE = `# TASS dictionary template: fill in Excel/Google Sheets, save as CSV, then:
#   tass import-csv -i my-dictionary.csv -o my-dictionary.json
# Metadata (edit the values; lines starting with # are ignored by the spreadsheet):
#id: my-dictionary
#name: My Dictionary
#license: CC-BY-4.0
#citation: Your Name (2026). My Dictionary v1. https://doi.org/...
#language: en
#description: What this dictionary measures, in one sentence.
category,term,weight,category_label
positive,happy,,Positive emotion
positive,joy*,,Positive emotion
positive,thank you,,Positive emotion
negative,sad,,Negative emotion
negative,terribl*,,Negative emotion
intensity,love,3,Weighted example (leave weight blank for plain counting)
intensity,like,1,Weighted example (leave weight blank for plain counting)
`;
