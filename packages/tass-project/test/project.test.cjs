/*
 * .tassproj container tests: deterministic ZIP round-trip, save/load integrity, tamper
 * detection, and the end-to-end reproduce loop (save -> rerun -> byte-identical) driven
 * through the real CLI in-process.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync, mkdtempSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { writeZip, readZip, crc32, saveProject, loadProject, diffProjects } = require('../lib/index.js');
const { main } = require('../../tass-cli/lib/cli.js');

const run = argv => {
    const out = [], err = [];
    const code = main(argv, { out: l => out.push(l), err: l => err.push(l) });
    return { code, out, err };
};

const CORPUS = 'session,turn,seconds,speaker,text\n'
    + 's1,1,0,A,"I am very happy today, thank you kindly!"\n'
    + 's1,2,120,B,"This is awful and I HATE it!!"\n'
    + 's1,3,400,A,"Sort of fine, not bad at all."\n';

function scoreOnce(dir) {
    const input = join(dir, 'in.csv');
    writeFileSync(input, CORPUS);
    const scored = join(dir, 'scored.csv');
    const r = run(['score', '-i', input, '--text-column', 'text', '-o', scored,
        '--group-column', 'speaker', '--group-summary', join(dir, 'groups.csv'),
        '--json', join(dir, 'rows.json'), '--vader-rules']);
    assert.equal(r.code, 0, r.err.join('\n'));
    return { input, scored, manifest: `${scored}.manifest.json` };
}

test('zip: round-trip, CRC, determinism', () => {
    const entries = [
        { name: 'a.txt', data: Buffer.from('hello') },
        { name: 'dir/b.json', data: Buffer.from('{"x":1}\n') },
        { name: 'empty', data: Buffer.alloc(0) },
    ];
    const z1 = writeZip(entries);
    const z2 = writeZip(entries);
    assert.ok(z1.equals(z2), 'same entries must produce identical archives');
    const back = readZip(z1);
    assert.equal(back.size, 3);
    assert.equal(back.get('a.txt').toString(), 'hello');
    assert.equal(back.get('dir/b.json').toString(), '{"x":1}\n');
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926); // the CRC-32 check value
});

test('save -> load: integrity verified; determinism: same run saves byte-identical projects', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tassproj-'));
    const { manifest } = scoreOnce(dir);
    const p1 = join(dir, 'a.tassproj');
    const p2 = join(dir, 'b.tassproj');
    saveProject({ manifestPath: manifest, output: p1, embedCorpus: true });
    saveProject({ manifestPath: manifest, output: p2, embedCorpus: true });
    assert.ok(readFileSync(p1).equals(readFileSync(p2)), 'same state must save byte-identically');
    const project = loadProject(p1);
    assert.equal(project.meta.tassproj, 1);
    assert.equal(project.meta.corpusMode, 'inline');
    assert.ok(project.entries.has('config.json'));
    assert.ok([...project.entries.keys()].some(k => k.startsWith('results/')));
});

test('tamper detection: a modified entry fails the load loudly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tassproj-tamper-'));
    const { manifest } = scoreOnce(dir);
    const p = join(dir, 'x.tassproj');
    saveProject({ manifestPath: manifest, output: p, embedCorpus: true });
    const buf = readFileSync(p);
    // Flip one byte inside a stored results entry's data region (find the scored CSV header text).
    const at = buf.indexOf(Buffer.from('tass_tokens'));
    assert.ok(at > 0);
    buf[at] = buf[at] ^ 0xff;
    writeFileSync(p, buf);
    assert.throws(() => loadProject(p), /CRC mismatch|content hash mismatch/);
});

test('rerun: embedded-corpus project REPRODUCES byte-identically via the CLI', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tassproj-rerun-'));
    const { manifest } = scoreOnce(dir);
    const p = join(dir, 'study.tassproj');
    const s = run(['project', 'save', '--manifest', manifest, '-o', p, '--embed-corpus']);
    assert.equal(s.code, 0, s.err.join('\n'));
    const r = run(['project', 'rerun', '-i', p, '--dir', join(dir, 'rerun')]);
    assert.equal(r.code, 0, [...r.out, ...r.err].join('\n'));
    assert.ok(r.out.some(l => l.startsWith('REPRODUCED')), r.out.join('\n'));
    assert.ok(r.out.filter(l => l.startsWith('IDENTICAL')).length >= 3);
});

test('rerun: changed referenced input is refused as not-a-reproduction', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tassproj-changed-'));
    const { input, manifest } = scoreOnce(dir);
    const p = join(dir, 'ref.tassproj');
    assert.equal(run(['project', 'save', '--manifest', manifest, '-o', p]).code, 0);
    writeFileSync(input, CORPUS + 's1,4,500,B,"extra row"\n');
    const r = run(['project', 'rerun', '-i', p, '--dir', join(dir, 'rerun')]);
    assert.equal(r.code, 2);
    assert.ok(r.err.some(l => l.includes('has changed since the saved run')), r.err.join('\n'));
});

test('diff: identical runs are equivalent; a config change surfaces with column deltas', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tassproj-diff-'));
    const input = join(dir, 'in.csv');
    writeFileSync(input, CORPUS);
    const mk = (name, extraArgv) => {
        const scored = join(dir, `${name}.csv`);
        const r = run(['score', '-i', input, '--text-column', 'text', '-o', scored, ...extraArgv]);
        assert.equal(r.code, 0, r.err.join('\n'));
        const p = join(dir, `${name}.tassproj`);
        assert.equal(run(['project', 'save', '--manifest', `${scored}.manifest.json`, '-o', p, '--embed-corpus']).code, 0);
        return loadProject(p);
    };
    const a = mk('a', ['--lexicons', 'afinn']);
    const a2 = mk('a2', ['--lexicons', 'afinn']);
    const b = mk('b', ['--lexicons', 'afinn,labmt']);

    const same = diffProjects(a, a2);
    assert.equal(same.config.length, 0);
    assert.equal(same.inputs.length, 0);
    assert.ok(!same.scoredDelta, 'identical config -> identical results');

    const changed = diffProjects(a, b);
    assert.ok(changed.config.some(l => l.includes('lexiconSpecs')), changed.config.join('\n'));
    assert.ok(changed.scoredDelta, 'different lexicons -> scored delta');
    assert.ok(changed.scoredDelta.addedColumns.some(c => c.startsWith('labmt_')));
});
