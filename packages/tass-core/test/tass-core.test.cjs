/*
 * @simdad/tass-core — engine slice tests: deterministic tokenizing, LIWC-style counting with
 * wildcards/weights/multi-category membership, .dic import round-trip (malformed lines counted,
 * never silently dropped), and KWIC context reconstruction from the original text.
 * Runs over compiled output — build first (tsc -b / yarn prepare).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tokenize, compileLexicon, analyze, parseDic, kwic } = require('../lib/index.js');

const LEX = {
    id: 'demo', name: 'Demo lexicon',
    categories: [
        { id: 'posemo', terms: [{ term: 'happy' }, { term: 'happi*' }, { term: 'joy' }] },
        { id: 'negemo', terms: [{ term: 'sad' }, { term: 'cried' }] },
        { id: 'affect', terms: [{ term: 'happy' }, { term: 'happi*' }, { term: 'sad' }, { term: 'cried' }, { term: 'joy' }] },
        { id: 'money', terms: [{ term: 'cash', weight: 2 }] },
    ],
};

test('tokenize: unicode words with offsets, apostrophes kept inside words', () => {
    const text = "Don't worry — l'homme responded.";
    const toks = tokenize(text);
    assert.deepEqual(toks.map(t => t.text), ["Don't", 'worry', "l'homme", 'responded']);
    for (const t of toks) { assert.equal(text.slice(t.start, t.end), t.text); }
});

test('analyze: counts, wildcard stems, multi-category membership, percent normalization', () => {
    const compiled = compileLexicon(LEX);
    const r = analyze('She was happy, then happier, then she cried. Joy!', compiled);
    // tokens: She was happy then happier then she cried Joy = 9
    assert.equal(r.totalTokens, 9);
    const by = Object.fromEntries(r.categories.map(c => [c.id, c]));
    assert.equal(by.posemo.hits, 3, 'happy + happier(stem) + joy');
    assert.equal(by.negemo.hits, 1);
    assert.equal(by.affect.hits, 4, 'a token may belong to several categories');
    assert.deepEqual(by.posemo.matchedForms, ['happy', 'happier', 'joy']);
    assert.ok(Math.abs(by.posemo.percent - (3 / 9) * 100) < 1e-9);
    // Determinism: same input -> deep-equal output.
    assert.deepEqual(analyze('She was happy, then happier, then she cried. Joy!', compiled), r);
});

test('analyze: weights sum separately from hits; empty document is all zeros', () => {
    const compiled = compileLexicon(LEX);
    const r = analyze('cash cash', compiled);
    const money = r.categories.find(c => c.id === 'money');
    assert.equal(money.hits, 2);
    assert.equal(money.weighted, 4);
    const empty = analyze('', compiled);
    assert.equal(empty.totalTokens, 0);
    for (const c of empty.categories) { assert.equal(c.percent, 0); }
});

test('parseDic: header/body round-trip with wildcards + multi-id terms; junk is counted', () => {
    const dic = [
        '%',
        '1\tposemo',
        '2\tnegemo',
        'garbage-header-line',
        '%',
        'happy\t1',
        'happi*\t1',
        'cried\t2',
        'both\t1\t2',
        'orphan\t9',
        'lonely-term-no-id',
        '',
    ].join('\n');
    const { lexicon, skippedLines } = parseDic(dic);
    assert.equal(skippedLines, 3, 'garbage header + orphan(unknown id) + no-id line');
    const pos = lexicon.categories.find(c => c.id === 'posemo');
    const neg = lexicon.categories.find(c => c.id === 'negemo');
    assert.deepEqual(pos.terms.map(t => t.term), ['happy', 'happi*', 'both']);
    assert.deepEqual(neg.terms.map(t => t.term), ['cried', 'both']);
    // And the imported lexicon actually counts.
    const r = analyze('Both cried, then felt happier.', compileLexicon(lexicon));
    const by = Object.fromEntries(r.categories.map(c => [c.id, c]));
    assert.equal(by.posemo.hits, 2, 'both + happier');
    assert.equal(by.negemo.hits, 2, 'both + cried');
});

test('kwic: window in tokens, original spacing preserved, wildcard + case options', () => {
    const text = 'The quick brown fox jumps over the lazy dog. The FOXES were quick.';
    const lines = kwic(text, 'fox*', { window: 2 });
    assert.equal(lines.length, 2);
    assert.equal(lines[0].keyword, 'fox');
    assert.equal(lines[0].left, 'quick brown ');
    assert.equal(lines[0].right, ' jumps over');
    assert.equal(lines[1].keyword, 'FOXES');
    // Offsets point at the source.
    for (const l of lines) { assert.equal(text.slice(l.start, l.end), l.keyword); }
    // Exact (non-wildcard) is case-insensitive by default, and misses when cased off.
    assert.equal(kwic(text, 'foxes').length, 1);
    assert.equal(kwic(text, 'foxes', { caseInsensitive: false }).length, 0);
});
