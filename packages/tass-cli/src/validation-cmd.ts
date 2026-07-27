/**
 * `tass validation` — the human-validation loop over a .tassproj (Modern Build Plan
 * Sections 3.5 / P1 validation workspace, CLI slice):
 *
 *   sample   deterministic review sheet (a human fills verdict/memo in a spreadsheet)
 *   import   filled sheet -> validation/ records inside the project (all row errors at once)
 *   export   records + attached/orphaned status (orphans are "from a previous run", VISIBLY)
 *   summary  per-category verdict counts + precision proxy as JSON
 *
 * Verdicts are keyed by content-derived IDs (tass-project validation.ts), so identical
 * re-runs reattach every verdict and changed inputs orphan them loudly, never silently.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { TassError, parseCsv, stringifyCsv } from '@simdad/tass-core';
import {
    loadProject, Project, validationId, isVerdict, VERDICTS,
    readValidation, writeValidation, deriveMatchUnits, sampleForValidation, partitionValidation,
    ValidationRecord, MatchUnitOptions,
} from '@simdad/tass-project';
import { Io } from './cli';

const BOOLEANS = new Set<string>();
const ALIASES: Record<string, string> = { '-i': '--input', '-o': '--output' };

function parseFlags(argv: string[]): Map<string, string> {
    const flags = new Map<string, string>();
    for (let i = 0; i < argv.length; i++) {
        let a = argv[i];
        if (!a.startsWith('-')) { throw TassError.usage('validation/bad-arg', `unexpected argument '${a}'`); }
        a = ALIASES[a] ?? a;
        if (BOOLEANS.has(a)) { flags.set(a, 'true'); continue; }
        const v = argv[++i];
        if (v === undefined) { throw TassError.usage('validation/flag-needs-value', `${a} needs a value`); }
        flags.set(a, v);
    }
    return flags;
}

function need(flags: Map<string, string>, flag: string, what: string): string {
    const v = flags.get(flag);
    if (!v) { throw TassError.usage('validation/missing-flag', `validation ${what} needs ${flag}`); }
    return v;
}

const list = (v: string | undefined) => v?.split(',').map(s => s.trim()).filter(Boolean);

// ─────────────────────────────────────────────────────────────────────────────
// Project plumbing: scored CSV + match-unit options out of a .tassproj
// ─────────────────────────────────────────────────────────────────────────────

interface ScoredContext { scoredCsvPath: string; opts: MatchUnitOptions }

/**
 * Extract the project's primary scored CSV to a temp file and rebuild the match-unit options
 * from the saved config: text column from settings, lexicon path specs resolved to the
 * ARCHIVED snapshots (disk copies may have drifted; project-cmd rerun does the same).
 */
function scoredContext(project: Project, projectPath: string): ScoredContext {
    const { config } = project;
    const scoredOrig = (config.namedOutputs?.scored ?? config.outputs[0]) as string | undefined;
    const entryName = scoredOrig ? `results/${basename(scoredOrig)}` : undefined;
    const data = entryName ? project.entries.get(entryName) : undefined;
    if (!entryName || !data) {
        throw TassError.usage('validation/no-scored-output',
            `${projectPath}: no scored CSV in results/; validation needs a saved score run`);
    }
    const s = config.settings as Record<string, unknown>;
    const textColumn = typeof s.textColumn === 'string' && s.textColumn ? s.textColumn : undefined;
    if (!textColumn) {
        throw TassError.usage('validation/no-text-column',
            `${projectPath}: the saved run has no text column (TXT corpus?); the scored CSV carries no text to derive match units from`);
    }

    const work = mkdtempSync(join(tmpdir(), 'tass-validation-'));
    const scoredCsvPath = join(work, basename(entryName));
    writeFileSync(scoredCsvPath, data);

    // Lexicon specs: bundled/installed ids pass through; path specs resolve to archived snapshots.
    const archived = [...project.entries.keys()].filter(k => k.startsWith('lexicons/'));
    const byBase = new Map<string, string[]>();
    for (const k of archived) {
        const b = basename(k).replace(/^\d+-/, '');
        byBase.set(b, [...(byBase.get(b) ?? []), k]);
    }
    const specs = (s.lexiconSpecs as string[] | undefined) ?? [];
    const lexicons = specs.map(spec => {
        if (!/[\\/]|\.json$/i.test(spec)) { return spec; }
        const candidates = byBase.get(basename(spec)) ?? [];
        if (candidates.length === 1) {
            const p = join(work, 'lexicons', basename(candidates[0]));
            mkdirSync(join(work, 'lexicons'), { recursive: true });
            writeFileSync(p, project.entries.get(candidates[0])!);
            return p;
        }
        if (candidates.length === 0 && existsSync(spec)) { return spec; }
        throw TassError.runtime('validation/ambiguous-lexicon',
            `cannot resolve archived lexicon for '${spec}' (${candidates.length} snapshot candidates)`);
    });
    return { scoredCsvPath, opts: { textColumn, lexicons: lexicons.length ? lexicons : undefined } };
}

// ─────────────────────────────────────────────────────────────────────────────
// sample — write the review sheet a human codes
// ─────────────────────────────────────────────────────────────────────────────

const SHEET_HEADER = ['validation_id', 'doc_id', 'category', 'term', 'occurrence',
    'text_excerpt', 'metric_value', 'verdict', 'memo'];

function cmdSample(argv: string[], io: Io): number {
    const flags = parseFlags(argv);
    const output = need(flags, '--output', 'sample');
    const projectPath = flags.get('--project');
    const inputPath = flags.get('--input');
    if (!projectPath === !inputPath) {
        throw TassError.usage('validation/missing-flag',
            'validation sample needs exactly one of --project <x.tassproj> or --input <scored.csv>');
    }
    const perSpec = flags.get('--per-category');
    const perCategory = perSpec === undefined ? undefined : Number(perSpec);
    if (perCategory !== undefined && (!Number.isInteger(perCategory) || perCategory < 1)) {
        throw TassError.usage('validation/bad-sample-size', '--per-category must be a positive integer');
    }

    let scoredCsvPath: string;
    let opts: MatchUnitOptions;
    if (projectPath) {
        ({ scoredCsvPath, opts } = scoredContext(loadProject(projectPath), projectPath));
    } else {
        const textColumn = flags.get('--text-column');
        if (!textColumn) { throw TassError.usage('validation/missing-flag', 'validation sample --input needs --text-column'); }
        scoredCsvPath = inputPath!;
        opts = { textColumn, lexicons: list(flags.get('--lexicons')) };
    }
    opts.categories = list(flags.get('--categories')) ?? opts.categories;

    const units = sampleForValidation(scoredCsvPath, { ...opts, perCategory });
    const rows: string[][] = [SHEET_HEADER];
    for (const u of units) {
        rows.push([u.id, u.docId, u.category, u.term, String(u.occurrence),
            u.excerpt, u.metricRaw, '', '']);
    }
    writeFileSync(output, stringifyCsv(rows));
    const categories = new Set(units.map(u => u.category)).size;
    io.err(`review sheet: ${units.length} unit(s) across ${categories} categor${categories === 1 ? 'y' : 'ies'} -> ${output}`);
    io.err(`fill 'verdict' (${VERDICTS.join('/')}) and optional 'memo', then: tass validation import`);
    return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// import — filled sheet -> validation/ records (all row errors collected, then one failure)
// ─────────────────────────────────────────────────────────────────────────────

function cmdImport(argv: string[], io: Io): number {
    const flags = parseFlags(argv);
    const projectPath = need(flags, '--project', 'import');
    const input = need(flags, '--input', 'import');
    loadProject(projectPath); // integrity check before we touch the archive

    const rows = parseCsv(readFileSync(input, 'utf8'));
    if (rows.length === 0) {
        throw TassError.usage('validation/empty-sheet', `${input}: empty file; expected the review sheet from: tass validation sample`);
    }
    const header = rows[0].map(h => h.trim().toLowerCase());
    const idx = (name: string) => header.indexOf(name);
    const errors: string[] = [];
    for (const required of ['validation_id', 'doc_id', 'category', 'term', 'occurrence', 'verdict']) {
        if (idx(required) < 0) { errors.push(`line 1: header is missing column '${required}'`); }
    }
    if (errors.length) {
        throw TassError.usage('validation/invalid', `review sheet is invalid:\n  ${errors.join('\n  ')}`);
    }
    const iId = idx('validation_id'), iDoc = idx('doc_id'), iCat = idx('category'),
        iTerm = idx('term'), iOcc = idx('occurrence'), iVerdict = idx('verdict'),
        iMemo = idx('memo'), iRater = idx('rater');

    const imported: ValidationRecord[] = [];
    const seen = new Map<string, number>(); // id -> first line
    let skippedBlank = 0;
    for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        if (row.every(c => c.trim() === '')) { continue; } // blank spreadsheet row
        const line = r + 1;
        const verdict = (row[iVerdict] ?? '').trim().toLowerCase();
        if (verdict === '') { skippedBlank++; continue; } // not yet coded — not an error
        if (!isVerdict(verdict)) {
            errors.push(`line ${line}: verdict '${row[iVerdict]}' is not one of ${VERDICTS.join(', ')} (leave blank to skip)`);
            continue;
        }
        const id = (row[iId] ?? '').trim();
        const docId = row[iDoc] ?? '';
        const category = row[iCat] ?? '';
        const term = row[iTerm] ?? '';
        const occRaw = (row[iOcc] ?? '').trim();
        const occurrence = Number(occRaw);
        if (occRaw === '' || !Number.isInteger(occurrence) || occurrence < 0) {
            errors.push(`line ${line}: occurrence '${occRaw}' must be a non-negative integer`);
            continue;
        }
        const expected = validationId(docId, category, term, occurrence);
        if (id !== expected) {
            errors.push(`line ${line}: validation_id '${id}' does not match its row content (expected ${expected}); do not edit id/doc_id/category/term/occurrence cells`);
            continue;
        }
        const first = seen.get(id);
        if (first !== undefined) {
            errors.push(`line ${line}: duplicate validation_id '${id}' (first seen on line ${first})`);
            continue;
        }
        seen.set(id, line);
        const memo = iMemo < 0 ? '' : (row[iMemo] ?? '').trim();
        const rater = iRater < 0 ? '' : (row[iRater] ?? '').trim();
        imported.push({
            id, docId, category, term, occurrence, verdict,
            ...(memo ? { memo } : {}), ...(rater ? { rater } : {}),
        });
    }
    if (errors.length) {
        throw TassError.usage('validation/invalid', `review sheet is invalid:\n  ${errors.join('\n  ')}`);
    }
    if (imported.length === 0) {
        throw TassError.usage('validation/no-verdicts',
            `${input}: no coded rows (every verdict is blank); fill the verdict column first`);
    }

    // Merge: the sheet wins per id; untouched existing records survive.
    const merged = new Map<string, ValidationRecord>();
    const existing = readValidation(projectPath);
    for (const rec of existing) { merged.set(rec.id, rec); }
    let updated = 0;
    for (const rec of imported) {
        if (merged.has(rec.id)) { updated++; }
        merged.set(rec.id, rec);
    }
    writeValidation(projectPath, [...merged.values()]);
    io.err(`imported ${imported.length} verdict(s) (${updated} updated, ${imported.length - updated} new`
        + `${skippedBlank ? `, ${skippedBlank} uncoded row(s) skipped` : ''}) -> ${projectPath} validation/`);
    return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// export — records + attached/orphaned status
// ─────────────────────────────────────────────────────────────────────────────

/** The visible orphan marker (Section 3.5: "from a previous run", never silent). */
const ORPHANED = 'orphaned (from a previous run)';

function cmdExport(argv: string[], io: Io): number {
    const flags = parseFlags(argv);
    const projectPath = need(flags, '--project', 'export');
    const output = need(flags, '--output', 'export');
    const project = loadProject(projectPath);
    const records = readValidation(projectPath);
    const { scoredCsvPath, opts } = scoredContext(project, projectPath);
    const { attached, orphaned } = partitionValidation(records, deriveMatchUnits(scoredCsvPath, opts));
    const attachedIds = new Set(attached.map(r => r.id));

    const rows: string[][] = [['validation_id', 'doc_id', 'category', 'term', 'occurrence',
        'verdict', 'memo', 'rater', 'status']];
    for (const r of records) {
        rows.push([r.id, r.docId, r.category, r.term, String(r.occurrence),
            r.verdict, r.memo ?? '', r.rater ?? '', attachedIds.has(r.id) ? 'attached' : ORPHANED]);
    }
    writeFileSync(output, stringifyCsv(rows));
    io.err(`${records.length} record(s): ${attached.length} attached, ${orphaned.length} orphaned -> ${output}`);
    if (orphaned.length > 0) {
        io.err(`note: ${orphaned.length} verdict(s) are from a previous run; the current scored output no longer derives their id`);
    }
    return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// summary — per-category counts + precision proxy, as JSON
// ─────────────────────────────────────────────────────────────────────────────

const round4 = (n: number) => Number(n.toFixed(4));

function cmdSummary(argv: string[], io: Io): number {
    const flags = parseFlags(argv);
    const projectPath = need(flags, '--project', 'summary');
    loadProject(projectPath); // integrity check
    const records = readValidation(projectPath);

    interface Counts { correct: number; incorrect: number; unsure: number }
    const byCategory = new Map<string, Counts>();
    const overall: Counts = { correct: 0, incorrect: 0, unsure: 0 };
    for (const r of records) {
        const c = byCategory.get(r.category) ?? { correct: 0, incorrect: 0, unsure: 0 };
        c[r.verdict]++;
        overall[r.verdict]++;
        byCategory.set(r.category, c);
    }
    const shape = (category: string | null, c: Counts) => ({
        ...(category === null ? {} : { category }),
        correct: c.correct, incorrect: c.incorrect, unsure: c.unsure,
        total: c.correct + c.incorrect + c.unsure,
        /** correct / (correct + incorrect); null when nothing decisive was coded. */
        precisionProxy: c.correct + c.incorrect === 0 ? null : round4(c.correct / (c.correct + c.incorrect)),
    });
    io.out(JSON.stringify({
        project: projectPath,
        records: records.length,
        categories: [...byCategory.keys()].sort().map(cat => shape(cat, byCategory.get(cat)!)),
        overall: shape(null, overall),
        note: 'precisionProxy = correct / (correct + incorrect) over human-coded matches: a precision estimate for the sampled units, not corpus recall',
    }, null, 1));
    return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// entry
// ─────────────────────────────────────────────────────────────────────────────

const USAGE = `tass validation: human validation of match units, inside the .tassproj

  tass validation sample --project study.tassproj -o review.csv [--per-category 10]
                         [--categories afinn:sentiment,…]
  tass validation sample --input scored.csv --text-column text -o review.csv
                         [--lexicons afinn,…] [--per-category 10] [--categories …]
      Deterministic review sheet: per category, the top-scoring matches plus an evenly
      strided spread (no RNG; two runs are byte-identical). Columns: validation_id, doc_id,
      category, term, occurrence, text_excerpt, metric_value, verdict, memo. A human fills
      verdict (${VERDICTS.join('/')}) and memo.

  tass validation import --project study.tassproj --input review.csv
      Write the coded sheet into the project's validation/ member. Row errors are collected
      and ALL reported at once (row-numbered); blank verdicts are skipped, not errors.
      Verdicts are keyed by content-derived IDs, so identical re-runs reattach every verdict.

  tass validation export --project study.tassproj -o records.csv
      Dump every stored verdict with its status: attached (derivable from the current scored
      output) or ${ORPHANED}; changed inputs orphan verdicts VISIBLY, never silently.

  tass validation summary --project study.tassproj
      Per-category verdict counts and precision proxy (correct / (correct + incorrect)) as JSON.

The validation/ member is reviewer-mutable and excluded from the container's tamper hash;
config, corpus, lexicons, and results stay integrity-checked on load.
`;

/** Entry: argv is everything after the word 'validation'. */
export function runValidationCommand(argv: string[], io: Io): number {
    const sub = argv[0];
    if (!sub || sub === 'help' || sub === '--help') { io.out(USAGE); return 0; }
    switch (sub) {
        case 'sample': return cmdSample(argv.slice(1), io);
        case 'import': return cmdImport(argv.slice(1), io);
        case 'export': return cmdExport(argv.slice(1), io);
        case 'summary': return cmdSummary(argv.slice(1), io);
        default:
            throw TassError.usage('validation/unknown-subcommand',
                `unknown validation subcommand '${sub}'; valid: sample, import, export, summary`);
    }
}
