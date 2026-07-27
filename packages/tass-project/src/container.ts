/**
 * The .tassproj container (Modern Build Plan Section 3.5): one deterministic archive holding
 * everything a re-run or a reviewer needs. Schema 1 layout:
 *
 *   tassproj.json   schema generation, engine/tool versions, corpus mode, per-entry hashes
 *   config.json     the run manifest VERBATIM (settings + input hashes + lexicon provenance)
 *   corpus/<name>   embedded corpus files (only with --embed-corpus; else by reference)
 *   lexicons/<name> verbatim copies of user-supplied lexicon JSONs used by the run
 *   results/<name>  every artifact the run wrote (path-free content, stored by basename)
 *   validation/     human verdicts and memos (validation.ts) — reviewer-MUTABLE
 *
 * Integrity: tassproj.json carries a sha256 per entry; load verifies ALL of them and fails
 * loudly on tamper — EXCEPT `validation/*`, which is reviewer-mutable by design (Section 3.5)
 * and therefore never enters the tamper hash. Determinism: entries are sorted, JSON is stably
 * serialized, the ZIP layer is timestamp-free, so the same saved state is the same file,
 * byte for byte.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { TassError, ENGINE_VERSION } from '@simdad/tass-core';
import { writeZip, readZip, ZipEntry } from './zip';
import { isValidationMember } from './validation';

export const TASSPROJ_SCHEMA = 1;

/** The run-manifest shape this package consumes (structural subset; see core manifest.ts). */
export interface RunManifest {
    manifestVersion?: number;
    tool: string;
    version: string;
    command: string;
    settings: Record<string, unknown>;
    inputs: Array<{ path: string; sha256: string; bytes: number }>;
    lexicons: Array<Record<string, unknown>>;
    academicOnlyUsed: string[];
    outputs: string[];
    /** Role -> path map (additive, core manifest 0.5.2+); rerun needs it. */
    namedOutputs?: Record<string, string | null>;
}

export interface ProjectMeta {
    tassproj: number;
    engine: string;
    engineVersion: string;
    corpusMode: 'reference' | 'inline';
    /** sha256 per archive entry (everything except tassproj.json itself). */
    contentHashes: Record<string, string>;
}

export interface Project {
    meta: ProjectMeta;
    /** The saved run manifest (config.json). */
    config: RunManifest;
    /** Every archive entry's bytes, by name. */
    entries: Map<string, Buffer>;
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const stableJson = (o: unknown) => Buffer.from(JSON.stringify(o, null, 1) + '\n', 'utf8');

export interface SaveOptions {
    /** Path to the run's <output>.manifest.json. */
    manifestPath: string;
    /** Destination .tassproj path. */
    output: string;
    /** Copy corpus files INTO the archive (archival bundles); default = reference by hash. */
    embedCorpus?: boolean;
}

/** Build and write a .tassproj from a completed run's manifest. Returns the entry names. */
export function saveProject(opts: SaveOptions): string[] {
    let config: RunManifest;
    try {
        config = JSON.parse(readFileSync(opts.manifestPath, 'utf8')) as RunManifest;
    } catch (e) {
        throw TassError.usage('project/bad-manifest',
            `${opts.manifestPath}: not a readable run manifest (${e instanceof Error ? e.message : e})`);
    }
    if (!config.settings || !Array.isArray(config.inputs) || !Array.isArray(config.outputs)) {
        throw TassError.usage('project/bad-manifest',
            `${opts.manifestPath}: missing manifest fields (settings/inputs/outputs) — pass the <output>.manifest.json a score run wrote`);
    }

    const entries = new Map<string, Buffer>();
    entries.set('config.json', stableJson(config));

    // Corpus: by reference (hash already in the manifest) or embedded copies.
    if (opts.embedCorpus) {
        for (const input of config.inputs) {
            if (!existsSync(input.path)) {
                throw TassError.usage('project/missing-input', `cannot embed corpus: ${input.path} not found`);
            }
            const bytes = readFileSync(input.path);
            const hash = sha256(bytes);
            if (hash !== input.sha256) {
                throw TassError.runtime('project/input-changed',
                    `${input.path} has changed since the run (sha256 mismatch) — re-run before saving, or save by reference`);
            }
            entries.set(`corpus/${uniqueName(entries, 'corpus/', basename(input.path))}`, bytes);
        }
    }

    // User-supplied lexicons (path specs). Bundled ids are provenance-recorded in config.json.
    const specs = (config.settings.lexiconSpecs as string[] | undefined) ?? [];
    for (const spec of specs) {
        if (!/[\\/]|\.json$/i.test(spec)) { continue; }
        if (!existsSync(spec)) {
            throw TassError.usage('project/missing-lexicon', `lexicon file ${spec} not found — cannot snapshot it into the project`);
        }
        entries.set(`lexicons/${uniqueName(entries, 'lexicons/', basename(spec))}`, readFileSync(spec));
    }

    // Results: every artifact the run wrote, by basename (content is path-free by design).
    for (const out of config.outputs) {
        if (!existsSync(out)) {
            throw TassError.usage('project/missing-output', `run artifact ${out} not found — save from the directory the run wrote to`);
        }
        entries.set(`results/${uniqueName(entries, 'results/', basename(out))}`, readFileSync(out));
    }

    const contentHashes: Record<string, string> = {};
    for (const name of [...entries.keys()].sort()) {
        // validation/* is reviewer-mutable and stays OUT of the tamper hash (save never
        // writes it, but the exclusion is enforced here, not assumed).
        if (isValidationMember(name)) { continue; }
        contentHashes[name] = sha256(entries.get(name)!);
    }
    const meta: ProjectMeta = {
        tassproj: TASSPROJ_SCHEMA,
        engine: '@simdad/tass-core',
        engineVersion: ENGINE_VERSION,
        corpusMode: opts.embedCorpus ? 'inline' : 'reference',
        contentHashes,
    };

    const zipEntries: ZipEntry[] = [
        { name: 'tassproj.json', data: stableJson(meta) },
        ...[...entries.keys()].sort().map(name => ({ name, data: entries.get(name)! })),
    ];
    writeFileSync(opts.output, writeZip(zipEntries));
    return zipEntries.map(e => e.name);
}

function uniqueName(entries: Map<string, Buffer>, prefix: string, name: string): string {
    if (!entries.has(prefix + name)) { return name; }
    let n = 2;
    while (entries.has(`${prefix}${n}-${name}`)) { n++; }
    return `${n}-${name}`;
}

/** Load a .tassproj, verifying schema and every content hash (tamper fails loudly). */
export function loadProject(path: string): Project {
    const entries = readZip(readFileSync(path));
    const metaBuf = entries.get('tassproj.json');
    if (!metaBuf) { throw TassError.runtime('project/corrupt', `${path}: no tassproj.json — not a TASS project`); }
    const meta = JSON.parse(metaBuf.toString('utf8')) as ProjectMeta;
    if (meta.tassproj !== TASSPROJ_SCHEMA) {
        throw TassError.usage('project/schema',
            `${path}: schema generation ${meta.tassproj} is newer than this TASS understands (${TASSPROJ_SCHEMA}) — update TASS`);
    }
    for (const [name, hash] of Object.entries(meta.contentHashes)) {
        // validation/* is reviewer-mutable: edits there must never trip tamper detection
        // (its names never carry a hash; skip defensively even if one sneaks in).
        if (isValidationMember(name)) { continue; }
        const data = entries.get(name);
        if (!data) { throw TassError.runtime('project/corrupt', `${path}: missing entry ${name}`); }
        if (sha256(data) !== hash) {
            throw TassError.runtime('project/tampered',
                `${path}: content hash mismatch for ${name} — the archive was modified outside TASS`);
        }
    }
    const configBuf = entries.get('config.json');
    if (!configBuf) { throw TassError.runtime('project/corrupt', `${path}: no config.json`); }
    const config = JSON.parse(configBuf.toString('utf8')) as RunManifest;
    return { meta, config, entries };
}
