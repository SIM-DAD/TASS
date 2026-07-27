/* GUI tests: drive handleApi(method, url, body) in-process — the HTTP server is a thin shell. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { handleApi } = require('../lib/gui.js');

test('GET / serves the embedded page', async () => {
    const r = await handleApi('GET', '/', '');
    assert.equal(r.status, 200);
    assert.match(r.type, /text\/html/);
    assert.match(r.body, /TASS/);
    assert.match(r.body, /api\/call/);
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
