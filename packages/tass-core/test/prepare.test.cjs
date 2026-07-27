/*
 * Prepare (corpus cleaning) engine tests: each operation, the fixed order, filter
 * include/exclude semantics (OR within a column, AND across columns, excludes always),
 * whitespace-only blank handling, and byte-identical determinism on a double run.
 * Runs over compiled output — build first (tsc -b).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prepareCorpus, parseFilterSpec, stringifyCsv, TassError } = require('../lib/index.js');

const HEADER = ['id', 'text', 'cond'];

function prep(rows, options, textColumn = 'text') {
    return prepareCorpus(HEADER, rows, textColumn, options);
}

test('trim: trims ends and collapses internal whitespace runs, text column only', () => {
    const { rows, report } = prep([
        ['1', '  happy \t\n  day  ', '  a  '],
        ['2', 'clean', 'b'],
    ], { trim: true });
    assert.deepEqual(rows, [
        ['1', 'happy day', '  a  '],   // other columns untouched
        ['2', 'clean', 'b'],
    ]);
    assert.equal(report.rowsIn, 2);
    assert.equal(report.rowsOut, 2);
    assert.equal(report.trimApplied, true);
    assert.deepEqual(report.drops, []); // trim never drops
});

test('drop-blank: whitespace-only counts as blank even without trim; examples recorded', () => {
    const { rows, report } = prep([
        ['1', 'kept', 'a'],
        ['2', '   ', 'a'],
        ['3', '', 'a'],
        ['4', '\t\n', 'a'],
    ], { dropBlank: true });
    assert.deepEqual(rows.map(r => r[0]), ['1']);
    assert.deepEqual(report.drops, [
        { op: 'drop-blank', dropped: 3, exampleRowIndexes: [1, 2, 3] },
    ]);
});

test('min-tokens: uses the engine tokenizer (punctuation is not a token)', () => {
    const { rows, report } = prep([
        ['1', 'one two three', 'a'],
        ['2', 'two words', 'a'],
        ['3', '!!! ... ---', 'a'],      // zero tokens
        ['4', "don't stop", 'a'],       // apostrophe word counts as one token -> 2 tokens
    ], { minTokens: 3 });
    assert.deepEqual(rows.map(r => r[0]), ['1']);
    assert.deepEqual(report.drops, [
        { op: 'min-tokens', dropped: 3, exampleRowIndexes: [1, 2, 3] },
    ]);
});

test('filter: same-column includes OR, cross-column includes AND, excludes always apply', () => {
    const header = ['id', 'text', 'cond', 'lang'];
    const rows = [
        ['1', 't', 'treat', 'en'],
        ['2', 't', 'control', 'en'],
        ['3', 't', 'treat', 'de'],
        ['4', 't', 'other', 'en'],
        ['5', 't', 'control', 'de'],
    ];
    // cond=treat OR cond=control, AND lang=en
    const inc = prepareCorpus(header, rows, 'text', {
        filters: [
            parseFilterSpec('cond=treat'), parseFilterSpec('cond=control'), parseFilterSpec('lang=en'),
        ],
    });
    assert.deepEqual(inc.rows.map(r => r[0]), ['1', '2']);
    assert.deepEqual(inc.report.drops, [
        { op: 'filter', dropped: 3, exampleRowIndexes: [2, 3, 4] },
    ]);
    // Exclude alone drops matches and keeps everything else.
    const exc = prepareCorpus(header, rows, 'text', { filters: [parseFilterSpec('lang!=de')] });
    assert.deepEqual(exc.rows.map(r => r[0]), ['1', '2', '4']);
    // Exclude overrides an include hit on the same row.
    const both = prepareCorpus(header, rows, 'text', {
        filters: [parseFilterSpec('cond=treat'), parseFilterSpec('lang!=de')],
    });
    assert.deepEqual(both.rows.map(r => r[0]), ['1']);
});

test('parseFilterSpec: include, exclude, value containing "=", malformed specs throw usage', () => {
    assert.deepEqual(parseFilterSpec('cond=treat'), { column: 'cond', value: 'treat', exclude: false });
    assert.deepEqual(parseFilterSpec('cond!=treat'), { column: 'cond', value: 'treat', exclude: true });
    assert.deepEqual(parseFilterSpec('note=a=b'), { column: 'note', value: 'a=b', exclude: false });
    assert.deepEqual(parseFilterSpec('note!=a=b'), { column: 'note', value: 'a=b', exclude: true });
    for (const bad of ['justtext', '=value', '!=value']) {
        assert.throws(() => parseFilterSpec(bad), e => e instanceof TassError && e.kind === 'usage' && e.code === 'prepare/bad-filter');
    }
});

test('dedup: keeps the first occurrence; comparison is after trim when trim is on', () => {
    const rows = [
        ['1', 'happy day', 'a'],
        ['2', '  happy   day ', 'a'],
        ['3', 'other', 'a'],
    ];
    // trim off: whitespace variants are NOT duplicates.
    const raw = prep(rows, { dedup: true });
    assert.equal(raw.rows.length, 3);
    // trim on: variant collapses to the same text -> dropped as a duplicate.
    const trimmed = prep(rows, { trim: true, dedup: true });
    assert.deepEqual(trimmed.rows.map(r => r[0]), ['1', '3']);
    assert.deepEqual(trimmed.report.drops, [
        { op: 'dedup', dropped: 1, exampleRowIndexes: [1] },
    ]);
});

test('fixed order: blank rows leave before min-tokens/filter/dedup see them', () => {
    const { rows, report } = prep([
        ['1', '   ', 'treat'],          // blank (would also fail min-tokens; counted blank only)
        ['2', 'happy day here', 'treat'],
        ['3', 'happy day here', 'treat'], // duplicate of 2
        ['4', 'tiny', 'treat'],         // under 3 tokens
        ['5', 'three word text', 'control'], // filtered out
    ], { trim: true, dropBlank: true, minTokens: 3, filters: [parseFilterSpec('cond=treat')], dedup: true });
    assert.deepEqual(rows.map(r => r[0]), ['2']);
    assert.deepEqual(report.drops, [
        { op: 'drop-blank', dropped: 1, exampleRowIndexes: [0] },
        { op: 'min-tokens', dropped: 1, exampleRowIndexes: [3] },
        { op: 'filter', dropped: 1, exampleRowIndexes: [4] },
        { op: 'dedup', dropped: 1, exampleRowIndexes: [2] },
    ]);
    assert.equal(report.rowsIn, 5);
    assert.equal(report.rowsOut, 1);
});

test('example dropped row indexes cap at 20 while the count keeps climbing', () => {
    const rows = [];
    for (let i = 0; i < 30; i++) { rows.push([String(i), '', 'a']); }
    rows.push(['keep', 'kept text', 'a']);
    const { report } = prep(rows, { dropBlank: true });
    assert.equal(report.drops[0].dropped, 30);
    assert.equal(report.drops[0].exampleRowIndexes.length, 20);
    assert.deepEqual(report.drops[0].exampleRowIndexes, Array.from({ length: 20 }, (_, i) => i));
});

test('no operations selected throws a usage error naming the operations', () => {
    assert.throws(() => prep([['1', 'x', 'a']], {}),
        e => e instanceof TassError && e.kind === 'usage' && e.code === 'prepare/no-operations'
            && /trim, drop-blank, min-tokens, filter, dedup/.test(e.message));
});

test('unknown text or filter column throws a usage error listing columns', () => {
    assert.throws(() => prep([['1', 'x', 'a']], { trim: true }, 'nope'),
        e => e instanceof TassError && e.code === 'prepare/column-not-found' && /id, text, cond/.test(e.message));
    assert.throws(() => prep([['1', 'x', 'a']], { filters: [parseFilterSpec('missing=v')] }),
        e => e instanceof TassError && e.code === 'prepare/column-not-found');
});

test('determinism: a double run is byte-identical (CSV bytes and report)', () => {
    const rows = [
        ['1', '  a   b  c ', 'treat'],
        ['2', '', 'treat'],
        ['3', 'a b c', 'control'],
        ['4', 'a b c', 'treat'],
    ];
    const opts = { trim: true, dropBlank: true, minTokens: 2, filters: [parseFilterSpec('cond=treat')], dedup: true };
    const one = prep(rows.map(r => r.slice()), opts);
    const two = prep(rows.map(r => r.slice()), opts);
    assert.equal(stringifyCsv([HEADER, ...one.rows]), stringifyCsv([HEADER, ...two.rows]));
    assert.deepEqual(one.report, two.report);
});

test('input rows are not mutated (trim rewrites a copy)', () => {
    const rows = [['1', '  spaced  ', 'a']];
    prep(rows, { trim: true });
    assert.equal(rows[0][1], '  spaced  ');
});
