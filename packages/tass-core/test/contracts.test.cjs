/*
 * Contract-pinning tests (R9 of the Modern Build Plan refactor). These fixtures freeze the
 * two promises a "harmless" edit is most likely to break silently:
 *
 *  - the TOKENIZER is contractually frozen for a given engine version (every published count
 *    depends on it) — the golden corpus below must only ever change alongside a versioned,
 *    documented tokenizer change;
 *  - the MANIFEST SHAPE is the provenance record (docs/API.md schema history) — key ORDER is
 *    part of byte-stability, so it is asserted exactly.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { writeFileSync, mkdtempSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const {
    tokenize, metricValue, fmt, Acc, buildScoreManifest, MANIFEST_VERSION, ENGINE_VERSION,
    listBundled, loadBundled, TassError, parseCsv,
} = require('../lib/index.js');

// ── tokenizer golden corpus ──────────────────────────────────────────────────

const GOLDEN = [
    ['', []],
    ['Hello world', ['Hello', 'world']],
    ["Don't stop", ["Don't", 'stop']],
    ["l'homme naïve café", ["l'homme", 'naïve', 'café']],
    ['rock’n’roll', ['rock’n’roll']],              // chained curly apostrophes stay one token
    ["'quoted' ends'", ['quoted', 'ends']],         // leading/trailing apostrophes are not word-internal
    ['123abc 42 3.14', ['123abc', '42', '3', '14']], // digits tokenize; the dot splits
    ['e-mail state-of-the-art', ['e', 'mail', 'state', 'of', 'the', 'art']], // hyphens split (documented)
    [':-) ... !!!', []],                            // pure punctuation yields no tokens
    ['ναι 日本語 مرحبا', ['ναι', '日本語', 'مرحبا']],  // Unicode letters across scripts
    ['A—B', ['A', 'B']],                            // em dash splits
];

test('tokenizer golden corpus (frozen; changes require a versioned engine change)', () => {
    for (const [input, expected] of GOLDEN) {
        assert.deepEqual(tokenize(input).map(t => t.text), expected, JSON.stringify(input));
    }
});

test('tokenizer offsets slice back to the source text', () => {
    const src = "Don't stop me now";
    for (const t of tokenize(src)) {
        assert.equal(src.slice(t.start, t.end), t.text);
    }
});

// ── metric + formatter contracts ─────────────────────────────────────────────

test('metricValue: mean is undefined (never 0) on zero hits', () => {
    const r = { id: 'x', hits: 0, weighted: 0, percent: 0, matchedForms: [] };
    assert.equal(metricValue(r, 'mean'), undefined);
    assert.equal(metricValue(r, 'percent'), 0);
});

test('fmt is byte-stable: integers bare, 4-dp trim, undefined empty', () => {
    assert.equal(fmt(undefined), '');
    assert.equal(fmt(3), '3');
    assert.equal(fmt(3.14159265), '3.1416');
    assert.equal(fmt(2.5), '2.5');
    assert.equal(fmt(2.0000001), '2');
});

test('Acc: ddof=1 SD, undefined-skipping, n<2 undefined', () => {
    const a = new Acc();
    a.add(2); a.add(undefined); a.add(4);
    assert.equal(a.n, 2);
    assert.equal(a.mean(), 3);
    assert.equal(fmt(a.sd()), fmt(Math.sqrt(2)));
    const b = new Acc(); b.add(5);
    assert.equal(b.sd(), undefined);
});

// ── manifest shape snapshot ──────────────────────────────────────────────────

test('score manifest: exact top-level key order (byte-stability of provenance)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tass-manifest-'));
    const input = join(dir, 'in.csv');
    writeFileSync(input, 'text\nhello\n');
    const m = buildScoreManifest({
        tool: '@simdad/tass-cli', toolVersion: '0.0.0', command: 'score',
        settings: { a: 1 }, inputs: [input], lexicons: [loadBundled('afinn')],
        academicOnlyUsed: [], outputs: ['out.csv'],
    });
    assert.deepEqual(Object.keys(m), [
        'manifestVersion', 'tool', 'version', 'engine', 'engineVersion', 'command',
        'determinism', 'settings', 'inputs', 'lexicons', 'academicOnlyUsed', 'outputs',
    ]);
    assert.equal(m.manifestVersion, MANIFEST_VERSION);
    assert.equal(m.engineVersion, ENGINE_VERSION);
    assert.match(m.inputs[0].sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(m.lexicons[0]),
        ['id', 'name', 'license', 'licenseClass', 'citation', 'categories', 'terms']);
});

// ── bundle + error taxonomy ──────────────────────────────────────────────────

test('bundle discovery scans data/ (no hand-kept list) and loads every entry', () => {
    const ids = listBundled();
    assert.ok(ids.length >= 10, `bundle has ${ids.length} lexicons`);
    assert.deepEqual(ids, [...ids].sort());
    for (const id of ids) { assert.equal(loadBundled(id).id, id); }
});

test('TassError carries stable codes and kinds across module boundaries', () => {
    try {
        parseCsv('"broken');
        assert.fail('should throw');
    } catch (e) {
        assert.ok(e instanceof TassError);
        assert.equal(e.kind, 'runtime');
        assert.equal(e.code, 'csv/unterminated-quote');
    }
});
