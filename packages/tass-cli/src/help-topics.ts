/**
 * TASS help topics: ONE content table rendered by every surface (CLI `tass help <topic>`,
 * the Community web GUI's Help drawer, and the desktop workbench's Help stage). Plain text
 * with blank-line paragraphs; surfaces may lightly format (the GUIs bold the `command`
 * lines) but never rewrite. Keep the prose task-oriented: every topic answers "how do I",
 * shows a runnable example, and says where the result lands.
 */

export interface HelpTopic {
    id: string;
    title: string;
    /** One line shown in the topic list. */
    summary: string;
    /** The topic body: plain text, paragraphs separated by blank lines, examples indented. */
    body: string;
}

export const HELP_TOPICS: HelpTopic[] = [
    {
        id: 'getting-started',
        title: 'Getting started',
        summary: 'Your first analysis in five minutes: score a file, read the output.',
        body: `TASS scores text against dictionaries (lexicons): lists of words and phrases that
indicate a category such as positive sentiment, politeness, or concreteness. The result is a
number per document per category, plus the receipts to defend that number in a paper.

Score a CSV where each row is a document:

    tass score --input posts.csv --text-column text --lexicons vader,afinn --output scored.csv

That writes scored.csv (your file plus one column per lexicon category) and
scored.csv.manifest.json (the provenance record: exact versions, input hashes, licenses,
citations). Nothing leaves your machine.

Try a single text with no files involved:

    tass analyze --text "What a wonderful day" --vader-rules

See which dictionaries are available and what they measure:

    tass dicts

Prefer a point-and-click version? Run "tass gui" and your browser opens a local workbench.
The desktop GUI Edition adds statistics, charts, and reports on the same engine.

Where to go next: "tass help scoring" for metrics and groups, "tass help dictionaries" to
pick lexicons wisely, "tass help projects" to make any run reproducible.`,
    },
    {
        id: 'scoring',
        title: 'Scoring files',
        summary: 'Metrics, group summaries, trajectories, and what the numbers mean.',
        body: `The default metric is percent: of a document's words, how many hit the category,
scaled to 100. A 3.2 on vader_positive means 3.2 percent of the tokens were positive words.
Four metrics exist:

    percent   hits per 100 tokens (comparable across documents of different lengths)
    hits      raw match count (comparable only within similar-length documents)
    weighted  sum of matched term weights (for weighted lexicons such as AFINN)
    mean      average weight of the matched terms (blank when nothing matched)

Ask for several at once:

    tass score -i posts.csv --text-column text -o scored.csv --metrics percent,hits,weighted

Group summaries aggregate by any column (speaker, condition, session):

    tass score ... --group-column speaker --group-summary groups.csv

Trajectories slice scores into time windows when your data has a seconds column (transcripts
ingested by "tass ingest" have one):

    tass score ... --window 300 --time-column seconds --trajectories traj.csv

Blank text scores blank, never zero: a missing document is not a neutral document. Every run
writes a manifest next to the output; keep it with your data, it is your methods paragraph.

Large files: add --workers 4 to use four threads. Output is byte-identical either way.`,
    },
    {
        id: 'dictionaries',
        title: 'Choosing dictionaries',
        summary: 'What is bundled, what the license classes mean, when to import your own.',
        body: `List the bundle with "tass dicts". Each entry shows the license, its class, the
required citation, and the categories with term counts.

License classes matter in print:

    commercial-ok   bundled set: verified for any use including commercial
    academic-only   never bundled; applies to resources you import yourself (NRC, LIWC)

When a run touches an academic-only resource, TASS says so on stderr and in the manifest, so
a reviewer can see exactly what your numbers rest on.

Rules of thumb: VADER for social-media sentiment; AFINN or labMT for simple valence;
Warriner VAD for valence, arousal, and dominance norms; concreteness and age-of-acquisition
for psycholinguistic work; politeness for interaction styles; Empath for broad topical
categories. Read docs/METHODS.md before reporting any number: it states what each lexicon
can and cannot claim.

Install more by name from the public registry:

    tass search sentiment
    tass install politeness

Or bring your own: "tass help authoring" covers the spreadsheet path, and "tass import-dic"
imports LIWC-format .dic files you have licensed.`,
    },
    {
        id: 'authoring',
        title: 'Authoring a dictionary',
        summary: 'Build your own lexicon in a spreadsheet and validate it row by row.',
        body: `A TASS dictionary is a list of terms in categories, optionally weighted. You can
author one in any spreadsheet:

    tass template --output my-dictionary.csv

Open that file in Excel or Google Sheets. One row per term: category, term, optional weight.
Terms may be single words (happy), stems (happi*), or multi-word phrases (thank you so much).
When you are done:

    tass import-csv --input my-dictionary.csv --name "My Constructs" --output my-constructs.json

Validation is strict and helpful: every problem is reported with its row number, all at once,
so one pass fixes everything. Then score with it:

    tass score -i posts.csv --text-column text --lexicons ./my-constructs.json -o scored.csv

The manifest records your dictionary's hash, so the exact word list travels with the result.

Want others to use it? The public registry accepts contributions with authorship credit and
an open license (CC-BY-4.0 or ODC-BY, citation required, commercial use welcome). See
"tass help registry".`,
    },
    {
        id: 'registry',
        title: 'The dictionary registry',
        summary: 'Install open, citable lexicons by name; contribute your own.',
        body: `The TASS registry (github.com/SIM-DAD/tass-lexicons) hosts open dictionaries with
required citations. Search and install by name:

    tass search politeness
    tass install politeness

Installs are integrity-checked: the registry pins a SHA-256 per version and TASS verifies it
before writing to ~/.tass/lexicons. An installed dictionary is then usable by its id like any
bundled one, and its citation appears in "tass cite" output and every manifest.

If your institution mirrors the registry, point TASS at the mirror with the TASS_REGISTRY
environment variable.

Contributing: the registry's CONTRIBUTING.md covers the format (the same spreadsheet template
"tass template" produces), the review bar (construct documentation plus a scoring rationale),
and credit (dictionary authors are cited authors, not anonymous donors). Every TASS-native
dictionary is open by mandate, never paywalled.`,
    },
    {
        id: 'projects',
        title: 'Reproducible projects',
        summary: 'Archive a run as one file; prove months later that it reproduces.',
        body: `A .tassproj file is a complete, integrity-checked archive of one analysis: the
configuration, the corpus (by reference and hash, or embedded), any custom dictionaries, and
every result file.

    tass project save --output study1.tassproj --config scored.csv.manifest.json
    tass project show --project study1.tassproj

The flagship command is rerun: it re-executes the archived configuration and byte-compares
every artifact.

    tass project rerun --project study1.tassproj

The answer is REPRODUCED, or a precise report of what moved. Reviewers and future-you get
the same guarantee: this number came from this data through this configuration.

Compare two projects, or a project against its own rerun:

    tass project diff --a study1.tassproj --b study1-revised.tassproj

Human verdicts from validation (see "tass help validation") live inside the project too, so
the evidence that your dictionary measures what you claim travels with the analysis.

Tamper protection: a project whose results were edited by hand loud-fails on load. The only
reviewer-mutable member is the validation record set, which is excluded from the integrity
hash by design.`,
    },
    {
        id: 'validation',
        title: 'Validating scores',
        summary: 'Human-check a sample of matches; report agreement instead of hope.',
        body: `Dictionary scores are only as good as the dictionary's fit to YOUR corpus. The
validation workflow makes the fit checkable and reportable.

Draw a deterministic sample of matches to review:

    tass validation sample --input scored.csv --output review.csv

review.csv has one row per sampled match: the document, the category, the matched term, a
text excerpt, and empty verdict and memo columns. Any spreadsheet works; mark each verdict
correct, incorrect, or unsure, add memos where the call was interesting.

Attach the finished sheet to your project and summarize:

    tass validation import --project study1.tassproj --input review.csv
    tass validation summary --project study1.tassproj

The summary reports counts and a precision proxy per category. In the GUI Edition, the
Validate stage does this in place, and with two coders the reliability statistics (Cohen's
kappa, Krippendorff's alpha) quantify agreement.

Verdicts survive reruns: identical inputs reattach every verdict; changed inputs mark
affected verdicts as from a previous run, visibly, never silently.`,
    },
    {
        id: 'stats',
        title: 'Statistics (GUI Edition)',
        summary: 'Group comparisons with assumption checks, corrections, and APA output.',
        body: `With the statistics module installed, "tass stats" runs the inferential suite over
any scored CSV:

    tass stats compare --input scored.csv --group-column condition \\
        --value-columns vader_positive_percent --output results.csv --apa apa.txt

TASS picks the standard test shape (two groups: Welch's t by default; three or more: ANOVA
variants; nonparametric alternatives on request), reports effect sizes with plain-language
labels, checks assumptions (Shapiro-Wilk normality, Levene homogeneity) and REPORTS them
without silently switching tests, corrects p-values across columns (Benjamini-Hochberg by
default), and runs post-hoc comparisons after a significant omnibus.

The --apa file is a paste-ready APA 7 summary plus a generated methods note. The --r-script
flag writes a base-R script that reproduces the run independently: hand it to the skeptical
reviewer.

Every method is published, cited, and benchmarked against R golden files; the benchmark
report ships with each release. "tass stats describe" gives descriptives,
"tass stats correlate" correlations, "tass stats reliability" coder agreement,
"tass stats readability" readability indices.

Statistical guidance, not statistical authority: TASS shows its reasoning and its checks,
and the analytic decision stays yours.`,
    },
    {
        id: 'charts',
        title: 'Charts (GUI Edition)',
        summary: 'Publication-ready deterministic SVG charts from any scored output.',
        body: `With the chart module installed, "tass viz" renders eight publication chart types
(bar, grouped bar, box, violin, means with confidence intervals, scatter, trajectory,
heatmap) as deterministic SVG:

    tass viz means --input scored.csv --group-column condition \\
        --value-column vader_positive_percent --output fig1.svg

Design guarantees: a colorblind-safe palette (Okabe-Ito), series distinguishable beyond
color (markers, dashes, hatching), the plotted numbers embedded in the file as a data table
(screen readers and reviewers can read the exact values), and byte-identical output for
identical input, so your figure is as reproducible as your analysis. The desktop workbench
adds PNG export for journals that require raster.`,
    },
    {
        id: 'mcp',
        title: 'AI-driven analysis (MCP)',
        summary: 'Serve the whole engine as tools for AI agents; TASS itself never calls a model.',
        body: `"tass mcp" turns the engine into an MCP (Model Context Protocol) server over stdio.
Any MCP client can then drive the full workflow: list dictionaries, score files, pull
exemplars and KWIC lines, run statistics, save and rerun projects.

Register it with Claude Code:

    claude mcp add --scope user tass -- tass mcp

Then ask the agent to, say, "score survey.csv against VADER and politeness, compare
conditions, and give me the APA paragraph." Every artifact the agent produces carries the
same manifests and citations as a hand-run analysis: provenance does not care who typed.

The division of labor is deliberate: TASS never calls a language model. If you want LLM
labels (for constructs no word list can capture), have YOUR agent produce them and merge:

    tass merge-labels --input scored.csv --labels labels.csv --output merged.csv

The merge records external-classifier provenance in the manifest, so the paper can say
precisely which numbers came from a model. AGENTS.md in the repo is the full operating
contract for agents.`,
    },
    {
        id: 'determinism',
        title: 'Determinism and provenance',
        summary: 'Why identical inputs give byte-identical outputs, and what the manifest proves.',
        body: `Reproducibility in TASS is enforced, not aspirational. The engine has no clocks and
no randomness: fixed column orders, stable sorts, one fixed-precision number formatter.
Same input, same configuration: byte-identical output, on Windows, macOS, and Linux.
Continuous integration runs a cross-platform hash gate on every change.

The manifest (written next to every scored output) records: TASS and engine versions, the
SHA-256 of every input, every dictionary's id, version, license, class, and citation, and
the exact settings of the run. That file is your Confirmed-Packet: the complete answer to
"where did this number come from".

Practical payoffs: "tass project rerun" can promise REPRODUCED because byte-identity is
checkable. Two labs can verify each other's runs by comparing hashes. And a determinism bug
is treated as a product defect, not a curiosity.

The one deliberate exception: validation verdicts are human input, stored alongside results
but excluded from the integrity hash, because reviewers add them after the fact.`,
    },
    {
        id: 'licenses',
        title: 'Licenses and editions',
        summary: 'What is open, what is commercial, and what you may use where.',
        body: `The code: the TASS engine, CLI, MCP server, minimal web GUI, and project container
are open source under Apache-2.0 (the Community Edition). The desktop workbench, statistics,
charts, and export tooling are the commercial GUI Edition. Both run the same engine; the
commercial methods are publicly documented, cited, and benchmarked even where the code is
private.

The dictionaries: every TASS-native dictionary is open (CC-BY-4.0 or ODC-BY), citation
required, commercial use welcome, installable free in every edition. Dictionaries are never
a paid feature.

The bundled third-party lexicons are verified commercial-ok, each under its own open license
with its citation carried in "tass dicts", "tass cite", and every manifest.

Restricted resources (NRC, LIWC, General Inquirer and similar) are never bundled. If you
hold a license, import yours; TASS flags every run that touches one academic-only, in the
manifest and on stderr, so a commercial deliverable cannot quietly rest on an academic-only
resource.

Your data never leaves your machine in any edition. The only network calls are the ones you
ask for by name: registry installs, the update check, license activation.`,
    },
    {
        id: 'troubleshooting',
        title: 'Troubleshooting',
        summary: 'The errors you will actually see, and the fastest way out of each.',
        body: `TASS errors carry a stable code and a hint; the hint is usually the fix. The common
ones:

"column not found": your --text-column (or group/value column) is not in the CSV header.
Check spelling and case; "tass score" with no --text-column lists what it found.

"not a lexicon id, file, or installed name": the --lexicons entry matches nothing. "tass
dicts" lists bundled ids; a path must exist; "tass install <name>" fetches from the registry.

Row-numbered import errors: dictionary CSV validation reports every bad row at once (unknown
category, empty term, bad weight). Fix the listed rows and re-import; nothing was written.

"integrity check failed" on a project: the archive was edited outside TASS or corrupted in
transit. Restore from your original; the message names the member that moved. Validation
verdicts never trip this.

Scores look like zero everywhere: usually the text column holds ids or filenames rather than
text, or the corpus language does not match the lexicon. "tass kwic" on a frequent word shows
you instantly what the tokenizer saw.

A number surprises you: "tass exemplars" shows the highest and lowest scoring documents with
their matched terms; most surprises are one ambiguous term doing heavy lifting, and the
validation workflow ("tass help validation") turns that suspicion into evidence.

Still stuck: every command prints usage with --help; docs/METHODS.md explains what each
measure can claim; the GUI Editions include this help under the Help button.`,
    },
];

export function helpTopic(id: string): HelpTopic | undefined {
    return HELP_TOPICS.find(t => t.id === id);
}

/** The `tass help` index: one line per topic, aligned, plain text. */
export function helpIndex(): string {
    const w = Math.max(...HELP_TOPICS.map(t => t.id.length));
    return [
        'TASS help topics ("tass help <topic>"):',
        '',
        ...HELP_TOPICS.map(t => `  ${t.id.padEnd(w)}  ${t.summary}`),
        '',
        'Command usage: any command with --help, e.g. "tass score --help".',
    ].join('\n');
}
