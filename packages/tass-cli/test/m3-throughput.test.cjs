/*
 * M3 throughput suite (Modern Build Plan Section 3.4): the streaming CSV reader must parse
 * byte-for-byte like the whole-file reference implementation, and `score --workers N` must
 * produce artifacts byte-identical to single-threaded — asserted by running the same score
 * with and without --workers into the SAME paths and comparing every artifact hash.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync, mkdtempSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { createHash } = require('node:crypto');
const { parseCsv, streamCsvRows, TassError } = require('@simdad/tass-core');
const { main } = require('../lib/cli.js');

const run = argv => {
    const out = [], err = [];
    const code = main(argv, { out: l => out.push(l), err: l => err.push(l) });
    return { code, out, err };
};

const sha = p => createHash('sha256').update(readFileSync(p)).digest('hex');

const streamAll = path => {
    const rows = [];
    streamCsvRows(path, (row, index) => {
        assert.equal(index, rows.length, 'row indexes must be sequential from 0');
        rows.push(row);
    });
    return rows;
};

// ─── streaming reader: parity with parseCsv ─────────────────────────────────

test('streamCsvRows parses exactly like parseCsv (quotes, embedded newlines, CRLF, BOM)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tass-stream-'));
    const fixtures = [
        'a,b,c\n1,2,3\n',
        '﻿h1,h2\nx,y\n',                                    // UTF-8 BOM
        'a,b\r\n"multi\nline",2\r\n',                            // CRLF + embedded LF in quotes
        'a,b\n"he said ""hi""","x, y"\n',                        // escaped quotes + quoted comma
        'a,b\n1,2',                                              // no trailing newline
        'a,b\n"",2\n',                                           // empty quoted field
        'a,b\n"tail quote at eof",2\n"z"',                       // quoted field ends the file
        'one\ncol\n',                                            // single column
        'a,b\n,\n',                                              // empty fields
        'a,b\r\nx,"embedded\r\ncrlf"\r\n',                       // CRLF inside quotes
        'ünïcodé,émoji\n"naïve, résumé",ok\n',                   // non-ASCII
    ];
    fixtures.forEach((text, i) => {
        const p = join(dir, `f${i}.csv`);
        writeFileSync(p, text);
        assert.deepEqual(streamAll(p), parseCsv(text), `fixture ${i}`);
    });
});

test('streamCsvRows matches parseCsv on a >1MB file (quoted fields span chunk boundaries)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tass-stream-big-'));
    // ~1.6 MB with multi-byte chars, escaped quotes, and embedded newlines everywhere, so the
    // 1 MiB read boundary is guaranteed to land inside quoted fields / escape pairs.
    let text = 'id,text\n';
    for (let i = 0; i < 6000; i++) {
        text += `${i},"row ${i} said ""héllo""\nand wrapped, naïvely — ${'x'.repeat(200)}"\r\n`;
    }
    const p = join(dir, 'big.csv');
    writeFileSync(p, text);
    assert.ok(Buffer.byteLength(text) > (1 << 20), 'fixture must exceed one read chunk');
    assert.deepEqual(streamAll(p), parseCsv(text));
});

test('streamCsvRows throws the same TassError codes as parseCsv on broken quoting', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tass-stream-err-'));
    for (const [i, text] of [['a,b\nx"y,2\n'], ['a,b\n"unterminated,2\n']].map((t, i) => [i, t[0]])) {
        const p = join(dir, `bad${i}.csv`);
        writeFileSync(p, text);
        let refErr;
        try { parseCsv(text); } catch (e) { refErr = e; }
        assert.ok(refErr instanceof TassError, `fixture ${i}: reference must throw`);
        let streamErr;
        try { streamAll(p); } catch (e) { streamErr = e; }
        assert.ok(streamErr instanceof TassError, `fixture ${i}: stream must throw`);
        assert.equal(streamErr.code, refErr.code, `fixture ${i}: same error code`);
        assert.equal(streamErr.message, refErr.message, `fixture ${i}: same error message`);
    }
});

// ─── --workers: byte-equality with single-threaded ──────────────────────────

const CORPUS_ROWS = 300;
const csvCorpus = () => {
    const words = ['happy', 'sad', 'wonderful', 'terrible', 'thanks', 'awful', 'fine', 'great',
        'not', 'bad', 'love', 'hate', 'kind', 'table', 'lamp'];
    let text = 'session,turn,seconds,speaker,text\n';
    for (let i = 0; i < CORPUS_ROWS; i++) {
        const body = Array.from({ length: 12 }, (_, j) => words[(i * 5 + j * 3) % words.length]).join(' ');
        text += `s${i % 3},${i},${i * 15},${'ABCD'[i % 4]},"${body}, row ${i}!"\n`;
    }
    return text;
};

test('score --workers 4 produces byte-identical artifacts to single-threaded (CSV, all artifact types)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tass-workers-'));
    const input = join(dir, 'in.csv');
    writeFileSync(input, csvCorpus());
    const a = {
        scored: join(dir, 'out.csv'),
        groups: join(dir, 'out-groups.csv'),
        traj: join(dir, 'out-traj.csv'),
        json: join(dir, 'out.json'),
        cites: join(dir, 'out-cites.txt'),
        manifest: join(dir, 'out.csv.manifest.json'),
    };
    // Same argv (and therefore the SAME destination paths, so the manifest matches too),
    // differing only in --workers.
    const score = (...extra) => {
        const r = run(['score', '-i', input, '--text-column', 'text', '-o', a.scored,
            '--metrics', 'percent,hits,weighted,mean',
            '--group-column', 'speaker', '--group-summary', a.groups,
            '--window', '60', '--time-column', 'seconds', '--trajectories', a.traj,
            '--json', a.json, '--citations', a.cites, '--vader-rules', ...extra]);
        assert.equal(r.code, 0, r.err.join('\n'));
        return Object.fromEntries(Object.entries(a).map(([k, p]) => [k, sha(p)]));
    };
    const single = score();
    const workers = score('--workers', '4');
    for (const key of Object.keys(a)) {
        assert.equal(workers[key], single[key], `${key} must be byte-identical with --workers 4`);
    }
    // Row-count sanity: the streamed scored CSV holds header + every corpus row.
    assert.equal(readFileSync(a.scored, 'utf8').trimEnd().split('\n').length, CORPUS_ROWS + 1);
});

test('score --workers works for TXT input and matches single-threaded bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tass-workers-txt-'));
    const t1 = join(dir, 'doc1.txt');
    const t2 = join(dir, 'doc2.txt');
    writeFileSync(t1, 'I am very happy today, thank you kindly!');
    writeFileSync(t2, 'This is awful and I HATE it!!');
    const out = join(dir, 'out.csv');
    const score = (...extra) => {
        const r = run(['score', '-i', t1, '-i', t2, '-o', out, '--vader-rules', ...extra]);
        assert.equal(r.code, 0, r.err.join('\n'));
        return [sha(out), sha(`${out}.manifest.json`)];
    };
    assert.deepEqual(score('--workers', '2'), score());
});

test('score --workers validates: integer 1-32', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tass-workers-bad-'));
    const input = join(dir, 'in.csv');
    writeFileSync(input, 'text\nhello\n');
    for (const bad of ['0', '33', '1.5', '-2', 'four']) {
        const r = run(['score', '-i', input, '--text-column', 'text',
            '-o', join(dir, 'out.csv'), '--workers', bad]);
        assert.equal(r.code, 1, `--workers ${bad} must be a usage error`);
        assert.match(r.err.join('\n'), /--workers must be an integer 1-32/);
    }
});
