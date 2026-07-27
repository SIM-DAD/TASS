/**
 * The public dictionary registry client (Modern Build Plan Section 8.3): `tass install`
 * fetches a named lexicon from the SIM-DAD/tass-lexicons repo, verifies its sha256 against
 * the signed-by-hash index, and drops it into the user lexicon dir where bare ids resolve
 * exactly like bundled ones. This is one of the THREE sanctioned network touchpoints in the
 * whole product (install, update check, license activation) and it is always explicit and
 * user-initiated (Modern Build Plan Section 7.4).
 *
 * Registry index shape (index.json at the registry root):
 *   { "registry": 1, "lexicons": { "<id>": { "latest": "1.0.0", "description": "...",
 *       "license": "CC-BY-4.0", "citation": "...",
 *       "versions": { "1.0.0": { "path": "lexicons/<id>/1.0.0/lexicon.json", "sha256": "..." } } } } }
 *
 * TASS_REGISTRY overrides the registry base URL (mirrors, air-gapped file shares over
 * http, CI): export TASS_REGISTRY=https://my-mirror/tass-lexicons
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { TassError, loadLexicon, userLexiconDir, listInstalled, listBundled } from '@simdad/tass-core';
import type { Io } from './cli';

export const DEFAULT_REGISTRY = 'https://raw.githubusercontent.com/SIM-DAD/tass-lexicons/main';

interface RegistryVersion { path: string; sha256: string }
interface RegistryEntry {
    latest: string;
    description?: string;
    license: string;
    citation: string;
    versions: Record<string, RegistryVersion>;
}
interface RegistryIndex { registry: number; lexicons: Record<string, RegistryEntry> }

/** Injectable fetcher (tests stub it; production uses global fetch, Node >= 18). */
export type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

function registryBase(): string {
    return (process.env.TASS_REGISTRY ?? DEFAULT_REGISTRY).replace(/\/+$/, '');
}

async function fetchIndex(fetcher: Fetcher): Promise<RegistryIndex> {
    const url = `${registryBase()}/index.json`;
    let res: Awaited<ReturnType<Fetcher>>;
    try {
        res = await fetcher(url);
    } catch (e) {
        throw TassError.runtime('registry/unreachable',
            `cannot reach the dictionary registry at ${url} (${e instanceof Error ? e.message : e})`,
            'check your connection, or set TASS_REGISTRY to a mirror');
    }
    if (!res.ok) {
        throw TassError.runtime('registry/unreachable', `registry index fetch failed: HTTP ${res.status} for ${url}`);
    }
    const index = JSON.parse(await res.text()) as RegistryIndex;
    if (index.registry !== 1 || typeof index.lexicons !== 'object') {
        throw TassError.runtime('registry/bad-index', `registry index at ${url} is not a version-1 TASS registry index`);
    }
    return index;
}

/** `tass install <name>[@version]` — fetch, sha256-verify, validate, place by id. */
export async function installLexicon(spec: string, io: Io, fetcher: Fetcher = fetch): Promise<number> {
    const at = spec.lastIndexOf('@');
    const name = at > 0 ? spec.slice(0, at) : spec;
    const wantVersion = at > 0 ? spec.slice(at + 1) : undefined;

    const index = await fetchIndex(fetcher);
    const entry = index.lexicons[name];
    if (!entry) {
        const known = Object.keys(index.lexicons).sort();
        throw TassError.usage('registry/unknown-lexicon',
            `'${name}' is not in the registry — available: ${known.join(', ') || '(none yet)'}`);
    }
    const version = wantVersion ?? entry.latest;
    const ver = entry.versions[version];
    if (!ver) {
        throw TassError.usage('registry/unknown-version',
            `'${name}' has no version ${version} — available: ${Object.keys(entry.versions).sort().join(', ')} (latest: ${entry.latest})`);
    }

    const url = `${registryBase()}/${ver.path}`;
    const res = await fetcher(url);
    if (!res.ok) {
        throw TassError.runtime('registry/unreachable', `lexicon fetch failed: HTTP ${res.status} for ${url}`);
    }
    const body = await res.text();
    const hash = createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex');
    if (hash !== ver.sha256) {
        throw TassError.runtime('registry/hash-mismatch',
            `${name}@${version}: downloaded content does not match the registry's sha256 — refusing to install`,
            'retry; if it persists, report it to tass@simdadllc.com');
    }
    // Validate as bundled-grade: registry lexicons MUST carry license + citation (the mandate).
    const lexicon = loadLexicon(JSON.parse(body), { bundled: true });
    if (lexicon.id !== name) {
        throw TassError.runtime('registry/id-mismatch', `${name}@${version}: lexicon id inside the file is '${lexicon.id}'`);
    }
    if (listBundled().includes(name)) {
        io.err(`note: '${name}' is also a BUNDLED lexicon — the bundled copy wins for bare-id resolution; use the file path to force the installed one.`);
    }
    mkdirSync(userLexiconDir(), { recursive: true });
    const dest = join(userLexiconDir(), `${name}.json`);
    writeFileSync(dest, body);
    io.err(`installed ${name}@${version} [${lexicon.license}] -> ${dest}`);
    io.err(`cite: ${lexicon.citation}`);
    io.err(`use it like a bundled lexicon: --lexicons ${name}`);
    return 0;
}

/** `tass search [term]` — list the registry (and what is already installed). */
export async function searchRegistry(term: string | undefined, io: Io, fetcher: Fetcher = fetch): Promise<number> {
    const index = await fetchIndex(fetcher);
    const installed = new Set(listInstalled());
    const t = term?.toLowerCase();
    const ids = Object.keys(index.lexicons).sort()
        .filter(id => !t || id.includes(t) || (index.lexicons[id].description ?? '').toLowerCase().includes(t));
    if (ids.length === 0) {
        io.out(t ? `no registry lexicons match '${term}'` : 'the registry is empty');
        return 0;
    }
    for (const id of ids) {
        const e = index.lexicons[id];
        io.out(`${id}@${e.latest} [${e.license}]${installed.has(id) ? ' (installed)' : ''}`);
        if (e.description) { io.out(`    ${e.description}`); }
        io.out(`    cite: ${e.citation}`);
    }
    io.err(`${ids.length} lexicon(s) — install by name: tass install <name>[@version]`);
    return 0;
}
