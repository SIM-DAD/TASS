/*
 * Determinism suite (R9 of the Modern Build Plan refactor): the product guarantee, as a named
 * test. Every artifact-producing command runs TWICE with identical inputs; every artifact must
 * be byte-identical across runs. This is the test a nontrivial engine change must keep green,
 * and the one CI runs per-OS with cross-OS hash comparison (R11).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync, mkdtempSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { createHash } = require('node:crypto');
const { main } = require('../lib/cli.js');

const run = argv => {
    const out = [], err = [];
    const code = main(argv, { out: l => out.push(l), err: l => err.push(l) });
    return { code, out, err };
};

const sha = p => createHash('sha256').update(readFileSync(p)).digest('hex');

const CORPUS = 'session,turn,seconds,speaker,text\n'
    + 's1,1,0,A,"I am very happy today, thank you kindly!"\n'
    + 's1,2,120,B,"This is awful and I HATE it!!"\n'
    + 's1,3,400,A,"Sort of fine, not bad at all."\n'
    + 's1,4,650,B,"The weather is a table lamp."\n';

test('determinism: score artifacts are byte-identical across runs (all metrics, groups, trajectories, vader-rules, json)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tass-det-'));
    const input = join(dir, 'in.csv');
    writeFileSync(input, CORPUS);
    // Same argv both times (the manifest embeds output paths, so identical runs means
    // identical DESTINATIONS too): run, hash, run again over the same paths, compare.
    const a = {
        scored: join(dir, 'out.csv'),
        groups: join(dir, 'out-groups.csv'),
        traj: join(dir, 'out-traj.csv'),
        json: join(dir, 'out.json'),
        cites: join(dir, 'out-cites.txt'),
        manifest: join(dir, 'out.csv.manifest.json'),
    };
    const score = (...extra) => {
        const r = run(['score', '-i', input, '--text-column', 'text', '-o', a.scored,
            '--metrics', 'percent,hits,weighted,mean',
            '--group-column', 'speaker', '--group-summary', a.groups,
            '--window', '300', '--time-column', 'seconds', '--trajectories', a.traj,
            '--json', a.json, '--citations', a.cites, '--vader-rules', ...extra]);
        assert.equal(r.code, 0, r.err.join('\n'));
        return Object.fromEntries(Object.entries(a).map(([k, p]) => [k, sha(p)]));
    };
    const first = score();
    const second = score();
    for (const key of Object.keys(a)) {
        assert.equal(first[key], second[key], `${key} must be byte-identical across runs`);
    }
    // --workers must be byte-identical to single-threaded (M3: same paths, same bytes).
    const workers = score('--workers', '4');
    for (const key of Object.keys(a)) {
        assert.equal(first[key], workers[key], `${key} must be byte-identical with --workers 4`);
    }
});

test('determinism: analyze output is identical across runs', () => {
    const argv = ['analyze', '--text', 'I am SO happy but kinda tired :( really!', '--all', '--vader-rules'];
    const r1 = run(argv);
    const r2 = run(argv);
    assert.equal(r1.code, 0);
    assert.deepEqual(r1.out, r2.out);
});

test('determinism: exemplars and kwic outputs are identical across runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tass-det2-'));
    const input = join(dir, 'in.csv');
    writeFileSync(input, CORPUS);
    for (const argv of [
        ['exemplars', '-i', input, '--text-column', 'text', '--lexicon', 'afinn', '--category', 'valence', '--top', '3', '--bottom', '1'],
        ['kwic', '-i', input, '--text-column', 'text', '-q', 'happ*'],
    ]) {
        const r1 = run(argv);
        const r2 = run(argv);
        assert.equal(r1.code, 0, r1.err.join('\n'));
        assert.deepEqual(r1.out, r2.out, argv[0]);
    }
});
