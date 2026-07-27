/**
 * TASS error taxonomy (R6 of the Modern Build Plan refactor). One error type for every
 * surface: the CLI maps `kind` to its exit codes (usage -> 1, runtime -> 2), MCP and the GUIs
 * map `code`/`hint` to structured error payloads. Codes are STABLE identifiers (semver
 * contract, docs/API.md); messages are prose and may improve freely.
 */

export type TassErrorKind = 'usage' | 'runtime';

export class TassError extends Error {
    constructor(
        /** usage = the caller asked wrong; runtime = the world failed us. */
        readonly kind: TassErrorKind,
        /** Stable machine identifier, namespaced: 'corpus/column-not-found', 'lexicon/unknown', … */
        readonly code: string,
        message: string,
        /** Optional one-line remedy a UI may show next to the message. */
        readonly hint?: string,
    ) {
        super(message);
        this.name = 'TassError';
    }

    static usage(code: string, message: string, hint?: string): TassError {
        return new TassError('usage', code, message, hint);
    }

    static runtime(code: string, message: string, hint?: string): TassError {
        return new TassError('runtime', code, message, hint);
    }
}
