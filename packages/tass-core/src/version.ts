/**
 * Version single-sourcing (R8 of the Modern Build Plan refactor): the engine version comes
 * from this package's package.json at runtime — never a hand-kept constant. METHODS.md tells
 * researchers to record "the TASS version"; with two packages that means BOTH the tool and
 * engine versions, and manifests carry both (see manifest.ts).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Read a package's version from its package.json, given the package root directory. */
export function packageVersion(packageRoot: string): string {
    const raw = readFileSync(join(packageRoot, 'package.json'), 'utf8');
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    if (typeof version !== 'string') { throw new Error(`${packageRoot}: package.json has no version`); }
    return version;
}

/** The @simdad/tass-core engine version. */
export const ENGINE_VERSION = packageVersion(join(__dirname, '..'));
