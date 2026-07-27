/**
 * Speaker-labeled transcript parser (the WhisperX-derived markdown convention used by the
 * owner's transcription pipeline):
 *
 *     # <title> — speaker-labeled transcript
 *     Mapping: SPEAKER_00→DR. K, …
 *
 *     [M:SS] **SPEAKER:** turn text…
 *     [H:MM:SS] **SPEAKER:** turn text…
 *
 * One turn per timestamped line; non-blank lines that don't open a turn are treated as
 * continuations of the previous turn (transcripts may hard-wrap). Header/mapping lines and
 * anything before the first turn are ignored. Speaker and timestamp stay METADATA — they are
 * never folded into the scored text.
 */

export interface Turn {
    /** 1-based turn number within the session. */
    turn: number;
    /** Timestamp as written (e.g. "12:07" or "1:02:33"). */
    timestamp: string;
    /** Timestamp in seconds from session start (window/trajectory math). */
    seconds: number;
    speaker: string;
    text: string;
}

const TURN_RE = /^\[(\d{1,2}(?::\d{2}){1,2})\]\s*\*\*([^*]+?):?\*\*:?\s*(.*)$/;

function toSeconds(stamp: string): number {
    const parts = stamp.split(':').map(Number);
    return parts.reduce((total, p) => total * 60 + p, 0);
}

/**
 * Chat-log line shapes (IRC/Chatty/Twitch-style exports — one message per line):
 *
 *     [HH:MM:SS] <username> message text
 *     [2026-01-31 20:04:05] username: message text
 *
 * The bracketed stamp may be a time of day or a full datetime; `seconds` is made RELATIVE to
 * the session's first message (what window/trajectory math needs), with a single midnight
 * crossing tolerated. Non-matching lines (joins, notices, bare prose) are skipped — chat
 * messages never wrap, so there is no continuation handling.
 */
const CHAT_RES = [
    /^\[([^\]]+)\]\s*<([^>]+)>\s*(.*)$/,        // [stamp] <user> text
    /^\[([^\]]+)\]\s*([^:<\s][^:]*):\s*(.*)$/,  // [stamp] user: text
];

/** Parse one chat log into turns. Returns [] when no message lines exist. */
export function parseChatLog(content: string): Turn[] {
    const turns: Turn[] = [];
    let base: number | undefined;
    for (const raw of content.split(/\r?\n/)) {
        const line = raw.trim();
        if (line === '') { continue; }
        let m: RegExpExecArray | null = null;
        for (const re of CHAT_RES) { m = re.exec(line); if (m) { break; } }
        if (!m) { continue; }
        const stamp = m[1].trim();
        const timeOfDay = /\d{1,2}:\d{2}(?::\d{2})?/.exec(stamp)?.[0];
        let seconds = timeOfDay ? toSeconds(timeOfDay) : 0;
        if (base === undefined) { base = seconds; }
        seconds -= base;
        if (seconds < 0) { seconds += 86400; }
        turns.push({
            turn: turns.length + 1,
            timestamp: stamp,
            seconds,
            speaker: m[2].trim(),
            text: m[3].trim(),
        });
    }
    return turns;
}

/** Parse one transcript document into turns. Returns [] when no turn lines exist. */
export function parseTranscript(content: string): Turn[] {
    const turns: Turn[] = [];
    for (const raw of content.split(/\r?\n/)) {
        const line = raw.trim();
        if (line === '') { continue; }
        const m = TURN_RE.exec(line);
        if (m) {
            turns.push({
                turn: turns.length + 1,
                timestamp: m[1],
                seconds: toSeconds(m[1]),
                speaker: m[2].trim(),
                text: m[3].trim(),
            });
        } else if (turns.length > 0 && !line.startsWith('#') && !line.startsWith('Mapping:')) {
            // Continuation of the previous turn (wrapped line).
            const last = turns[turns.length - 1];
            last.text = last.text === '' ? line : `${last.text} ${line}`;
        }
    }
    return turns;
}
