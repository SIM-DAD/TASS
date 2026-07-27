/**
 * Cross-OS determinism probe (R11 of the Modern Build Plan refactor). Scores a FIXED inline
 * corpus with a fixed configuration and prints one SHA-256 over every artifact the run
 * produces. CI runs this on every OS in the matrix and asserts all hashes are equal: the
 * engine's outputs must be byte-identical across platforms, not just across runs.
 *
 * Usage: node scripts/determinism-hash.mjs           (after npm run build; prints the hash)
 *        node scripts/determinism-hash.mjs --check   (exit 1 unless it matches the committed
 *                                                     scripts/determinism-hash.expected)
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { main } = require('../packages/tass-cli/lib/cli.js');

const dir = mkdtempSync(join(tmpdir(), 'tass-xos-'));
const input = join(dir, 'in.csv');
// Fixed corpus: exercises phrases, stems, VADER rules, groups, and time windows.
writeFileSync(input, 'session,turn,seconds,speaker,text\n'
    + 's1,1,0,A,"I am very happy today, thank you kindly!"\n'
    + 's1,2,120,B,"This is awful and I HATE it!!"\n'
    + 's1,3,400,A,"Sort of fine, not bad at all."\n'
    + 's1,4,650,B,"The weather is a table lamp."\n', 'utf8');

const out = join(dir, 'out.csv');
const artifacts = {
    scored: out,
    groups: join(dir, 'out-groups.csv'),
    traj: join(dir, 'out-traj.csv'),
    json: join(dir, 'out.json'),
    manifest: `${out}.manifest.json`,
};
const code = main(['score', '-i', input, '--text-column', 'text', '-o', out,
    '--metrics', 'percent,hits,weighted,mean',
    '--group-column', 'speaker', '--group-summary', artifacts.groups,
    '--window', '300', '--time-column', 'seconds', '--trajectories', artifacts.traj,
    '--json', artifacts.json, '--vader-rules'],
    { out: () => {}, err: () => {} });
if (code !== 0) { console.error(`score failed with exit ${code}`); process.exit(1); }

// The manifest embeds absolute paths (they differ per machine by design); hash it with the
// temp directory normalized out so only CONTENT differences show up.
const norm = s => s.split(dir.replace(/\\/g, '\\\\')).join('<T>').split(dir).join('<T>').replace(/\\\\/g, '/');
const h = createHash('sha256');
for (const [name, path] of Object.entries(artifacts)) {
    h.update(name).update('\0').update(norm(readFileSync(path, 'utf8'))).update('\0');
}
const hash = h.digest('hex');
console.log(hash);

if (process.argv.includes('--check')) {
    const expectedPath = new URL('determinism-hash.expected', import.meta.url);
    const expected = readFileSync(expectedPath, 'utf8').trim();
    if (hash !== expected) {
        console.error(`DETERMINISM GATE FAILED: expected ${expected}`);
        console.error('If the output format changed ON PURPOSE, update scripts/determinism-hash.expected in the same commit and say why.');
        process.exit(1);
    }
    console.log('determinism gate: OK');
}
