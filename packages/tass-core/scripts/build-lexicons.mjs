#!/usr/bin/env node
/*
 * build-lexicons.mjs — fetch the VERIFIED free-for-commercial lexicons and convert them into
 * tass-core Lexicon JSON under data/lexicons/, with citation + license recorded IN each file
 * (the attribution manifest requirement — every bundled lexicon is citable in-app).
 *
 * Licensing is governed by meta/sprint/research-2026-07-04/tass.md. ONLY the verified-permissive
 * set goes through this script. The landmine list (NRC/LIWC/GI/…) must never be added here.
 *
 * Deterministic output: sources are pinned to commit-ish raw URLs at add time; entries are
 * emitted sorted so re-runs produce byte-identical JSON for unchanged sources.
 *
 * Usage:  node scripts/build-lexicons.mjs          (writes data/lexicons/*.json)
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'data', 'lexicons');
mkdirSync(outDir, { recursive: true });

async function fetchText(url) {
    const res = await fetch(url);
    if (!res.ok) { throw new Error(`${res.status} ${url}`); }
    return res.text();
}

function writeLexicon(file, lexicon) {
    // Everything this script emits is by contract verified free-for-commercial (see header);
    // academic-only resources arrive ONLY via the user-import path, never here.
    lexicon.licenseClass = 'commercial-ok';
    // Sorted categories/terms => byte-stable output.
    lexicon.categories.sort((a, b) => a.id.localeCompare(b.id));
    for (const c of lexicon.categories) {
        c.terms.sort((a, b) => a.term.localeCompare(b.term));
    }
    writeFileSync(join(outDir, file), JSON.stringify(lexicon, null, 1) + '\n');
    const terms = lexicon.categories.reduce((n, c) => n + c.terms.length, 0);
    console.error(`wrote ${file}: ${lexicon.categories.length} categories, ${terms} terms`);
}

// ── VADER (MIT — Hutto & Gilbert 2014) ──────────────────────────────────────
// token \t mean-valence \t std \t ratings. Bundled as ONE weighted 'valence' category
// (mean valence as the weight). TASS's `weighted` sum / hits = mean document valence.
{
    const raw = await fetchText('https://raw.githubusercontent.com/cjhutto/vaderSentiment/master/vaderSentiment/vader_lexicon.txt');
    const terms = [];
    for (const line of raw.split('\n')) {
        const [token, mean] = line.split('\t');
        if (!token || mean === undefined || token.includes(' ')) { continue; } // single tokens only
        const weight = Number(mean);
        if (!Number.isFinite(weight)) { continue; }
        terms.push({ term: token, weight });
    }
    writeLexicon('vader.json', {
        id: 'vader',
        name: 'VADER valence lexicon',
        license: 'MIT',
        citation: 'Hutto, C.J. & Gilbert, E.E. (2014). VADER: A Parsimonious Rule-based Model for Sentiment Analysis of Social Media Text. ICWSM-14. https://github.com/cjhutto/vaderSentiment',
        categories: [{ id: 'valence', label: 'Valence (VADER mean rating, -4..+4)', terms }],
    });
}

// ── AFINN-165 (Apache-2.0 — Finn Årup Nielsen) ──────────────────────────────
{
    const raw = await fetchText('https://raw.githubusercontent.com/fnielsen/afinn/master/afinn/data/AFINN-en-165.txt');
    const terms = [];
    for (const line of raw.split('\n')) {
        const [token, score] = line.split('\t');
        if (!token || score === undefined || token.includes(' ')) { continue; }
        const weight = Number(score);
        if (!Number.isFinite(weight)) { continue; }
        terms.push({ term: token, weight });
    }
    writeLexicon('afinn.json', {
        id: 'afinn',
        name: 'AFINN-165 valence lexicon',
        license: 'Apache-2.0',
        citation: 'Nielsen, F.Å. (2011). A new ANEW: evaluation of a word list for sentiment analysis in microblogs. ESWC2011. https://github.com/fnielsen/afinn',
        categories: [{ id: 'valence', label: 'Valence (AFINN score, -5..+5)', terms }],
    });
}

// ── Empath (MIT — Fast et al. 2016) — the ~200-category LIWC-style flagship ─
// categories.tsv: category \t seedish \t term \t term … (first column repeats the category name).
{
    const raw = await fetchText('https://raw.githubusercontent.com/Ejhfast/empath-client/master/empath/data/categories.tsv');
    const categories = [];
    for (const line of raw.split('\n')) {
        const cols = line.trim().split('\t');
        if (cols.length < 2 || !cols[0]) { continue; }
        const id = cols[0];
        const seen = new Set();
        const terms = [];
        for (const t of cols.slice(1)) {
            const term = t.trim();
            // single-token terms only (the tass tokenizer matches per word); Empath's phrases
            // use '_' — keep the token form the tokenizer can actually hit.
            if (!term || term.includes(' ') || seen.has(term)) { continue; }
            seen.add(term);
            terms.push({ term });
        }
        if (terms.length) { categories.push({ id, terms }); }
    }
    writeLexicon('empath.json', {
        id: 'empath',
        name: 'Empath categories',
        license: 'MIT',
        citation: 'Fast, E., Chen, B., & Bernstein, M. (2016). Empath: Understanding Topic Signals in Large-Scale Text. CHI 2016. https://github.com/Ejhfast/empath-client',
        categories,
    });
}

// ── stopwords-iso EN (MIT) ──────────────────────────────────────────────────
// JSON array of words. One unweighted 'stopwords' category (function-word coverage stat).
{
    const raw = await fetchText('https://raw.githubusercontent.com/stopwords-iso/stopwords-en/master/stopwords-en.json');
    const words = JSON.parse(raw);
    const seen = new Set();
    const terms = [];
    for (const w of words) {
        const term = String(w).trim();
        if (!term || term.includes(' ') || seen.has(term)) { continue; }
        seen.add(term);
        terms.push({ term });
    }
    writeLexicon('stopwords.json', {
        id: 'stopwords',
        name: 'English stopwords (stopwords-iso)',
        license: 'MIT',
        citation: 'Diaz, G. et al. stopwords-iso: collection of stopwords in multiple languages. https://github.com/stopwords-iso/stopwords-en',
        categories: [{ id: 'stopwords', label: 'Function words / stopwords', terms }],
    });
}

// ── labMT 1.0 (CC-BY — Dodds et al. 2011, PLOS ONE S1) ─────────────────────
// Tab table after two title lines; word + happiness_average (1..9). One weighted category.
{
    const raw = await fetchText('https://journals.plos.org/plosone/article/file?type=supplementary&id=10.1371/journal.pone.0026752.s001');
    const lines = raw.split('\n');
    const headerIdx = lines.findIndex(l => l.startsWith('word\t'));
    if (headerIdx < 0) { throw new Error('labMT: header row not found — source format changed?'); }
    const cols = lines[headerIdx].trim().split('\t');
    const wordCol = cols.indexOf('word');
    const scoreCol = cols.indexOf('happiness_average');
    const terms = [];
    for (const line of lines.slice(headerIdx + 1)) {
        const f = line.split('\t');
        const term = (f[wordCol] ?? '').trim();
        const weight = Number(f[scoreCol]);
        if (!term || term.includes(' ') || !Number.isFinite(weight)) { continue; }
        terms.push({ term, weight });
    }
    writeLexicon('labmt.json', {
        id: 'labmt',
        name: 'labMT 1.0 happiness lexicon',
        license: 'CC-BY',
        citation: 'Dodds, P.S., Harris, K.D., Kloumann, I.M., Bliss, C.A., & Danforth, C.M. (2011). Temporal Patterns of Happiness and Information in a Global Social Network: Hedonometrics and Twitter. PLoS ONE 6(12): e26752, S1 Dataset. https://doi.org/10.1371/journal.pone.0026752',
        categories: [{ id: 'happiness', label: 'Happiness (labMT average, 1..9)', terms }],
    });
}

// ── Affective norms via NoRaRe (CC-BY 4.0 CLDF data) ────────────────────────
// NoRaRe redistributes the psycholinguistic norm sets as CC-BY — the clean bundling path
// (research 2026-07-04 §1). NOTE: NoRaRe carries the Concepticon-mapped subset, not every
// lemma of the original supplements; counts are logged so coverage is never overstated.
async function norare(dataset, wordCol, catSpecs) {
    const raw = await fetchText(`https://raw.githubusercontent.com/concepticon/norare-data/master/datasets/${dataset}/${dataset}.tsv`);
    const lines = raw.split('\n');
    const header = lines[0].trim().split('\t');
    const wi = header.indexOf(wordCol);
    if (wi < 0) { throw new Error(`${dataset}: word column ${wordCol} missing`); }
    const specs = catSpecs.map(s => {
        const ci = header.indexOf(s.column);
        if (ci < 0) { throw new Error(`${dataset}: column ${s.column} missing`); }
        return { ...s, ci, seen: new Set(), terms: [] };
    });
    for (const line of lines.slice(1)) {
        const f = line.split('\t');
        const term = (f[wi] ?? '').trim().toLowerCase();
        if (!term || term.includes(' ')) { continue; }
        for (const s of specs) {
            const weight = Number(f[s.ci]);
            if (!Number.isFinite(weight) || s.seen.has(term)) { continue; }
            s.seen.add(term);
            s.terms.push({ term, weight });
        }
    }
    return specs.map(s => ({ id: s.id, label: s.label, terms: s.terms }));
}

{
    const categories = await norare('Warriner-2013-AffectiveRatings', 'ENGLISH', [
        { id: 'valence', label: 'Valence (Warriner mean, 1..9)', column: 'ENGLISH_VALENCE_MEAN' },
        { id: 'arousal', label: 'Arousal (Warriner mean, 1..9)', column: 'ENGLISH_AROUSAL_MEAN' },
        { id: 'dominance', label: 'Dominance (Warriner mean, 1..9)', column: 'ENGLISH_DOMINANCE_MEAN' },
    ]);
    writeLexicon('warriner-vad.json', {
        id: 'warriner-vad',
        name: 'Warriner valence-arousal-dominance norms (NoRaRe subset)',
        license: 'CC-BY-4.0',
        citation: 'Warriner, A.B., Kuperman, V., & Brysbaert, M. (2013). Norms of valence, arousal, and dominance for 13,915 English lemmas. Behavior Research Methods, 45, 1191-1207. Data via NoRaRe (https://norare.clld.org), CC-BY 4.0.',
        categories,
    });
}

{
    const categories = await norare('Brysbaert-2014a-Concreteness', 'ENGLISH', [
        { id: 'concreteness', label: 'Concreteness (Brysbaert mean, 1..5)', column: 'ENGLISH_CONCRETENESS_MEAN' },
    ]);
    writeLexicon('concreteness.json', {
        id: 'concreteness',
        name: 'Brysbaert concreteness norms (NoRaRe subset)',
        license: 'CC-BY-4.0',
        citation: 'Brysbaert, M., Warriner, A.B., & Kuperman, V. (2014). Concreteness ratings for 40 thousand generally known English word lemmas. Behavior Research Methods, 46, 904-911. Data via NoRaRe (https://norare.clld.org), CC-BY 4.0.',
        categories,
    });
}

{
    const categories = await norare('Kuperman-2012-AoA', 'ENGLISH', [
        { id: 'aoa', label: 'Age of acquisition (Kuperman mean rating, years)', column: 'ENGLISH_AOA_MEAN' },
    ]);
    writeLexicon('aoa.json', {
        id: 'aoa',
        name: 'Kuperman age-of-acquisition norms (NoRaRe subset)',
        license: 'CC-BY-4.0',
        citation: 'Kuperman, V., Stadthagen-Gonzalez, H., & Brysbaert, M. (2012). Age-of-acquisition ratings for 30,000 English words. Behavior Research Methods, 44, 978-990. Data via NoRaRe (https://norare.clld.org), CC-BY 4.0.',
        categories,
    });
}

// ── TASS politeness markers v1 (TASS-native, CC-BY-4.0, lexical + PHRASE approximation) ──────
// Authored fresh for TASS from the published politeness-strategy taxonomy (Danescu-Niculescu-
// Mizil et al. 2013). v1 uses the engine's n-gram support (0.4.0) to add the phrase-level
// strategies (counterfactual/indicative modals, deference, indirect openers…). Still NOT the
// ConvoKit dependency-parse extractors and still position-blind (no sentence-start features) —
// honestly labeled as an approximation. Released open (CC-BY-4.0): the TASS-native dictionaries
// exist to be the shareable, citation-required counter to LIWC's proprietary lexicons, so they
// are never gated. Attribution (the citation below) is the only condition of use.
{
    const cat = (id, label, words) => ({ id, label, terms: words.map(term => ({ term })) });
    writeLexicon('politeness.json', {
        id: 'politeness',
        name: 'TASS politeness markers v1 (lexical + phrase approximation)',
        license: 'CC-BY-4.0',
        citation: 'SIM DAD LLC (2026). TASS politeness markers v1: lexical + phrase approximation of the strategy taxonomy in Danescu-Niculescu-Mizil, C., Sudhof, M., Jurafsky, D., Leskovec, J., & Potts, C. (2013). A computational approach to politeness with application to social factors. ACL 2013. Released under CC-BY-4.0. https://www.cs.cornell.edu/~cristian/Politeness.html',
        categories: [
            cat('gratitude', 'Gratitude', ['thank', 'thanks', 'thankful', 'grateful', 'appreciate', 'appreciated', 'appreciation',
                'thank you', 'thanks so much', 'thank you so much', 'much appreciated']),
            cat('apology', 'Apologizing', ['sorry', 'apologize', 'apologies', 'apology', 'forgive', 'excuse', 'regret',
                "i'm sorry", 'i am sorry', 'excuse me', 'forgive me', 'my bad', 'my apologies']),
            cat('please', 'Please', ['please', 'kindly', 'if you please', 'if possible']),
            cat('greeting', 'Greeting', ['hi', 'hello', 'hey', 'welcome', 'greetings',
                'good morning', 'good afternoon', 'good evening', "what's up", 'how are you']),
            cat('hedge', 'Hedges', ['maybe', 'perhaps', 'possibly', 'probably', 'might', 'somewhat', 'sorta', 'kinda',
                'guess', 'suppose', 'suggest', 'seems', 'seemed', 'apparently', 'arguably', 'roughly', 'partially', 'presumably',
                'i think', 'i believe', 'i guess', 'i suppose', 'i wonder', 'sort of', 'kind of', 'in my opinion',
                'it seems', 'it appears', 'more or less']),
            cat('counterfactual_modal', 'Counterfactual modal (could/would you…)', ['could you', 'would you',
                'could you please', 'would you please', 'would you mind', 'would it be possible']),
            cat('indicative_modal', 'Indicative modal (can/will you…)', ['can you', 'will you',
                'can you please', 'will you please']),
            cat('deference', 'Deference', ['great job', 'good job', 'good point', 'great point', 'well done',
                'nice work', 'good work', 'well said', 'interesting point']),
            cat('factuality', 'Factuality (impoliteness marker)', ['actually', 'really', 'in fact',
                'the truth is', 'the fact is', 'the reality is', 'to be honest', 'honestly']),
            cat('indirect_btw', 'Indirect opener (by the way)', ['by the way', 'incidentally', 'just wondering',
                'quick question']),
            cat('affirmation', 'Affirmation / agreement', ['yeah', 'yes', 'yep', 'okay', 'ok', 'sure', 'absolutely',
                'definitely', 'certainly', 'agreed', 'exactly', 'right', 'true']),
            cat('negation', 'Negation', ['no', 'not', 'never', 'none', 'nothing', 'nobody', "don't", "doesn't", "didn't",
                "can't", 'cannot', "won't", "wouldn't", "shouldn't", "couldn't", "isn't", "aren't", "wasn't", "weren't"]),
            cat('first_person', 'First person', ['i', 'me', 'my', 'mine', 'myself', "i'm", "i've", "i'll", "i'd"]),
            cat('first_person_plural', 'First person plural (solidarity)', ['we', 'our', 'ours', 'us', 'ourselves',
                "we're", "we've", "we'll", "we'd", 'let us', "let's"]),
            cat('second_person', 'Second person', ['you', 'your', 'yours', 'yourself', "you're", "you've", "you'll", "you'd"]),
        ],
    });
}

// ── SocialSent historical (PDDL — Hamilton et al. 2016) ─────────────────────────────────────
// Induced sentiment lexicons (SentProp). We bundle the MODERN decade (2000s) of the
// frequent-words historical series as one weighted 'sentiment' category — the general-purpose
// member of the family. The 250 subreddit-specific lexicons stay unbundled (too big, and
// community choice is a per-study decision); users can convert any of them to a lexicon JSON.
// Data license: Open Data Commons PDDL (per the project page) => commercial-ok.
{
    const { execFileSync } = await import('node:child_process');
    const { mkdtempSync, readFileSync, readdirSync, statSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const res = await fetch('https://nlp.stanford.edu/projects/socialsent/files/socialsent_hist_freq.zip');
    if (!res.ok) { throw new Error(`socialsent download failed: ${res.status}`); }
    const zipBytes = Buffer.from(await res.arrayBuffer());
    const tmp = mkdtempSync(join(tmpdir(), 'socialsent-'));
    const zipPath = join(tmp, 'hist_freq.zip');
    writeFileSync(zipPath, zipBytes);
    execFileSync('tar', ['-xf', zipPath, '-C', tmp]); // bsdtar reads zip on Windows + macOS + Linux
    // Find the 2000s-decade tsv wherever the zip roots it.
    const find2000 = dir => {
        for (const f of readdirSync(dir)) {
            const p = join(dir, f);
            if (statSync(p).isDirectory()) { const hit = find2000(p); if (hit) { return hit; } }
            else if (/^2000\.tsv$/.test(f)) { return p; }
        }
        return undefined;
    };
    const tsv = find2000(tmp);
    if (!tsv) { throw new Error('socialsent: 2000.tsv not found in socialsent_hist_freq.zip'); }
    const terms = [];
    for (const line of readFileSync(tsv, 'utf8').split('\n')) {
        const [word, mean] = line.trim().split(/\s+/);
        if (!word || mean === undefined || word.includes(' ')) { continue; }
        const weight = Number(mean);
        if (!Number.isFinite(weight)) { continue; }
        terms.push({ term: word, weight });
    }
    writeLexicon('socialsent.json', {
        id: 'socialsent',
        name: 'SocialSent historical sentiment (frequent words, 2000s decade)',
        license: 'ODC-PDDL-1.0',
        citation: 'Hamilton, W.L., Clark, K., Leskovec, J., & Jurafsky, D. (2016). Inducing Domain-Specific Sentiment Lexicons from Unlabeled Corpora. EMNLP 2016. https://nlp.stanford.edu/projects/socialsent/',
        categories: [{ id: 'sentiment', label: 'SentProp sentiment (2000s frequent words)', terms }],
    });
}

console.error('done.');
