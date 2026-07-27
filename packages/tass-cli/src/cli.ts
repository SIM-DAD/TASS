/**
 * @simdad/tass-cli — the TASS command line (clean rebuild; M0 2026-07-15, M1 same day for the
 * Dr. K / Reckful run — TASS-RUN-REQUIREMENTS-2026-07-15).
 *
 * Subcommands:
 *   tass dicts [--json]                 list bundled lexicons (license, class, citation)
 *   tass analyze --text "…"             raw text -> JSON scores (the direct machine/AI surface)
 *   tass mcp                            serve the engine over MCP stdio for AI agents
 *   tass ingest -i dir -o turns.csv     speaker-labeled transcripts -> turn-level CSV
 *   tass score  -i in.csv -o out.csv    score documents -> scored CSV (+summary/trajectories/json)
 *   tass exemplars -i in.csv …          top/bottom-scoring documents with matched terms (trace-back)
 *   tass kwic   -i in.csv -q "term*"    keyword-in-context concordance
 *   tass import-dic -i x.dic -o l.json  convert a user-licensed LIWC-format .dic
 *   tass import-nrc -i nrc.txt -o l.json convert a user-licensed NRC EmoLex wordlist (academic-only)
 *
 * Contracts that matter:
 *  - Deterministic: same inputs => byte-identical outputs. Nothing time-stamped, columns in
 *    fixed order, numbers formatted stably. The run manifest documents this.
 *  - Attribution travels: every `score` writes `<output>.manifest.json` — input hashes, every
 *    lexicon's name/license/class/citation, settings — the Confirmed-Packet provenance block.
 *  - License classes are enforced socially, mechanically: bundled = verified 'commercial-ok';
 *    user imports of restricted resources (NRC…) are marked 'academic-only' and every run that
 *    touches one says so on stderr and in the manifest. Nothing restricted ships in TASS.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, openSync, writeSync, closeSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
    Lexicon, CompiledLexicon, compileLexicon, analyze, kwic, parseDic,
    TassError, Corpus, CorpusRow, loadCorpus, splitCorpusInputs, streamCsvCorpus,
    listBundled, loadBundled, resolveLexicon,
    Metric, METRICS, isMetric, metricValue, safeName, fmt, secondsToStamp, Acc,
    buildScoreManifest, packageVersion,
    stringifyCsv, parseCsv, parseTranscript, parseChatLog, vaderRuleScore, valenceMap,
    parseLexiconCsv, LEXICON_CSV_TEMPLATE,
} from '@simdad/tass-core';
import { commandBooleans } from './spec';
import type { ScorePool } from './score-pool';

/** Where the CLI writes lines; injectable so tests capture output without child processes. */
export interface Io {
    out(line: string): void;
    err(line: string): void;
}

/** Tool version, single-sourced from this package's package.json (R8). */
export const VERSION = packageVersion(join(__dirname, '..'));

/** Argv-level usage error: message + exit 1 (engine errors arrive as TassError instead). */
class UsageError extends Error {}

/** Render any thrown error to stderr and return the exit code (usage 1, runtime 2). */
export function renderError(e: unknown, io: Io): number {
    if (e instanceof UsageError) { io.err(`tass: ${e.message}`); return 1; }
    if (e instanceof TassError) {
        io.err(`tass: ${e.message}`);
        if (e.hint) { io.err(`  hint: ${e.hint}`); }
        return e.kind === 'usage' ? 1 : 2;
    }
    io.err(`tass: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
}

/** The optional statistics plugin (@simdad/tass-stats); undefined in the Community Edition. */
export function loadStats(): { runStatsCommand(argv: string[], io: Io): number; STATS_TOOL_SPECS: unknown[] } | undefined {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require('@simdad/tass-stats');
    } catch {
        return undefined;
    }
}

/** The optional chart plugin (@simdad/tass-viz); undefined in the Community Edition. */
export function loadViz(): { runVizCommand(argv: string[], io: Io): number; VIZ_TOOL_SPECS: unknown[] } | undefined {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require('@simdad/tass-viz');
    } catch {
        return undefined;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Argument parsing (hand-rolled: flags with values, repeatable -i, no external deps)
// ─────────────────────────────────────────────────────────────────────────────

interface ParsedArgs {
    positional: string[];
    flags: Map<string, string[]>;
}

const FLAG_ALIASES: Record<string, string> = {
    '-i': '--input', '-o': '--output', '-q': '--query', '-w': '--window',
};

/** Flags that take no value. */
const BOOLEAN_FLAGS = new Set(['--help', '--version']);

/**
 * Per-command boolean flags (same flag name can take a value elsewhere, e.g. score --json
 * PATH). DERIVED from the shared tool spec (R7) plus its explicit CLI-only table — the CLI
 * parser and the MCP schemas read the same source, so they cannot drift.
 */
const COMMAND_BOOLEANS: Record<string, string[]> = commandBooleans();

function parseArgs(argv: string[], extraBooleans?: Set<string>): ParsedArgs {
    const positional: string[] = [];
    const flags = new Map<string, string[]>();
    for (let i = 0; i < argv.length; i++) {
        let a = argv[i];
        if (!a.startsWith('-')) { positional.push(a); continue; }
        a = FLAG_ALIASES[a] ?? a;
        if (BOOLEAN_FLAGS.has(a) || extraBooleans?.has(a)) {
            flags.set(a, [...(flags.get(a) ?? []), 'true']);
            continue;
        }
        const value = argv[++i];
        if (value === undefined) { throw new UsageError(`${a} needs a value`); }
        flags.set(a, [...(flags.get(a) ?? []), value]);
    }
    return { positional, flags };
}

function one(args: ParsedArgs, flag: string): string | undefined {
    const v = args.flags.get(flag);
    if (v && v.length > 1) { throw new UsageError(`${flag} given more than once`); }
    return v?.[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// score (+ group summaries, windowed trajectories, JSON export, run manifest)
// Corpus loading, lexicon resolution, metrics, and the manifest builder live in
// @simdad/tass-core since the R1-R4 refactor; the CLI is argv parsing + orchestration.
// ─────────────────────────────────────────────────────────────────────────────

/** The bundled VADER lexicon's word->valence map, for the rule layer (--vader-rules). */
function vaderValences(): Map<string, number> {
    const lex = loadBundled('vader');
    return valenceMap(lex.categories.flatMap(c => c.terms));
}

const VADER_RULES_NOTE = 'vader-rules columns are the TASS implementation of the published VADER heuristics '
    + '(negation, boosters, ALL-CAPS, punctuation, but-clauses, emoticons, idiom tables) over the bundled '
    + 'vader lexicon — report as "TASS VADER-rules compound", not canonical "VADER compound".';

function cmdScore(args: ParsedArgs, io: Io): number {
    const inputs = args.flags.get('--input') ?? [];
    if (inputs.length === 0) { throw new UsageError('score needs -i/--input (CSV file, or one or more TXT files)'); }
    const output = one(args, '--output');
    if (!output) { throw new UsageError('score needs -o/--output (path for the scored CSV)'); }

    const metricsSpec = one(args, '--metrics') ?? 'percent';
    const metrics: Metric[] = metricsSpec.split(',').map(m => m.trim()).filter(Boolean).map(m => {
        if (!isMetric(m)) { throw new UsageError(`unknown metric '${m}' — valid: ${METRICS.join(', ')}`); }
        return m;
    });

    const lexSpecs = (one(args, '--lexicons')?.split(',').map(s => s.trim()).filter(Boolean)) ?? listBundled();
    const lexicons = lexSpecs.map(resolveLexicon);
    const compiled: CompiledLexicon[] = lexicons.map(compileLexicon);

    const academicOnly = lexicons.filter(l => l.licenseClass === 'academic-only').map(l => l.id);
    for (const id of academicOnly) {
        io.err(`ACADEMIC-ONLY lexicon in this run: ${id} — fine for scholarly use, never redistributable; flagged in the manifest.`);
    }

    const groupColumns = one(args, '--group-column')?.split(',').map(s => s.trim()).filter(Boolean) ?? [];
    const windowSpec = one(args, '--window');
    const window = windowSpec === undefined ? undefined : Number(windowSpec);
    if (window !== undefined && (!Number.isInteger(window) || window < 1)) {
        throw new UsageError('--window must be a positive integer (seconds)');
    }
    const timeColumn = one(args, '--time-column');
    if (window !== undefined && !timeColumn) { throw new UsageError('--window needs --time-column (numeric seconds)'); }

    const workersSpec = one(args, '--workers');
    const workers = workersSpec === undefined ? undefined : Number(workersSpec);
    if (workers !== undefined && (!Number.isInteger(workers) || workers < 1 || workers > 32)) {
        throw new UsageError('--workers must be an integer 1-32');
    }

    // Input classification up front (same validation/errors as loadCorpus): the CSV branch
    // streams row-at-a-time (M3 — memory O(row + aggregates + output buffer)); TXT files load
    // whole-file as before (a TXT document IS the file).
    const { csv } = splitCorpusInputs(inputs);

    // Fixed column order: passthrough, token count, then lexicon -> category -> metric.
    const scoreCols: Array<{ name: string; lex: number; cat: number; metric: Metric }> = [];
    compiled.forEach((cl, li) => {
        cl.lexicon.categories.forEach((cat, ci) => {
            for (const m of metrics) {
                scoreCols.push({ name: `${safeName(cl.lexicon.id)}_${safeName(cat.id)}_${m}`, lex: li, cat: ci, metric: m });
            }
        });
    });

    // Optional VADER rule layer: four extra columns computed from the raw text.
    const wantVaderRules = args.flags.has('--vader-rules');
    const vrNames = wantVaderRules
        ? ['vader_rules_compound', 'vader_rules_positive', 'vader_rules_negative', 'vader_rules_neutral']
        : [];
    const vmap = wantVaderRules ? vaderValences() : undefined;
    if (wantVaderRules) { io.err(`note: ${VADER_RULES_NOTE}`); }
    const allNames = [...scoreCols.map(c => c.name), ...vrNames];

    // JSON rows (--json) still accumulate in memory: the artifact is ONE JSON array whose
    // bytes must equal JSON.stringify(jsonRows, null, 1), it is opt-in, and the objects are
    // small typed rows. The streaming memory guarantee — O(row + aggregates + output buffer)
    // — holds for the default artifact set; add --json and memory grows with the row count.
    const jsonRows: Array<Record<string, unknown>> = [];
    const wantJson = one(args, '--json');

    // Chunked output writer (M3): the scored CSV is opened once and appended in row order,
    // flushed every FLUSH_ROWS rows (and once at the end).
    const FLUSH_ROWS = 8192;
    let outFd: number | undefined;
    let outLines: string[] = [];
    let bufferedRows = 0;
    const flushOut = () => {
        if (outLines.length > 0) { writeSync(outFd!, outLines.join('')); outLines = []; }
        bufferedRows = 0;
    };
    const writeLine = (cells: string[]) => {
        outLines.push(stringifyCsv([cells]));
        if (++bufferedRows >= FLUSH_ROWS) { flushOut(); }
    };

    let header: string[] = [];
    let rowCount = 0;

    // Aggregations: group summary (by --group-column values) and windowed trajectories
    // (by group values + time bin). Key parts joined with  (never appears in data).
    interface Bucket { keyParts: string[]; tokens: Acc; cols: Acc[] }
    const newBucket = (keyParts: string[]): Bucket =>
        ({ keyParts, tokens: new Acc(), cols: allNames.map(() => new Acc()) });
    const groups = new Map<string, Bucket>();
    const windows = new Map<string, Bucket>();

    /** Fold one scored row into the artifacts: CSV line, JSON row, aggregate buckets. */
    const processScored = (row: CorpusRow, tokens: number, values: Array<number | undefined>) => {
        rowCount++;
        writeLine([...row.passthrough, String(tokens), ...values.map(fmt)]);
        if (wantJson) {
            const obj: Record<string, unknown> = {};
            header.forEach((h, i) => { obj[h] = row.passthrough[i]; });
            obj.tass_tokens = tokens;
            allNames.forEach((name, i) => { obj[name] = values[i] ?? null; });
            jsonRows.push(obj);
        }

        const feed = (map: Map<string, Bucket>, keyParts: string[]) => {
            const key = keyParts.join('');
            let b = map.get(key);
            if (!b) { b = newBucket(keyParts); map.set(key, b); }
            b.tokens.add(tokens);
            values.forEach((v, i) => b!.cols[i].add(v));
        };
        if (row.groupValues) { feed(groups, row.groupValues); }
        if (window !== undefined && row.seconds !== undefined) {
            const bin = Math.floor(row.seconds / window) * window;
            feed(windows, [...(row.groupValues ?? []), String(bin)]);
        }
    };

    /** Score one text on this thread (the single-threaded path; workers do the same math). */
    const scoreText = (text: string): { tokens: number; values: Array<number | undefined> } => {
        const results = compiled.map(cl => analyze(text, cl));
        const tokens = results[0]?.totalTokens ?? 0;
        const values: Array<number | undefined> =
            scoreCols.map(c => metricValue(results[c.lex].categories[c.cat], c.metric));
        if (vmap) {
            const vr = vaderRuleScore(text, vmap);
            values.push(vr.compound, vr.positive, vr.negative, vr.neutral);
        }
        return { tokens, values };
    };

    // Worker pool (--workers N, M3): batches of texts scored in parallel worker threads,
    // results collected strictly in dispatch order, so output bytes are identical to
    // single-threaded by construction. Deliberately NOT recorded in the manifest:
    // parallelism is an execution detail, never an analytical setting — the same run with
    // and without --workers produces the same manifest.
    const BATCH_ROWS = 512;
    let pool: ScorePool | undefined;
    if (workers !== undefined) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { ScorePool: Pool } = require('./score-pool') as typeof import('./score-pool');
        pool = new Pool(workers, {
            lexicons,
            scoreCols: scoreCols.map(c => ({ lex: c.lex, cat: c.cat, metric: c.metric })),
            vaderRules: wantVaderRules,
        });
    }
    let batch: CorpusRow[] = [];
    const pendingBatches: CorpusRow[][] = [];
    const drainOne = () => {
        const res = pool!.collect();
        const rows = pendingBatches.shift()!;
        rows.forEach((row, i) =>
            processScored(row, res.tokens[i], res.values[i].map(v => (v === null ? undefined : v))));
    };
    const dispatchBatch = () => {
        if (batch.length === 0) { return; }
        pool!.dispatch(batch.map(r => r.text));
        pendingBatches.push(batch);
        batch = [];
        // Bounded pipeline: at most workers + 2 batches in flight keeps memory O(batches).
        while (pool!.inFlight > workers! + 2) { drainOne(); }
    };
    const handleRow = (row: CorpusRow) => {
        if (!pool) {
            const { tokens, values } = scoreText(row.text);
            processScored(row, tokens, values);
            return;
        }
        batch.push(row);
        if (batch.length >= BATCH_ROWS) { dispatchBatch(); }
    };

    try {
        if (csv !== undefined) {
            // Streaming CSV path (M3): rows are parsed, scored, and written incrementally.
            streamCsvCorpus(csv, one(args, '--text-column'), groupColumns, timeColumn,
                h => {
                    header = h;
                    outFd = openSync(output, 'w');
                    writeLine([...h, 'tass_tokens', ...allNames]);
                },
                handleRow);
        } else {
            // TXT path (file = document): whole-file loading, unchanged semantics.
            const corpus = loadCorpus(inputs, one(args, '--text-column'), groupColumns, timeColumn);
            header = corpus.header;
            outFd = openSync(output, 'w');
            writeLine([...corpus.header, 'tass_tokens', ...allNames]);
            for (const row of corpus.rows) { handleRow(row); }
        }
        if (pool) {
            dispatchBatch();
            while (pendingBatches.length > 0) { drainOne(); }
        }
        flushOut();
        closeSync(outFd!);
        outFd = undefined;
    } catch (e) {
        // A failed run must never leave a partial analytical artifact behind (Modern Build
        // Plan Section 3.4: partial results are not valid for inference and are deleted).
        if (outFd !== undefined) {
            try { closeSync(outFd); } catch { /* best-effort */ }
            rmSync(output, { force: true });
        }
        pool?.close();
        throw e;
    }
    pool?.close();

    io.err(`scored ${rowCount} documents x ${scoreCols.length} score columns -> ${output}`);
    if (wantJson) {
        writeFileSync(wantJson, JSON.stringify(jsonRows, null, 1) + '\n');
        io.err(`JSON rows -> ${wantJson}`);
    }

    const writeAggregate = (path: string, map: Map<string, Bucket>, keyHeader: string[], windowed: boolean) => {
        const rows: string[][] = [[...keyHeader, 'n', 'mean_tass_tokens',
            ...allNames.flatMap(name => [`mean_${name}`, `sd_${name}`, `n_${name}`])]];
        const sorted = [...map.values()].sort((a, b) =>
            a.keyParts.join('').localeCompare(b.keyParts.join(''), undefined, { numeric: windowed }));
        for (const b of sorted) {
            const keyOut = windowed
                ? [...b.keyParts.slice(0, -1), b.keyParts[b.keyParts.length - 1], secondsToStamp(Number(b.keyParts[b.keyParts.length - 1]))]
                : b.keyParts;
            rows.push([...keyOut, String(b.tokens.n), fmt(b.tokens.mean()),
                ...b.cols.flatMap(a => [fmt(a.mean()), fmt(a.sd()), String(a.n)])]);
        }
        writeFileSync(path, stringifyCsv(rows));
    };

    const summaryPath = one(args, '--group-summary');
    if (summaryPath) {
        if (groups.size === 0) { throw new UsageError('--group-summary needs --group-column'); }
        writeAggregate(summaryPath, groups, groupColumns, false);
        io.err(`group summary (${groups.size} groups: mean/sd/n per column) -> ${summaryPath}`);
    }

    const trajPath = one(args, '--trajectories');
    if (trajPath) {
        if (window === undefined) { throw new UsageError('--trajectories needs --window and --time-column'); }
        writeAggregate(trajPath, windows, [...groupColumns, 'window_start_seconds', 'window_start'], true);
        io.err(`windowed trajectories (${windows.size} windows of ${window}s) -> ${trajPath}`);
    }

    const citationsPath = one(args, '--citations');
    if (citationsPath) {
        const lines = lexicons.map(l =>
            `${l.name}${l.license ? ` [${l.license}]` : ''}${l.citation ? ` — ${l.citation}` : ''}`);
        writeFileSync(citationsPath, lines.join('\n') + '\n');
        io.err(`citations -> ${citationsPath}`);
    }

    // Run manifest — the Confirmed-Packet provenance block (built in core since R4;
    // deliberately timestamp-free so the whole run stays a pure function of its inputs).
    const manifestPath = `${output}.manifest.json`;
    const manifest = buildScoreManifest({
        tool: '@simdad/tass-cli',
        toolVersion: VERSION,
        command: 'score',
        settings: {
            textColumn: one(args, '--text-column') ?? null,
            groupColumns,
            metrics,
            window: window ?? null,
            timeColumn: timeColumn ?? null,
            lexiconSpecs: lexSpecs,
            vaderRules: wantVaderRules,
        },
        inputs,
        lexicons,
        academicOnlyUsed: academicOnly,
        outputs: [output, one(args, '--json'), summaryPath, trajPath, citationsPath]
            .filter((p): p is string => Boolean(p)),
        namedOutputs: {
            scored: output,
            json: one(args, '--json') ?? null,
            groupSummary: summaryPath ?? null,
            trajectories: trajPath ?? null,
            citations: citationsPath ?? null,
        },
    });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 1) + '\n');
    io.err(`run manifest (provenance block) -> ${manifestPath}`);
    return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// ingest — speaker-labeled transcripts -> turn-level CSV
// ─────────────────────────────────────────────────────────────────────────────

function cmdIngest(args: ParsedArgs, io: Io): number {
    const inputs = args.flags.get('--input') ?? [];
    if (inputs.length === 0) { throw new UsageError('ingest needs -i/--input (transcript files and/or folders)'); }
    const output = one(args, '--output');
    if (!output) { throw new UsageError('ingest needs -o/--output (path for the turns CSV)'); }
    const format = one(args, '--format') ?? 'transcript';
    if (format !== 'transcript' && format !== 'chat') {
        throw new UsageError(`unknown --format '${format}' — valid: transcript (speaker-labeled), chat ([stamp] <user>/user: logs)`);
    }
    const parse = format === 'chat' ? parseChatLog : parseTranscript;
    const extRe = format === 'chat' ? /\.(log|txt)$/i : /\.(md|txt)$/i;

    const files: string[] = [];
    for (const p of inputs) {
        if (statSync(p).isDirectory()) {
            for (const f of readdirSync(p).sort()) {
                if (extRe.test(f)) { files.push(join(p, f)); }
            }
        } else {
            files.push(p);
        }
    }

    const rows: string[][] = [['session', 'turn', 'timestamp', 'seconds', 'speaker', 'text']];
    let sessions = 0;
    for (const f of files) {
        const turns = parse(readFileSync(f, 'utf8'));
        if (turns.length === 0) {
            io.err(`skipped (no turn lines): ${basename(f)}`);
            continue;
        }
        sessions++;
        const session = basename(f).replace(extRe, '');
        for (const t of turns) {
            rows.push([session, String(t.turn), t.timestamp, String(t.seconds), t.speaker, t.text]);
        }
        io.err(`${basename(f)}: ${turns.length} turns, ${new Set(turns.map(t => t.speaker)).size} speaker(s)`);
    }
    if (rows.length === 1) {
        throw new Error(format === 'chat'
            ? 'no messages found in any input — expected chat-log lines ([stamp] <user> … or [stamp] user: …)'
            : 'no turns found in any input — is this the speaker-labeled format ([M:SS] **SPEAKER:** …)?');
    }
    writeFileSync(output, stringifyCsv(rows));
    io.err(`${rows.length - 1} turns from ${sessions} session(s) -> ${output}`);
    return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// exemplars — trace-back: top/bottom-scoring documents with their matched terms
// ─────────────────────────────────────────────────────────────────────────────

function cmdExemplars(args: ParsedArgs, io: Io): number {
    const inputs = args.flags.get('--input') ?? [];
    if (inputs.length === 0) { throw new UsageError('exemplars needs -i/--input'); }
    const lexSpec = one(args, '--lexicon');
    if (!lexSpec) { throw new UsageError('exemplars needs --lexicon (one bundled id or lexicon JSON path)'); }
    const lexicon = resolveLexicon(lexSpec);
    const categoryId = one(args, '--category');
    if (!categoryId) {
        throw new UsageError(`exemplars needs --category — ${lexicon.id} has: ${lexicon.categories.map(c => c.id).join(', ')}`);
    }
    const catIndex = lexicon.categories.findIndex(c => c.id === categoryId);
    if (catIndex < 0) {
        throw new UsageError(`category '${categoryId}' not in ${lexicon.id} — has: ${lexicon.categories.map(c => c.id).join(', ')}`);
    }
    const metricSpec = one(args, '--metric') ?? 'percent';
    if (!isMetric(metricSpec)) { throw new UsageError(`unknown metric '${metricSpec}' — valid: ${METRICS.join(', ')}`); }
    const metric: Metric = metricSpec;
    const top = Number(one(args, '--top') ?? 10);
    const bottom = Number(one(args, '--bottom') ?? 0);
    if (!Number.isInteger(top) || !Number.isInteger(bottom) || top < 0 || bottom < 0) {
        throw new UsageError('--top/--bottom must be non-negative integers');
    }

    const corpus = loadCorpus(inputs, one(args, '--text-column'), []);
    const compiled = compileLexicon(lexicon);
    const scored = corpus.rows.map((row, i) => {
        const r = analyze(row.text, compiled).categories[catIndex];
        return { row, i, value: metricValue(r, metric), matched: r.matchedForms };
    }).filter(s => s.value !== undefined) as Array<{ row: Corpus['rows'][0]; i: number; value: number; matched: string[] }>;

    // Deterministic order: score, then original position as the tiebreak.
    const byScore = [...scored].sort((a, b) => b.value - a.value || a.i - b.i);
    const picks = [
        ...byScore.slice(0, top).map(s => ({ ...s, which: 'top' })),
        ...byScore.slice(Math.max(0, byScore.length - bottom)).reverse().map(s => ({ ...s, which: 'bottom' })),
    ];

    const header = [...corpus.header, 'tass_exemplar_rank', `${safeName(lexicon.id)}_${safeName(categoryId)}_${metric}`, 'matched_terms'];
    const rows: string[][] = [header];
    for (const p of picks) {
        rows.push([...p.row.passthrough, p.which, fmt(p.value), p.matched.join('; ')]);
    }
    const output = one(args, '--output');
    if (output) {
        writeFileSync(output, stringifyCsv(rows));
        io.err(`${picks.length} exemplar(s) -> ${output}`);
    } else {
        for (const p of picks) {
            io.out(`${p.which}\t${fmt(p.value)}\t[${p.matched.join(', ')}]\t${p.row.passthrough.join(' | ')}`);
        }
        io.err(`${picks.length} exemplar(s) for ${lexicon.id}:${categoryId} (${metric})`);
    }
    return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// dicts
// ─────────────────────────────────────────────────────────────────────────────

function cmdDicts(args: ParsedArgs, io: Io): number {
    const asJson = args.flags.has('--json');
    const bundle = listBundled().map(id => {
        const lex = loadBundled(id);
        return {
            id,
            name: lex.name,
            license: lex.license ?? null,
            licenseClass: lex.licenseClass ?? 'unspecified',
            citation: lex.citation ?? null,
            categories: lex.categories.map(c => ({ id: c.id, label: c.label ?? c.id, terms: c.terms.length })),
        };
    });
    if (asJson) {
        io.out(JSON.stringify(bundle, null, 1));
        return 0;
    }
    for (const lex of bundle) {
        const terms = lex.categories.reduce((n, c) => n + c.terms, 0);
        io.out(`${lex.id}  —  ${lex.name}`);
        io.out(`    license: ${lex.license} [${lex.licenseClass}]   categories: ${lex.categories.length}   terms: ${terms}`);
        io.out(`    cite: ${lex.citation}`);
    }
    return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// analyze — raw text in, JSON out (the direct machine/AI surface; no CSV needed)
// ─────────────────────────────────────────────────────────────────────────────

function cmdAnalyze(args: ParsedArgs, io: Io): number {
    const inline = one(args, '--text');
    const inputPath = one(args, '--input');
    const fromStdin = args.flags.has('--stdin');
    const sources = [inline !== undefined, fromStdin, inputPath !== undefined].filter(Boolean).length;
    if (sources !== 1) {
        throw new UsageError('analyze needs exactly one of --text "…", --stdin, or -i/--input FILE');
    }
    // fd 0 read: works cross-platform for piped/redirected stdin (the only way analyze --stdin runs).
    const text = inline !== undefined ? inline
        : fromStdin ? readFileSync(0, 'utf8')
        : readFileSync(inputPath!, 'utf8');

    const lexSpecs = (one(args, '--lexicons')?.split(',').map(s => s.trim()).filter(Boolean)) ?? listBundled();
    const lexicons = lexSpecs.map(resolveLexicon);
    const includeZero = args.flags.has('--all');

    const academicOnly = lexicons.filter(l => l.licenseClass === 'academic-only').map(l => l.id);
    for (const id of academicOnly) {
        io.err(`ACADEMIC-ONLY lexicon in this run: ${id} — fine for scholarly use, never redistributable.`);
    }

    let totalTokens = 0;
    const lexOut = lexicons.map(lex => {
        const r = analyze(text, compileLexicon(lex));
        totalTokens = r.totalTokens;
        const categories = r.categories
            .map((c, i) => ({
                id: c.id,
                label: lex.categories[i].label ?? c.id,
                hits: c.hits,
                weighted: c.weighted,
                percent: Number(c.percent.toFixed(4)),
                mean: c.hits === 0 ? null : Number((c.weighted / c.hits).toFixed(4)),
                matchedForms: c.matchedForms,
            }))
            .filter(c => includeZero || c.hits > 0);
        return {
            id: lex.id,
            licenseClass: lex.licenseClass ?? 'unspecified',
            citation: lex.citation ?? null,
            categories,
        };
    });

    let vaderRules: Record<string, unknown> | undefined;
    if (args.flags.has('--vader-rules')) {
        const vr = vaderRuleScore(text, vaderValences());
        vaderRules = { ...vr, note: VADER_RULES_NOTE };
    }

    io.out(JSON.stringify({
        tool: '@simdad/tass-cli',
        version: VERSION,
        determinism: 'output is a pure function of text + lexicons; nothing is time-stamped',
        totalTokens,
        academicOnlyUsed: academicOnly,
        zeroHitCategoriesOmitted: !includeZero,
        vaderRules,
        lexicons: lexOut,
    }, null, 1));
    return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// kwic
// ─────────────────────────────────────────────────────────────────────────────

function cmdKwic(args: ParsedArgs, io: Io): number {
    const inputs = args.flags.get('--input') ?? [];
    if (inputs.length === 0) { throw new UsageError('kwic needs -i/--input'); }
    const query = one(args, '--query');
    if (!query) { throw new UsageError('kwic needs -q/--query (a word, or a stem like "happi*")'); }
    const windowSpec = one(args, '--window');
    const window = windowSpec === undefined ? undefined : Number(windowSpec);
    if (window !== undefined && (!Number.isInteger(window) || window < 1)) {
        throw new UsageError('--window must be a positive integer');
    }
    const maxSpec = one(args, '--max');
    const max = maxSpec === undefined ? Infinity : Number(maxSpec);

    const corpus = loadCorpus(inputs, one(args, '--text-column'), []);
    let printed = 0;
    for (const row of corpus.rows) {
        const docRef = row.passthrough[0] ?? '';
        for (const line of kwic(row.text, query, { window })) {
            if (printed >= max) { break; }
            // Single-line contexts: real newlines would break the one-hit-per-line contract.
            const left = line.left.replace(/\s+/g, ' ');
            const right = line.right.replace(/\s+/g, ' ');
            io.out(`${docRef}\t${left}\t[${line.keyword}]\t${right}`);
            printed++;
        }
    }
    io.err(`${printed} concordance line(s) for ${query}`);
    return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// import-dic / import-nrc — user-licensed dictionary converters (files never bundled)
// ─────────────────────────────────────────────────────────────────────────────

function cmdImportDic(args: ParsedArgs, io: Io): number {
    const input = one(args, '--input');
    if (!input) { throw new UsageError('import-dic needs -i/--input (a LIWC-format .dic file you licensed)'); }
    const output = one(args, '--output');
    if (!output) { throw new UsageError('import-dic needs -o/--output (lexicon JSON path)'); }
    const id = one(args, '--id') ?? basename(input).replace(/\.dic$/i, '');
    const name = one(args, '--name') ?? `Imported: ${basename(input)}`;

    const { lexicon, skippedLines } = parseDic(readFileSync(input, 'utf8'), id, name);
    const terms = lexicon.categories.reduce((n, c) => n + c.terms.length, 0);
    if (terms === 0) { throw new Error(`${input}: no usable entries (skipped ${skippedLines} lines) — is this LIWC .dic format?`); }
    writeFileSync(output, JSON.stringify(lexicon, null, 1) + '\n');
    io.err(`imported ${lexicon.categories.length} categories, ${terms} terms -> ${output}`
        + (skippedLines > 0 ? ` (${skippedLines} malformed line(s) skipped)` : ''));
    io.err('note: the source dictionary stays under ITS license — imported lexicons are for your own use.');
    return 0;
}

/** NRC EmoLex wordlevel format: `word<TAB>affect<TAB>0|1` (10 affects per word). */
function cmdImportNrc(args: ParsedArgs, io: Io): number {
    const input = one(args, '--input');
    if (!input) { throw new UsageError('import-nrc needs -i/--input (your licensed NRC EmoLex wordlevel .txt)'); }
    const output = one(args, '--output');
    if (!output) { throw new UsageError('import-nrc needs -o/--output (lexicon JSON path)'); }
    const id = one(args, '--id') ?? 'nrc-emolex';

    const catTerms = new Map<string, { term: string }[]>();
    let associations = 0;
    for (const line of readFileSync(input, 'utf8').split('\n')) {
        const [word, affect, flag] = line.trim().split('\t');
        if (!word || !affect || flag !== '1' || word.includes(' ')) { continue; }
        associations++;
        const list = catTerms.get(affect) ?? [];
        list.push({ term: word });
        catTerms.set(affect, list);
    }
    if (associations === 0) {
        throw new Error(`${input}: no `.concat('word<TAB>affect<TAB>1 lines found — expected the NRC EmoLex wordlevel file'));
    }
    const lexicon: Lexicon = {
        id,
        name: 'NRC Word-Emotion Association Lexicon (EmoLex) — user import',
        license: 'NRC Research License — free for research, commercial use requires an NRC license',
        licenseClass: 'academic-only',
        citation: 'Mohammad, S.M., & Turney, P.D. (2013). Crowdsourcing a Word-Emotion Association Lexicon. Computational Intelligence, 29(3), 436-465. https://saifmohammad.com/WebPages/NRC-Emotion-Lexicon.htm',
        categories: [...catTerms.entries()].sort(([a], [b]) => a.localeCompare(b))
            .map(([cid, terms]) => ({ id: cid, terms })),
    };
    writeFileSync(output, JSON.stringify(lexicon, null, 1) + '\n');
    io.err(`imported ${lexicon.categories.length} affect categories, ${associations} associations -> ${output}`);
    io.err('ACADEMIC-ONLY: EmoLex is licensed for research use; runs using it are flagged in their manifest. Never redistribute the JSON.');
    return 0;
}

/**
 * SocialSent subreddit/decade TSVs (`word<TAB>mean<TAB>std`, PDDL) — the community-specific
 * members of the family the bundled `socialsent` (2000s general) lexicon comes from. Community
 * choice is a per-study decision, so these convert on demand instead of bloating the bundle.
 */
function cmdImportSocialsent(args: ParsedArgs, io: Io): number {
    const input = one(args, '--input');
    if (!input) { throw new UsageError('import-socialsent needs -i/--input (a SocialSent .tsv, or the unzipped subreddits folder)'); }
    const subreddit = one(args, '--subreddit');
    let file = input;
    if (statSync(input).isDirectory()) {
        if (!subreddit) { throw new UsageError('import-socialsent: -i is a folder — pick one with --subreddit NAME (resolves NAME.tsv inside it)'); }
        file = join(input, `${subreddit}.tsv`);
    }
    const output = one(args, '--output');
    if (!output) { throw new UsageError('import-socialsent needs -o/--output (lexicon JSON path)'); }
    const community = (subreddit ?? basename(file).replace(/\.tsv$/i, '')).toLowerCase();
    const id = one(args, '--id') ?? `socialsent-${safeName(community)}`;

    const terms: Array<{ term: string; weight: number }> = [];
    for (const line of readFileSync(file, 'utf8').split('\n')) {
        const [word, mean] = line.trim().split(/\s+/);
        if (!word || mean === undefined || word.includes(' ')) { continue; }
        const weight = Number(mean);
        if (!Number.isFinite(weight)) { continue; }
        terms.push({ term: word, weight });
    }
    if (terms.length === 0) { throw new Error(`${file}: no word<TAB>mean lines found — expected a SocialSent lexicon TSV`); }
    terms.sort((a, b) => a.term.localeCompare(b.term));

    const lexicon: Lexicon = {
        id,
        name: `SocialSent sentiment (${community}) — user import`,
        license: 'ODC-PDDL-1.0',
        licenseClass: 'commercial-ok',
        citation: 'Hamilton, W.L., Clark, K., Leskovec, J., & Jurafsky, D. (2016). Inducing Domain-Specific Sentiment Lexicons from Unlabeled Corpora. EMNLP 2016. https://nlp.stanford.edu/projects/socialsent/',
        categories: [{ id: 'sentiment', label: `SentProp sentiment (${community})`, terms }],
    };
    writeFileSync(output, JSON.stringify(lexicon, null, 1) + '\n');
    io.err(`imported ${terms.length} terms (${community}) -> ${output} — use via --lexicons ${output}`);
    return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// cite — the citation block for a run (or the bundle): tool, lexicons, methods (M3)
// ─────────────────────────────────────────────────────────────────────────────

/** The TASS software citation. DOI lands with the first public release (Zenodo per-release). */
function tassCitation(style: string): string {
    const year = '2026';
    switch (style) {
        case 'mla':
            return `SIM DAD LLC. TASS: Text Analysis for Social Scientists. Version ${VERSION}, SIM DAD LLC, ${year}, https://usetass.app.`;
        case 'chicago':
            return `SIM DAD LLC. ${year}. TASS: Text Analysis for Social Scientists (version ${VERSION}). Computer software. https://usetass.app.`;
        default: // apa
            return `SIM DAD LLC. (${year}). TASS: Text Analysis for Social Scientists (Version ${VERSION}) [Computer software]. https://usetass.app`;
    }
}

function cmdCite(args: ParsedArgs, io: Io): number {
    const style = one(args, '--style') ?? 'apa';
    if (!['apa', 'mla', 'chicago'].includes(style)) {
        throw new UsageError(`unknown --style '${style}' — valid: apa (default), mla, chicago`);
    }
    const manifestPath = one(args, '--manifest');
    const lines: string[] = [];
    lines.push('== Cite the tool ==');
    lines.push(tassCitation(style));
    lines.push('');
    if (manifestPath) {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
            tool?: string; version?: string; engineVersion?: string; command?: string;
            settings?: Record<string, unknown>;
            lexicons?: Array<{ id: string; name: string; license: string | null; licenseClass: string; citation: string | null }>;
            academicOnlyUsed?: string[];
        };
        lines.push(`== This run (${manifest.tool ?? '?'} ${manifest.command ?? '?'}, version ${manifest.version ?? '?'}${manifest.engineVersion ? `, engine ${manifest.engineVersion}` : ''}) ==`);
        const lexicons = manifest.lexicons ?? [];
        if (lexicons.length) {
            lines.push('Cite each lexicon as published (canonical citation strings, reproduced verbatim):');
            for (const l of lexicons) {
                lines.push(`- ${l.name}${l.license ? ` [${l.license}]` : ''}${l.citation ? ` — ${l.citation}` : ' — (no citation recorded)'}`);
            }
        }
        if (manifest.academicOnlyUsed?.length) {
            lines.push(`ACADEMIC-ONLY lexicons in this run: ${manifest.academicOnlyUsed.join(', ')} — check the resource's license before any commercial reporting.`);
        }
        // Statistics method citations, when the stats plugin is present and this was a stats run.
        const stats = loadStats() as (ReturnType<typeof loadStats> & { SUBSTANTIATION?: Array<{ method: string; status: string; citation: string; note?: string }> }) | undefined;
        if (stats?.SUBSTANTIATION && manifest.command?.startsWith('stats')) {
            const s = manifest.settings ?? {};
            const keys = manifest.command === 'stats compare'
                ? (s.nonparametric === true ? ['mann-whitney', 'kruskal-wallis', 'dunn']
                    : s.welchAnova === true ? ['anova-welch', 'games-howell', 'welch-t']
                    : ['welch-t', 'student-t', 'anova-oneway', 'tukey-hsd'])
                    .concat(['shapiro-wilk', 'levene-brown-forsythe', 'corrections'])
                : manifest.command === 'stats correlate' ? [String(s.method ?? 'pearson'), 'corrections']
                : manifest.command === 'stats readability' ? ['readability'] : [];
            const entries = keys.map(k => stats.SUBSTANTIATION!.find(e => e.method === k)).filter(Boolean);
            if (entries.length) {
                lines.push('');
                lines.push('Method citations (from the substantiation register; cite what you report):');
                for (const e of entries) {
                    lines.push(`- ${e!.method}: ${e!.citation}${e!.status !== 'validated' ? ` [status: ${e!.status}]` : ''}`);
                }
            }
        }
    } else {
        lines.push('== Bundled lexicons (cite the ones you used; per-run: tass cite --manifest <output>.manifest.json) ==');
        for (const id of listBundled()) {
            const l = loadBundled(id);
            lines.push(`- ${l.name}${l.license ? ` [${l.license}]` : ''}${l.citation ? ` — ${l.citation}` : ''}`);
        }
    }
    const output = one(args, '--output');
    if (output) {
        writeFileSync(output, lines.join('\n') + '\n');
        io.err(`citation block (${style}) -> ${output}`);
    } else {
        for (const l of lines) { io.out(l); }
    }
    return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// merge-labels — join externally produced labels (e.g. an LLM classifier driven via MCP)
// onto a corpus as ordinary columns. TASS never calls a model (Constraint 2): labels enter
// as DATA, and the manifest records their file hash + external-classifier provenance.
// ─────────────────────────────────────────────────────────────────────────────

function cmdMergeLabels(args: ParsedArgs, io: Io): number {
    const input = one(args, '--input');
    if (!input) { throw new UsageError('merge-labels needs -i/--input (the corpus CSV)'); }
    const labelsPath = one(args, '--labels');
    if (!labelsPath) { throw new UsageError('merge-labels needs --labels (the label CSV to join)'); }
    const key = one(args, '--key');
    if (!key) { throw new UsageError('merge-labels needs --key (the shared key column name)'); }
    const output = one(args, '--output');
    if (!output) { throw new UsageError('merge-labels needs -o/--output (path for the merged CSV)'); }
    const prefix = one(args, '--prefix') ?? '';

    const corpus = parseCsv(readFileSync(input, 'utf8'));
    const labels = parseCsv(readFileSync(labelsPath, 'utf8'));
    if (corpus.length < 2 || labels.length < 1) { throw new UsageError('merge-labels: both CSVs need a header row (and the corpus needs data)'); }
    const cKey = corpus[0].indexOf(key);
    if (cKey < 0) { throw new UsageError(`key '${key}' not in corpus — columns: ${corpus[0].join(', ')}`); }
    const lKey = labels[0].indexOf(key);
    if (lKey < 0) { throw new UsageError(`key '${key}' not in labels — columns: ${labels[0].join(', ')}`); }

    const labelCols = labels[0].map((h, i) => ({ h: prefix + h, i })).filter(c => c.i !== lKey);
    const collisions = labelCols.filter(c => corpus[0].includes(c.h)).map(c => c.h);
    if (collisions.length) {
        throw new UsageError(`label column(s) already exist in the corpus: ${collisions.join(', ')} — use --prefix to namespace them`);
    }
    const byKey = new Map<string, string[]>();
    for (let r = 1; r < labels.length; r++) {
        const k = labels[r][lKey] ?? '';
        if (byKey.has(k)) { throw new UsageError(`labels: duplicate key '${k}' (row ${r + 1}) — one label row per key`); }
        byKey.set(k, labels[r]);
    }

    let matched = 0;
    const rows: string[][] = [[...corpus[0], ...labelCols.map(c => c.h)]];
    for (let r = 1; r < corpus.length; r++) {
        const lab = byKey.get(corpus[r][cKey] ?? '');
        if (lab) { matched++; }
        rows.push([...corpus[0].map((_, i) => corpus[r][i] ?? ''), ...labelCols.map(c => lab ? (lab[c.i] ?? '') : '')]);
    }
    writeFileSync(output, stringifyCsv(rows));
    io.err(`merged ${labelCols.length} label column(s): ${matched}/${corpus.length - 1} corpus rows matched, `
        + `${byKey.size - matched} label row(s) unmatched -> ${output}`);
    io.err('provenance: labels are recorded as external-classifier data (TASS did not produce them).');

    const manifest = buildScoreManifest({
        tool: '@simdad/tass-cli', toolVersion: VERSION, command: 'merge-labels',
        settings: {
            key, prefix, labelColumns: labelCols.map(c => c.h),
            labelProvenance: 'external-classifier',
        },
        inputs: [input, labelsPath], lexicons: [], academicOnlyUsed: [], outputs: [output],
    });
    writeFileSync(`${output}.manifest.json`, JSON.stringify(manifest, null, 1) + '\n');
    io.err(`run manifest (provenance block) -> ${output}.manifest.json`);
    return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// import-csv / template — the spreadsheet dictionary authoring path (Constraint 8)
// ─────────────────────────────────────────────────────────────────────────────

function cmdImportCsv(args: ParsedArgs, io: Io): number {
    const input = one(args, '--input');
    if (!input) { throw new UsageError('import-csv needs -i/--input (a dictionary CSV — get a starting point via: tass template)'); }
    const output = one(args, '--output');
    if (!output) { throw new UsageError('import-csv needs -o/--output (lexicon JSON path)'); }
    const { lexicon, warnings } = parseLexiconCsv(readFileSync(input, 'utf8'), {
        id: one(args, '--id'),
        name: one(args, '--name'),
        license: one(args, '--license'),
        citation: one(args, '--citation'),
        language: one(args, '--language'),
        description: one(args, '--description'),
    });
    for (const w of warnings) { io.err(`warning: ${w}`); }
    writeFileSync(output, JSON.stringify(lexicon, null, 1) + '\n');
    const terms = lexicon.categories.reduce((n, c) => n + c.terms.length, 0);
    io.err(`imported ${lexicon.categories.length} categories, ${terms} terms -> ${output} — use via --lexicons ${output}`);
    return 0;
}

function cmdTemplate(args: ParsedArgs, io: Io): number {
    const output = one(args, '--output');
    if (output) {
        writeFileSync(output, LEXICON_CSV_TEMPLATE);
        io.err(`dictionary template -> ${output} — fill in Excel/Sheets, save as CSV, then: tass import-csv`);
    } else {
        io.out(LEXICON_CSV_TEMPLATE);
    }
    return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// entry
// ─────────────────────────────────────────────────────────────────────────────

const USAGE = `TASS — Text Analysis for Social Scientists (CLI ${VERSION})

usage:
  tass dicts [--json]
      List bundled lexicons (license, class, size, citation). --json emits the machine form.

  tass analyze --text "…" | --stdin | -i file.txt
               [--lexicons afinn,vader,…] [--all]
      Score raw text directly and print JSON to stdout (totalTokens + per-category hits,
      weighted, percent, mean, matched forms). Zero-hit categories are omitted unless --all.
      The direct machine/AI surface — no CSV round-trip needed.

  tass ingest -i transcripts-folder -o turns.csv [--format transcript|chat]
      Turn-level CSV (session, turn, timestamp, seconds, speaker, text) from either
      speaker-labeled transcripts ([M:SS] **SPEAKER:** …; the default) or, with --format chat,
      IRC/Twitch-style chat logs ([stamp] <user> text  or  [stamp] user: text — one message
      per line; seconds are relative to each session's first message).

  tass score -i turns.csv --text-column text -o scored.csv
             [--lexicons afinn,vader,… | path/to/lexicon.json]
             [--metrics percent,hits,weighted,mean]      (default: percent; mean = weighted/hits)
             [--group-column speaker,session --group-summary means.csv]
             [--window 300 --time-column seconds --trajectories traj.csv]
             [--json rows.json] [--citations cites.txt] [--workers 4]
      Score documents (CSV rows, or TXT files via repeated -i). Output = input columns +
      tass_tokens + one column per lexicon_category_metric. Every run writes
      <output>.manifest.json — input hashes + full lexicon provenance (Confirmed Packet).
      CSV input streams row-at-a-time (memory stays flat at any corpus size); --workers N
      (1-32) scores in parallel worker threads with byte-identical output (default: single-
      threaded).

  tass exemplars -i turns.csv --text-column text --lexicon empath --category health
                 [--metric percent] [--top 10] [--bottom 5] [-o exemplars.csv]
      Highest/lowest-scoring documents with their matched terms — score-to-quote trace-back.

  tass kwic -i turns.csv --text-column text -q "happi*" [--window 7] [--max 100]
      Keyword-in-context concordance (stem wildcard with trailing *).

  tass cite [--manifest scored.csv.manifest.json] [--style apa|mla|chicago] [-o cites.txt]
      The citation block: the TASS software citation (styled), every lexicon a run used
      (canonical citation strings from the manifest), academic-only flags, and, for stats
      runs with the statistics engine installed, the method citations to report.

  tass search [term]
  tass install <name>[@version]
      The public dictionary registry (SIM-DAD/tass-lexicons): list open, citable lexicons
      and install one by name (sha256-verified; citation metadata travels into every
      manifest). Installed lexicons resolve by bare id, exactly like bundled ones.
      TASS_REGISTRY overrides the registry URL (mirrors). Explicit network use only.

  tass merge-labels -i corpus.csv --labels labels.csv --key id -o merged.csv [--prefix llm_]
      Join externally produced labels (human coders, or an LLM driven via MCP) onto a corpus
      by a shared key column. Labels become ordinary columns; the manifest records the label
      file's hash and external-classifier provenance. TASS itself never calls a model.

  tass template [-o my-dictionary.csv]
      Write the spreadsheet dictionary template (fill in Excel/Google Sheets, save as CSV).

  tass import-csv -i my-dictionary.csv -o my-dictionary.json
                  [--id ID --name NAME --license L --citation C --language en --description D]
      Convert a spreadsheet-authored dictionary (columns: category, term, optional weight,
      optional category_label; metadata via leading #key: value lines, flags win). Errors are
      row-numbered and ALL reported at once. License + citation are required before a
      dictionary can be published to the registry.

  tass import-dic -i mydict.dic -o mydict.json [--id ID --name NAME]
      Convert a LIWC-format .dic YOU licensed into a lexicon JSON usable via --lexicons.

  tass import-nrc -i NRC-Emotion-Lexicon-Wordlevel.txt -o nrc.json [--id ID]
      Convert your licensed NRC EmoLex wordlist (marked academic-only; runs are flagged).

  tass import-socialsent -i subreddits/ --subreddit gaming -o gaming.json [--id ID]
      Convert a SocialSent community/decade TSV (word mean std; PDDL, commercial-ok) into a
      lexicon JSON — -i may be the .tsv itself or the unzipped subreddits folder.

  tass project <save|show|rerun|diff> …
      Reproducible .tassproj containers: archive a run (config + hashes + lexicon snapshots
      + artifacts), verify + inspect, RE-RUN with byte-identity checking, and diff two runs.
      Run "tass project help" for full usage.

  tass validation <sample|import|export|summary> …
      Human validation of match units, inside the .tassproj: a deterministic review sheet
      (sample), coded verdicts written into the project's validation/ member (import),
      records with attached/orphaned status (export), and per-category precision-proxy
      counts (summary). Verdicts are keyed by content-derived IDs, so identical re-runs
      reattach them and changed inputs orphan them VISIBLY. Run "tass validation help".

  tass viz <bar|grouped-bar|box|violin|means|scatter|trajectory|heatmap> …
      Publication charts as deterministic SVG with embedded data tables (requires
      @simdad/tass-viz; run "tass viz help" for full usage).

  tass stats <compare|describe|correlate> …
      Inferential statistics over scored CSVs (requires @simdad/tass-stats; run
      "tass stats help" for full usage). Group comparisons with effect sizes, assumption
      checks, corrections, and post-hoc; descriptives; correlations.

  tass mcp
      Serve the engine over the Model Context Protocol (stdio, JSON-RPC 2.0) so AI agents can
      drive TASS as tools: tass_dicts, tass_analyze_text, tass_score_file, tass_ingest,
      tass_exemplars, tass_kwic (+ tass_stats_* when @simdad/tass-stats is installed).
      Register e.g.: claude mcp add tass -- tass mcp

  tass gui [--port 7770] [--no-open]
      The human GUI: a local web app (127.0.0.1 only) over the same engine — analyze text,
      score files, KWIC, exemplars, browse the dictionary bundle. Opens your browser.

Sentiment flags (analyze + score): --vader-rules adds the TASS implementation of the published
VADER heuristics (negation, boosters, ALL-CAPS, punctuation, but-clauses, emoticons, idiom
tables) over the bundled vader lexicon. Report as "TASS VADER-rules compound" — tokenizer
corner cases and emoji handling differ, so values can deviate slightly from the reference.
`;

/** CLI entry. Returns the process exit code (0 ok, 1 usage, 2 runtime). */
export function main(argv: string[], io?: Io): number {
    const realIo: Io = io ?? {
        out: l => process.stdout.write(l + '\n'),
        err: l => process.stderr.write(l + '\n'),
    };
    try {
        // Bare `tass --version` / `tass --help`: the "command" is itself a flag — parse it as one.
        const flagFirst = argv[0]?.startsWith('-') ?? false;
        const cmd = flagFirst ? undefined : argv[0];
        if (cmd === 'project') {
            // Own argv space (like stats): booleans such as --embed-corpus parse locally.
            // Lazy require avoids a load-time cycle (project-cmd imports main from here).
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { runProjectCommand } = require('./project-cmd') as typeof import('./project-cmd');
            return runProjectCommand(argv.slice(1), realIo);
        }
        if (cmd === 'validation') {
            // Own argv space (like project); lazy require keeps the load path uniform.
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { runValidationCommand } = require('./validation-cmd') as typeof import('./validation-cmd');
            return runValidationCommand(argv.slice(1), realIo);
        }
        if (cmd === 'help' && argv[1]) {
            // Task-oriented topics; `tass help` alone lists them below the usage block.
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { helpTopic, helpIndex } = require('./help-topics') as typeof import('./help-topics');
            const topic = helpTopic(argv[1]);
            if (topic) {
                realIo.out(`${topic.title}\n${'='.repeat(topic.title.length)}\n\n${topic.body}`);
                return 0;
            }
            realIo.err(`no help topic "${argv[1]}"\n`);
            realIo.out(helpIndex());
            return 1;
        }
        if (cmd === 'viz') {
            const viz = loadViz();
            if (!viz) {
                throw new UsageError('tass viz requires @simdad/tass-viz (the TASS chart engine) — not installed in this edition');
            }
            return viz.runVizCommand(argv.slice(1), realIo);
        }
        if (cmd === 'stats') {
            // Plugin seam (Modern Build Plan Section 5): the stats package owns its own argv.
            const stats = loadStats();
            if (!stats) {
                throw new UsageError('tass stats requires @simdad/tass-stats (the TASS statistics engine) — not installed in this edition');
            }
            return stats.runStatsCommand(argv.slice(1), realIo);
        }
        const args = parseArgs(flagFirst ? argv : argv.slice(1),
            new Set(COMMAND_BOOLEANS[cmd ?? ''] ?? []));
        if (!cmd && args.flags.has('--version')) { realIo.out(VERSION); return 0; }
        if (!cmd || cmd === 'help' || args.flags.has('--help')) {
            realIo.out(USAGE);
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { helpIndex } = require('./help-topics') as typeof import('./help-topics');
            realIo.out('\n' + helpIndex());
            return 0;
        }
        if (args.flags.has('--version')) { realIo.out(VERSION); return 0; }
        switch (cmd) {
            case 'dicts': return cmdDicts(args, realIo);
            case 'analyze': return cmdAnalyze(args, realIo);
            case 'ingest': return cmdIngest(args, realIo);
            case 'score': return cmdScore(args, realIo);
            case 'exemplars': return cmdExemplars(args, realIo);
            case 'kwic': return cmdKwic(args, realIo);
            case 'cite': return cmdCite(args, realIo);
            case 'merge-labels': return cmdMergeLabels(args, realIo);
            case 'import-csv': return cmdImportCsv(args, realIo);
            case 'template': return cmdTemplate(args, realIo);
            case 'import-dic': return cmdImportDic(args, realIo);
            case 'import-nrc': return cmdImportNrc(args, realIo);
            case 'import-socialsent': return cmdImportSocialsent(args, realIo);
            case 'install':
            case 'search': {
                // Async network commands (explicit, user-initiated — one of the three
                // sanctioned network touchpoints). The promise keeps the process alive;
                // the exit code lands when it settles.
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const registry = require('./registry') as typeof import('./registry');
                const task = cmd === 'install'
                    ? (() => {
                        const spec = args.positional[0];
                        if (!spec) { throw new UsageError('install needs a lexicon name — see: tass search'); }
                        return registry.installLexicon(spec, realIo);
                    })()
                    : registry.searchRegistry(args.positional[0], realIo);
                task.then(c => { process.exitCode = c; })
                    .catch((e: unknown) => { process.exitCode = renderError(e, realIo); });
                return 0;
            }
            case 'mcp':
                // Long-running stdio server; the launcher uses process.exitCode (not exit()),
                // so returning here leaves the stdin listener alive until the client closes it.
                require('./mcp').serveMcp();
                return 0;
            case 'gui': {
                const portSpec = one(args, '--port');
                const port = portSpec === undefined ? 7770 : Number(portSpec);
                if (!Number.isInteger(port) || port < 0 || port > 65535) {
                    throw new UsageError('--port must be an integer 0-65535 (0 = pick a free port)');
                }
                require('./gui').serveGui(port, !args.flags.has('--no-open'), realIo);
                return 0;
            }
            default:
                throw new UsageError(`unknown command '${cmd}' — run: tass help`);
        }
    } catch (e) {
        return renderError(e, realIo);
    }
}
