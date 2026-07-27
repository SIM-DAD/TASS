/*
 * `tass validation` CLI tests: sample determinism (two runs byte-identical), import with
 * ALL row errors collected (lexicon-csv style), export with attached/orphaned status,
 * and the summary math (counts + precision proxy).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync, mkdtempSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { main } = require('../lib/cli.js');
const { validationId, writeValidation, readValidation } = require('../../tass-project/lib/index.js');

const run = argv => {
    const out = [], err = [];
    const code = main(argv, { out: l => out.push(l), err: l => err.push(l) });
    return { code, out, err };
};

const CORPUS = 'id,text\n'
    + 'd1,"happy happy joy, so happy and glad today"\n'
    + 'd2,"sad and awful, just awful"\n'
    + 'd3,"the table is a lamp"\n';

function makeProject(dir) {
    const input = join(dir, 'in.csv');
    writeFileSync(input, CORPUS);
    const scored = join(dir, 'scored.csv');
    assert.equal(run(['score', '-i', input, '--text-column', 'text', '-o', scored, '--lexicons', 'afinn']).code, 0);
    const project = join(dir, 'study.tassproj');
    assert.equal(run(['project', 'save', '--manifest', `${scored}.manifest.json`, '-o', project, '--embed-corpus']).code, 0);
    return { scored, project };
}

/** Minimal CSV split for the review sheet (no quoted commas in these fixtures' key cells). */
const parseSheet = path => readFileSync(path, 'utf8').trim().split('\n');

test('sample: review sheet from a project, deterministic byte-identical across runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tassvalcli-sample-'));
    const { project } = makeProject(dir);
    const s1 = join(dir, 'review1.csv'), s2 = join(dir, 'review2.csv');
    const r1 = run(['validation', 'sample', '--project', project, '-o', s1, '--per-category', '4']);
    assert.equal(r1.code, 0, r1.err.join('\n'));
    assert.equal(run(['validation', 'sample', '--project', project, '-o', s2, '--per-category', '4']).code, 0);
    assert.ok(readFileSync(s1).equals(readFileSync(s2)), 'sampling has no RNG: byte-identical');

    const lines = parseSheet(s1);
    assert.equal(lines[0], 'validation_id,doc_id,category,term,occurrence,text_excerpt,metric_value,verdict,memo');
    assert.ok(lines.length >= 2 && lines.length <= 5, `per-category cap: ${lines.length - 1} rows`);
    assert.ok(lines.slice(1).every(l => l.endsWith(',,')), 'verdict + memo are blank for the human');
});

test('sample: --input scored.csv path works without a project', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tassvalcli-input-'));
    const { scored } = makeProject(dir);
    const sheet = join(dir, 'review.csv');
    const r = run(['validation', 'sample', '--input', scored, '--text-column', 'text',
        '--lexicons', 'afinn', '-o', sheet]);
    assert.equal(r.code, 0, r.err.join('\n'));
    assert.ok(parseSheet(sheet).length > 1);
    // Exactly one of --project/--input, and --input needs --text-column.
    assert.equal(run(['validation', 'sample', '-o', sheet]).code, 1);
    assert.equal(run(['validation', 'sample', '--input', scored, '-o', sheet]).code, 1);
});

test('import: collects ALL row errors, row-numbered, and writes nothing on failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tassvalcli-err-'));
    const { project } = makeProject(dir);
    const goodId = validationId('d1', 'afinn:valence', 'happy', 0);
    const sheet = join(dir, 'review.csv');
    writeFileSync(sheet, [
        'validation_id,doc_id,category,term,occurrence,text_excerpt,metric_value,verdict,memo',
        `${goodId},d1,afinn:valence,happy,0,x,1,valid,`,          // bad verdict word
        `${goodId},d1,afinn:valence,happy,oops,x,1,correct,`,     // bad occurrence
        `deadbeefdeadbeef,d1,afinn:valence,happy,1,x,1,correct,`, // id does not re-derive
        `${goodId},d1,afinn:valence,happy,0,x,1,correct,ok`,      // fine
        `${goodId},d1,afinn:valence,happy,0,x,1,unsure,`,         // duplicate of line 5
        '',
    ].join('\n'));
    const r = run(['validation', 'import', '--project', project, '--input', sheet]);
    assert.equal(r.code, 1);
    const msg = r.err.join('\n');
    assert.match(msg, /line 2: verdict 'valid'/);
    assert.match(msg, /line 3: occurrence 'oops'/);
    assert.match(msg, /line 4: validation_id 'deadbeefdeadbeef' does not match/);
    assert.match(msg, /line 6: duplicate validation_id/);
    assert.deepEqual(readValidation(project), [], 'a failed import writes no records');
});

test('import + summary: verdicts land in validation/, math checks out', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tassvalcli-sum-'));
    const { project } = makeProject(dir);
    const rec = (doc, term, occ, verdict) =>
        `${validationId(doc, 'afinn:valence', term, occ)},${doc},afinn:valence,${term},${occ},x,1,${verdict},`;
    const sheet = join(dir, 'review.csv');
    writeFileSync(sheet, [
        'validation_id,doc_id,category,term,occurrence,verdict,memo'
            .replace('occurrence,', 'occurrence,text_excerpt,metric_value,'),
        rec('d1', 'happy', 0, 'correct'),
        rec('d1', 'happy', 1, 'correct'),
        rec('d1', 'happy', 2, 'incorrect'),
        rec('d2', 'sad', 0, 'unsure'),
        `${validationId('d2', 'afinn:valence', 'awful', 0)},d2,afinn:valence,awful,0,x,1,,`, // uncoded -> skipped
        '',
    ].join('\n'));
    const imp = run(['validation', 'import', '--project', project, '--input', sheet]);
    assert.equal(imp.code, 0, imp.err.join('\n'));
    assert.match(imp.err.join('\n'), /4 verdict\(s\).*1 uncoded row\(s\) skipped/);

    const sum = run(['validation', 'summary', '--project', project]);
    assert.equal(sum.code, 0, sum.err.join('\n'));
    const j = JSON.parse(sum.out.join('\n'));
    assert.equal(j.records, 4);
    assert.deepEqual(j.categories.map(c => c.category), ['afinn:valence']);
    const c = j.categories[0];
    assert.equal(c.correct, 2);
    assert.equal(c.incorrect, 1);
    assert.equal(c.unsure, 1);
    assert.equal(c.total, 4);
    assert.equal(c.precisionProxy, Number((2 / 3).toFixed(4)), 'precision proxy = correct/(correct+incorrect)');
    assert.equal(j.overall.precisionProxy, c.precisionProxy);
});

test('export: attached vs orphaned status; orphans say "from a previous run"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tassvalcli-exp-'));
    const { project } = makeProject(dir);
    const live = {
        id: validationId('d1', 'afinn:valence', 'happy', 0), docId: 'd1',
        category: 'afinn:valence', term: 'happy', occurrence: 0, verdict: 'correct',
    };
    // A verdict whose id the current scored output cannot re-derive (edited corpus row).
    const stale = {
        id: validationId('dX', 'afinn:valence', 'gone', 0), docId: 'dX',
        category: 'afinn:valence', term: 'gone', occurrence: 0, verdict: 'incorrect', memo: 'old run',
    };
    writeValidation(project, [live, stale]);

    const out = join(dir, 'records.csv');
    const r = run(['validation', 'export', '--project', project, '-o', out]);
    assert.equal(r.code, 0, r.err.join('\n'));
    const lines = parseSheet(out);
    assert.equal(lines[0], 'validation_id,doc_id,category,term,occurrence,verdict,memo,rater,status');
    const liveLine = lines.find(l => l.startsWith(live.id));
    const staleLine = lines.find(l => l.startsWith(stale.id));
    assert.ok(liveLine.endsWith(',attached'), liveLine);
    assert.ok(staleLine.includes('orphaned (from a previous run)'), staleLine);
    assert.match(r.err.join('\n'), /1 attached, 1 orphaned/);
    assert.match(r.err.join('\n'), /from a previous run/, 'orphans are reported VISIBLY');
});

test('validation appears in MCP tool list via the shared spec table', () => {
    const { toolList } = require('../lib/mcp.js');
    const names = toolList().map(t => t.name);
    for (const t of ['tass_validation_sample', 'tass_validation_import', 'tass_validation_export', 'tass_validation_summary']) {
        assert.ok(names.includes(t), t);
    }
});
