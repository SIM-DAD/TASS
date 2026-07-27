/*
 * Registry client tests with a stubbed fetcher (no network in tests, ever). Covers version
 * resolution, sha256 verification, metadata validation, and search filtering.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { installLexicon, searchRegistry } = require('../lib/registry.js');

const LEX = JSON.stringify({
    id: 'test-lex', name: 'Test Lexicon', license: 'CC-BY-4.0',
    citation: 'Tester (2026). Test Lexicon v1. https://example.org',
    licenseClass: 'commercial-ok',
    categories: [{ id: 'a', terms: [{ term: 'hello' }] }],
});
const SHA = createHash('sha256').update(Buffer.from(LEX, 'utf8')).digest('hex');
const INDEX = JSON.stringify({
    registry: 1,
    lexicons: {
        'test-lex': {
            latest: '1.0.0', description: 'a test lexicon', license: 'CC-BY-4.0',
            citation: 'Tester (2026)',
            versions: { '1.0.0': { path: 'lexicons/test-lex/1.0.0/lexicon.json', sha256: SHA } },
        },
    },
});

const fetcher = (bodies) => async url => {
    for (const [suffix, body] of Object.entries(bodies)) {
        if (url.endsWith(suffix)) { return { ok: true, status: 200, text: async () => body }; }
    }
    return { ok: false, status: 404, text: async () => '' };
};

const io = () => {
    const out = [], err = [];
    return { out: l => out.push(l), err: l => err.push(l), lines: { out, err } };
};

test('install: fetches, verifies sha256, validates metadata, writes to the user dir', async t => {
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tass-home-'));
    const orig = os.homedir;
    os.homedir = () => fakeHome; // core's userLexiconDir() reads homedir at call time
    t.after(() => { os.homedir = orig; });

    const i = io();
    const code = await installLexicon('test-lex', i,
        fetcher({ 'index.json': INDEX, 'lexicon.json': LEX }));
    assert.equal(code, 0);
    const dest = path.join(fakeHome, '.tass', 'lexicons', 'test-lex.json');
    assert.ok(fs.existsSync(dest));
    assert.ok(i.lines.err.some(l => l.includes('installed test-lex@1.0.0 [CC-BY-4.0]')));
    assert.ok(i.lines.err.some(l => l.startsWith('cite:')));
});

test('install: sha256 mismatch refuses to install', async () => {
    const bad = LEX.replace('hello', 'evil!');
    await assert.rejects(
        () => installLexicon('test-lex', io(), fetcher({ 'index.json': INDEX, 'lexicon.json': bad })),
        /does not match the registry's sha256/);
});

test('install: unknown name and unknown version are usage errors listing options', async () => {
    await assert.rejects(
        () => installLexicon('nope', io(), fetcher({ 'index.json': INDEX })),
        /not in the registry; available: test-lex/);
    await assert.rejects(
        () => installLexicon('test-lex@9.9.9', io(), fetcher({ 'index.json': INDEX })),
        /no version 9\.9\.9; available: 1\.0\.0/);
});

test('search: lists and filters', async () => {
    const i = io();
    await searchRegistry(undefined, i, fetcher({ 'index.json': INDEX }));
    assert.ok(i.lines.out.some(l => l.startsWith('test-lex@1.0.0 [CC-BY-4.0]')));
    const j = io();
    await searchRegistry('zzz', j, fetcher({ 'index.json': INDEX }));
    assert.ok(j.lines.out[0].includes("no registry lexicons match"));
});
