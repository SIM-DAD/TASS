/*
 * merge-labels: external labels join as ordinary columns with external-classifier
 * provenance; collisions and duplicate keys are refused with actionable messages.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync, mkdtempSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { main } = require('../lib/cli.js');

const run = argv => {
    const out = [], err = [];
    const code = main(argv, { out: l => out.push(l), err: l => err.push(l) });
    return { code, out, err };
};

test('merge-labels: left join by key, blanks for unmatched, provenance manifest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tass-merge-'));
    const corpus = join(dir, 'corpus.csv');
    const labels = join(dir, 'labels.csv');
    const out = join(dir, 'merged.csv');
    writeFileSync(corpus, 'id,text\n1,hello world\n2,goodbye\n3,unlabeled\n');
    writeFileSync(labels, 'id,stance,confidence\n1,pro,0.9\n2,anti,0.7\n9,orphan,0.1\n');
    const r = run(['merge-labels', '-i', corpus, '--labels', labels, '--key', 'id', '-o', out, '--prefix', 'llm_']);
    assert.equal(r.code, 0, r.err.join('\n'));
    const rows = readFileSync(out, 'utf8').trim().split('\n');
    assert.equal(rows[0], 'id,text,llm_stance,llm_confidence');
    assert.equal(rows[1], '1,hello world,pro,0.9');
    assert.equal(rows[3], '3,unlabeled,,');
    assert.ok(r.err.some(l => l.includes('2/3 corpus rows matched') && l.includes('1 label row(s) unmatched')));
    const manifest = JSON.parse(readFileSync(`${out}.manifest.json`, 'utf8'));
    assert.equal(manifest.command, 'merge-labels');
    assert.equal(manifest.settings.labelProvenance, 'external-classifier');
    assert.equal(manifest.inputs.length, 2);
});

test('merge-labels: column collision and duplicate keys are usage errors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tass-merge2-'));
    const corpus = join(dir, 'corpus.csv');
    writeFileSync(corpus, 'id,stance\n1,x\n');
    const labels = join(dir, 'labels.csv');
    writeFileSync(labels, 'id,stance\n1,pro\n');
    const r1 = run(['merge-labels', '-i', corpus, '--labels', labels, '--key', 'id', '-o', join(dir, 'o.csv')]);
    assert.equal(r1.code, 1);
    assert.ok(r1.err.some(l => l.includes('already exist') && l.includes('--prefix')));
    writeFileSync(labels, 'id,tag\n1,a\n1,b\n');
    const r2 = run(['merge-labels', '-i', corpus, '--labels', labels, '--key', 'id', '-o', join(dir, 'o.csv')]);
    assert.equal(r2.code, 1);
    assert.ok(r2.err.some(l => l.includes("duplicate key '1'")));
});
