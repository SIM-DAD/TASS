/**
 * Bundled-lexicon discovery and resolution (R2 of the Modern Build Plan refactor). The core
 * package OWNS its bundle: the data directory scan here is the single source of truth for
 * what ships (the old `BUNDLED_LEXICONS` constant was a second, unenforced list and is gone).
 * Every surface (CLI, MCP, GUI, future desktop) resolves lexicons through this module, so a
 * lexicon visible to one surface is visible to all.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Lexicon, loadLexicon } from './index';
import { TassError } from './errors';

/** Where `tass install` puts registry lexicons; resolvable by bare id like bundled ones. */
export function userLexiconDir(): string {
    return join(homedir(), '.tass', 'lexicons');
}

/** Sorted ids of user-installed registry lexicons (empty when the dir does not exist). */
export function listInstalled(): string[] {
    const dir = userLexiconDir();
    if (!existsSync(dir)) { return []; }
    return readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort();
}

/** Absolute path of the bundled-lexicon data directory inside this package. */
export function bundledDir(): string {
    // lib/bundled.js at runtime -> <package root>/data/lexicons.
    return join(__dirname, '..', 'data', 'lexicons');
}

/** Sorted ids of every bundled lexicon (file stems under data/lexicons/). */
export function listBundled(): string[] {
    return readdirSync(bundledDir()).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort();
}

/** Load one bundled lexicon by id (validated; bundled data must carry license + citation). */
export function loadBundled(id: string): Lexicon {
    const raw = readFileSync(join(bundledDir(), `${id}.json`), 'utf8');
    return loadLexicon(JSON.parse(raw), { bundled: true });
}

/**
 * Resolve a lexicon spec: a bundled id ("afinn"), a user-INSTALLED registry id
 * (`tass install <name>` puts them in the user lexicon dir), or a path to a lexicon JSON
 * the user built/imported (anything containing a path separator or ending in .json).
 * Bundled wins on an id collision (the bundle is the versioned, engine-pinned set).
 */
export function resolveLexicon(spec: string): Lexicon {
    if (/[\\/]|\.json$/i.test(spec)) {
        const raw = readFileSync(spec, 'utf8');
        return loadLexicon(JSON.parse(raw), { bundled: false });
    }
    const ids = listBundled();
    if (ids.includes(spec)) { return loadBundled(spec); }
    const installedPath = join(userLexiconDir(), `${spec}.json`);
    if (existsSync(installedPath)) {
        return loadLexicon(JSON.parse(readFileSync(installedPath, 'utf8')), { bundled: false });
    }
    const installed = listInstalled();
    throw TassError.usage('lexicon/unknown',
        `unknown lexicon '${spec}' — bundled: ${ids.join(', ')}`
        + (installed.length ? `; installed: ${installed.join(', ')}` : '')
        + ` (or pass a .json path, or: tass install ${spec})`);
}
