/*
 * CSV layer tests: RFC-4180 quoting round-trips, BOM/CRLF tolerance, and visible failure on
 * structurally broken input. Runs over compiled output — build first (tsc -b).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv, stringifyCsv } = require('../lib/index.js');

test('parses quoted fields with commas, quotes, and newlines', () => {
    const text = 'a,b\n"1,5","he said ""hi"""\n"multi\nline",plain\n';
    assert.deepEqual(parseCsv(text), [
        ['a', 'b'],
        ['1,5', 'he said "hi"'],
        ['multi\nline', 'plain'],
    ]);
});

test('handles CRLF and a UTF-8 BOM', () => {
    const text = '﻿col1,col2\r\nx,y\r\n';
    assert.deepEqual(parseCsv(text), [['col1', 'col2'], ['x', 'y']]);
});

test('last row without trailing newline is kept', () => {
    assert.deepEqual(parseCsv('a,b\n1,2'), [['a', 'b'], ['1', '2']]);
});

test('round-trip: stringify -> parse is identity', () => {
    const rows = [
        ['text', 'group'],
        ['plain', 'a'],
        ['comma, inside', 'b'],
        ['quote " inside', 'c'],
        ['new\nline', 'd'],
        [' leading space', 'e'],
    ];
    assert.deepEqual(parseCsv(stringifyCsv(rows)), rows);
});

test('unterminated quote fails loudly', () => {
    assert.throws(() => parseCsv('a,b\n"broken,x\n'), /unterminated/);
});
