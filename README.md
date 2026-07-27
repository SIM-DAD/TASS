# TASS Community Edition

**Text Analysis for Social Scientists**: LIWC-style dictionary scoring over open
lexicons: deterministic, provenance-first, driveable by humans (CLI) and by AI
agents (MCP server). Apache-2.0, zero runtime dependencies, Node 18+.

TASS is built by [SIM DAD LLC](https://usetass.app). This repository is the full
Community Edition: the scoring engine, the `tass` CLI, the MCP server, the minimal
local web GUI, and the reproducible-project container. The commercial GUI Edition
adds a no-code desktop workbench, the inferential statistics suite, publication
charts, and Excel/APA export on top of this exact engine; its methods, formulas,
citations, and R-benchmark reports are public even where its code is not.

## Why researchers use it

1. **Deterministic.** Same inputs, byte-identical outputs, on every OS. CI enforces
   a cross-platform determinism hash. Reproducibility is a product claim, not a hope.
2. **Provenance travels.** Every scoring run writes a manifest with tool and engine
   versions, input SHA-256 hashes, and each lexicon's license, class, and citation:
   the block a methods section needs.
3. **Licensing is mechanical.** Everything bundled is verified commercial-ok.
   Restricted resources (NRC, LIWC, GI) are never bundled; your own imports of them
   are flagged academic-only in every run that touches them.
4. **Trace every number.** `tass exemplars` and `tass kwic` connect any score back
   to quotable text.
5. **Open dictionaries, forever.** Every TASS-native dictionary is CC-BY-4.0 or
   ODC-BY, citation required, commercial use welcome, and installable by name from
   the public registry ([SIM-DAD/tass-lexicons](https://github.com/SIM-DAD/tass-lexicons)).

## Quick start

```
npm install && npm run build
node packages/tass-cli/bin/tass.js help
```

Score a CSV of documents against bundled sentiment lexicons:

```
tass score --input posts.csv --text-column text --lexicons vader,afinn --output scored.csv
```

Analyze a single text, no files involved:

```
tass analyze --text "What a wonderful day" --vader-rules
```

Author your own dictionary in a spreadsheet (`tass template`, fill it in, `tass
import-csv`), install open ones by name (`tass install politeness`), archive any
run as a reproducible `.tassproj` (`tass project save`), and prove it reproduces
(`tass project rerun`).

For AI-driven analysis, `tass mcp` serves the whole engine as MCP tools over stdio.
`AGENTS.md` is the operating contract for agents.

## Documentation

- `docs/METHODS.md`: what TASS measures and how; read before reporting numbers.
- `docs/API.md`: the engine's semver contract.
- `tass help <topic>`: task-oriented help inside the CLI.

## Contributing

See `CONTRIBUTING.md` (Apache-2.0, DCO sign-off, determinism and zero-dependency
rules). Dictionary contributions go to the registry repo.

---

Apache-2.0 © SIM DAD LLC. "TASS" is a SIM DAD LLC trademark; see NOTICE.
