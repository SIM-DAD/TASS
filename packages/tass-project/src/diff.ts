/**
 * Compare-runs diff (Modern Build Plan Section 3.5): what changed between two projects, in
 * research terms. Config first (which dictionary/setting moved), then results (which columns
 * moved and by how much). Determinism makes this trustworthy: an identical config with
 * identical inputs MUST produce a zero diff, so any non-zero result diff traces to a listed
 * config or input change.
 */
import { parseCsv } from '@simdad/tass-core';
import { Project } from './container';

export interface ScoredColumnDelta {
    column: string;
    /** Cells whose value differs (row-aligned by index). */
    changed: number;
    /** Largest absolute numeric change (undefined when non-numeric cells changed). */
    maxAbsDelta?: number;
}

export interface ProjectDiff {
    /** Human-readable config differences ("settings.metrics: [percent] -> [percent,hits]"). */
    config: string[];
    /** Input corpus differences (path or hash changes). */
    inputs: string[];
    /** Entries present in only one project's results/. */
    onlyInA: string[];
    onlyInB: string[];
    /** Result files whose bytes are identical. */
    identical: string[];
    /** Scored-CSV column-level deltas for the primary output (when both sides have it). */
    scoredDelta?: { file: string; rowsA: number; rowsB: number; addedColumns: string[]; removedColumns: string[]; columns: ScoredColumnDelta[] };
}

const show = (v: unknown) => Array.isArray(v) ? `[${v.join(',')}]` : String(v ?? 'null');

export function diffProjects(a: Project, b: Project): ProjectDiff {
    const out: ProjectDiff = { config: [], inputs: [], onlyInA: [], onlyInB: [], identical: [] };

    // Config: settings keys, lexicon provenance, command.
    const sa = a.config.settings, sb = b.config.settings;
    for (const key of [...new Set([...Object.keys(sa), ...Object.keys(sb)])].sort()) {
        const va = show(sa[key]), vb = show(sb[key]);
        if (va !== vb) { out.config.push(`settings.${key}: ${va} -> ${vb}`); }
    }
    if (a.config.command !== b.config.command) { out.config.push(`command: ${a.config.command} -> ${b.config.command}`); }
    const lexA = a.config.lexicons.map(l => `${l.id}`).join(','), lexB = b.config.lexicons.map(l => `${l.id}`).join(',');
    if (lexA !== lexB) { out.config.push(`lexicons: [${lexA}] -> [${lexB}]`); }
    if (a.meta.engineVersion !== b.meta.engineVersion) {
        out.config.push(`engineVersion: ${a.meta.engineVersion} -> ${b.meta.engineVersion}`);
    }

    // Inputs by position: path and content hash.
    const nIn = Math.max(a.config.inputs.length, b.config.inputs.length);
    for (let i = 0; i < nIn; i++) {
        const ia = a.config.inputs[i], ib = b.config.inputs[i];
        if (!ia || !ib) { out.inputs.push(`input[${i}]: ${ia?.path ?? '(none)'} -> ${ib?.path ?? '(none)'}`); continue; }
        if (ia.sha256 !== ib.sha256) {
            out.inputs.push(`input[${i}] content changed (${ia.path}${ia.path === ib.path ? '' : ` -> ${ib.path}`})`);
        } else if (ia.path !== ib.path) {
            out.inputs.push(`input[${i}] moved: ${ia.path} -> ${ib.path} (same content)`);
        }
    }

    // Primary scored CSV per side, from its own manifest (runs usually differ in output
    // NAMES; the comparison is by ROLE, not by file name).
    const base = (p: string) => p.split(/[\\/]/).pop()!;
    const primaryOf = (p: Project): string | undefined => {
        const scored = (p.config.namedOutputs?.scored ?? p.config.outputs[0]) as string | undefined;
        const key = scored ? `results/${base(scored)}` : undefined;
        return key && p.entries.has(key) ? key : undefined;
    };
    const primaryA = primaryOf(a);
    const primaryB = primaryOf(b);

    // Remaining results: byte-compare by matching entry name; primaries handled by role.
    const resA = [...a.entries.keys()].filter(k => k.startsWith('results/') && k !== primaryA).sort();
    const resB = [...b.entries.keys()].filter(k => k.startsWith('results/') && k !== primaryB).sort();
    out.onlyInA = resA.filter(k => !b.entries.has(k));
    out.onlyInB = resB.filter(k => !a.entries.has(k));
    for (const k of resA.filter(k => b.entries.has(k))) {
        if (a.entries.get(k)!.equals(b.entries.get(k)!)) { out.identical.push(k); }
    }

    if (primaryA && primaryB && a.entries.get(primaryA)!.equals(b.entries.get(primaryB)!)) {
        out.identical.push(primaryA === primaryB ? primaryA : `${primaryA} = ${primaryB}`);
    } else if (primaryA && primaryB) {
        const primary = primaryA === primaryB ? primaryA : `${primaryA} vs ${primaryB}`;
        const ra = parseCsv(a.entries.get(primaryA)!.toString('utf8'));
        const rb = parseCsv(b.entries.get(primaryB)!.toString('utf8'));
        const ha = ra[0] ?? [], hb = rb[0] ?? [];
        const addedColumns = hb.filter(c => !ha.includes(c));
        const removedColumns = ha.filter(c => !hb.includes(c));
        const sharedCols = ha.filter(c => hb.includes(c));
        const ia = new Map(ha.map((c, i) => [c, i] as const));
        const ib = new Map(hb.map((c, i) => [c, i] as const));
        const columns: ScoredColumnDelta[] = [];
        const rows = Math.min(ra.length, rb.length);
        for (const col of sharedCols) {
            const ca = ia.get(col)!, cb = ib.get(col)!;
            let changed = 0;
            let maxAbs: number | undefined = 0;
            for (let r = 1; r < rows; r++) {
                const va = ra[r][ca] ?? '', vb = rb[r][cb] ?? '';
                if (va === vb) { continue; }
                changed++;
                const na = Number(va), nb = Number(vb);
                if (va !== '' && vb !== '' && Number.isFinite(na) && Number.isFinite(nb)) {
                    if (maxAbs !== undefined) { maxAbs = Math.max(maxAbs, Math.abs(na - nb)); }
                } else {
                    maxAbs = undefined; // a non-numeric change (blank <-> value) has no delta
                }
            }
            if (changed > 0) { columns.push({ column: col, changed, maxAbsDelta: maxAbs }); }
        }
        out.scoredDelta = {
            file: primary, rowsA: ra.length - 1, rowsB: rb.length - 1,
            addedColumns, removedColumns, columns,
        };
    }
    return out;
}
