# TASS: Methods and Validity

**Text Analysis for Social Scientists**
A SIM DAD LLC product · version 0.5.0

This document is the public reference for what TASS measures and how. It is written for
researchers, reviewers, and anyone evaluating whether a TASS-produced number belongs in a
methods section. Every measure below is a published, citable method, implemented so that the
same input always yields the same output.

---

## 1. What TASS is

TASS is a dictionary-based text-analysis engine built and maintained by SIM DAD LLC. It scores
documents against category lexicons in the LIWC tradition: a lexicon maps categories to terms,
TASS counts how often a document's words fall into each category, and it reports normalized,
provenance-tagged results. It runs from the command line, as a local web app, and as an MCP
server for AI agents. The engine and CLI have zero runtime dependencies; Node 18 or newer is the
only requirement.

TASS is deliberately narrow. It does not train models, it does not call a cloud service, and it
does not invent scores. It applies established lexicons and published scoring rules to your text
and shows its work.

## 2. Beta status and the AURA Lab relationship

TASS is currently a **closed beta** product. Its primary in-house test site is the **AURA Lab**
(Avatars, Users, Relationships, and Affect), which uses TASS as a **sanctioned beta tester** on
live research corpora. This dogfooding relationship is disclosed openly: it is how TASS is
hardened against real analytic workflows before general release, and it is also a conflict of
interest that we state plainly rather than obscure. AURA Lab receives no special build, no
private scoring path, and no undocumented method. The lab runs the same published engine
described here, and any result AURA Lab reports from TASS is reproducible by anyone with the same
inputs and the same lexicons.

Because TASS is in beta, results should be validated against the underlying published method for
any high-stakes use, and the version number should be recorded with every reported figure. TASS
makes that easy: it writes its own version, and the versions and licenses of every lexicon it
touched, into a manifest beside every scored output (Section 6).

## 3. The core method: LIWC-style dictionary scoring

### Tokenization

TASS tokenizes on a deterministic Unicode word baseline shared by every scoring layer. The choice
of tokenizer is fixed for a given TASS version, which is what makes counts reproducible. Any
change to tokenization is a versioned change, not a silent one.

### Term types

A lexicon term can be one of three forms:

- a **literal word** (`happy`),
- a **stem wildcard** (`happi*`), matching any token that begins with the stem, following the
  standard LIWC `.dic` convention, or
- a **multi-word phrase** (`thank you`, `sort of`, `would you mind*`), where only the final word
  may carry the wildcard. A phrase match counts as a single hit.

A single token may satisfy multiple categories at once, exactly as in LIWC category counting; TASS
records the hit in every category the term belongs to.

### The four reported metrics

For each category in a document, TASS can report any of four measures. They are selected with
`--metrics` and default to `percent`:

| Metric | Definition | Typical use |
|---|---|---|
| `percent` | category hits as a percentage of the document's total tokens | the number most LIWC-style papers report |
| `hits` | raw count of category matches | frequency reporting, sparse categories |
| `weighted` | sum of per-term weights over all matches | valence and intensity lexicons (VADER, labMT, AFINN) |
| `mean` | `weighted / hits` (undefined when hits are zero) | average intensity per matched term |

Weighted and mean metrics are meaningful only for lexicons that carry per-term weights.
Plain-count lexicons use a default weight of 1, so their weighted sum equals their hit count.

### Groups and trajectories

Scores can be summarized per group (`--group-column`) and, for time-stamped or ordered data,
reported as windowed trajectories. These are aggregations of the per-document scores above; they
introduce no new scoring rule.

## 4. The bundled lexicons

TASS ships ten lexicons. Every bundled lexicon is verified `commercial-ok`, and every one carries
its citation and license inside the product, printed on request (`tass dicts`) and written into
each run's manifest. The published sources are:

| Lexicon | Measures | License | Primary citation |
|---|---|---|---|
| **AFINN-165** | valence (−5 to +5 per word) | Apache-2.0 | Nielsen, F. Å. (2011). A new ANEW: evaluation of a word list for sentiment analysis in microblogs. ESWC 2011. |
| **VADER** | valence lexicon for the rule model (Section 5) | MIT | Hutto, C. J., & Gilbert, E. E. (2014). VADER: A Parsimonious Rule-based Model for Sentiment Analysis of Social Media Text. ICWSM-14. |
| **labMT 1.0** | happiness / hedonometric valence | CC-BY | Dodds, P. S., Harris, K. D., Kloumann, I. M., Bliss, C. A., & Danforth, C. M. (2011). Temporal Patterns of Happiness and Information in a Global Social Network. PLoS ONE 6(12): e26752. |
| **Empath** | 194 topical and affective categories | MIT | Fast, E., Chen, B., & Bernstein, M. (2016). Empath: Understanding Topic Signals in Large-Scale Text. CHI 2016. |
| **SocialSent** (2000s decade, frequent words) | domain-induced sentiment | ODC-PDDL-1.0 | Hamilton, W. L., Clark, K., Leskovec, J., & Jurafsky, D. (2016). Inducing Domain-Specific Sentiment Lexicons from Unlabeled Corpora. EMNLP 2016. |
| **Warriner VAD** | valence, arousal, dominance norms | CC-BY-4.0 | Warriner, A. B., Kuperman, V., & Brysbaert, M. (2013). Norms of valence, arousal, and dominance for 13,915 English lemmas. Behavior Research Methods, 45, 1191-1207. |
| **Concreteness** | concreteness norms | CC-BY-4.0 | Brysbaert, M., Warriner, A. B., & Kuperman, V. (2014). Concreteness ratings for 40 thousand English word lemmas. Behavior Research Methods, 46, 904-911. |
| **Age of Acquisition** | AoA norms | CC-BY-4.0 | Kuperman, V., Stadthagen-Gonzalez, H., & Brysbaert, M. (2012). Age-of-acquisition ratings for 30,000 English words. Behavior Research Methods, 44, 978-990. |
| **stopwords-iso (English)** | stopword filtering | MIT | stopwords-iso project. |
| **TASS politeness markers v1** | 15 politeness-strategy categories (lexical and phrase approximation) | CC-BY-4.0 (SIM DAD LLC) | Approximates the strategy taxonomy of Danescu-Niculescu-Mizil, C., Sudhof, M., Jurafsky, D., Leskovec, J., & Potts, C. (2013). A computational approach to politeness with application to social factors. ACL 2013. |

The three NoRaRe-sourced norm sets (Warriner VAD, Concreteness, Age of Acquisition) are drawn
from the NoRaRe database (https://norare.clld.org) under CC-BY-4.0.

**A note on the politeness lexicon.** TASS politeness markers v1 is a SIM DAD original. It is a
lexical and phrase-level *approximation* of the Stanford politeness strategy taxonomy, not a
reimplementation of that paper's trained classifier. It covers fifteen strategy markers
(gratitude, deference, greeting, apology, hedge, please, indirection, first- and second-person
address, modality, factuality, affirmation, and negation, among others). It is released under
CC-BY-4.0, so it is free to use and share, including commercially, with attribution as the only
condition. This is deliberate: the TASS-native dictionaries exist to be the open, citeable counter
to proprietary, non-inspectable dictionaries, so they are never gated. Report it as an
approximation, and cite both TASS and the Danescu-Niculescu-Mizil et al. (2013) source.

## 5. VADER-rules sentiment

TASS includes a rule-based sentiment layer (`--vader-rules`) that reproduces the published VADER
heuristics of Hutto and Gilbert (2014). It is a **clean-room implementation**: the rule word lists
are taken from the MIT-licensed published model description, and the per-token valences come from
the bundled VADER lexicon.

The heuristics implemented are:

- **negation flipping**, including `n't` contractions and the "least" special case,
- **booster and dampener words** with distance decay (for example *very*, *extremely*, *barely*,
  *kinda*),
- **ALL-CAPS emphasis**,
- **exclamation and question-mark emphasis**,
- **"but"-clause reweighting**,
- **emoticon valences** (whitespace tokens that appear verbatim in the lexicon, such as `:)`), and
- **multi-word idiom tables**, scored as units with their member words consumed.

The headline output is a **compound** score in the range −1 to +1, plus positive, negative, and
neutral proportions that sum to 1, and the list of tokens that contributed (for trace-back).

**Honest framing, required.** TASS does not implement UTF-8 emoji-description translation, and its
tokenizer differs from the reference `vaderSentiment` package in corner cases. Scores can
therefore deviate slightly from that reference package. For this reason TASS reports and labels
this measure as **"TASS VADER-rules compound"**, never as a canonical "VADER compound". Use that
label in any write-up, and cite Hutto and Gilbert (2014) for the method.

## 6. What makes a TASS result valid

TASS is built so that a reviewer can trust and re-run any number it produces. Four guarantees
back that up.

1. **Determinism.** Same inputs produce byte-identical outputs. Nothing is time-stamped, column
   order is fixed, and number formatting is stable. Reproducibility is a research requirement, so
   it is a product guarantee, not a best effort.

2. **Provenance travels with the output.** Every `score` run writes a companion
   `<output>.manifest.json` recording the tool and engine versions, the SHA-256 hash of each
   input, and every lexicon's name, license, license class, and citation. This is the confirmed
   record a methods section and a replication attempt both need.

3. **Every number traces back to text.** `tass exemplars` returns the top and bottom documents for
   a category with the exact matched terms, and `tass kwic` gives a keyword-in-context concordance.
   No score is a black box; you can always read the passages that produced it.

4. **Licensing is mechanical, not aspirational.** Everything bundled is verified `commercial-ok`.
   Restricted resources are never bundled. When a user imports a restricted dictionary
   (Section 7), TASS marks it `academic-only` and says so on standard error and in the manifest of
   every run that touches it.

## 7. Restricted resources and user imports

Some widely used dictionaries are not free to redistribute. TASS never bundles LIWC, the NRC
emotion and affect lexicons, the General Inquirer, or any comparable restricted resource. Instead,
TASS reads standard file formats so a user who has legitimately licensed a dictionary can import
their own copy:

- `tass import-dic` reads any LIWC-format `.dic` file,
- `tass import-nrc` reads the NRC EmoLex format, and
- `tass import-socialsent` converts SocialSent community or decade TSVs on demand.

Any dictionary imported this way that is not clearly commercial is flagged `academic-only`, and
every run that uses it carries that flag through to the manifest. This keeps the licensing status
of a result visible for the life of that result.

## 8. Documented limits

- TASS scores English text. Non-English input will tokenize but will not match the bundled English
  lexicons.
- Dictionary scoring is bag-of-words at heart. Outside the VADER-rules layer, TASS does not model
  syntax, negation, or sarcasm; a category count is a count of matched terms, not an interpretation.
- The VADER-rules layer approximates but does not exactly equal the reference package (Section 5).
- The TASS politeness lexicon is an approximation of a published taxonomy, not a trained classifier
  (Section 4).
- TASS is in beta. Validate against the underlying published method for high-stakes use, and record
  the TASS version with every reported figure.

## 9. How to cite and reproduce

Cite TASS as the tool and cite the underlying lexicon or method for the measure. For example:

> Sentiment was scored with TASS 0.5.0 (SIM DAD LLC) using its VADER-rules layer, a clean-room
> implementation of the heuristics of Hutto and Gilbert (2014). Category prevalence was scored with
> TASS against the Empath lexicon (Fast, Chen, and Bernstein, 2016).

To reproduce a result, keep the input files, the TASS version, and the `.manifest.json` that TASS
wrote alongside the output. Those three together fully determine every score.

---

*TASS is a SIM DAD LLC product. This document describes version 0.5.0. Lexicon citations and
licenses are also available at runtime via `tass dicts` and in every run's manifest.*
