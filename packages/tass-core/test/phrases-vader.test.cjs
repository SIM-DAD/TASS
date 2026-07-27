/* Engine 0.4.0: n-gram (phrase) term matching + the VADER rule layer. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compileLexicon, analyze } = require('../lib/index.js');
const { vaderRuleScore, valenceMap } = require('../lib/vader.js');

function lex(categories) {
    return compileLexicon({ id: 't', name: 'T', categories });
}

test('phrases: greedy longest-first matching, phrase = one hit, stem tail works', () => {
    const cl = lex([{ id: 'p', terms: [{ term: 'thank you' }, { term: 'thank*' }, { term: 'would you mind*' }] }]);
    const r = analyze('thank you thank thanks would you mind waiting', cl).categories[0];
    // 'thank you' (phrase), thank + thanks (stem singles), 'would you mind*' (phrase w/ stem tail)
    assert.equal(r.hits, 4);
    assert.equal(analyze('thank you thank thanks would you mind waiting', cl).totalTokens, 8);
    assert.equal(r.percent, 50);
    assert.deepEqual(r.matchedForms, ['thank you', 'would you mind*', 'thank', 'thanks']);
});

test('phrases: consumed tokens do not double-count within the SAME category', () => {
    const cl = lex([{ id: 'p', terms: [{ term: 'thank you' }, { term: 'you' }] }]);
    const r = analyze('thank you', cl).categories[0];
    assert.equal(r.hits, 1);
    assert.deepEqual(r.matchedForms, ['thank you']);
});

test('phrases: other categories still see the consumed tokens', () => {
    const cl = lex([
        { id: 'a', terms: [{ term: 'thank you' }] },
        { id: 'b', terms: [{ term: 'you' }] },
    ]);
    const r = analyze('thank you', cl);
    assert.equal(r.categories[0].hits, 1);
    assert.equal(r.categories[1].hits, 1);
});

test('phrases: weights and case-insensitivity', () => {
    const cl = lex([{ id: 'p', terms: [{ term: 'Kind Of', weight: 2 }] }]);
    const r = analyze('it was kind of odd', cl).categories[0];
    assert.equal(r.hits, 1);
    assert.equal(r.weighted, 2);
});

const V = valenceMap([
    { term: 'good', weight: 1.9 }, { term: 'great', weight: 3.1 }, { term: 'bad', weight: -2.5 },
    { term: 'happi*', weight: 9 },      // stems must be ignored by the rule layer
    { term: 'kiss of death', weight: -9 }, // phrases too
]);

test('vader rules: valenceMap keeps only single literal tokens', () => {
    assert.equal(V.size, 3);
    assert.equal(V.get('good'), 1.9);
});

test('vader rules: polarity, negation, boosters, caps, punctuation, but-clause', () => {
    const base = vaderRuleScore('this is good', V).compound;
    assert.ok(base > 0);
    assert.ok(vaderRuleScore('this is not good', V).compound < 0, 'negation flips');
    assert.ok(vaderRuleScore("this isn't good", V).compound < 0, "n't contraction negates");
    assert.ok(vaderRuleScore('this is very good', V).compound > base, 'booster amplifies');
    assert.ok(vaderRuleScore('this is barely good', V).compound < base, 'dampener reduces');
    assert.ok(vaderRuleScore('this is good!!!', V).compound > base, 'exclamations amplify');
    assert.ok(vaderRuleScore('this is GOOD here', V).compound > base, 'ALL-CAPS emphasis (mixed-case doc)');
    assert.ok(vaderRuleScore('good but bad', V).compound < 0, 'but-clause reweights toward the after-side');
    assert.ok(vaderRuleScore('bad but good', V).compound > 0);
});

test('vader rules: neutral text scores 0 and ratios sum sensibly', () => {
    const r = vaderRuleScore('the table and the chair', V);
    assert.equal(r.compound, 0);
    assert.deepEqual(r.matchedForms, []);
    const s = vaderRuleScore('good and bad and good', V);
    assert.ok(Math.abs(s.positive + s.negative + s.neutral - 1) < 0.01);
    assert.deepEqual(s.matchedForms, ['good', 'bad']);
});

test('vader rules: emoticons in the lexicon survive tokenization and score', () => {
    const VE = valenceMap([{ term: 'good', weight: 1.9 }, { term: ':)', weight: 2 }, { term: ':(', weight: -1.9 }]);
    const base = vaderRuleScore('the meeting was good', VE).compound;
    const smiled = vaderRuleScore('the meeting was good :)', VE);
    assert.ok(smiled.compound > base, 'positive emoticon raises compound');
    assert.ok(smiled.matchedForms.includes(':)'));
    assert.ok(vaderRuleScore(':(', VE).compound < 0, 'emoticon alone scores');
    // Punctuation NOT in the lexicon is stripped, not scored.
    assert.equal(vaderRuleScore('good!!', VE).matchedForms.length, 1);
});

test('vader rules: multi-word idioms score as units and consume member words', () => {
    const VI = valenceMap([{ term: 'shit', weight: -2.6 }, { term: 'death', weight: -2.9 }, { term: 'good', weight: 1.9 }]);
    assert.ok(vaderRuleScore('that show was the shit', VI).compound > 0, '"the shit" is positive despite "shit"');
    const kiss = vaderRuleScore('it was the kiss of death', VI);
    assert.ok(kiss.compound < 0);
    assert.deepEqual(kiss.matchedForms, ['kiss of death'], 'idiom is the matched form, not "death"');
    assert.ok(vaderRuleScore('yeah right, good', VI).compound < vaderRuleScore('good', VI).compound);
});

test('vader rules: two-word booster idioms dampen like their single-token forms', () => {
    const VG = valenceMap([{ term: 'good', weight: 1.9 }]);
    const base = vaderRuleScore('it was good', VG).compound;
    const damped = vaderRuleScore('it was kind of good', VG).compound;
    assert.ok(damped < base, '"kind of" dampens');
    assert.ok(damped > 0);
    assert.equal(damped, vaderRuleScore('it was kindof good', VG).compound, 'collapses onto the kindof booster');
});

test('vader rules: deterministic', () => {
    const a = JSON.stringify(vaderRuleScore('really not GOOD but great!!', V));
    const b = JSON.stringify(vaderRuleScore('really not GOOD but great!!', V));
    assert.equal(a, b);
});
