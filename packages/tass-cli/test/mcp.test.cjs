/*
 * MCP server tests: drive handleMessage(req) in-process (the stdio loop in serveMcp is a
 * one-line-per-message wrapper around it). Tools reuse main(argv, io), so behavior parity
 * with the CLI is by construction; these tests pin the protocol envelope + adapters.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, readFileSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { handleMessage } = require('../lib/mcp.js');

const dir = mkdtempSync(join(tmpdir(), 'tass-mcp-'));

const LEX_PATH = join(dir, 'demo-lex.json');
writeFileSync(LEX_PATH, JSON.stringify({
    id: 'demo', name: 'Demo',
    categories: [
        { id: 'posemo', terms: [{ term: 'happy' }, { term: 'joy', weight: 2 }] },
        { id: 'negemo', terms: [{ term: 'sad' }] },
    ],
}));

const CSV_PATH = join(dir, 'corpus.csv');
writeFileSync(CSV_PATH, [
    'id,text,cond',
    '1,"happy happy joy",treat',
    '2,"sad and flat",control',
    '',
].join('\n'));

function rpc(method, params, id = 1) {
    return handleMessage({ jsonrpc: '2.0', id, method, params });
}

function callTool(name, args) {
    const res = rpc('tools/call', { name, arguments: args });
    assert.equal(res.error, undefined, JSON.stringify(res.error));
    return res.result;
}

test('initialize: echoes client protocol version, declares tools, names the server', () => {
    const res = rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'x', version: '0' } });
    assert.equal(res.jsonrpc, '2.0');
    assert.equal(res.id, 1);
    assert.equal(res.result.protocolVersion, '2024-11-05');
    assert.deepEqual(res.result.capabilities, { tools: {} });
    assert.equal(res.result.serverInfo.name, 'tass');
});

test('notifications produce no response; ping answers; unknown method errors', () => {
    assert.equal(handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
    assert.deepEqual(rpc('ping').result, {});
    const res = rpc('no/such/method');
    assert.equal(res.error.code, -32601);
});

test('tools/list exposes the core tools (plus stats tools when the plugin is installed)', () => {
    const { tools } = rpc('tools/list').result;
    const names = tools.map(t => t.name).sort();
    for (const core of ['tass_analyze_text', 'tass_dicts', 'tass_exemplars', 'tass_ingest', 'tass_kwic', 'tass_merge_labels', 'tass_prepare_file', 'tass_score_file']) {
        assert.ok(names.includes(core), core);
    }
    // Every non-core tool must come from the project/validation groups or a plugin.
    for (const extra of names.filter(n => !n.startsWith('tass_stats_') && !n.startsWith('tass_project_') && !n.startsWith('tass_validation_') && !n.startsWith('tass_viz_'))) {
        assert.ok(['tass_analyze_text', 'tass_dicts', 'tass_exemplars', 'tass_ingest', 'tass_kwic', 'tass_merge_labels', 'tass_prepare_file', 'tass_score_file'].includes(extra), extra);
    }
    for (const t of tools) {
        assert.equal(t.inputSchema.type, 'object', t.name);
        assert.ok(t.description.length > 20, t.name);
    }
});

test('tass_dicts returns the bundle as JSON', () => {
    const result = callTool('tass_dicts', {});
    assert.notEqual(result.isError, true);
    const bundle = JSON.parse(result.content[0].text);
    const ids = bundle.map(l => l.id);
    for (const id of ['afinn', 'vader', 'empath', 'politeness']) { assert.ok(ids.includes(id), id); }
    const afinn = bundle.find(l => l.id === 'afinn');
    assert.equal(afinn.licenseClass, 'commercial-ok');
    assert.ok(afinn.citation);
});

test('tass_analyze_text: exact scores, zero-hit categories omitted by default', () => {
    const result = callTool('tass_analyze_text', { text: 'happy happy joy', lexicons: [LEX_PATH] });
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.totalTokens, 3);
    const demo = body.lexicons.find(l => l.id === 'demo');
    assert.deepEqual(demo.categories.map(c => c.id), ['posemo']); // negemo has 0 hits -> omitted
    const pos = demo.categories[0];
    assert.equal(pos.hits, 3);
    assert.equal(pos.weighted, 4);
    assert.equal(pos.percent, 100);
    assert.deepEqual(pos.matchedForms, ['happy', 'joy']);
});

test('tass_analyze_text: include_zero keeps empty categories; lexicons accepts CSV string', () => {
    const result = callTool('tass_analyze_text', { text: 'happy', lexicons: LEX_PATH, include_zero: true });
    const demo = JSON.parse(result.content[0].text).lexicons[0];
    assert.deepEqual(demo.categories.map(c => c.id), ['posemo', 'negemo']);
    assert.equal(demo.categories[1].hits, 0);
    assert.equal(demo.categories[1].mean, null);
});

test('tass_score_file writes scored CSV + manifest and reports the log', () => {
    const out = join(dir, 'scored.csv');
    const result = callTool('tass_score_file', {
        input: CSV_PATH, output: out, text_column: 'text',
        lexicons: [LEX_PATH], metrics: ['percent', 'hits'],
    });
    assert.notEqual(result.isError, true);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.ok, true);
    assert.ok(body.log.some(l => l.includes('scored 2 documents')), body.log.join('\n'));
    assert.ok(existsSync(out));
    const manifest = JSON.parse(readFileSync(`${out}.manifest.json`, 'utf8'));
    assert.equal(manifest.command, 'score');
    assert.equal(manifest.inputs.length, 1);
});

test('tass_prepare_file cleans a CSV and reports the kept-row summary', () => {
    const messy = join(dir, 'messy.csv');
    writeFileSync(messy, [
        'id,text,cond',
        '1,"  happy   happy  joy ",treat',
        '2,"   ",control',
        '3,"happy happy joy",treat',
        '',
    ].join('\n'));
    const out = join(dir, 'messy-prepared.csv');
    const result = callTool('tass_prepare_file', {
        input: messy, output: out, text_column: 'text',
        trim: true, drop_blank: true, dedup: true, filter: ['cond=treat'],
    });
    assert.notEqual(result.isError, true, result.content[0].text);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.ok, true);
    assert.ok(body.output.some(l => l.includes('kept 1 of 3 rows')), body.output.join('\n'));
    assert.ok(existsSync(out));
    assert.ok(existsSync(`${out}.manifest.json`));
});

test('tass_kwic returns concordance lines', () => {
    const result = callTool('tass_kwic', { input: CSV_PATH, text_column: 'text', query: 'happy' });
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.output.length, 2); // "happy happy" -> two hits
    assert.match(body.output[0], /\[happy\]/);
});

test('tass_exemplars returns ranked lines with matched terms', () => {
    const result = callTool('tass_exemplars', {
        input: CSV_PATH, text_column: 'text', lexicon: LEX_PATH, category: 'posemo', top: 1,
    });
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.output.length, 1);
    assert.match(body.output[0], /^top\t/);
    assert.match(body.output[0], /happy/);
});

test('errors: unknown tool, missing required arg, CLI usage error -> isError with message', () => {
    const unknown = callTool('tass_nope', {});
    assert.equal(unknown.isError, true);
    assert.match(unknown.content[0].text, /unknown tool/);

    const missing = callTool('tass_analyze_text', {});
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /missing required argument 'text'/);

    const badLex = callTool('tass_analyze_text', { text: 'hi', lexicons: ['definitely-not-bundled'] });
    assert.equal(badLex.isError, true);
    assert.match(badLex.content[0].text, /unknown lexicon/);

    const badCall = rpc('tools/call', {});
    assert.equal(badCall.error.code, -32602);
});

test('parse-error path: serveMcp is line-oriented; handleMessage never throws on junk shapes', () => {
    assert.equal(rpc(undefined).error.code, -32601);
    const res = handleMessage({});
    assert.equal(res, undefined); // no id -> notification semantics, no reply
});
