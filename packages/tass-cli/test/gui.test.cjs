/* GUI tests: drive handleApi(method, url, body) in-process — the HTTP server is a thin shell. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { handleApi, issuedArtifacts } = require('../lib/gui.js');

test('GET / serves the embedded page', async () => {
    const r = await handleApi('GET', '/', '');
    assert.equal(r.status, 200);
    assert.match(r.type, /text\/html/);
    assert.match(r.body, /TASS/);
    assert.match(r.body, /api\/call/);
    // P2-16: path placeholders render single backslashes, not doubled ones.
    assert.ok(r.body.includes('placeholder="C:\\data\\turns.csv"'));
    assert.ok(!r.body.includes('C:\\\\data'));
    // P0-3: the Exemplars pickers are selects fed from the bundle, not free-text inputs.
    assert.match(r.body, /<select id="e-lex">/);
    assert.match(r.body, /<select id="e-cat">/);
    assert.match(r.body, /<select id="e-metric">/);
    // P1-6: the derived-output hint element exists and the output field is optional.
    assert.match(r.body, /id="s-out-hint"/);
    assert.match(r.body, /Output CSV <span class="note">\(optional\)<\/span>/);
    // P1-15: the Help getting-started topic leads with the GUI path, then the CLI text.
    assert.match(r.body, /In this app/);
    assert.match(r.body, /From the terminal/);
    // P2-17: group columns get a datalist.
    assert.match(r.body, /<datalist id="s-groupcols">/);
});

test('GET /api/columns reads only the CSV header and maps missing-file errors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tass-gui-'));
    const csv = join(dir, 'turns.csv');
    writeFileSync(csv, 'session,speaker,text\ns1,A,"hello, world"\n');
    const ok = await handleApi('GET', `/api/columns?path=${encodeURIComponent(csv)}`, '');
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body).columns, ['session', 'speaker', 'text']);
    const missing = await handleApi('GET', `/api/columns?path=${encodeURIComponent(join(dir, 'nope.csv'))}`, '');
    assert.equal(missing.status, 404);
    const err = JSON.parse(missing.body);
    assert.match(err.error, /does not exist/);
    assert.match(err.detail, /ENOENT/);
});

test('GET /api/download serves only session-issued artifacts (403 otherwise)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tass-gui-'));
    const input = join(dir, 'in.csv');
    const output = join(dir, 'in-scored.csv');
    writeFileSync(input, 'text\na great day\nterrible stuff\n');
    // Un-issued path: refused even if it exists.
    writeFileSync(join(dir, 'secret.csv'), 'x\n1\n');
    const forbidden = await handleApi('GET', `/api/download?path=${encodeURIComponent(join(dir, 'secret.csv'))}`, '');
    assert.equal(forbidden.status, 403);
    // A successful score run issues the scored CSV and its manifest.
    issuedArtifacts.clear();
    const call = await handleApi('POST', '/api/call', JSON.stringify({
        name: 'tass_score_file',
        arguments: { input, output, text_column: 'text', lexicons: 'afinn' },
    }));
    assert.equal(call.status, 200);
    assert.notEqual(JSON.parse(call.body).isError, true);
    assert.ok(issuedArtifacts.has(output));
    assert.ok(issuedArtifacts.has(`${output}.manifest.json`));
    const dl = await handleApi('GET', `/api/download?path=${encodeURIComponent(output)}`, '');
    assert.equal(dl.status, 200);
    assert.match(dl.type, /text\/csv/);
    assert.match(dl.headers['content-disposition'], /attachment; filename="in-scored\.csv"/);
    assert.match(dl.body, /afinn/);
    const pv = await handleApi('GET', `/api/preview?path=${encodeURIComponent(output)}`, '');
    assert.equal(pv.status, 200);
    assert.match(pv.type, /text\/plain/);
    assert.match(pv.body, /text,/);
    const pvNo = await handleApi('GET', `/api/preview?path=${encodeURIComponent(input)}`, '');
    assert.equal(pvNo.status, 403);
});

test('GET /api/tools lists the tool layer', async () => {
    const r = await handleApi('GET', '/api/tools', '');
    assert.equal(r.status, 200);
    const tools = JSON.parse(r.body);
    assert.ok(tools.some(t => t.name === 'tass_analyze_text'));
});

test('POST /api/call runs a tool end-to-end', async () => {
    const r = await handleApi('POST', '/api/call', JSON.stringify({
        name: 'tass_analyze_text',
        arguments: { text: 'a great day', lexicons: 'afinn', vader_rules: true },
    }));
    assert.equal(r.status, 200);
    const result = JSON.parse(r.body);
    assert.notEqual(result.isError, true);
    const d = JSON.parse(result.content[0].text);
    assert.equal(d.totalTokens, 3);
    assert.ok(d.vaderRules.compound > 0);
});

test('POST /api/call error paths: bad JSON, missing name, unknown tool', async () => {
    assert.equal((await handleApi('POST', '/api/call', '{nope')).status, 400);
    assert.equal((await handleApi('POST', '/api/call', '{}')).status, 400);
    const r = await handleApi('POST', '/api/call', JSON.stringify({ name: 'tass_nope' }));
    assert.equal(JSON.parse(r.body).isError, true);
    assert.equal((await handleApi('GET', '/elsewhere', '')).status, 404);
});
