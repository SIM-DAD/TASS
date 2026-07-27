/*
 * @simdad/tass-core — bundled-lexicon tests over the REAL data files (data/lexicons/*.json,
 * built by scripts/build-lexicons.mjs). Contract: every bundled lexicon validates with license +
 * citation present (the attribution rule), loads at real size, and actually scores text.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { loadLexicon, compileLexicon, analyze, listBundled } = require('../lib/index.js');

const dataDir = join(__dirname, '..', 'data', 'lexicons');
const load = id => loadLexicon(JSON.parse(readFileSync(join(dataDir, `${id}.json`), 'utf8')));

test('every bundled lexicon validates with license + citation (attribution rule)', () => {
    for (const id of listBundled()) {
        const lex = load(id);
        assert.equal(lex.id, id);
        assert.ok(lex.license, `${id}: license`);
        assert.match(lex.citation, /https?:\/\//, `${id}: citation carries a source URL`);
        assert.ok(lex.categories.length > 0);
    }
});

test('sizes are in the expected order of magnitude (guard against a truncated fetch)', () => {
    assert.ok(load('vader').categories[0].terms.length > 7000, 'vader ~7.5k');
    assert.ok(load('afinn').categories[0].terms.length > 3000, 'afinn ~3.3k');
    const empath = load('empath');
    assert.ok(empath.categories.length > 150, 'empath ~194 categories');
});

test('vader scores real text: positive words sum positive, negative negative', () => {
    const compiled = compileLexicon(load('vader'));
    const pos = analyze('What a wonderful, happy, great day.', compiled).categories[0];
    const neg = analyze('A horrible, sad disaster of a day.', compiled).categories[0];
    assert.ok(pos.weighted > 0, `positive weighted sum, got ${pos.weighted}`);
    assert.ok(neg.weighted < 0, `negative weighted sum, got ${neg.weighted}`);
});

test('empath categories fire on on-topic text', () => {
    const compiled = compileLexicon(load('empath'));
    const r = analyze('The soldier fired his weapon during the war.', compiled);
    const hits = r.categories.filter(c => c.hits > 0).map(c => c.id);
    assert.ok(hits.includes('war') || hits.includes('weapon') || hits.includes('fight'),
        `expected a conflict-ish category, got: ${hits.slice(0, 12).join(', ')}`);
});

test('loader fail-loud: bundled data without a license is rejected', () => {
    assert.throws(() => loadLexicon({ id: 'x', name: 'X', categories: [{ id: 'c', terms: [{ term: 'a' }] }] }),
        /must declare license/);
    // …but a user-imported lexicon may omit it.
    const ok = loadLexicon({ id: 'x', name: 'X', categories: [{ id: 'c', terms: [{ term: 'a' }] }] }, { bundled: false });
    assert.equal(ok.id, 'x');
});
