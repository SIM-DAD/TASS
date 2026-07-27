/*
 * Spreadsheet dictionary authoring tests (Modern Build Plan Section 8.3): the template
 * round-trips, validation errors are row-numbered and collected, warnings surface, and the
 * output is a valid engine lexicon.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseLexiconCsv, LEXICON_CSV_TEMPLATE, loadLexicon, compileLexicon, analyze, TassError } = require('../lib/index.js');

test('template parses into a scoring lexicon (round-trip)', () => {
    const { lexicon, warnings } = parseLexiconCsv(LEXICON_CSV_TEMPLATE);
    assert.equal(lexicon.id, 'my-dictionary');
    assert.equal(lexicon.license, 'CC-BY-4.0');
    assert.deepEqual(lexicon.categories.map(c => c.id), ['positive', 'negative', 'intensity']);
    assert.equal(warnings.length, 0);
    // Valid for the engine (bundled-grade validation) and actually scores.
    const validated = loadLexicon(JSON.parse(JSON.stringify(lexicon)), { bundled: true });
    const r = analyze('I feel joyful today, thank you so much. Nothing terrible.', compileLexicon(validated));
    assert.equal(r.categories.find(c => c.id === 'positive').hits, 2); // joy* + "thank you"
    assert.equal(r.categories.find(c => c.id === 'negative').hits, 1); // terribl*
});

test('metadata: flags override the #block; missing license warns but does not fail', () => {
    const csv = '#id: filed\n#license: MIT\ncategory,term\na,hello\n';
    const r = parseLexiconCsv(csv, { id: 'flagged', citation: undefined });
    assert.equal(r.lexicon.id, 'flagged');
    assert.equal(r.lexicon.license, 'MIT');
    assert.ok(r.warnings.some(w => w.includes('citation')));
});

test('validation: all errors collected, row-numbered', () => {
    const csv = 'category,term,weight\n,hello,\na,,\na,mid*dle,\na,bad phrase* word,\na,x,notanumber\n';
    try {
        parseLexiconCsv(csv);
        assert.fail('should throw');
    } catch (e) {
        assert.ok(e instanceof TassError);
        assert.equal(e.code, 'lexicon-csv/invalid');
        for (const frag of ['line 2: empty category', 'line 3: empty term',
            "line 4: 'mid*dle'", 'line 5:', "line 6: weight 'notanumber'"]) {
            assert.ok(e.message.includes(frag), `${frag} in:\n${e.message}`);
        }
    }
});

test('unknown column and missing required columns are header errors', () => {
    assert.throws(() => parseLexiconCsv('category,term,extra\na,b,c\n'), /unknown column 'extra'/);
    assert.throws(() => parseLexiconCsv('word,cat\na,b\n'), /must include 'category' and 'term'/);
});

test('duplicates dedupe with warning; mixed weighting warns', () => {
    const csv = '#license: MIT\n#citation: X (2026)\ncategory,term,weight\na,hello,\na,hello,\na,world,2\n';
    const r = parseLexiconCsv(csv);
    assert.equal(r.lexicon.categories[0].terms.length, 2);
    assert.ok(r.warnings.some(w => w.includes("duplicate term 'hello'")));
    assert.ok(r.warnings.some(w => w.includes('mixes weighted')));
});

test('semicolon-delimited spreadsheets parse with a warning', () => {
    const r = parseLexiconCsv('category;term\na;hello\na;world\n');
    assert.equal(r.lexicon.categories[0].terms.length, 2);
    assert.ok(r.warnings.some(w => w.includes('semicolon')));
});
