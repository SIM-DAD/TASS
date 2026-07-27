/**
 * tass mcp — a Model Context Protocol (MCP) stdio server over the TASS engine, so AI agents
 * drive the exact same code paths humans do. Hand-rolled JSON-RPC 2.0 over newline-delimited
 * stdio — deliberately dependency-free like everything else in TASS.
 *
 * Every tool is a thin adapter that builds a CLI argv and calls {@link main} in-process with a
 * captured Io. That is the design guarantee: the MCP surface can never drift from the CLI —
 * same validation, same outputs, same run manifests, same academic-only flagging.
 *
 * Protocol subset implemented (all a tools-only server needs):
 *   initialize / notifications/initialized / ping / tools/list / tools/call
 */
import { createInterface } from 'node:readline';
import { main, VERSION, loadStats, loadViz } from './cli';
import { TOOL_SPECS, PROJECT_SPECS, VALIDATION_SPECS, ToolSpec, inputSchema, buildArgv } from './spec';

// ─────────────────────────────────────────────────────────────────────────────
// In-process CLI runner
// ─────────────────────────────────────────────────────────────────────────────

interface CliRun { code: number; stdout: string[]; stderr: string[] }

function runCli(argv: string[]): CliRun {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = main(argv, { out: l => stdout.push(l), err: l => stderr.push(l) });
    return { code, stdout, stderr };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool definitions — GENERATED from the shared spec (R7): the same table produces the
// inputSchema and the argv, so the MCP surface cannot drift from the CLI's flags.
// ─────────────────────────────────────────────────────────────────────────────

type JsonObject = Record<string, unknown>;

interface ToolDef {
    name: string;
    description: string;
    inputSchema: JsonObject;
    /** Build the CLI argv for this call. Throws Error on bad arguments. */
    argv(args: JsonObject): string[];
    /** How to shape a successful run into the result text (default: JSON status envelope). */
    render?(run: CliRun): string;
}

/** stdout of these tools is already JSON — pass it through verbatim. */
const passthrough = (run: CliRun) => run.stdout.join('\n');

/** Default envelope: machine-readable status + the CLI's log lines. */
const envelope = (run: CliRun) => JSON.stringify(
    { ok: true, log: run.stderr, output: run.stdout }, null, 1);

// The stats plugin contributes its own specs when installed (same shape, same generator).
const ALL_SPECS: ToolSpec[] = [
    ...TOOL_SPECS,
    ...PROJECT_SPECS,
    ...VALIDATION_SPECS,
    ...(loadStats()?.STATS_TOOL_SPECS as ToolSpec[] | undefined ?? []),
    ...(loadViz()?.VIZ_TOOL_SPECS as ToolSpec[] | undefined ?? []),
];

const TOOLS: ToolDef[] = ALL_SPECS.map(spec => ({
    name: spec.tool,
    description: spec.description,
    inputSchema: inputSchema(spec),
    argv: (args: JsonObject) => buildArgv(spec, args),
    render: spec.render === "passthrough" ? passthrough : undefined,
}));

// ─────────────────────────────────────────────────────────────────────────────
// JSON-RPC 2.0 handling
// ─────────────────────────────────────────────────────────────────────────────

interface RpcRequest { jsonrpc?: string; id?: number | string | null; method?: string; params?: JsonObject }
interface RpcResponse { jsonrpc: '2.0'; id: number | string | null; result?: unknown; error?: { code: number; message: string } }

const PROTOCOL_VERSION = '2025-06-18';

/** Tool metadata for other drivers (the GUI serves the same tools over HTTP). */
export function toolList(): Array<{ name: string; description: string; inputSchema: JsonObject }> {
    return TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

export function callTool(name: string, args: JsonObject): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
    const tool = TOOLS.find(t => t.name === name);
    if (!tool) {
        return { content: [{ type: 'text', text: `unknown tool '${name}' — available: ${TOOLS.map(t => t.name).join(', ')}` }], isError: true };
    }
    let run: CliRun;
    try {
        run = runCli(tool.argv(args));
    } catch (e) {
        return { content: [{ type: 'text', text: `${name}: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
    }
    if (run.code !== 0) {
        return { content: [{ type: 'text', text: run.stderr.join('\n') || `exit code ${run.code}` }], isError: true };
    }
    const content: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: (tool.render ?? envelope)(run) }];
    // Passthrough tools carry their log (e.g. academic-only warnings) as a second block.
    if (tool.render === passthrough && run.stderr.length > 0) {
        content.push({ type: 'text', text: run.stderr.join('\n') });
    }
    return content[0].text === '' ? { content: [{ type: 'text', text: '(no output)' }] } : { content };
}

/**
 * Handle one JSON-RPC message. Returns the response to send, or undefined for notifications
 * (and for anything else that must not produce a reply). Exported for tests.
 */
export function handleMessage(req: RpcRequest): RpcResponse | undefined {
    const id = req.id ?? null;
    const isNotification = req.id === undefined;
    const reply = (result: unknown): RpcResponse | undefined =>
        isNotification ? undefined : { jsonrpc: '2.0', id, result };
    const fail = (code: number, message: string): RpcResponse | undefined =>
        isNotification ? undefined : { jsonrpc: '2.0', id, error: { code, message } };

    switch (req.method) {
        case 'initialize': {
            const requested = req.params?.protocolVersion;
            return reply({
                // Echo the client's requested version when it names one (we use only the stable
                // tools subset, identical across published protocol revisions); otherwise ours.
                protocolVersion: typeof requested === 'string' ? requested : PROTOCOL_VERSION,
                capabilities: { tools: {} },
                serverInfo: { name: 'tass', title: 'TASS — Text Analysis for Social Scientists', version: VERSION },
            });
        }
        case 'notifications/initialized':
        case 'notifications/cancelled':
            return undefined;
        case 'ping':
            return reply({});
        case 'tools/list':
            return reply({ tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
        case 'tools/call': {
            const name = req.params?.name;
            if (typeof name !== 'string') { return fail(-32602, 'tools/call needs params.name'); }
            const args = (req.params?.arguments ?? {}) as JsonObject;
            if (typeof args !== 'object' || Array.isArray(args)) { return fail(-32602, 'params.arguments must be an object'); }
            return reply(callTool(name, args));
        }
        default:
            return fail(-32601, `method '${req.method}' not found`);
    }
}

/** Run the stdio server: one JSON-RPC message per line in, one per line out. */
export function serveMcp(): void {
    const send = (msg: RpcResponse) => process.stdout.write(JSON.stringify(msg) + '\n');
    const rl = createInterface({ input: process.stdin, terminal: false });
    rl.on('line', line => {
        const trimmed = line.trim();
        if (trimmed === '') { return; }
        let req: RpcRequest;
        try {
            req = JSON.parse(trimmed) as RpcRequest;
        } catch {
            send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
            return;
        }
        const res = handleMessage(req);
        if (res) { send(res); }
    });
}
