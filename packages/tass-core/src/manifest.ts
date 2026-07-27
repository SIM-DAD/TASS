/**
 * Run-manifest construction (R4 of the Modern Build Plan refactor) — the Confirmed-Packet
 * provenance block written beside every scored output. Deliberately timestamp-free so the
 * whole run stays a pure function of its inputs (determinism is a product claim).
 *
 * The manifest schema is now VERSIONED (`manifestVersion`): consumers branch on it, the
 * writer only ever emits the current one. Additive fields do not bump it; renames/removals do.
 *
 * Schema history:
 *   1 — implicit (0.3.0-0.5.0): tool/version/command/determinism/settings/inputs/lexicons/
 *       academicOnlyUsed/outputs.
 *   2 — adds manifestVersion, engine, engineVersion (R4/R8).
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { Lexicon } from './index';
import { ENGINE_VERSION } from './version';

export const MANIFEST_VERSION = 2;

/** SHA-256 hex digest of a file's bytes. */
export function sha256File(path: string): string {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export interface ScoreManifestArgs {
    /** The surface that ran (e.g. '@simdad/tass-cli') and its version. */
    tool: string;
    toolVersion: string;
    command: string;
    /** Run settings, verbatim (fixed key order = byte-stable serialization). */
    settings: Record<string, unknown>;
    /** Input file paths (hashed here). */
    inputs: string[];
    lexicons: Lexicon[];
    /** Ids of academic-only lexicons used in this run. */
    academicOnlyUsed: string[];
    /** Every artifact path this run wrote. */
    outputs: string[];
    /**
     * Role -> path map of the run's artifacts (null = not requested). Additive since 0.5.2:
     * lets a project re-run reconstruct the exact command without guessing which output was
     * which. Schema stays 2 (additive fields do not bump it).
     */
    namedOutputs?: Record<string, string | null>;
}

/** Build the manifest object for a score-style run. Serialize with JSON.stringify(m, null, 1). */
export function buildScoreManifest(a: ScoreManifestArgs): Record<string, unknown> {
    return {
        manifestVersion: MANIFEST_VERSION,
        tool: a.tool,
        version: a.toolVersion,
        engine: '@simdad/tass-core',
        engineVersion: ENGINE_VERSION,
        command: a.command,
        determinism: 'output is a pure function of inputs + lexicons + settings; nothing is time-stamped',
        settings: a.settings,
        inputs: a.inputs.map(p => ({ path: p, sha256: sha256File(p), bytes: statSync(p).size })),
        lexicons: a.lexicons.map(l => ({
            id: l.id,
            name: l.name,
            license: l.license ?? null,
            licenseClass: l.licenseClass ?? 'unspecified',
            citation: l.citation ?? null,
            categories: l.categories.length,
            terms: l.categories.reduce((n, c) => n + c.terms.length, 0),
        })),
        academicOnlyUsed: a.academicOnlyUsed,
        outputs: a.outputs,
        ...(a.namedOutputs ? { namedOutputs: a.namedOutputs } : {}),
    };
}
