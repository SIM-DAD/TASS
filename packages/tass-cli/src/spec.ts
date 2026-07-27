/**
 * The shared tool/command spec (R7 of the Modern Build Plan refactor): ONE table describing
 * every MCP-exposed capability. From this table are GENERATED (a) the MCP inputSchema of each
 * tool and (b) the argv the tool builds for the CLI, and from it are DERIVED the CLI's
 * per-command boolean-flag sets. The CLI flag definitions and the MCP schemas therefore
 * cannot drift: there is nothing to keep in sync by hand.
 *
 * CLI-only flags that no MCP tool exposes (e.g. analyze --stdin, gui --no-open) live in
 * CLI_ONLY_BOOLEANS below — explicitly, so the exception list is visible in the same file.
 */

export type ArgKind = 'string' | 'int' | 'boolean' | 'list';

export interface ArgSpec {
    /** MCP argument name (snake_case). */
    name: string;
    /** CLI flag it maps to ('--text-column'). Booleans are pushed bare when true. */
    flag: string;
    kind: ArgKind;
    required?: boolean;
    /** list only: repeat the flag per value (-i a -i b) instead of comma-joining. */
    repeat?: boolean;
    /** Allowed values (string: enum of the value; list: enum of the items). */
    enum?: string[];
    description: string;
}

export interface ToolSpec {
    /** MCP tool name. */
    tool: string;
    /** CLI command word the tool runs. */
    command: string;
    /** Fixed argv always appended after the command (e.g. dicts --json). */
    fixedArgv?: string[];
    description: string;
    args: ArgSpec[];
    /** How stdout is shaped into the tool result: JSON passthrough vs status envelope. */
    render: 'passthrough' | 'envelope';
}

const LEXICONS: ArgSpec = {
    name: 'lexicons', flag: '--lexicons', kind: 'list',
    description: 'Lexicons to use: bundled ids (see tass_dicts) and/or absolute paths to lexicon JSON files. Comma-separated string also accepted. Omit for the full bundled set.',
};

const INPUT = (what: string): ArgSpec => ({
    name: 'input', flag: '--input', kind: 'list', repeat: true, required: true,
    description: `Input path(s): ${what}`,
});

const TEXT_COLUMN: ArgSpec = {
    name: 'text_column', flag: '--text-column', kind: 'string',
    description: 'CSV column holding the document text.',
};

export const TOOL_SPECS: ToolSpec[] = [
    {
        tool: 'tass_dicts', command: 'dicts', fixedArgv: ['--json'], render: 'passthrough',
        description: 'List the bundled TASS lexicons with license, license class (commercial-ok vs academic-only), citation, and per-category term counts. Call this first to learn valid lexicon and category ids.',
        args: [],
    },
    {
        tool: 'tass_analyze_text', command: 'analyze', render: 'passthrough',
        description: 'Score raw text against TASS lexicons and return JSON: total tokens plus per-category hits, weighted sum, percent-of-tokens, mean weight, and the matched word forms. Deterministic (same input => identical output). Zero-hit categories are omitted unless include_zero is true.',
        args: [
            { name: 'text', flag: '--text', kind: 'string', required: true, description: 'The text to analyze.' },
            LEXICONS,
            { name: 'include_zero', flag: '--all', kind: 'boolean', description: 'Include categories with zero hits (default false).' },
            { name: 'vader_rules', flag: '--vader-rules', kind: 'boolean', description: 'Also compute the TASS VADER-rules sentiment (negation, boosters, caps, punctuation, but-clauses); returned as a vaderRules block.' },
        ],
    },
    {
        tool: 'tass_score_file', command: 'score', render: 'envelope',
        description: 'Score a CSV (row = document; requires text_column) or one/more TXT files against TASS lexicons, writing a scored CSV plus optional group summary, windowed trajectories, JSON rows, and citations. Every run also writes <output>.manifest.json: input SHA-256 hashes and full lexicon provenance. Paths must be absolute.',
        args: [
            INPUT('one CSV, or one or more TXT files.'),
            { name: 'output', flag: '--output', kind: 'string', required: true, description: 'Path for the scored CSV.' },
            { ...TEXT_COLUMN, description: 'CSV column holding the document text (required for CSV input).' },
            LEXICONS,
            { name: 'metrics', flag: '--metrics', kind: 'list', enum: ['percent', 'hits', 'weighted', 'mean'], description: "Metrics per category (default 'percent'). 'mean' = weighted/hits, blank when no hits." },
            { name: 'group_column', flag: '--group-column', kind: 'list', description: 'CSV column(s) to group by, e.g. ["speaker","session"].' },
            { name: 'group_summary', flag: '--group-summary', kind: 'string', description: 'Path for the per-group summary CSV (n, mean, sd, per-column n). Needs group_column.' },
            { name: 'window', flag: '--window', kind: 'int', description: 'Time-window size in seconds for trajectories.' },
            { name: 'time_column', flag: '--time-column', kind: 'string', description: 'CSV column with numeric seconds (ingest emits one). Needed with window.' },
            { name: 'trajectories', flag: '--trajectories', kind: 'string', description: 'Path for the windowed-trajectories CSV. Needs window + time_column.' },
            { name: 'json', flag: '--json', kind: 'string', description: 'Path for typed JSON rows of the scored output.' },
            { name: 'citations', flag: '--citations', kind: 'string', description: 'Path for a human-readable citations file.' },
            { name: 'vader_rules', flag: '--vader-rules', kind: 'boolean', description: 'Add vader_rules_{compound,positive,negative,neutral} columns (TASS VADER-rules layer).' },
            { name: 'workers', flag: '--workers', kind: 'int', description: 'Score with N parallel worker threads (integer 1-32). Output is byte-identical to single-threaded; default is single-threaded.' },
        ],
    },
    {
        tool: 'tass_ingest', command: 'ingest', render: 'envelope',
        description: 'Convert speaker-labeled transcripts ([M:SS] **SPEAKER:** … lines; .md/.txt files or folders of them), or, with format "chat", IRC/Twitch-style chat logs ([stamp] <user> text or [stamp] user: text), into a turn-level CSV with session, turn, timestamp, seconds, speaker, text columns (the shape tass_score_file expects). Paths must be absolute.',
        args: [
            INPUT('transcript/chat-log file(s) and/or folder(s).'),
            { name: 'output', flag: '--output', kind: 'string', required: true, description: 'Path for the turns CSV.' },
            { name: 'format', flag: '--format', kind: 'string', enum: ['transcript', 'chat'], description: 'Input shape: speaker-labeled transcript (default) or chat log.' },
        ],
    },
    {
        tool: 'tass_exemplars', command: 'exemplars', render: 'envelope',
        description: 'Trace-back: the highest/lowest-scoring documents for one lexicon category, with the exact matched terms; turns any score into quotable text. Input is a CSV (with text_column) or TXT files.',
        args: [
            INPUT('one CSV, or TXT files.'),
            TEXT_COLUMN,
            { name: 'lexicon', flag: '--lexicon', kind: 'string', required: true, description: 'One bundled id or a lexicon JSON path.' },
            { name: 'category', flag: '--category', kind: 'string', required: true, description: 'Category id within the lexicon (tass_dicts lists them).' },
            { name: 'metric', flag: '--metric', kind: 'string', enum: ['percent', 'hits', 'weighted', 'mean'], description: "Ranking metric (default 'percent')." },
            { name: 'top', flag: '--top', kind: 'int', description: 'How many top-scoring documents (default 10).' },
            { name: 'bottom', flag: '--bottom', kind: 'int', description: 'How many bottom-scoring documents (default 0).' },
            { name: 'output', flag: '--output', kind: 'string', description: 'Optional path for an exemplars CSV; omit to get lines back directly.' },
        ],
    },
    {
        tool: 'tass_kwic', command: 'kwic', render: 'envelope',
        description: 'Keyword-in-context concordance: every occurrence of a word (or stem* wildcard) with its surrounding context, tagged by document. Input is a CSV (with text_column) or TXT files.',
        args: [
            INPUT('one CSV, or TXT files.'),
            TEXT_COLUMN,
            { name: 'query', flag: '--query', kind: 'string', required: true, description: "The word to find, or a stem wildcard like 'happi*'." },
            { name: 'window', flag: '--window', kind: 'int', description: 'Context window in tokens per side (default 7).' },
            { name: 'max', flag: '--max', kind: 'int', description: 'Maximum concordance lines to return.' },
        ],
    },
];

const MERGE_LABELS_SPEC: ToolSpec = {
    tool: 'tass_merge_labels', command: 'merge-labels', render: 'envelope',
    description: 'Join externally produced labels (human coders, or an LLM classifier the agent ran itself) onto a corpus CSV by a shared key column. Label columns become ordinary data columns; the run manifest records the label file hash and external-classifier provenance. Paths must be absolute.',
    args: [
        { name: 'input', flag: '--input', kind: 'string', required: true, description: 'The corpus CSV.' },
        { name: 'labels', flag: '--labels', kind: 'string', required: true, description: 'The label CSV (one row per key).' },
        { name: 'key', flag: '--key', kind: 'string', required: true, description: 'Shared key column name.' },
        { name: 'output', flag: '--output', kind: 'string', required: true, description: 'Path for the merged CSV.' },
        { name: 'prefix', flag: '--prefix', kind: 'string', description: "Prefix for label column names (e.g. 'llm_')." },
    ],
};
TOOL_SPECS.push(MERGE_LABELS_SPEC);

const PROJECT_SPECS: ToolSpec[] = [
    {
        tool: 'tass_project_save', command: 'project', fixedArgv: ['save'], render: 'envelope',
        description: 'Archive a completed score run as a reproducible .tassproj container: config, input hashes, snapshots of user-supplied lexicons, and every artifact. Pass the <output>.manifest.json the run wrote. embed_corpus copies the corpus files into the archive (archival bundle); default references them by hash. Paths must be absolute.',
        args: [
            { name: 'manifest', flag: '--manifest', kind: 'string', required: true, description: "The run's <output>.manifest.json path." },
            { name: 'output', flag: '--output', kind: 'string', required: true, description: 'Destination .tassproj path.' },
            { name: 'embed_corpus', flag: '--embed-corpus', kind: 'boolean', description: 'Copy corpus files into the archive.' },
        ],
    },
    {
        tool: 'tass_project_rerun', command: 'project', fixedArgv: ['rerun'], render: 'envelope',
        description: 'Re-execute a .tassproj\'s saved configuration and byte-compare every artifact against the archive. Success text ends with REPRODUCED when all artifacts are byte-identical; a nonzero exit means a difference (or a changed referenced input), reported per artifact.',
        args: [
            { name: 'input', flag: '--input', kind: 'string', required: true, description: 'The .tassproj path.' },
            { name: 'dir', flag: '--dir', kind: 'string', description: 'Working directory for the rerun outputs (default: a temp dir).' },
        ],
    },
    {
        tool: 'tass_project_diff', command: 'project', fixedArgv: ['diff'], render: 'envelope',
        description: 'Compare two .tassproj runs: settings and lexicon changes, input content changes, and per-column scored-CSV deltas (changed-cell counts and max absolute change).',
        args: [
            { name: 'a', flag: '--a', kind: 'string', required: true, description: 'First .tassproj.' },
            { name: 'b', flag: '--b', kind: 'string', required: true, description: 'Second .tassproj.' },
        ],
    },
];

export { PROJECT_SPECS };

const VALIDATION_SPECS: ToolSpec[] = [
    {
        tool: 'tass_validation_sample', command: 'validation', fixedArgv: ['sample'], render: 'envelope',
        description: 'Write a deterministic human-review sheet (CSV) of match-level units: per category, the top-scoring matches plus an evenly strided spread; no RNG, two runs are byte-identical. Source is a .tassproj (project) OR a scored CSV (input + text_column). A human fills the verdict (correct/incorrect/unsure) and memo columns, then tass_validation_import writes them into the project. Paths must be absolute.',
        args: [
            { name: 'project', flag: '--project', kind: 'string', description: 'The .tassproj to sample from (uses its saved scored output and config).' },
            { name: 'input', flag: '--input', kind: 'string', description: 'A scored CSV to sample from directly (alternative to project; needs text_column).' },
            { name: 'output', flag: '--output', kind: 'string', required: true, description: 'Path for the review-sheet CSV.' },
            { name: 'per_category', flag: '--per-category', kind: 'int', description: 'Units to sample per category (default 10).' },
            { name: 'text_column', flag: '--text-column', kind: 'string', description: 'Scored-CSV column holding the document text (required with input).' },
            { name: 'lexicons', flag: '--lexicons', kind: 'list', description: 'Lexicon specs the score run used (with input; default: the full bundled set).' },
            { name: 'categories', flag: '--categories', kind: 'list', description: "Restrict to these categories: qualified 'lexicon:category' or bare category ids." },
        ],
    },
    {
        tool: 'tass_validation_import', command: 'validation', fixedArgv: ['import'], render: 'envelope',
        description: "Import a coded review sheet into the project's validation/ member. Verdicts must be correct/incorrect/unsure (blank = skipped); row errors are collected and ALL reported at once, row-numbered. Records are keyed by content-derived IDs, so identical re-runs reattach every verdict. Paths must be absolute.",
        args: [
            { name: 'project', flag: '--project', kind: 'string', required: true, description: 'The .tassproj to write validation records into.' },
            { name: 'input', flag: '--input', kind: 'string', required: true, description: 'The filled review-sheet CSV (from tass_validation_sample).' },
        ],
    },
    {
        tool: 'tass_validation_export', command: 'validation', fixedArgv: ['export'], render: 'envelope',
        description: "Export every stored validation record with its status: attached (id derivable from the current scored output) or orphaned (from a previous run; changed inputs orphan verdicts visibly, never silently). Paths must be absolute.",
        args: [
            { name: 'project', flag: '--project', kind: 'string', required: true, description: 'The .tassproj holding validation records.' },
            { name: 'output', flag: '--output', kind: 'string', required: true, description: 'Path for the records CSV (with a status column).' },
        ],
    },
    {
        tool: 'tass_validation_summary', command: 'validation', fixedArgv: ['summary'], render: 'passthrough',
        description: 'Per-category validation counts (correct/incorrect/unsure) and the precision proxy correct/(correct+incorrect), as JSON. Paths must be absolute.',
        args: [
            { name: 'project', flag: '--project', kind: 'string', required: true, description: 'The .tassproj holding validation records.' },
        ],
    },
];

export { VALIDATION_SPECS };

/** CLI-only boolean flags no MCP tool exposes (kept beside the specs so the exception is visible). */
export const CLI_ONLY_BOOLEANS: Record<string, string[]> = {
    dicts: ['--json'],
    analyze: ['--stdin'],
    gui: ['--no-open'],
};

/** Per-command boolean-flag sets for the CLI parser: derived from the specs + the CLI-only table. */
export function commandBooleans(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [cmd, flags] of Object.entries(CLI_ONLY_BOOLEANS)) { out[cmd] = [...flags]; }
    for (const spec of TOOL_SPECS) {
        const booleans = spec.args.filter(a => a.kind === 'boolean').map(a => a.flag);
        if (booleans.length) { out[spec.command] = [...(out[spec.command] ?? []), ...booleans]; }
    }
    return out;
}

/** Generate the MCP inputSchema for one tool from its spec. */
export function inputSchema(spec: ToolSpec): Record<string, unknown> {
    const properties: Record<string, unknown> = {};
    for (const a of spec.args) {
        switch (a.kind) {
            case 'string':
                properties[a.name] = { type: 'string', ...(a.enum ? { enum: a.enum } : {}), description: a.description };
                break;
            case 'int':
                properties[a.name] = { type: 'integer', description: a.description };
                break;
            case 'boolean':
                properties[a.name] = { type: 'boolean', description: a.description };
                break;
            case 'list':
                properties[a.name] = {
                    type: ['array', 'string'],
                    items: { type: 'string', ...(a.enum ? { enum: a.enum } : {}) },
                    description: a.description,
                };
                break;
        }
    }
    const required = spec.args.filter(a => a.required).map(a => a.name);
    return {
        type: 'object',
        properties,
        ...(required.length ? { required } : {}),
        additionalProperties: false,
    };
}

/** Build the CLI argv for one tool call from its spec. Throws Error on bad arguments. */
export function buildArgv(spec: ToolSpec, args: Record<string, unknown>): string[] {
    const argv: string[] = [spec.command, ...(spec.fixedArgv ?? [])];
    for (const a of spec.args) {
        const v = args[a.name];
        if (v === undefined || v === null) {
            if (a.required) { throw new Error(`missing required argument '${a.name}'`); }
            continue;
        }
        switch (a.kind) {
            case 'boolean':
                if (typeof v !== 'boolean') { throw new Error(`argument '${a.name}' must be a boolean`); }
                if (v) { argv.push(a.flag); }
                break;
            case 'int':
                if (typeof v !== 'number' || !Number.isFinite(v)) { throw new Error(`argument '${a.name}' must be a number`); }
                argv.push(a.flag, String(v));
                break;
            case 'string':
                if (typeof v !== 'string') { throw new Error(`argument '${a.name}' must be a string`); }
                argv.push(a.flag, v);
                break;
            case 'list': {
                let items: string[];
                if (typeof v === 'string') { items = v.split(',').map(s => s.trim()).filter(Boolean); }
                else if (Array.isArray(v) && v.every(x => typeof x === 'string')) { items = v as string[]; }
                else { throw new Error(`argument '${a.name}' must be a string or an array of strings`); }
                if (items.length === 0) { break; }
                if (a.repeat) { for (const item of items) { argv.push(a.flag, item); } }
                else { argv.push(a.flag, items.join(',')); }
                break;
            }
        }
    }
    return argv;
}
