# TASS — Text Analysis for Social Scientists

> Professional-grade NLP analysis for researchers who shouldn't have to write code.

**TASS** is a native Windows desktop application that makes text analysis accessible to social scientists, humanities researchers, and data journalists — no Python, R, or command line required. It combines dictionary-based analysis, machine learning classification, group statistical comparisons, and publication-quality visualizations in a clean, minimal GUI.

**Status:** Pre-release / Active Development — v1.0 targeting May 2026

---

## Why TASS?

The dominant tool in this space, LIWC, has long served as the default for researchers who need NLP without code. TASS is built to do everything LIWC does — and a great deal it cannot:

| | TASS | LIWC |
|---|---|---|
| No coding required | Yes | Yes |
| Handles large datasets (100k+ entries) | Yes | No |
| Open, transparent dictionaries | Yes | No |
| Group statistical comparisons built in | Yes | No |
| Publication-quality visualizations | Yes | Limited |
| Custom dictionary import | Yes | Limited |
| Price | $49/year | $89+/year |
| Offline, local analysis | Yes | Yes |

---

## Features — v1.0

### Data Import
- CSV, TXT, and XLSX file support
- Batch file processing
- Column mapping wizard: designate text column, group column, and metadata columns
- Read-only data preview before analysis

### Analysis Engine
- Dictionary-based scoring across all bundled resources
- Three analysis levels: **word-level** (match highlighting), **entry-level** (per row), **document-level** (aggregate)
- Multi-threaded processing — uses all available CPU cores
- Real-time progress display with estimated time remaining

### Group Comparisons
- Define groups by column values
- Descriptive statistics (mean, SD, min, max, median) per group
- Independent t-test, Mann-Whitney U, one-way ANOVA
- Effect sizes (Cohen's d, eta-squared)
- Visualized box plots and violin plots per category

### Output & Export
- CSV — full entry-level scores
- Excel — multi-sheet workbook (raw scores, summary stats, group comparisons)
- Static visualizations — high-resolution PNG (300 DPI) and SVG
  - Bar charts, word clouds, box plots, violin plots, heatmaps
- Auto-generated APA citation block on every export

### Projects
- Save and restore full session state (`.tass` project files)
- Recent projects on home screen
- Auto-save prompt on close

### Help & Support
- In-app tooltip system
- Searchable documentation panel (F1)
- "How to Cite TASS" dialog with APA, MLA, and Chicago formats
- Opt-in crash reporting

---

## Dictionary Library

TASS ships with a curated set of commercially-licensed dictionaries and is building an expanding library of original TASS-native resources.

### Bundled at Launch (v1.0)

| Dictionary | Coverage | License |
|---|---|---|
| AFINN-165 | Sentiment valence | MIT |
| VADER Lexicon | Sentiment valence + intensity | MIT |
| Moral Foundations Dictionary 2.0 | Care, Fairness, Loyalty, Authority, Purity | CC-BY |
| Brysbaert Concreteness Norms | Concreteness for ~40k words | CC-BY |
| HurtLex | Hurtful/offensive language by category | CC-BY-SA |
| WordNet 3.1 | Full English lexicon + POS tags | Princeton (commercial-compatible) |
| NLTK Stopwords | Function word categories | Apache 2.0 |
| SentiWordNet 3.0 | Synset-level positive/negative/objective scores | CC-BY-SA |

**Policy:** TASS exclusively bundles dictionaries with verified commercial-use-compatible licenses. All dictionaries are fully attributed and documented in-app.

### TASS-Native Dictionaries (In Development)

Rather than depend on restrictively-licensed third-party resources, TASS is building an original library of dictionaries developed and owned by SIM DAD LLC. These are independently citable contributions to the field.

**Shipping with v1.1 (August 2026):**
- TASS Affective Norms — valence, arousal, dominance
- TASS Discrete Emotions — anger, fear, joy, sadness, anticipation, trust, surprise, disgust
- TASS Psychosocial Process Lexicon — cognitive, social, biological, temporal categories
- TASS Opinion & Stance — evaluative language for social science contexts
- TASS Power & Status — power gain/loss, authority, political arenas
- TASS Hedging & Epistemic Stance — modal verbs, approximators, evidentials, boosters
- TASS Modal Language — deontic and epistemic modal categories

**Shipping with v2.0 (Spring 2027):**
- TASS Agency & Communion
- TASS Narrative & Temporal Orientation
- TASS Collective Identity & Social Boundaries
- TASS Formality & Register
- TASS Political & Ideological Language
- TASS Health & Illness Communication
- TASS Deception & Trust Cues
- TASS Crisis & Uncertainty Language
- TASS Financial & Economic Sentiment
- TASS Academic & Scientific Register
- TASS Interpersonal Dominance & Deference

**Full library at v2.0:** 26 dictionaries across sentiment, affect, psycholinguistics, moral foundations, toxicity, power, stance, identity, and domain-specific registers.

---

## Roadmap

### v1.0 — Summer 2026
Core tool: dictionary analysis, group comparisons, static visualizations, CSV/Excel export, license system, saved projects.

### v1.1 — Fall 2026
Machine learning models (DistilBERT sentiment, LDA topic modeling, spaCy NER), custom dictionary import, PDF/JSON export, interactive dashboards, auto-update system, Linux support.

### v2.0 — Spring 2027
LLM integration hooks (user-supplied API key), cloud-assisted processing for large corpora, Spanish NLP, SQL data connectors.

---

## Technical Stack

| Layer | Technology |
|---|---|
| Language | Python 3.11 |
| GUI | PySide6 (Qt 6) |
| Bundler | PyInstaller |
| Installer | Inno Setup |
| Statistics | SciPy + NumPy |
| Data I/O | pandas + openpyxl |
| Visualizations | Matplotlib + Seaborn |
| Word Clouds | wordcloud |
| NLP | NLTK |
| License Backend | Supabase + Lemon Squeezy |
| Distribution | GitHub Releases |

**System Requirements:** Windows 10/11 (64-bit), 4-core CPU, 8GB RAM minimum; 6-core, 16GB RAM recommended.

---

## How to Cite TASS

If you use TASS in your research, please cite it:

```
[Author]. (2026). TASS: Text Analysis for Social Scientists (Version 1.0) [Software].
SIM DAD LLC. https://doi.org/[ZENODO_DOI]
```

A Zenodo DOI will be minted at the v1.0 release. Every TASS export includes a pre-formatted citation block.

---

## License

TASS is **source-available** under a proprietary commercial license. The source code is publicly readable on GitHub for transparency and academic review. It may not be used, distributed, or incorporated into other commercial products without a license from SIM DAD LLC.

See [LICENSE](LICENSE) for full terms.

---

## Documentation

Full product requirements and technical architecture are documented in this repository:

- [PRD.md](PRD.md) — Product Requirements Document (features, dictionaries, monetization, roadmap)
- [TECH_SPEC.md](TECH_SPEC.md) — Technical Specification (architecture, stack, data flow, sprint plan)

---

## Contact & Support

**SIM DAD LLC**
For support inquiries, bug reports, or licensing questions, use the in-app support button or visit the product website.

Crash reports submitted through TASS are sent to the development team with your explicit consent and are used solely to improve the software.
