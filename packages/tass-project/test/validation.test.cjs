/*
 * Validation-record model tests (Modern Build Plan Section 3.5, validation/): content-derived
 * id stability, zip rewrite preserving every other member byte-identically, the tamper-hash
 * exclusion in BOTH directions (validation edits pass, results edits still fail), orphan
 * partitioning, and byte-identical deterministic sampling.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync, mkdtempSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const {
    writeZip, readZip, loadProject,
    validationId, readValidation, writeValidation,
    deriveMatchUnits, sampleForValidation, partitionValidation,
} = require('../lib/index.js');
const { main } = require('../../tass-cli/lib/cli.js');

const run = argv => {
    const out = [], err = [];
    const code = main(argv, { out: l => out.push(l), err: l => err.push(l) });
    return { code, out, err };
};

// An id column (document identity = its value) + repeated terms (occurrence indexes > 0).
const CORPUS = 'id,text\n'
    + 'd1,"happy happy joy, so happy and glad today"\n'
    + 'd2,"sad and awful, just awful"\n'
    + 'd3,"the table is a lamp"\n';

function makeProject(dir) {
    const input = join(dir, 'in.csv');
    writeFileSync(input, CORPUS);
    const scored = join(dir, 'scored.csv');
    const r = run(['score', '-i', input, '--text-column', 'text', '-o', scored, '--lexicons', 'afinn']);
    assert.equal(r.code, 0, r.err.join('\n'));
    const project = join(dir, 'study.tassproj');
    const s = run(['project', 'save', '--manifest', `${scored}.manifest.json`, '-o', project, '--embed-corpus']);
    assert.equal(s.code, 0, s.err.join('\n'));
    return { input, scored, project };
}

test('validationId: stable, content-derived, sensitive to every field', () => {
    const id = validationId('d1', 'afinn:valence', 'happy', 0);
    assert.equal(id, validationId('d1', 'afinn:valence', 'happy', 0), 'same tuple, same id');
    assert.match(id, /^[0-9a-f]{16}$/);
    const variants = [
        validationId('d2', 'afinn:valence', 'happy', 0),
        validationId('d1', 'other:cat', 'happy', 0),
        validationId('d1', 'afinn:valence', 'glad', 0),
        validationId('d1', 'afinn:valence', 'happy', 1),
    ];
    assert.equal(new Set([id, ...variants]).size, 5, 'every field participates in the hash');
    // Delimiter injection cannot collide: length-prefixed encoding is injective.
    assert.notEqual(validationId('a|b', 'c', 't', 0), validationId('a', 'b|c', 't', 0));
});

test('write/read validation: round-trip, other members byte-identical, deterministic bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tassval-rt-'));
    const { project } = makeProject(dir);
    const before = readZip(readFileSync(project));

    const records = [
        { id: validationId('d1', 'afinn:valence', 'happy', 1), docId: 'd1', category: 'afinn:valence', term: 'happy', occurrence: 1, verdict: 'correct', rater: 'r1' },
        { id: validationId('d2', 'afinn:valence', 'sad', 0), docId: 'd2', category: 'afinn:valence', term: 'sad', occurrence: 0, verdict: 'incorrect', memo: 'negated' },
    ];
    writeValidation(project, records);
    const after = readZip(readFileSync(project));

    assert.equal(after.size, before.size + 1, 'exactly the validation member was added');
    for (const [name, data] of before) {
        assert.ok(after.get(name).equals(data), `${name} must be byte-identical after writeValidation`);
    }
    assert.deepEqual(readValidation(project), [...records].sort((a, b) => a.id < b.id ? -1 : 1));

    // Determinism: writing the same records again produces the same archive bytes.
    const bytes1 = readFileSync(project);
    writeValidation(project, records);
    assert.ok(readFileSync(project).equals(bytes1), 'same records, same bytes');
});

test('tamper exclusion: editing validation/ passes load; editing results/ still fails loudly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tassval-tamper-'));
    const { project } = makeProject(dir);
    writeValidation(project, [{
        id: validationId('d1', 'afinn:valence', 'happy', 0), docId: 'd1',
        category: 'afinn:valence', term: 'happy', occurrence: 0, verdict: 'unsure',
    }]);

    // (a) A reviewer's tool rewrites validation/records.json: load must NOT trip tamper.
    const rewrite = mutate => {
        const entries = readZip(readFileSync(project));
        mutate(entries);
        const rest = [...entries.keys()].filter(n => n !== 'tassproj.json').sort();
        writeFileSync(project, writeZip([
            { name: 'tassproj.json', data: entries.get('tassproj.json') },
            ...rest.map(name => ({ name, data: entries.get(name) })),
        ]));
    };
    rewrite(e => e.set('validation/records.json', Buffer.from('[]\n')));
    assert.doesNotThrow(() => loadProject(project), 'validation/ edits are reviewer-mutable by design');
    assert.deepEqual(readValidation(project), []);

    // (b) The same rewrite against results/ IS tampering and must fail loudly.
    rewrite(e => {
        const name = [...e.keys()].find(k => k.startsWith('results/') && k.endsWith('.csv'));
        e.set(name, Buffer.from(e.get(name).toString('utf8').replace('happy', 'hacked')));
    });
    assert.throws(() => loadProject(project), /content hash mismatch/, 'results/ stays integrity-checked');
});

test('match units: id-column identity, per-occurrence expansion via kwic', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tassval-units-'));
    const { scored } = makeProject(dir);
    const units = deriveMatchUnits(scored, { textColumn: 'text', lexicons: ['afinn'] });
    const happy = units.filter(u => u.docId === 'd1' && u.term === 'happy');
    assert.equal(happy.length, 3, '"happy" appears three times in d1 -> three occurrence units');
    assert.deepEqual(happy.map(u => u.occurrence), [0, 1, 2]);
    assert.ok(happy.every(u => u.excerpt.includes('[happy]')), 'excerpt marks the keyword');
    assert.ok(units.every(u => ['d1', 'd2'].includes(u.docId)), 'doc identity = the id column value');
    assert.ok(units.every(u => u.id === validationId(u.docId, u.category, u.term, u.occurrence)));
});

test('sample: deterministic (two runs identical), per-category cap, ranked order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tassval-sample-'));
    const { scored } = makeProject(dir);
    const opts = { textColumn: 'text', lexicons: ['afinn'], perCategory: 3 };
    const s1 = sampleForValidation(scored, opts);
    const s2 = sampleForValidation(scored, opts);
    assert.deepEqual(s1, s2, 'no RNG anywhere: two runs are identical');
    assert.ok(s1.length <= 3, 'per-category cap holds (one category in afinn)');
    assert.ok(s1.length > 0);
    const all = deriveMatchUnits(scored, opts);
    const topMetric = Math.max(...all.map(u => u.metricValue));
    assert.equal(s1[0].metricValue, topMetric, 'top-k half keeps the highest-scoring unit');
});

test('orphan partition: current ids attach, stale ids are from a previous run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tassval-orphan-'));
    const { scored } = makeProject(dir);
    const units = deriveMatchUnits(scored, { textColumn: 'text', lexicons: ['afinn'] });
    const live = {
        id: units[0].id, docId: units[0].docId, category: units[0].category,
        term: units[0].term, occurrence: units[0].occurrence, verdict: 'correct',
    };
    // An id no current unit derives (e.g. the corpus row was edited since the verdict).
    const stale = {
        id: validationId('d1', 'afinn:valence', 'vanished', 7), docId: 'd1',
        category: 'afinn:valence', term: 'vanished', occurrence: 7, verdict: 'incorrect',
    };
    const { attached, orphaned } = partitionValidation([live, stale], units);
    assert.deepEqual(attached, [live]);
    assert.deepEqual(orphaned, [stale]);
});

test('writeValidation: rejects bad verdicts and duplicate ids before touching the archive', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tassval-guard-'));
    const { project } = makeProject(dir);
    const rec = { id: 'aaaaaaaaaaaaaaaa', docId: 'd1', category: 'c', term: 't', occurrence: 0, verdict: 'correct' };
    assert.throws(() => writeValidation(project, [{ ...rec, verdict: 'maybe' }]), /verdict 'maybe'/);
    assert.throws(() => writeValidation(project, [rec, { ...rec }]), /duplicate validation record id/);
    assert.deepEqual(readValidation(project), [], 'failed writes leave the member untouched');
});
