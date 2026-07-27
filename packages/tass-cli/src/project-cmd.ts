/**
 * `tass project` — save/show/rerun/diff for .tassproj containers (Modern Build Plan
 * Section 3.5). The flagship demo of the determinism guarantee: `rerun` re-executes the
 * saved configuration through the SAME in-process CLI entry the original run used and
 * byte-compares every artifact against the archive; anything but IDENTICAL is a defect
 * (or a changed input, which is reported as exactly that).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { TassError } from '@simdad/tass-core';
import { saveProject, loadProject, diffProjects, Project } from '@simdad/tass-project';
import { main, Io } from './cli';

const BOOLEANS = new Set(['--embed-corpus']);
const ALIASES: Record<string, string> = { '-i': '--input', '-o': '--output', '-a': '--a', '-b': '--b' };

function parseFlags(argv: string[]): Map<string, string> {
    const flags = new Map<string, string>();
    for (let i = 0; i < argv.length; i++) {
        let a = argv[i];
        if (!a.startsWith('-')) { throw TassError.usage('project/bad-arg', `unexpected argument '${a}'`); }
        a = ALIASES[a] ?? a;
        if (BOOLEANS.has(a)) { flags.set(a, 'true'); continue; }
        const v = argv[++i];
        if (v === undefined) { throw TassError.usage('project/flag-needs-value', `${a} needs a value`); }
        flags.set(a, v);
    }
    return flags;
}

function need(flags: Map<string, string>, flag: string, what: string): string {
    const v = flags.get(flag);
    if (!v) { throw TassError.usage('project/missing-flag', `project ${what} needs ${flag}`); }
    return v;
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function cmdSave(argv: string[], io: Io): number {
    const flags = parseFlags(argv);
    const manifestPath = need(flags, '--manifest', 'save');
    const output = need(flags, '--output', 'save');
    const names = saveProject({ manifestPath, output, embedCorpus: flags.has('--embed-corpus') });
    io.err(`project (${names.length} entries, corpus ${flags.has('--embed-corpus') ? 'embedded' : 'by reference'}) -> ${output}`);
    return 0;
}

function cmdShow(argv: string[], io: Io): number {
    const flags = parseFlags(argv);
    const project = loadProject(need(flags, '--input', 'show'));
    const { meta, config } = project;
    io.out(`tassproj schema ${meta.tassproj} · ${meta.engine} ${meta.engineVersion} · corpus ${meta.corpusMode}`);
    io.out(`command: ${config.tool} ${config.command} (tool ${config.version})`);
    io.out(`inputs: ${config.inputs.map(i => `${i.path} (${i.bytes} bytes, ${i.sha256.slice(0, 12)}…)`).join('; ')}`);
    io.out(`lexicons: ${config.lexicons.map(l => `${l.id}`).join(', ')}`);
    if (config.academicOnlyUsed.length) { io.out(`ACADEMIC-ONLY lexicons used: ${config.academicOnlyUsed.join(', ')}`); }
    io.out(`settings: ${JSON.stringify(config.settings)}`);
    io.out('entries:');
    for (const name of [...project.entries.keys()].sort()) {
        io.out(`  ${name}  (${project.entries.get(name)!.length} bytes)`);
    }
    return 0;
}

/** Reconstruct the score argv from the saved manifest, pointed at workdir outputs. */
function rebuildArgv(project: Project, workdir: string): { argv: string[]; produced: Map<string, string> } {
    const { config } = project;
    if (config.command !== 'score') {
        throw TassError.usage('project/not-a-score-run', `rerun supports score runs (this project saved '${config.command}')`);
    }
    const named = config.namedOutputs as Record<string, string | null> | undefined;
    if (!named) {
        throw TassError.usage('project/legacy-manifest',
            'this project was saved from a manifest without namedOutputs — re-run the original score with TASS >= 0.5.2 and save again');
    }
    const s = config.settings as Record<string, unknown>;

    // Corpus paths: inline -> extract (matched to inputs by sha256); reference -> verify on disk.
    const inputs: string[] = [];
    if (project.meta.corpusMode === 'inline') {
        const byHash = new Map<string, string>();
        for (const [name, data] of project.entries) {
            if (!name.startsWith('corpus/')) { continue; }
            const p = join(workdir, 'corpus', basename(name));
            mkdirSync(join(workdir, 'corpus'), { recursive: true });
            writeFileSync(p, data);
            byHash.set(sha256(data), p);
        }
        for (const input of config.inputs) {
            const p = byHash.get(input.sha256);
            if (!p) { throw TassError.runtime('project/corrupt', `embedded corpus is missing the content of ${input.path}`); }
            inputs.push(p);
        }
    } else {
        for (const input of config.inputs) {
            if (!existsSync(input.path)) {
                throw TassError.runtime('project/input-missing',
                    `referenced corpus ${input.path} not found — rerun needs the original file (or a project saved with --embed-corpus)`);
            }
            if (sha256(readFileSync(input.path)) !== input.sha256) {
                throw TassError.runtime('project/input-changed',
                    `${input.path} has changed since the saved run (sha256 mismatch) — a rerun would not be a reproduction`);
            }
            inputs.push(input.path);
        }
    }

    // Lexicon specs: bundled ids pass through; path specs resolve to the archived snapshots.
    const archived = [...project.entries.keys()].filter(k => k.startsWith('lexicons/'));
    const byBase = new Map<string, string[]>();
    for (const k of archived) {
        const b = basename(k).replace(/^\d+-/, '');
        byBase.set(b, [...(byBase.get(b) ?? []), k]);
    }
    const specs = (s.lexiconSpecs as string[] | undefined) ?? [];
    const lexSpecs = specs.map(spec => {
        if (!/[\\/]|\.json$/i.test(spec)) { return spec; }
        const candidates = byBase.get(basename(spec)) ?? [];
        if (candidates.length !== 1) {
            throw TassError.runtime('project/ambiguous-lexicon',
                `cannot uniquely match archived lexicon for '${spec}' (${candidates.length} candidates) — reruns of projects with duplicate lexicon file names are not supported in schema 1`);
        }
        const p = join(workdir, 'lexicons', basename(candidates[0]));
        mkdirSync(join(workdir, 'lexicons'), { recursive: true });
        writeFileSync(p, project.entries.get(candidates[0])!);
        return p;
    });

    const argv = ['score'];
    for (const p of inputs) { argv.push('-i', p); }
    const produced = new Map<string, string>(); // results/<basename> -> workdir path
    const outFor = (role: string): string | null => {
        const orig = named[role];
        if (!orig) { return null; }
        const p = join(workdir, basename(orig));
        produced.set(`results/${basename(orig)}`, p);
        return p;
    };
    argv.push('-o', outFor('scored')!);
    if (typeof s.textColumn === 'string' && s.textColumn) { argv.push('--text-column', s.textColumn); }
    const metrics = s.metrics as string[] | undefined;
    if (metrics?.length) { argv.push('--metrics', metrics.join(',')); }
    const groups = s.groupColumns as string[] | undefined;
    if (groups?.length) { argv.push('--group-column', groups.join(',')); }
    if (typeof s.window === 'number') { argv.push('--window', String(s.window)); }
    if (typeof s.timeColumn === 'string' && s.timeColumn) { argv.push('--time-column', s.timeColumn); }
    if (lexSpecs.length) { argv.push('--lexicons', lexSpecs.join(',')); }
    const json = outFor('json'); if (json) { argv.push('--json', json); }
    const summary = outFor('groupSummary'); if (summary) { argv.push('--group-summary', summary); }
    const traj = outFor('trajectories'); if (traj) { argv.push('--trajectories', traj); }
    const cites = outFor('citations'); if (cites) { argv.push('--citations', cites); }
    if (s.vaderRules === true) { argv.push('--vader-rules'); }
    return { argv, produced };
}

function cmdRerun(argv: string[], io: Io): number {
    const flags = parseFlags(argv);
    const project = loadProject(need(flags, '--input', 'rerun'));
    const workdir = flags.get('--dir') ?? mkdtempSync(join(tmpdir(), 'tassproj-rerun-'));
    mkdirSync(workdir, { recursive: true });

    const { argv: scoreArgv, produced } = rebuildArgv(project, workdir);
    io.err(`rerunning: tass ${scoreArgv.join(' ')}`);
    const code = main(scoreArgv, { out: () => { /* score writes files */ }, err: l => io.err(`  ${l}`) });
    if (code !== 0) { throw TassError.runtime('project/rerun-failed', `re-run exited with code ${code}`); }

    let identical = 0, different = 0, missing = 0;
    for (const [entryName, path] of [...produced.entries()].sort()) {
        const saved = project.entries.get(entryName);
        if (!saved) { io.err(`  (not in archive, skipped) ${entryName}`); continue; }
        if (!existsSync(path)) { io.out(`MISSING    ${entryName}`); missing++; continue; }
        if (saved.equals(readFileSync(path))) { io.out(`IDENTICAL  ${entryName}`); identical++; }
        else { io.out(`DIFFERENT  ${entryName}`); different++; }
    }
    if (different === 0 && missing === 0) {
        io.out(`REPRODUCED: all ${identical} artifact(s) byte-identical (outputs in ${workdir})`);
        return 0;
    }
    io.err(`NOT REPRODUCED: ${different} different, ${missing} missing of ${identical + different + missing} — `
        + `same TASS version? same engine? (archive: ${project.meta.engineVersion})`);
    return 2;
}

function cmdDiff(argv: string[], io: Io): number {
    const flags = parseFlags(argv);
    const a = loadProject(need(flags, '--a', 'diff'));
    const b = loadProject(need(flags, '--b', 'diff'));
    const d = diffProjects(a, b);
    const section = (title: string, lines: string[]) => {
        if (lines.length === 0) { return; }
        io.out(`${title}:`);
        for (const l of lines) { io.out(`  ${l}`); }
    };
    section('config changes', d.config);
    section('input changes', d.inputs);
    section('results only in A', d.onlyInA);
    section('results only in B', d.onlyInB);
    section('identical results', d.identical);
    if (d.scoredDelta) {
        const sd = d.scoredDelta;
        io.out(`scored delta (${sd.file}): rows ${sd.rowsA} -> ${sd.rowsB}`);
        if (sd.addedColumns.length) { io.out(`  added columns: ${sd.addedColumns.join(', ')}`); }
        if (sd.removedColumns.length) { io.out(`  removed columns: ${sd.removedColumns.join(', ')}`); }
        for (const c of sd.columns) {
            io.out(`  ${c.column}: ${c.changed} cell(s) changed${c.maxAbsDelta !== undefined ? `, max |delta| ${c.maxAbsDelta}` : ''}`);
        }
    }
    const clean = d.config.length === 0 && d.inputs.length === 0 && d.onlyInA.length === 0
        && d.onlyInB.length === 0 && !d.scoredDelta;
    if (clean) { io.out('projects are equivalent (config, inputs, and results all match)'); }
    return 0;
}

const USAGE = `tass project — reproducible .tassproj containers

  tass project save --manifest scored.csv.manifest.json -o study.tassproj [--embed-corpus]
      Archive a completed run: config + input hashes + lexicon snapshots + every artifact.
      --embed-corpus copies the corpus in (archival bundle); default references it by hash.

  tass project show -i study.tassproj
      Provenance summary and entry list (integrity-verified on load).

  tass project rerun -i study.tassproj [--dir DIR]
      Re-execute the saved configuration and byte-compare every artifact against the
      archive. Exit 0 = REPRODUCED (all identical); exit 2 = any difference, with a report.

  tass project diff --a a.tassproj --b b.tassproj
      What changed between two runs: settings, lexicons, inputs, and per-column score deltas.
`;

/** Entry: argv is everything after the word 'project'. */
export function runProjectCommand(argv: string[], io: Io): number {
    const sub = argv[0];
    if (!sub || sub === 'help' || sub === '--help') { io.out(USAGE); return 0; }
    switch (sub) {
        case 'save': return cmdSave(argv.slice(1), io);
        case 'show': return cmdShow(argv.slice(1), io);
        case 'rerun': return cmdRerun(argv.slice(1), io);
        case 'diff': return cmdDiff(argv.slice(1), io);
        default:
            throw TassError.usage('project/unknown-subcommand', `unknown project subcommand '${sub}' — valid: save, show, rerun, diff`);
    }
}
