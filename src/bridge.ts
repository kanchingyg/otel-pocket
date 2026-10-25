import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { analyzeTrace, buildTraceTree, collapseN1Lines, filterTraces, formatTraceTreeText, truncateForModel, } from "./span-analyzer.js";
import type { TraceStore } from "./otlp-server.js";
import { assertLoopbackLlmBaseUrl } from "./llm-guard.js";
import { inspectVerboseFromArgs, redactSecretsInString, sanitizeInspectTraceResult, } from "./trace-redact.js";

export const DEFAULT_N_CTX = 4096;

export type GuardOptions = { allowWrite?: boolean; dryRun?: boolean };

export type McpToolContext = { dryRun: boolean; allowWrite: boolean; nCtx: number };

export type OtelMcpTool = {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations?: Record<string, unknown>;
    mutates?: boolean;
    handler: (args: Record<string, unknown>, ctx: McpToolContext) => Promise<unknown> | unknown;
};

type JsonRpcMessage = {
    jsonrpc?: string;
    id?: number | string;
    method?: string;
    params?: { name?: string; arguments?: Record<string, unknown> };
};

type McpToolDef = {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations?: Record<string, unknown>;
    mutates?: boolean;
};

type McpDispatchOptions = {
    tools?: McpToolDef[];
    handlers?: Record<string, (args: Record<string, unknown>) => Promise<unknown> | unknown>;
    serverInfo?: { name: string; version: string };
    pathToWsl?: boolean;
    nCtx?: number;
};

type ChatMessage = {
    role: string;
    content?: string;
    reasoning_content?: string;
    tool_calls?: unknown[];
};

type EmbedLock = { provider: string; model: string; dimension: number };
const TRUNCATION_MARKER = "[...TRUNCATED BY OTEL-POCKET CONTEXT GUARD...]";
let allowWrite = false;
let dryRun = false;
export function setGuards(opts: GuardOptions): void {
    allowWrite = Boolean(opts.allowWrite);
    dryRun = Boolean(opts.dryRun);
}
export function canonicalizeJson(value: unknown): string {
    if (value === null || value === undefined)
        return "null";
    if (typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map((v) => canonicalizeJson(v)).join(",")}]`;
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalizeJson(obj[k])}`).join(",")}}`;
}
const loopState = { lastHash: "", repeatCount: 0 };
export function resetLoopBreaker() {
    loopState.lastHash = "";
    loopState.repeatCount = 0;
}
export function checkLoopBreaker(toolName: string, args: unknown): string | null {
    const h = createHash("sha256")
        .update(`${toolName}:${canonicalizeJson(args)}`)
        .digest("hex");
    if (h === loopState.lastHash)
        loopState.repeatCount++;
    else {
        loopState.lastHash = h;
        loopState.repeatCount = 1;
    }
    if (loopState.repeatCount >= 3) {
        return "LOOP_BREAKER: Identical tool call repeated 2 times consecutively. Stop calling tools and return your final synthesis.";
    }
    return null;
}
export function guardMutatingTool(tool: { mutates?: boolean; name?: string } | null | undefined): {
    blocked: boolean;
    reason?: string;
} {
    if (!tool?.mutates)
        return { blocked: false };
    if (dryRun) {
        return {
            blocked: true,
            reason: `[dry-run] Would call mutating tool ${tool.name ?? "tool"}; pass --allow-write and omit --dry-run to execute.`,
        };
    }
    if (!allowWrite) {
        return { blocked: true, reason: "Read-only mode: pass --allow-write to enable mutating tools." };
    }
    return { blocked: false };
}
const WIN_DRIVE_RE = /^([A-Za-z]):\\(.*)$/;
const WSL_RE = /^\/mnt\/([a-z])\/(.*)$/i;
export function windowsToWsl(p: string): string {
    const m = p.match(WIN_DRIVE_RE);
    if (!m)
        return p;
    return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
}
export function wslToWindows(p: string): string {
    const m = p.match(WSL_RE);
    if (!m)
        return p;
    return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, "\\")}`;
}
export function normalizePathsDeep(value: unknown, toWsl: boolean): unknown {
    if (typeof value === "string") {
        if (toWsl && WIN_DRIVE_RE.test(value))
            return windowsToWsl(value);
        if (!toWsl && WSL_RE.test(value))
            return wslToWindows(value);
        return value;
    }
    if (Array.isArray(value))
        return value.map((v) => normalizePathsDeep(v, toWsl));
    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>))
            out[k] = normalizePathsDeep(v, toWsl);
        return out;
    }
    return value;
}
export function redactSecrets(text: string): string {
    return redactSecretsInString(text);
}

function assertPathUnderRoot(root: string, targetPath: string): string {
    const resolvedRoot = resolve(root);
    const resolved = resolve(resolvedRoot, targetPath);
    const rel = relative(resolvedRoot, resolved);
    if (rel.startsWith("..") || resolve(rel) === "..") {
        throw new Error(`Path escapes repo root: ${targetPath}`);
    }
    return resolved;
}

let jsonRpcWrite: ((line: string) => void) | null = null;
let stdoutHijacked = false;
export function hijackStdoutForMcp() {
    if (stdoutHijacked)
        return;
    stdoutHijacked = true;
    const native = process.stdout.write.bind(process.stdout);
    jsonRpcWrite = (line) => native(line);
    process.stdout.write = ((
        chunk: string | Uint8Array,
        encoding?: BufferEncoding | ((err?: Error | null) => void),
        cb?: (err?: Error | null) => void,
    ): boolean => {
        const str = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
        if (jsonRpcWrite && str.trim().startsWith("{") && str.includes('"jsonrpc"')) {
            if (typeof encoding === "function") {
                return native(chunk, encoding);
            }
            return native(chunk, encoding, cb);
        }
        process.stderr.write(str);
        return true;
    }) as typeof process.stdout.write;
}
export const jsonRpcFrameLog: string[] = [];
function writeJsonRpcFrame(obj: Record<string, unknown>): void {
    const line = JSON.stringify(obj) + "\n";
    jsonRpcFrameLog.push(line);
    if (jsonRpcWrite)
        jsonRpcWrite(line);
    else
        process.stdout.write(line);
}
export function dispatchMcpMessage(msg: JsonRpcMessage, opts: McpDispatchOptions = {}): void {
    const tools = opts.tools ?? [];
    const handlers = opts.handlers ?? {};
    const toWsl = opts.pathToWsl ?? false;
    const nCtx = opts.nCtx ?? DEFAULT_N_CTX;
    const { id, method, params } = msg;
    const info = opts.serverInfo ?? { name: "otel-pocket", version: "0.1.0" };
    if (method === "initialize") {
        writeJsonRpcFrame({
            jsonrpc: "2.0",
            id,
            result: {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: info,
            },
        });
        return;
    }
    if (method === "notifications/initialized")
        return;
    if (method === "tools/list") {
        writeJsonRpcFrame({
            jsonrpc: "2.0",
            id,
            result: {
                tools: tools.map((t) => ({
                    name: t.name,
                    description: t.description,
                    inputSchema: t.inputSchema,
                    annotations: t.annotations,
                })),
            },
        });
        return;
    }
    if (method === "tools/call") {
        const name = params?.name ?? "";
        const args = normalizePathsDeep(params?.arguments ?? {}, toWsl) as Record<string, unknown>;
        const loopErr = checkLoopBreaker(name, args);
        if (loopErr) {
            writeJsonRpcFrame({
                jsonrpc: "2.0",
                id,
                result: { content: [{ type: "text", text: loopErr }], isError: true },
            });
            return;
        }
        const tool = tools.find((t) => t.name === name);
        if (tool) {
            const guard = guardMutatingTool(tool);
            if (guard.blocked) {
                writeJsonRpcFrame({
                    jsonrpc: "2.0",
                    id,
                    result: { content: [{ type: "text", text: guard.reason ?? "blocked" }], isError: true },
                });
                return;
            }
        }
        const handler = handlers[name];
        void (async () => {
            try {
                let result = handler ? await handler(args) : { ok: true, tool: name, args };
                const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
                const normalized = redactSecrets(
                    String(normalizePathsDeep(truncateToolOutput(text, nCtx), !toWsl)),
                );
                writeJsonRpcFrame({
                    jsonrpc: "2.0",
                    id,
                    result: { content: [{ type: "text", text: normalized }] },
                });
            }
            catch (e) {
                writeJsonRpcFrame({
                    jsonrpc: "2.0",
                    id,
                    result: { content: [{ type: "text", text: String(e) }], isError: true },
                });
            }
        })();
        return;
    }
    if (id !== undefined) {
        writeJsonRpcFrame({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Method not found: ${method}` },
        });
    }
}
export function startMcpServer(
    meta: { name: string; version: string },
    tools: OtelMcpTool[],
    options?: { allowWrite?: boolean; nCtx?: number },
): void {
    hijackStdoutForMcp();
    if (options?.allowWrite)
        setGuards({ allowWrite: true });
    const nCtx = options?.nCtx ?? DEFAULT_N_CTX;
    const defs = tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: { readOnlyHint: true, ...t.annotations },
        mutates: t.mutates,
    }));
    const handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {};
    for (const t of tools) {
        handlers[t.name] = async (args: Record<string, unknown>) => {
            const ctx = { dryRun, allowWrite, nCtx };
            return await t.handler(args, ctx);
        };
    }
    const stdin = process.stdin;
    stdin.setEncoding("utf8");
    let buffer = "";
    stdin.on("data", (chunk) => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line)
                continue;
            try {
                dispatchMcpMessage(JSON.parse(line), { tools: defs, handlers, serverInfo: meta, nCtx });
            }
            catch {
                /* ignore */
            }
        }
    });
}
export function headTailTruncate(text: string, maxChars: number): string {
    if (text.length <= maxChars)
        return text;
    const headLen = Math.floor(maxChars * 0.6);
    const tailLen = Math.floor(maxChars * 0.4) - TRUNCATION_MARKER.length;
    return text.slice(0, headLen) + TRUNCATION_MARKER + text.slice(-Math.max(0, tailLen));
}
export function truncateToolOutput(text: string, nCtx: number): string {
    return headTailTruncate(text, Math.floor(nCtx * 4 * 0.3));
}
export async function probeNCtx(
    baseUrl: string,
    fetchImpl: typeof fetch = fetch,
): Promise<{ nCtx: number; source: string }> {
    const base = baseUrl.replace(/\/$/, "");
    try {
        const props = await fetchImpl(`${base}/props`);
        if (props.ok) {
            const j = (await props.json()) as { n_ctx?: number };
            if (j.n_ctx)
                return { nCtx: j.n_ctx, source: "llama.cpp" };
        }
    }
    catch {
        /* continue */
    }
    try {
        const models = await fetchImpl(`${base}/v1/models`);
        if (models.ok) {
            const j = (await models.json()) as { data?: Array<{ max_model_len?: number }> };
            const n = j.data?.[0]?.max_model_len;
            if (n)
                return { nCtx: n, source: "vllm" };
        }
    }
    catch {
        /* continue */
    }
    return { nCtx: DEFAULT_N_CTX, source: "fallback" };
}
export function buildRecencyAnchor(sigs: Array<{ name: string; summary: string }>): string {
    const lines = sigs.map((s) => `- ${s.name}: ${s.summary}`);
    return [
        "[AVAILABLE TOOLS — ANCHORED FOR RECENCY]",
        ...lines,
        'To call a tool, output ONLY: <tool_call>{"name": "TOOL_NAME", "arguments": {...}}</tool_call>',
    ].join("\n");
}
export function anchorPromptTail(prompt: string, anchor: string): string {
    const marker = "\nASSISTANT:";
    const idx = prompt.lastIndexOf(marker);
    if (idx === -1)
        return `${prompt}\n\n${anchor}\n${marker}`;
    return `${prompt.slice(0, idx)}\n\n${anchor}\n${prompt.slice(idx)}`;
}
export function stripRedactedThinking(text: string): string {
    return text.replace(/<think>[\s\S]*?(?:<\/redacted_thinking>|$)/gi, "");
}
export function parseDirtyToolCall(content: string): { name: string; arguments: Record<string, unknown> } | null {
    const text = stripRedactedThinking(content);
    const hermes = text.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i);
    if (hermes) {
        try {
            const obj = JSON.parse(hermes[1].replace(/'/g, '"')) as { name?: string; arguments?: Record<string, unknown> };
            if (obj?.name)
                return { name: obj.name, arguments: obj.arguments ?? {} };
        }
        catch {
            /* continue */
        }
    }
    const kimi = text.match(/functions\.([^:<|]+):\d+<\|(?:redacted_)?tool_call_argument_begin\|>([\s\S]*?)<\|(?:redacted_)?tool_call_end/i);
    if (kimi) {
        try {
            return { name: kimi[1].trim(), arguments: JSON.parse(kimi[2]) };
        }
        catch {
            return { name: kimi[1].trim(), arguments: {} };
        }
    }
    const glm = text.match(/<\|(?:redacted_)?tool_call_begin[^|]*\|>([^<|]+)<\|tool_call_sep\|>([\s\S]*?)<\|(?:redacted_)?tool_call_end/i);
    if (glm) {
        try {
            return { name: glm[1].trim(), arguments: JSON.parse(glm[2].replace(/'/g, '"')) };
        }
        catch {
            return { name: glm[1].trim(), arguments: {} };
        }
    }
    const qwen = text.match(/✿FUNCTION✿:\s*([^\n]+)\s*✿ARGS✿:\s*([\s\S]*?)(?:✿RESULT✿|$)/i);
    if (qwen) {
        try {
            return { name: qwen[1].trim(), arguments: JSON.parse(qwen[2].replace(/'/g, '"')) };
        }
        catch {
            return { name: qwen[1].trim(), arguments: {} };
        }
    }
    const iq = text.match(/\{\s*['"]?cmd['"]?\s*:\s*['"]([^'"]+)['"]/);
    if (iq)
        return { name: "run_shell", arguments: { cmd: iq[1] } };
    return null;
}
export class StreamToolJsonAbort {
    depth = 0;
    started = false;
    acc = "";
    feed(chunk: string): boolean {
        this.acc += chunk;
        if (!this.started && /<tool_call>/i.test(this.acc))
            this.started = true;
        let d = 0;
        for (const c of this.acc) {
            if (c === "{")
                d++;
            if (c === "}")
                d--;
        }
        this.depth = d;
        return this.started && this.depth === 0 && /\{[\s\S]*\}/.test(this.acc);
    }
}
export function createReasoningState() {
    return { inToolLoop: false, lastUserTurnIndex: -1 };
}
export function applyReasoningContentPolicy(
    messages: ChatMessage[],
    state: { inToolLoop: boolean; lastUserTurnIndex: number },
): { messages: ChatMessage[]; state: { inToolLoop: boolean; lastUserTurnIndex: number } } {
    let lastUser = -1;
    for (let i = 0; i < messages.length; i++) {
        if (messages[i].role === "user")
            lastUser = i;
    }
    const newUserTurn = lastUser > state.lastUserTurnIndex;
    if (newUserTurn)
        state = { ...state, lastUserTurnIndex: lastUser, inToolLoop: false };
    const hasTools = messages.some((m) => m.role === "assistant" && m.tool_calls?.length);
    if (hasTools)
        state = { ...state, inToolLoop: true };
    const cleaned = messages.map((m, idx) => {
        const copy = { ...m };
        if (newUserTurn && copy.role === "assistant" && idx < lastUser)
            delete copy.reasoning_content;
        if (!state.inToolLoop && copy.role === "assistant")
            delete copy.reasoning_content;
        return copy;
    });
    return { messages: cleaned, state };
}
export function sanitizeRequestBody(body: Record<string, unknown>, model: string): Record<string, unknown> {
    const out = { ...body };
    if (/deepseek-reasoner|qwq|glm-z1|thinking/i.test(model)) {
        delete out.temperature;
        delete out.top_p;
    }
    return out;
}
export function detectProvider(baseUrl: string, _model: string): "dashscope" | "moonshot" | "ollama" | "openai" | "generic" {
    const u = baseUrl.toLowerCase();
    if (u.includes("dashscope"))
        return "dashscope";
    if (u.includes("moonshot"))
        return "moonshot";
    if (u.includes("11434") || u.includes("ollama"))
        return "ollama";
    if (u.includes("openai"))
        return "openai";
    return "generic";
}
export function normalizeToolChoice(toolChoice: string, provider: string): string {
    if ((toolChoice === "required" || toolChoice === "any") && provider !== "openai")
        return "auto";
    return toolChoice;
}
export const EMBED_LOCK = ".otel-pocket-embed-lock.json";
export function readEmbedLock(repoRoot: string): EmbedLock | null {
    const p = assertPathUnderRoot(repoRoot, EMBED_LOCK);
    if (!existsSync(p))
        return null;
    return JSON.parse(readFileSync(p, "utf8")) as EmbedLock;
}
export function writeEmbedLock(repoRoot: string, lock: EmbedLock): void {
    const p = assertPathUnderRoot(repoRoot, EMBED_LOCK);
    writeFileSync(p, JSON.stringify(lock, null, 2));
}
export function assertDimensionFingerprint(lock: EmbedLock | null, dim: number): void {
    if (lock && lock.dimension !== dim) {
        throw new Error(`Dimension fingerprint mismatch: lock expects ${lock.dimension}, got ${dim}`);
    }
}
export function l2Normalize(vec: number[]): number[] {
    const norm = Math.hypot(...vec) || 1;
    return vec.map((v) => v / norm);
}
export function mrlSlice(vec: number[], dimensions: number): number[] {
    return l2Normalize(vec.slice(0, dimensions));
}
export function floatArrayToBase64(vec: number[]): string {
    const buf = Buffer.alloc(vec.length * 4);
    for (let i = 0; i < vec.length; i++)
        buf.writeFloatLE(vec[i], i * 4);
    return buf.toString("base64");
}
export function base64ToFloatArray(b64: string): number[] {
    const buf = Buffer.from(b64, "base64");
    const out = [];
    for (let i = 0; i < buf.length; i += 4)
        out.push(buf.readFloatLE(i));
    return out;
}
export function chunkArray<T>(arr: T[], size: number): T[][] {
    const out = [];
    for (let i = 0; i < arr.length; i += size)
        out.push(arr.slice(i, i + size));
    return out;
}
export async function normalizeEmbedBatch(
    inputs: string[],
    options: {
        upstream: { name: string; maxBatch: number; embed: (batch: string[]) => Promise<number[][]> };
        model: string;
        dimensions?: number;
        lock?: EmbedLock | null;
    },
): Promise<{ embeddings: number[][] }> {
    const indexed = inputs.map((text, i) => ({ text, i }));
    const nonEmpty = indexed.filter((x) => x.text.trim().length > 0);
    const batches = chunkArray(nonEmpty, options.upstream.maxBatch);
    const vectors = new Map();
    for (const batch of batches) {
        const got = await options.upstream.embed(batch.map((b) => b.text));
        for (let j = 0; j < batch.length; j++) {
            let vec = got[j] ?? [];
            if (options.dimensions && vec.length > options.dimensions)
                vec = mrlSlice(vec, options.dimensions);
            else if (options.dimensions)
                vec = l2Normalize(vec.slice(0, options.dimensions));
            if (options.dimensions)
                assertDimensionFingerprint(options.lock ?? null, vec.length);
            vectors.set(batch[j].i, vec);
        }
    }
    const dim = options.dimensions ?? vectors.values().next().value?.length ?? 0;
    const embeddings = [];
    for (let i = 0; i < inputs.length; i++) {
        embeddings.push(vectors.get(i) ?? new Array(dim).fill(0));
    }
    return { embeddings };
}
export function buildOtelMcpTools(store: TraceStore): OtelMcpTool[] {
    return [
        {
            name: "list_recent_traces",
            description: "List recent OTLP traces with duration and errors.",
            inputSchema: {
                type: "object",
                properties: {
                    minDurationMs: { type: "number" },
                    errorsOnly: { type: "boolean" },
                },
                additionalProperties: false,
            },
            handler: (args) => {
                const list = filterTraces(store.listSummaries(), {
                    minDurationMs:
                        typeof args.minDurationMs === "number" ? args.minDurationMs : undefined,
                    errorsOnly: Boolean(args.errorsOnly),
                });
                return list.slice(0, 50).map((t) => ({
                    traceId: t.traceId,
                    root: t.rootName,
                    durationMs: Math.round(t.durationMs),
                    spans: t.spanCount,
                    error: t.hasError,
                }));
            },
        },
        {
            name: "inspect_trace_tree",
            description: "Hierarchical span tree with N+1 SQL and gen_ai metrics.",
            inputSchema: {
                type: "object",
                properties: {
                    traceId: { type: "string" },
                    verbose: { type: "boolean", description: "Include raw SQL, URLs, and HTTP headers in output" },
                },
                required: ["traceId"],
                additionalProperties: false,
            },
            handler: (args) => {
                const verbose = inspectVerboseFromArgs(args);
                const spans = store.getTrace(String(args.traceId));
                if (!spans.length)
                    return { error: "trace not found" };
                const analysis = analyzeTrace(spans);
                const raw = {
                    traceId: analysis.traceId,
                    durationMs: analysis.durationMs,
                    criticalPathMs: analysis.criticalPathMs,
                    n1: analysis.n1,
                    genAi: analysis.genAi,
                    embeddingAlerts: analysis.embeddingAlerts,
                    tree: formatTraceTreeText(buildTraceTree(spans)),
                    collapsed: collapseN1Lines(spans),
                };
                return sanitizeInspectTraceResult(raw, spans, verbose);
            },
        },
        {
            name: "diagnose_slow_trace",
            description: "Explain trace bottlenecks via local OpenAI-compatible LLM.",
            inputSchema: {
                type: "object",
                properties: {
                    traceId: { type: "string" },
                    model: { type: "string" },
                    baseUrl: { type: "string" },
                },
                required: ["traceId"],
                additionalProperties: false,
            },
            handler: async (args, ctx) => {
                const spans = store.getTrace(String(args.traceId));
                if (!spans.length)
                    return { error: "trace not found" };
                const analysis = analyzeTrace(spans);
                const sanitized = sanitizeInspectTraceResult(
                    {
                        traceId: analysis.traceId,
                        durationMs: analysis.durationMs,
                        criticalPathMs: analysis.criticalPathMs,
                        n1: analysis.n1,
                        genAi: analysis.genAi,
                        embeddingAlerts: analysis.embeddingAlerts,
                        tree: formatTraceTreeText(buildTraceTree(spans)),
                        collapsed: collapseN1Lines(spans),
                    },
                    spans,
                    false,
                );
                const summary = truncateForModel(JSON.stringify({ analysis: sanitized, collapsed: sanitized.collapsed }, null, 2), ctx.nCtx);
                const anchor = buildRecencyAnchor([
                    { name: "inspect_trace_tree", summary: "Fetch span tree for a traceId" },
                ]);
                const baseUrl = String(args.baseUrl ?? process.env.OTEL_POCKET_LLM_URL ?? "http://127.0.0.1:11434");
                const model = String(args.model ?? process.env.OTEL_POCKET_LLM_MODEL ?? "llama3.2");
                try {
                    assertLoopbackLlmBaseUrl(baseUrl);
                } catch (e) {
                    return { error: String(e) };
                }
                const prompt = redactSecrets(anchorPromptTail(`Diagnose the slow trace.\n\n${summary}\n\nASSISTANT:`, anchor));
                return diagnoseWithOpenAiCompat(baseUrl, model, prompt);
            },
        },
    ];
}
export async function diagnoseWithOpenAiCompat(
    baseUrl: string,
    model: string,
    prompt: string,
    fetchImpl: typeof fetch = fetch,
): Promise<{ diagnosis: string; model: string }> {
    assertLoopbackLlmBaseUrl(baseUrl);
    const safePrompt = redactSecrets(prompt);
    const body = sanitizeRequestBody({ model, messages: [{ role: "user", content: safePrompt }] }, model);
    normalizeToolChoice("auto", detectProvider(baseUrl, model));
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        return { diagnosis: `LLM error ${res.status}: ${headTailTruncate(await res.text(), 400)}`, model };
    }
    const j = (await res.json()) as {
        choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
    };
    const msg = j.choices?.[0]?.message;
    const text = msg?.content ?? msg?.reasoning_content ?? "No LLM content";
    return { diagnosis: redactSecrets(text), model };
}