/**
 * VADER rule layer — a clean-room TASS implementation of the published VADER heuristics
 * (Hutto, C.J. & Gilbert, E.E. (2014). VADER: A Parsimonious Rule-based Model for Sentiment
 * Analysis of Social Media Text. ICWSM-14). The word lists below are from the MIT-licensed
 * published model description; the token valences come from the bundled `vader` lexicon.
 *
 * Heuristics implemented: negation flipping (incl. n't contractions and the "least" rule),
 * booster/dampener words with distance decay, ALL-CAPS emphasis, exclamation/question-mark
 * emphasis, "but"-clause reweighting, emoticon valences (the rule layer keeps whitespace tokens
 * that appear verbatim in the lexicon, e.g. ":)"), and the multi-word idiom tables (scored as
 * units — member words are consumed). NOT implemented (documented limits): UTF-8 emoji
 * description translation, and tokenizer corner cases differ from the reference package.
 * Scores can therefore deviate slightly from the reference vaderSentiment package — report as
 * "TASS VADER-rules compound", never as canonical "VADER compound".
 *
 * Deterministic like everything in TASS: same text + lexicon => identical scores.
 */

export interface VaderScores {
    /** Normalized weighted composite in [-1, 1] — the headline sentiment number. */
    compound: number;
    /** Proportions of the document's sentiment mass (positive + negative + neutral = 1). */
    positive: number;
    negative: number;
    neutral: number;
    /** Lexicon tokens that contributed (post-rules), for trace-back. */
    matchedForms: string[];
}

const B_INCR = 0.293;
const B_DECR = -0.293;
const C_INCR = 0.733;   // ALL-CAPS emphasis
const N_SCALAR = -0.74; // negation flip

const NEGATE = new Set([
    'aint', 'arent', 'cannot', 'cant', 'couldnt', 'darent', 'didnt', 'doesnt', 'dont', 'hadnt',
    'hasnt', 'havent', 'isnt', 'mightnt', 'mustnt', 'neednt', 'neither', 'never', 'none', 'nope',
    'nor', 'not', 'nothing', 'nowhere', 'oughtnt', 'shant', 'shouldnt', 'uhuh', 'uh-uh', 'wasnt',
    'werent', 'without', 'wont', 'wouldnt', 'rarely', 'seldom', 'despite',
]);

const BOOSTERS = new Map<string, number>([
    ['absolutely', B_INCR], ['amazingly', B_INCR], ['awfully', B_INCR], ['completely', B_INCR],
    ['considerably', B_INCR], ['decidedly', B_INCR], ['deeply', B_INCR], ['enormously', B_INCR],
    ['entirely', B_INCR], ['especially', B_INCR], ['exceptionally', B_INCR], ['extremely', B_INCR],
    ['fabulously', B_INCR], ['flipping', B_INCR], ['flippin', B_INCR], ['fricking', B_INCR],
    ['frickin', B_INCR], ['frigging', B_INCR], ['friggin', B_INCR], ['fully', B_INCR],
    ['fucking', B_INCR], ['fuckin', B_INCR], ['greatly', B_INCR], ['hella', B_INCR],
    ['highly', B_INCR], ['hugely', B_INCR], ['incredibly', B_INCR], ['intensely', B_INCR],
    ['majorly', B_INCR], ['more', B_INCR], ['most', B_INCR], ['particularly', B_INCR],
    ['purely', B_INCR], ['quite', B_INCR], ['really', B_INCR], ['remarkably', B_INCR],
    ['so', B_INCR], ['substantially', B_INCR], ['thoroughly', B_INCR], ['totally', B_INCR],
    ['tremendously', B_INCR], ['uber', B_INCR], ['unbelievably', B_INCR], ['unusually', B_INCR],
    ['utterly', B_INCR], ['very', B_INCR],
    ['almost', B_DECR], ['barely', B_DECR], ['hardly', B_DECR], ['kinda', B_DECR],
    ['kindof', B_DECR], ['less', B_DECR], ['little', B_DECR], ['marginally', B_DECR],
    ['occasionally', B_DECR], ['partly', B_DECR], ['scarcely', B_DECR], ['slightly', B_DECR],
    ['somewhat', B_DECR], ['sorta', B_DECR], ['sortof', B_DECR],
]);

/**
 * Multi-word idioms scored as a unit (the published special-case + sentiment-laden tables).
 * A matched idiom becomes ONE token carrying this valence; its member words are consumed, so
 * e.g. "the shit" scores +3 instead of letting "shit" fire its negative word valence.
 * (The reference package defines both tables but only applies the special cases; TASS applies
 * both — a documented deviation covered by the "TASS VADER-rules" label.)
 */
const IDIOM_VALENCE = new Map<string, number>([
    ['the shit', 3], ['the bomb', 3], ['bad ass', 1.5], ['bus stop', 0], ['yeah right', -2],
    ['kiss of death', -1.5], ['to die for', 3], ['beating heart', 3.1], ['broken heart', -2.9],
    ['cut the mustard', 2], ['hand to mouth', -2], ['back handed', -2], ['blow smoke', -2],
    ['blowing smoke', -2], ['upper hand', 1], ['break a leg', 2], ['cooking with gas', 2],
    ['in the black', 2], ['in the red', -2], ['on the ball', 2], ['under the weather', -2],
]);

/** Two-word booster idioms, collapsed onto their existing single-token booster equivalents. */
const IDIOM_COLLAPSE = new Map<string, string>([
    ['kind of', 'kindof'], ['sort of', 'sortof'],
]);

const MAX_IDIOM_WORDS = 4;

/** Strip both apostrophe styles for negation lookup: "isn't"/"isn’t" -> "isnt". */
function bare(word: string): string {
    return word.replace(/['’]/g, '');
}

function isNegation(word: string): boolean {
    const b = bare(word);
    return NEGATE.has(b) || b.endsWith('nt') && NEGATE.has(b) || /n['’]t$/.test(word);
}

function isAllCaps(word: string): boolean {
    return word.length > 1 && word === word.toUpperCase() && /[A-Z]/.test(word);
}

/**
 * Whitespace tokenization that keeps emoticons: a chunk found verbatim (lower-cased) in the
 * lexicon survives as-is (":)", ":-D"); anything else is stripped of leading/trailing
 * punctuation (internal apostrophes survive: "don't,"->"don't"); empty leftovers are dropped.
 */
function wordsAndEmoticons(text: string, valence: Map<string, number>): string[] {
    const out: string[] = [];
    for (const chunk of text.split(/\s+/)) {
        if (chunk === '') { continue; }
        if (valence.has(chunk.toLowerCase())) { out.push(chunk); continue; }
        const stripped = chunk.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
        if (stripped !== '') { out.push(stripped); }
    }
    return out;
}

/**
 * Collapse multi-word idioms into single tokens (greedy, longest span first). Returns the new
 * cased token list plus the idiom-valence overrides keyed by the collapsed token text.
 */
function collapseIdioms(tokens: string[]): { tokens: string[]; idiomVal: Map<string, number> } {
    const out: string[] = [];
    const idiomVal = new Map<string, number>();
    const lower = tokens.map(t => t.toLowerCase());
    let i = 0;
    while (i < tokens.length) {
        let matched = false;
        for (let span = Math.min(MAX_IDIOM_WORDS, tokens.length - i); span >= 2; span--) {
            const joined = lower.slice(i, i + span).join(' ');
            const v = IDIOM_VALENCE.get(joined);
            if (v !== undefined) {
                out.push(joined);
                idiomVal.set(joined, v);
                i += span;
                matched = true;
                break;
            }
            const collapse = IDIOM_COLLAPSE.get(joined);
            if (collapse !== undefined) {
                out.push(collapse);
                i += span;
                matched = true;
                break;
            }
        }
        if (!matched) { out.push(tokens[i]); i++; }
    }
    return { tokens: out, idiomVal };
}

/** x / sqrt(x^2 + alpha), clamped — VADER's compound normalization. */
function normalizeScore(x: number, alpha = 15): number {
    const n = x / Math.sqrt(x * x + alpha);
    return Math.min(1, Math.max(-1, n));
}

/**
 * Score one document with the VADER rule layer. `valence` maps lower-cased lexicon words to
 * their published mean valences (-4..4) — pass the bundled `vader` lexicon's term weights.
 */
export function vaderRuleScore(text: string, valence: Map<string, number>): VaderScores {
    const { tokens: wordsCased, idiomVal } = collapseIdioms(wordsAndEmoticons(text, valence));
    const words = wordsCased.map(w => w.toLowerCase());
    // Idiom tokens override the word lexicon; everything else looks up its lexicon valence.
    const lookup = (w: string) => idiomVal.has(w) ? idiomVal.get(w) : valence.get(w);
    // CAPS emphasis only differentiates when the document MIXES cases (an all-caps rant is style,
    // not emphasis — per the paper).
    const capsCount = wordsCased.filter(isAllCaps).length;
    const capsDifferential = capsCount > 0 && capsCount < wordsCased.length;

    const sentiments: number[] = [];
    const matchedForms: string[] = [];
    const seen = new Set<string>();

    for (let i = 0; i < words.length; i++) {
        const word = words[i];
        // Booster/negation words themselves carry no valence slot of their own.
        if (BOOSTERS.has(word) && lookup(word) === undefined) { sentiments.push(0); continue; }
        let v = lookup(word);
        if (v === undefined) { sentiments.push(0); continue; }

        if (capsDifferential && isAllCaps(wordsCased[i])) {
            v += v > 0 ? C_INCR : v < 0 ? -C_INCR : 0;
        }

        // Look back up to 3 tokens for boosters and negations, with distance decay.
        for (let dist = 1; dist <= 3; dist++) {
            const j = i - dist;
            if (j < 0) { break; }
            const prev = words[j];
            const decay = dist === 1 ? 1 : dist === 2 ? 0.95 : 0.9;
            const boost = BOOSTERS.get(prev);
            if (boost !== undefined && lookup(prev) === undefined) {
                let b = boost;
                if (capsDifferential && isAllCaps(wordsCased[j])) { b += b > 0 ? C_INCR : -C_INCR; }
                v += v > 0 ? b * decay : v < 0 ? -b * decay : 0;
            }
            if (isNegation(prev)) {
                v *= N_SCALAR;
            } else if (dist === 1 && prev === 'least' && (i - 2 < 0 || (words[i - 2] !== 'at' && words[i - 2] !== 'very'))) {
                v *= N_SCALAR; // "least favorite" negates; "at least good" does not
            }
        }

        sentiments.push(v);
        if (v !== 0 && !seen.has(word)) { seen.add(word); matchedForms.push(word); }
    }

    // "but" reweighting: sentiment before the first "but" x0.5, after x1.5.
    const butIdx = words.indexOf('but');
    if (butIdx >= 0) {
        for (let i = 0; i < sentiments.length; i++) {
            if (i < butIdx) { sentiments[i] *= 0.5; }
            else if (i > butIdx) { sentiments[i] *= 1.5; }
        }
    }

    let sum = sentiments.reduce((a, b) => a + b, 0);

    // Punctuation emphasis (from the raw text, since the tokenizer drops punctuation).
    const bangs = Math.min((text.match(/!/g) ?? []).length, 4);
    const qms = (text.match(/\?/g) ?? []).length;
    let punct = bangs * 0.292;
    if (qms > 1) { punct += qms <= 3 ? qms * 0.18 : 0.96; }
    if (sum > 0) { sum += punct; } else if (sum < 0) { sum -= punct; }

    const compound = sentiments.some(s => s !== 0) ? normalizeScore(sum) : 0;

    // Sentiment mass ratios (VADER's sift): |v|+1 per signed token, 1 per scored-neutral token.
    let pos = 0, neg = 0, neu = 0;
    for (let i = 0; i < sentiments.length; i++) {
        const s = sentiments[i];
        if (s > 0) { pos += s + 1; }
        else if (s < 0) { neg += -s + 1; }
        else if (lookup(words[i]) !== undefined) { neu += 1; }
    }
    if (pos > Math.abs(neg)) { pos += punct; } else if (pos < Math.abs(neg)) { neg += punct; }
    const total = pos + neg + neu;
    const r = (n: number) => total === 0 ? 0 : Math.round((n / total) * 1000) / 1000;

    return {
        compound: Math.round(compound * 10000) / 10000,
        positive: r(pos),
        negative: r(neg),
        neutral: r(neu),
        matchedForms,
    };
}

/** Build the word->valence map the rule layer needs from a lexicon's flat term list. */
export function valenceMap(terms: Array<{ term: string; weight?: number }>): Map<string, number> {
    const m = new Map<string, number>();
    for (const t of terms) {
        if (!t.term.endsWith('*') && !t.term.includes(' ')) { m.set(t.term.toLowerCase(), t.weight ?? 0); }
    }
    return m;
}
