/*
 * CLI tests: drive main(argv, io) in-process (no child processes) over real temp files.
 * A custom lexicon fixture keeps score expectations independent of the bundled data;
 * one test exercises the bundled bundle only for loading/attribution wiring.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { main } = require('../lib/cli.js');

function run(argv) {
    const out = [];
    const err = [];
    const code = main(argv, { out: l => out.push(l), err: l => err.push(l) });
    return { code, out, err };
}

const dir = mkdtempSync(join(tmpdir(), 'tass-cli-'));

const LEX_PATH = join(dir, 'demo-lex.json');
writeFileSync(LEX_PATH, JSON.stringify({
    id: 'demo', name: 'Demo',
    categories: [
        { id: 'posemo', terms: [{ term: 'happy' }, { term: 'happi*' }, { term: 'joy', weight: 2 }] },
        { id: 'negemo', terms: [{ term: 'sad' }] },
    ],
}));

const CSV_PATH = join(dir, 'corpus.csv');
writeFileSync(CSV_PATH, [
    'id,text,cond',
    '1,"happy happy joy",treat',
    '2,"sad and flat",control',
    '3,"happiness rising",treat',
    '',
].join('\n'));

test('dicts lists the bundle with license and citation', () => {
    const r = run(['dicts']);
    assert.equal(r.code, 0);
    const text = r.out.join('\n');
    for (const id of ['afinn', 'vader', 'empath']) { assert.match(text, new RegExp(`^${id} `, 'm')); }
    assert.match(text, /license: MIT/);
    assert.match(text, /cite: /);
});

test('score: custom lexicon, all metrics, exact values', () => {
    const out = join(dir, 'scored.csv');
    const r = run(['score', '-i', CSV_PATH, '--text-column', 'text', '--lexicons', LEX_PATH,
        '--metrics', 'percent,hits,weighted', '-o', out]);
    assert.equal(r.code, 0, r.err.join('\n'));
    const rows = readFileSync(out, 'utf8').trim().split('\n').map(l => l.split(','));
    assert.deepEqual(rows[0], ['id', 'text', 'cond', 'tass_tokens',
        'demo_posemo_percent', 'demo_posemo_hits', 'demo_posemo_weighted',
        'demo_negemo_percent', 'demo_negemo_hits', 'demo_negemo_weighted']);
    // doc 1: "happy happy joy" -> 3 tokens, posemo hits 3, weighted 1+1+2=4, 100%
    assert.deepEqual(rows[1].slice(3), ['3', '100', '3', '4', '0', '0', '0']);
    // doc 2: "sad and flat" -> 3 tokens, negemo 1 hit, 33.3333%
    assert.deepEqual(rows[2].slice(3), ['3', '0', '0', '0', '33.3333', '1', '1']);
    // doc 3: "happiness rising" -> stem happi* fires once: 50%
    assert.deepEqual(rows[3].slice(3), ['2', '50', '1', '1', '0', '0', '0']);
});

test('score: group summary with mean/sd/n per column', () => {
    const out = join(dir, 'scored2.csv');
    const means = join(dir, 'means.csv');
    const r = run(['score', '-i', CSV_PATH, '--text-column', 'text', '--lexicons', LEX_PATH,
        '--group-column', 'cond', '-o', out, '--group-summary', means]);
    assert.equal(r.code, 0, r.err.join('\n'));
    const rows = readFileSync(means, 'utf8').trim().split('\n').map(l => l.split(','));
    assert.deepEqual(rows[0], ['cond', 'n', 'mean_tass_tokens',
        'mean_demo_posemo_percent', 'sd_demo_posemo_percent', 'n_demo_posemo_percent',
        'mean_demo_negemo_percent', 'sd_demo_negemo_percent', 'n_demo_negemo_percent']);
    // control: one doc -> sd blank at n=1; treat: docs 1+3 -> mean (100+50)/2, sd sqrt(1250)
    assert.deepEqual(rows[1], ['control', '1', '3', '0', '', '1', '33.3333', '', '1']);
    assert.deepEqual(rows[2], ['treat', '2', '2.5', '75', '35.3553', '2', '0', '0', '2']);
});

test('score: composite speaker x session grouping', () => {
    const csv = join(dir, 'multi.csv');
    writeFileSync(csv, ['speaker,session,text',
        'A,s1,happy joy', 'A,s2,sad', 'B,s1,happy', 'B,s1,joy joy', ''].join('\n'));
    const out = join(dir, 'multi-scored.csv');
    const means = join(dir, 'multi-means.csv');
    const r = run(['score', '-i', csv, '--text-column', 'text', '--lexicons', LEX_PATH,
        '--group-column', 'speaker,session', '-o', out, '--group-summary', means]);
    assert.equal(r.code, 0, r.err.join('\n'));
    const rows = readFileSync(means, 'utf8').trim().split('\n').map(l => l.split(','));
    assert.deepEqual(rows[0].slice(0, 3), ['speaker', 'session', 'n']);
    assert.deepEqual(rows.slice(1).map(r2 => `${r2[0]}|${r2[1]}|${r2[2]}`), ['A|s1|1', 'A|s2|1', 'B|s1|2']);
});

test('score: mean metric is weighted/hits, blank when no hits', () => {
    const out = join(dir, 'mean.csv');
    const r = run(['score', '-i', CSV_PATH, '--text-column', 'text', '--lexicons', LEX_PATH,
        '--metrics', 'mean', '-o', out]);
    assert.equal(r.code, 0, r.err.join('\n'));
    const rows = readFileSync(out, 'utf8').trim().split('\n').map(l => l.split(','));
    // doc1 posemo weighted 4 / hits 3; doc1 negemo no hits -> blank
    assert.equal(rows[1][4], '1.3333');
    assert.equal(rows[1][5], '');
});

test('score: windowed trajectories', () => {
    const csv = join(dir, 'time.csv');
    writeFileSync(csv, ['session,seconds,text',
        's1,0,happy', 's1,100,joy', 's1,400,sad', 's1,500,sad sad', ''].join('\n'));
    const out = join(dir, 'time-scored.csv');
    const traj = join(dir, 'traj.csv');
    const r = run(['score', '-i', csv, '--text-column', 'text', '--lexicons', LEX_PATH,
        '--group-column', 'session', '--window', '300', '--time-column', 'seconds',
        '--trajectories', traj, '-o', out]);
    assert.equal(r.code, 0, r.err.join('\n'));
    const rows = readFileSync(traj, 'utf8').trim().split('\n').map(l => l.split(','));
    assert.deepEqual(rows[0].slice(0, 4), ['session', 'window_start_seconds', 'window_start', 'n']);
    // window 0: turns at 0+100 (n=2); window 300: turns at 400+500 (n=2)
    assert.deepEqual(rows[1].slice(0, 4), ['s1', '0', '0:00', '2']);
    assert.deepEqual(rows[2].slice(0, 4), ['s1', '300', '5:00', '2']);
});

test('score: manifest carries hashes, provenance, and academic-only flags', () => {
    const nrc = join(dir, 'fake-nrc.txt');
    writeFileSync(nrc, 'abandon\tfear\t1\nabandon\tsadness\t1\nabandon\tjoy\t0\ncherish\tjoy\t1\n');
    const nrcLex = join(dir, 'nrc.json');
    assert.equal(run(['import-nrc', '-i', nrc, '-o', nrcLex]).code, 0);
    const out = join(dir, 'nrc-scored.csv');
    const r = run(['score', '-i', CSV_PATH, '--text-column', 'text', '--lexicons', `afinn,${nrcLex}`, '-o', out]);
    assert.equal(r.code, 0, r.err.join('\n'));
    assert.match(r.err.join('\n'), /ACADEMIC-ONLY/);
    const manifest = JSON.parse(readFileSync(`${out}.manifest.json`, 'utf8'));
    assert.equal(manifest.inputs.length, 1);
    assert.match(manifest.inputs[0].sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(manifest.academicOnlyUsed, ['nrc-emolex']);
    const afinn = manifest.lexicons.find(l => l.id === 'afinn');
    assert.equal(afinn.licenseClass, 'commercial-ok');
    assert.match(afinn.citation, /Nielsen/);
});

test('ingest: speaker-labeled transcripts -> turn CSV (dyad + monologue)', () => {
    const tdir = join(dir, 'transcripts');
    require('node:fs').mkdirSync(tdir, { recursive: true });
    writeFileSync(join(tdir, 'session-a.md'), [
        '# Session A — speaker-labeled transcript', '',
        'Mapping: SPEAKER_00→DR. K, SPEAKER_01→BYRON', '',
        '[0:00] **DR. K:** How are you feeling today?', '',
        '[0:12] **BYRON:** Honestly, pretty happy.',
        'It comes and goes though.', '',
        '[1:02:33] **DR. K:** Tell me more.', '',
    ].join('\n'));
    writeFileSync(join(tdir, 'monologue.md'), [
        '# Monologue — speaker-labeled transcript', '',
        '[0:05] **DR. K:** Today I want to talk about grief.', '',
    ].join('\n'));
    writeFileSync(join(tdir, 'QC-REPORT.md'), '# QC report\nNo turns here.\n');
    const out = join(dir, 'turns.csv');
    const r = run(['ingest', '-i', tdir, '-o', out]);
    assert.equal(r.code, 0, r.err.join('\n'));
    assert.match(r.err.join('\n'), /skipped \(no turn lines\): QC-REPORT.md/);
    const { parseCsv } = require('@simdad/tass-core');
    const rows = parseCsv(readFileSync(out, 'utf8'));
    assert.deepEqual(rows[0], ['session', 'turn', 'timestamp', 'seconds', 'speaker', 'text']);
    assert.equal(rows.length, 1 + 4);
    // continuation line folded into turn 2; H:MM:SS parsed
    const byron = rows.find(r2 => r2[4] === 'BYRON');
    assert.equal(byron[5], 'Honestly, pretty happy. It comes and goes though.');
    const late = rows.find(r2 => r2[2] === '1:02:33');
    assert.equal(late[3], String(1 * 3600 + 2 * 60 + 33));
    assert.equal(rows.filter(r2 => r2[0] === 'monologue').length, 1);
});

test('exemplars: top/bottom trace-back with matched terms', () => {
    const out = join(dir, 'exemplars.csv');
    const r = run(['exemplars', '-i', CSV_PATH, '--text-column', 'text', '--lexicon', LEX_PATH,
        '--category', 'posemo', '--top', '1', '--bottom', '1', '-o', out]);
    assert.equal(r.code, 0, r.err.join('\n'));
    const rows = readFileSync(out, 'utf8').trim().split('\n');
    assert.match(rows[0], /tass_exemplar_rank,demo_posemo_percent,matched_terms/);
    assert.match(rows[1], /^1,.*top,100,happy; joy/);  // doc 1 is the top posemo turn
    const bad = run(['exemplars', '-i', CSV_PATH, '--text-column', 'text', '--lexicon', LEX_PATH,
        '--category', 'nope']);
    assert.equal(bad.code, 1);
    assert.match(bad.err.join('\n'), /has: posemo, negemo/);
});

test('score: bundled lexicons load and produce columns', () => {
    const out = join(dir, 'scored3.csv');
    const cites = join(dir, 'cites.txt');
    const r = run(['score', '-i', CSV_PATH, '--text-column', 'text', '--lexicons', 'afinn',
        '-o', out, '--citations', cites]);
    assert.equal(r.code, 0, r.err.join('\n'));
    const header = readFileSync(out, 'utf8').split('\n')[0];
    assert.match(header, /afinn_valence_percent/);
    assert.match(readFileSync(cites, 'utf8'), /Nielsen/);
});

test('score: TXT files, one document each', () => {
    const t1 = join(dir, 'a.txt'); writeFileSync(t1, 'happy words here');
    const t2 = join(dir, 'b.txt'); writeFileSync(t2, 'sad words here');
    const out = join(dir, 'scored-txt.csv');
    const r = run(['score', '-i', t1, '-i', t2, '--lexicons', LEX_PATH, '-o', out]);
    assert.equal(r.code, 0, r.err.join('\n'));
    const rows = readFileSync(out, 'utf8').trim().split('\n').map(l => l.split(','));
    assert.deepEqual(rows[0].slice(0, 2), ['file', 'tass_tokens']);
    assert.equal(rows[1][0], 'a.txt');
    assert.equal(rows[2][0], 'b.txt');
});

test('kwic prints doc-tagged concordance lines', () => {
    const r = run(['kwic', '-i', CSV_PATH, '--text-column', 'text', '-q', 'happi*']);
    assert.equal(r.code, 0, r.err.join('\n'));
    assert.equal(r.out.length, 1);
    assert.match(r.out[0], /\[happiness\]/);
});

test('import-dic converts and the result scores', () => {
    const dic = join(dir, 'mine.dic');
    writeFileSync(dic, '%\n1\tgood\n2\tbad\n%\nhappy\t1\nhappi*\t1\nsad\t2\nbroken-line\n');
    const lexOut = join(dir, 'mine.json');
    const r = run(['import-dic', '-i', dic, '-o', lexOut]);
    assert.equal(r.code, 0, r.err.join('\n'));
    assert.match(r.err.join('\n'), /1 malformed line/);
    const out = join(dir, 'scored-dic.csv');
    const r2 = run(['score', '-i', CSV_PATH, '--text-column', 'text', '--lexicons', lexOut, '-o', out]);
    assert.equal(r2.code, 0, r2.err.join('\n'));
    assert.match(readFileSync(out, 'utf8').split('\n')[0], /mine_good_percent/);
});

test('usage errors exit 1 with a helpful message', () => {
    assert.equal(run(['score', '-i', CSV_PATH, '-o', join(dir, 'x.csv')]).code, 1); // no text column
    const r = run(['score', '-i', CSV_PATH, '--text-column', 'nope', '-o', join(dir, 'x.csv')]);
    assert.equal(r.code, 1);
    assert.match(r.err.join('\n'), /columns: id, text, cond/);
    assert.equal(run(['score', '-i', CSV_PATH, '--text-column', 'text', '--lexicons', 'nrc', '-o', join(dir, 'x.csv')]).code, 1);
    assert.equal(run(['frobnicate']).code, 1);
});

test('help and version', () => {
    const h = run([]);
    assert.equal(h.code, 0);
    assert.match(h.out.join('\n'), /usage:/);
    assert.equal(run(['score', '--version']).code, 0);
    const v = run(['--version']);
    assert.equal(v.code, 0);
    assert.match(v.out[0], /^\d+\.\d+\.\d+$/);
});

test('dicts --json emits the machine-readable bundle', () => {
    const r = run(['dicts', '--json']);
    assert.equal(r.code, 0);
    const bundle = JSON.parse(r.out.join('\n'));
    assert.ok(Array.isArray(bundle) && bundle.length >= 9);
    const vader = bundle.find(l => l.id === 'vader');
    assert.equal(vader.licenseClass, 'commercial-ok');
    assert.ok(vader.categories.every(c => typeof c.terms === 'number'));
});

test('analyze --text: exact JSON scores, zero-hit categories omitted unless --all', () => {
    const r = run(['analyze', '--text', 'happy happy joy', '--lexicons', LEX_PATH]);
    assert.equal(r.code, 0, r.err.join('\n'));
    const body = JSON.parse(r.out.join('\n'));
    assert.equal(body.totalTokens, 3);
    assert.equal(body.zeroHitCategoriesOmitted, true);
    const demo = body.lexicons.find(l => l.id === 'demo');
    assert.deepEqual(demo.categories.map(c => c.id), ['posemo']);
    assert.equal(demo.categories[0].hits, 3);
    assert.equal(demo.categories[0].weighted, 4); // happy(1) + happy(1) + joy(2)
    assert.deepEqual(demo.categories[0].matchedForms, ['happy', 'joy']);

    const all = run(['analyze', '--text', 'happy', '--lexicons', LEX_PATH, '--all']);
    const allBody = JSON.parse(all.out.join('\n'));
    assert.deepEqual(allBody.lexicons[0].categories.map(c => c.id), ['posemo', 'negemo']);
    assert.equal(allBody.lexicons[0].categories[1].mean, null);
});

test('analyze --vader-rules: negation flips the compound', () => {
    const pos = JSON.parse(run(['analyze', '--text', 'this is great', '--lexicons', 'afinn', '--vader-rules']).out.join('\n'));
    const neg = JSON.parse(run(['analyze', '--text', 'this is not great', '--lexicons', 'afinn', '--vader-rules']).out.join('\n'));
    assert.ok(pos.vaderRules.compound > 0);
    assert.ok(neg.vaderRules.compound < 0);
    assert.match(pos.vaderRules.note, /TASS VADER-rules/);
});

test('score --vader-rules adds the four columns and flags the manifest', () => {
    const out = join(dir, 'scored-vr.csv');
    const r = run(['score', '-i', CSV_PATH, '--text-column', 'text', '--lexicons', LEX_PATH,
        '--vader-rules', '-o', out, '--group-column', 'cond', '--group-summary', join(dir, 'vr-means.csv')]);
    assert.equal(r.code, 0, r.err.join('\n'));
    const header = readFileSync(out, 'utf8').split('\n')[0].split(',');
    for (const c of ['vader_rules_compound', 'vader_rules_positive', 'vader_rules_negative', 'vader_rules_neutral']) {
        assert.ok(header.includes(c), c);
    }
    const means = readFileSync(join(dir, 'vr-means.csv'), 'utf8').split('\n')[0];
    assert.match(means, /mean_vader_rules_compound/);
    const manifest = JSON.parse(readFileSync(`${out}.manifest.json`, 'utf8'));
    assert.equal(manifest.settings.vaderRules, true);
});

test('bundled politeness v1 matches phrase strategies', () => {
    const r = run(['analyze', '--text', 'Thank you so much. Could you please check this? I think it seems fine.',
        '--lexicons', 'politeness']);
    assert.equal(r.code, 0, r.err.join('\n'));
    const cats = JSON.parse(r.out.join('\n')).lexicons[0].categories;
    const byId = Object.fromEntries(cats.map(c => [c.id, c]));
    assert.ok(byId.gratitude.matchedForms.includes('thank you so much'), 'longest gratitude phrase wins');
    assert.ok(byId.counterfactual_modal.matchedForms.includes('could you please'), 'longest modal phrase wins');
    assert.ok(byId.hedge.matchedForms.includes('i think'), 'hedge phrase');
});

test('socialsent is bundled and weighted', () => {
    const r = run(['dicts', '--json']);
    const ss = JSON.parse(r.out.join('\n')).find(l => l.id === 'socialsent');
    assert.ok(ss, 'socialsent bundled');
    assert.equal(ss.licenseClass, 'commercial-ok');
    const a = JSON.parse(run(['analyze', '--text', 'a wonderful day', '--lexicons', 'socialsent']).out.join('\n'));
    assert.equal(a.lexicons[0].categories.length, 1); // weighted sentiment category hit
});

test('analyze -i FILE works; requires exactly one text source', () => {
    const txt = join(dir, 'doc.txt');
    writeFileSync(txt, 'sad but happy');
    const r = run(['analyze', '-i', txt, '--lexicons', LEX_PATH]);
    assert.equal(r.code, 0, r.err.join('\n'));
    const body = JSON.parse(r.out.join('\n'));
    assert.deepEqual(body.lexicons[0].categories.map(c => c.id), ['posemo', 'negemo']);
    assert.equal(run(['analyze']).code, 1);
    assert.equal(run(['analyze', '--text', 'x', '-i', txt]).code, 1);
});

// ── 0.5.0: chat-log ingest + SocialSent import ───────────────────────────────

test('ingest --format chat: both line shapes, noise skipped, relative seconds', () => {
    const log = join(dir, 'stream1.log');
    writeFileSync(log, [
        '# comment noise',
        '[20:04:05] <viewer_a> first message',
        '[20:04:35] viewer_b: second one: with a colon',
        '* viewer_a joined the channel',
        '[2026-01-31 20:05:05] <viewer_a> datetime stamp form',
        '',
    ].join('\n'));
    const out = join(dir, 'chat-turns.csv');
    const r = run(['ingest', '-i', log, '-o', out, '--format', 'chat']);
    assert.equal(r.code, 0, r.err.join('\n'));
    const rows = readFileSync(out, 'utf8').trim().split('\n');
    assert.equal(rows[0], 'session,turn,timestamp,seconds,speaker,text');
    assert.equal(rows.length, 4);
    assert.match(rows[1], /^stream1,1,20:04:05,0,viewer_a,first message$/);
    assert.match(rows[2], /^stream1,2,20:04:35,30,viewer_b,second one: with a colon$/);
    assert.match(rows[3], /^stream1,3,2026-01-31 20:05:05,60,viewer_a,datetime stamp form$/);
});

test('ingest --format chat: no messages is a runtime error', () => {
    const log = join(dir, 'empty.log');
    writeFileSync(log, 'just prose\nno stamps here\n');
    const r = run(['ingest', '-i', log, '-o', join(dir, 'nope.csv'), '--format', 'chat']);
    assert.equal(r.code, 2);
    assert.match(r.err.join('\n'), /no messages found/);
});

test('import-socialsent: folder + --subreddit -> usable commercial-ok lexicon', () => {
    const tsv = join(dir, 'gaming.tsv');
    writeFileSync(tsv, 'gg\t2.5\t0.4\npog\t3.0\t0.2\nlag\t-2.0\t0.5\nbad line\n');
    const out = join(dir, 'socialsent-gaming.json');
    const r = run(['import-socialsent', '-i', dir, '--subreddit', 'gaming', '-o', out]);
    assert.equal(r.code, 0, r.err.join('\n'));
    const lex = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(lex.id, 'socialsent-gaming');
    assert.equal(lex.licenseClass, 'commercial-ok');
    assert.equal(lex.categories[0].terms.length, 3);
    // Round-trip: the imported lexicon scores through analyze.
    const a = run(['analyze', '--text', 'gg but the lag', '--lexicons', out]);
    assert.equal(a.code, 0, a.err.join('\n'));
    const parsed = JSON.parse(a.out.join('\n'));
    assert.equal(parsed.lexicons[0].categories[0].hits, 2);
});
