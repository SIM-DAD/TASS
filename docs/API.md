# @simdad/tass-core — public API contract

This file is the semver contract for the engine.
Everything exported from the package root (`require('@simdad/tass-core')`) and listed here is
public API: breaking changes to it require a major version bump once the package is published.
Anything not listed here is internal, even if technically reachable.

The package `exports` map exposes only the root entry (plus `./package.json`). Deep imports
(`@simdad/tass-core/lib/...`) are unsupported and blocked by the map.

## Guarantees (these are API too)

- **Zero runtime dependencies.** Node >= 18 builtins only. Adding a dependency is a breaking
  change to the product posture and needs the owner's explicit decision.
- **Determinism.** Every function here is a pure function of its arguments (plus, for the
  bundled/loader helpers, the package's own immutable data files). Same input, byte-identical
  output. Nothing reads clocks, RNGs, locales, or the environment.
- **Frozen tokenizer.** `tokenize` behavior is fixed for a given engine version; changes are
  versioned, never silent (pinned by the golden-corpus test).
- **`mean` metric semantics.** `metricValue(r, 'mean')` is `undefined` when `r.hits === 0`.
  Never coerce it to 0.
- **Error taxonomy.** Failures throw `TassError` with a STABLE `code` (namespaced strings such
  as `corpus/column-not-found`, `lexicon/unknown`, `csv/unterminated-quote`) and a `kind` of
  `usage` (caller error) or `runtime` (world error). Codes are API; messages are prose and may
  change.

## Exported surface

### Engine
| Export | Kind | Purpose |
|---|---|---|
| `tokenize(text)` | fn | Deterministic Unicode word tokenizer -> `Token[]` (text + offsets) |
| `compileLexicon(lexicon)` | fn | Compile once, reuse across documents -> `CompiledLexicon` |
| `analyze(text, compiled)` | fn | Score one document -> `AnalyzeResult` (per-category hits/weighted/percent/matchedForms) |
| `kwic(text, query, options?)` | fn | Keyword-in-context concordance -> `KwicLine[]` |
| `vaderRuleScore(text, valences)` | fn | TASS VADER-rules sentiment -> `VaderScores` (report as "TASS VADER-rules compound") |
| `valenceMap(terms)` | fn | Lexicon terms -> word->valence map for the rule layer |
| `Lexicon`, `LexiconCategory`, `LexiconTerm`, `Token`, `CategoryResult`, `AnalyzeResult`, `CompiledLexicon`, `KwicLine`, `KwicOptions`, `VaderScores` | types | Engine shapes |

### Lexicon loading and the bundle
| Export | Kind | Purpose |
|---|---|---|
| `loadLexicon(json, opts?)` | fn | Validate parsed lexicon JSON (bundled data must carry license + citation) |
| `parseDic(content, id?, name?)` | fn | LIWC-format `.dic` reader (user-licensed imports) |
| `bundledDir()` / `listBundled()` / `loadBundled(id)` | fn | The bundle's single source of truth (directory scan; no hand-kept list) |
| `resolveLexicon(spec)` | fn | Bundled id or lexicon-JSON path -> `Lexicon` |

### Corpus IO
| Export | Kind | Purpose |
|---|---|---|
| `loadCorpus(inputs, textColumn, groupColumns, timeColumn?)` | fn | One CSV or many TXT files -> `Corpus` |
| `parseCsv(text)` / `stringifyCsv(rows)` | fn | RFC-4180 reader/writer (LF, trailing newline, BOM-tolerant) |
| `parseTranscript(content)` / `parseChatLog(content)` | fn | Speaker-labeled transcript / chat-log -> `Turn[]` |
| `Corpus`, `CorpusRow`, `Turn` | types | IO shapes |

### Metrics and formatting
| Export | Kind | Purpose |
|---|---|---|
| `METRICS`, `Metric`, `isMetric(s)` | const/type/fn | The four reported metrics |
| `metricValue(result, metric)` | fn | THE single metric implementation (mean-undefined rule lives here) |
| `fmt(n)` | fn | THE fixed-precision formatter for every text artifact (byte-stability contract) |
| `safeName(s)` | fn | Column-safe identifier for R/pandas |
| `secondsToStamp(s)` | fn | Seconds -> `M:SS` / `H:MM:SS` label |
| `Acc` | class | Streaming mean/SD (ddof=1), undefined-skipping |

### Provenance
| Export | Kind | Purpose |
|---|---|---|
| `MANIFEST_VERSION` | const | Current manifest schema generation (2) |
| `buildScoreManifest(args)` | fn | The run manifest (timestamp-free; input hashes, lexicon provenance, settings) |
| `sha256File(path)` | fn | SHA-256 hex of a file |
| `ScoreManifestArgs` | type | Builder input |
| `ENGINE_VERSION` | const | This package's version (single-sourced from package.json) |
| `packageVersion(root)` | fn | Read a package version (used by surfaces for their own version) |

### Errors
| Export | Kind | Purpose |
|---|---|---|
| `TassError` (`.usage(...)`, `.runtime(...)`) | class | Taxonomy: `kind` maps to CLI exit codes (usage=1, runtime=2); `code` is stable; optional `hint` |
| `TassErrorKind` | type | `'usage' \| 'runtime'` |

## Manifest schema history

| `manifestVersion` | Introduced | Shape |
|---|---|---|
| 1 (implicit) | 0.3.0 | tool, version, command, determinism, settings, inputs, lexicons, academicOnlyUsed, outputs |
| 2 | 0.5.1 | adds `manifestVersion`, `engine`, `engineVersion` |

Additive fields do not bump the version; renames and removals do. Readers must branch on
`manifestVersion` (absent = 1) and accept all listed generations.
