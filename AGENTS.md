# AGENTS.md — driving TASS as an AI agent

TASS is designed to be operated by AI. Two equivalent surfaces exist; both run the exact same
code paths, validation, and provenance machinery.

## Surface 1: MCP (preferred for agents)

`tass mcp` serves stdio JSON-RPC (register once: `claude mcp add --scope user tass -- tass mcp`).
Tools:

| Tool | Use it to |
|---|---|
| `tass_dicts` | Learn the bundled lexicons + their category ids, licenses, citations. Call first. |
| `tass_analyze_text` | Score a string directly; returns tokens, per-category hits/weighted/percent/mean + matched forms. Pass `vader_rules: true` for the rules-based sentiment block. |
| `tass_score_file` | Batch-score a CSV/TXT corpus to files: scored CSV, group summaries, windowed trajectories, JSON rows, citations — plus the run manifest. |
| `tass_ingest` | Turn speaker-labeled transcripts (`[M:SS] **SPEAKER:** …`) — or chat logs (`[stamp] <user> …` / `[stamp] user: …`) with `format: "chat"` — into the turn-level CSV `tass_score_file` expects. |
| `tass_exemplars` | Trace any score back to the highest/lowest-scoring documents and the exact words that fired. |
| `tass_kwic` | Concordance lines for a word or `stem*` across a corpus. |

All file paths must be **absolute**. File-writing tools return a log naming every artifact
written; read the files yourself afterwards if you need their contents.

## Surface 2: CLI (for shells and scripts)

`tass help` is the authoritative usage text. Machine-friendly modes:

- `tass dicts --json` — the bundle as JSON.
- `tass analyze --text "…" | --stdin | -i file.txt [--lexicons a,b] [--all]` — JSON to stdout.
- `tass score … --json rows.json` — typed row objects alongside the CSV.
- Exit codes: `0` ok, `1` usage error, `2` runtime failure. Diagnostics go to stderr; stdout
  carries only data.

## Contracts you can rely on (and must preserve)

1. **Determinism.** Same inputs ⇒ byte-identical outputs. Do not add timestamps, random ids,
   or environment-dependent values to any output. Verify nontrivial changes by running a score
   twice and hashing.
2. **Manifests are the provenance record.** Every `score` writes `<output>.manifest.json`
   (input SHA-256s, lexicon license/class/citation, settings, `academicOnlyUsed`). When you
   report results to a human, cite from the manifest — never from memory.
3. **Licensing wall.** Bundled = `commercial-ok` only. NRC/LIWC/GI and other restricted
   resources are user-imported (`tass import-nrc`, `tass import-dic`), flagged `academic-only`,
   and must NEVER be committed, bundled, or redistributed.
4. **Interpretation limits.** Plain `vader` columns are lexicon-only (mean token valence).
   With `--vader-rules` / `vader_rules: true` you additionally get the TASS implementation of
   the published VADER heuristics (negation, boosters, ALL-CAPS, punctuation, but-clauses,
   emoticons, idiom tables) — report those as "TASS VADER-rules compound", never as the
   canonical "VADER compound" (tokenizer corner cases and emoji handling differ). NoRaRe norm lexicons (warriner-vad,
   concreteness, aoa) are Concepticon-mapped subsets — check per-column `n_` coverage in group
   summaries. `politeness` v1 is a lexical + phrase approximation of the
   Danescu-Niculescu-Mizil taxonomy (no dependency parsing, position-blind), labeled as such.
   `socialsent` is the 2000s-decade frequent-words lexicon (Hamilton et al. 2016).
5. **For `mean`-metric columns, blank/null means "no hits"** — never coerce it to 0.

## Development rules (for agents editing this repo)

- **IP quarantine (binding):** the pre-2026-07-15 TASS codebase (PySide6/Tauri lineage, incl.
  the public SIM-DAD/tass GitHub repo) is off-limits — never read, copy, or port code, tests,
  or transformed dictionary data from it. This repo is a clean-room rebuild from requirements.
- Zero runtime dependencies is a design constraint, not an accident. Adding one requires the
  owner's explicit decision.
- The MCP server must stay a thin adapter over `main(argv, io)` — new capabilities are added to
  the CLI first, then exposed as tools. That parity is what keeps the two surfaces honest.
- Lexicon JSONs under `data/lexicons/` are build artifacts of `scripts/build-lexicons.mjs`
  (pinned upstream URLs, deterministic sort). Regenerate them via the script; never hand-edit.
- Tests: `npm test` (node:test, in-process `main(argv, io)` — no child processes). Keep new
  tests in that style. Everything must be green before any install or push.
