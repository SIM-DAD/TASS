/**
 * M3 throughput benchmark (Modern Build Plan Section 3.4 / Section 9 benchmark task).
 *
 * Generates synthetic corpora (10k and 500k rows; deterministic content — words cycled
 * arithmetically from a fixed pool, NO RNG) into a temp dir, then runs `tass score` over each
 * with the full bundled lexicon set + --vader-rules + a group summary, single-threaded and
 * with --workers 4. Each run executes in a fresh child Node process so wall time and peak RSS
 * are per-run measurements. Afterwards it asserts that the single-threaded and worker runs
 * produced byte-identical artifacts, and prints a compact table.
 *
 * Usage:   npm run build && node scripts/bench-score.mjs
 *
 * This is a manual / CI-optional gate — deliberately NOT wired into `npm test` (the 500k run
 * takes minutes). Wall time is advisory; the byte-equality assertion is hard (exit 1 on any
 * difference or failed run).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, openSync, writeSync, closeSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const CLI = require.resolve('../packages/tass-cli/lib/cli.js');

// ─── deterministic corpus generation (no RNG anywhere) ──────────────────────

const POOL = [
    'happy', 'sad', 'wonderful', 'terrible', 'thanks', 'awful', 'fine', 'great', 'love',
    'hate', 'kind', 'cruel', 'calm', 'angry', 'proud', 'afraid', 'table', 'lamp', 'window',
    'river', 'walked', 'talked', 'never', 'always', 'maybe', 'because', 'friend', 'enemy',
    'money', 'health', 'family', 'work', 'play', 'rest', 'today', 'tomorrow', 'not', 'very',
    'really', 'quite',
];
const WORDS_PER_ROW = 15;

function writeCorpus(path, rows) {
    const fd = openSync(path, 'w');
    let buf = 'session,turn,seconds,speaker,text\n';
    for (let i = 0; i < rows; i++) {
        const words = [];
        for (let j = 0; j < WORDS_PER_ROW; j++) {
            words.push(POOL[(i * 7 + j * 3) % POOL.length]);
        }
        buf += `s${i % 10},${i},${i * 5},${'ABCD'[i % 4]},"${words.join(' ')}, row ${i}!"\n`;
        if (buf.length > (1 << 20)) { writeSync(fd, buf); buf = ''; }
    }
    if (buf) { writeSync(fd, buf); }
    closeSync(fd);
}

// ─── per-run child process: wall time + peak RSS ────────────────────────────

// process.argv under `node -e`: [execPath, ...args after the script string].
const RUNNER = `
const { main } = require(process.argv[1]);
const argv = JSON.parse(process.argv[2]);
const t0 = process.hrtime.bigint();
const code = main(argv, { out: () => {}, err: () => {} });
const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
const peakRssMb = process.resourceUsage().maxRSS / 1024; // maxRSS is KiB on all platforms
console.log(JSON.stringify({ code, wallMs, peakRssMb }));
`;

function benchRun(argv) {
    const r = spawnSync(process.execPath, ['-e', RUNNER, CLI, JSON.stringify(argv)],
        { encoding: 'utf8', maxBuffer: 1 << 24 });
    if (r.status !== 0) {
        console.error(`bench run failed (exit ${r.status}):\n${r.stderr}`);
        process.exit(1);
    }
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    if (out.code !== 0) {
        console.error(`score exited ${out.code} for argv: ${argv.join(' ')}`);
        process.exit(1);
    }
    return out;
}

const sha = p => createHash('sha256').update(readFileSync(p)).digest('hex');

// ─── the benchmark matrix ───────────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), 'tass-bench-'));
const configs = [
    { name: '10k', rows: 10_000 },
    { name: '500k', rows: 500_000 },
];
const results = [];

for (const cfg of configs) {
    const input = join(dir, `${cfg.name}.csv`);
    writeCorpus(input, cfg.rows);
    const scored = join(dir, `${cfg.name}-out.csv`);
    const groups = join(dir, `${cfg.name}-groups.csv`);
    const artifacts = { scored, groups, manifest: `${scored}.manifest.json` };
    // Full bundled lexicon set (the default), VADER rules, group summary.
    const base = ['score', '-i', input, '--text-column', 'text', '-o', scored,
        '--vader-rules', '--group-column', 'speaker', '--group-summary', groups];

    const single = benchRun(base);
    const singleHashes = Object.fromEntries(Object.entries(artifacts).map(([k, p]) => [k, sha(p)]));
    const workers = benchRun([...base, '--workers', '4']);
    const workerHashes = Object.fromEntries(Object.entries(artifacts).map(([k, p]) => [k, sha(p)]));

    const equal = Object.keys(artifacts).every(k => singleHashes[k] === workerHashes[k]);
    if (!equal) {
        console.error(`BYTE-EQUALITY FAILURE on ${cfg.name}: single vs --workers 4 artifacts differ`);
        for (const k of Object.keys(artifacts)) {
            if (singleHashes[k] !== workerHashes[k]) { console.error(`  ${k}: ${singleHashes[k]} != ${workerHashes[k]}`); }
        }
        process.exit(1);
    }
    results.push({ corpus: cfg.name, rows: cfg.rows, mode: 'single', ...single, equal: '' });
    results.push({ corpus: cfg.name, rows: cfg.rows, mode: 'workers=4', ...workers, equal: 'bytes-equal' });
}

// ─── compact table ──────────────────────────────────────────────────────────

const rows = [['corpus', 'rows', 'mode', 'wall_s', 'peak_rss_mb', 'vs_single'],
    ...results.map(r => [r.corpus, String(r.rows), r.mode,
        (r.wallMs / 1000).toFixed(2), r.peakRssMb.toFixed(1), r.equal])];
const widths = rows[0].map((_, c) => Math.max(...rows.map(r => r[c].length)));
for (const r of rows) {
    console.log(r.map((cell, c) => cell.padEnd(widths[c] + 2)).join('').trimEnd());
}
console.log(`\nartifacts + corpora in ${dir}`);
