import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isJsonObject } from "../json-types.js";
import { createCoworkAdapter } from "../../harness/adapters/cowork.js";
import { callHookDaemon, discoverSocket } from "../../hook-entry-transport.js";
import { mapCoworkFileEvent, type CoworkWorkspace } from "./workspace.js";
import { parseCoworkEvent, type CoworkVerdict } from "./native.js";
import { coworkFileState, sameCoworkFileState } from "./file-state.js";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const BRIDGE_TIMEOUT_MS = 10000;
type Evaluate = (raw: Record<string, unknown>, workspace: CoworkWorkspace) => Promise<CoworkVerdict>;
export interface CoworkBridgeOptions { token: string; workspace: CoworkWorkspace; evaluate?: Evaluate }

async function evaluateOnHost(raw: Record<string, unknown>, workspace: CoworkWorkspace): Promise<CoworkVerdict> {
    const native = parseCoworkEvent(raw), adapter = createCoworkAdapter();
    const event = adapter.parseHookInput(raw, native.event);
    const socketPath = discoverSocket(workspace.hostRoot, native.session);
    if (!socketPath) throw new Error("Host daemon unavailable");
    const method = native.event === "PreToolUse" ? "hook.pre_tool_use" : "hook.post_tool_use";
    const response = await callHookDaemon({ socketPath, method, event, timeoutMs: 7000, env: process.env });
    if (!response.ok) throw new Error("Host daemon did not produce a decision");
    const decision = response.decision;
    const decisions = { allow: "allow", block: "deny", ask: "ask" } as const;
    return { decision: decision.updated_input ? "deny" : decisions[decision.decision], checks: ["host_daemon_decision"],
        unmeasured: ["native_enforcement", "post_checks_completion", "filesystem_lock", "shared_mount_identity"],
        reason: decision.reason ?? "Host input rewrite requires explicit review",
        context: [...(decision.warnings ?? []), decision.additional_context ?? ""].filter(Boolean).join("\n") };
}

function authorized(request: IncomingMessage, token: string): boolean {
    const supplied = Buffer.from(request.headers.authorization ?? ""), expected = Buffer.from(`Bearer ${token}`);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readRequest(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of request) {
        const bytes = Buffer.from(chunk);
        total += bytes.length;
        if (total > MAX_REQUEST_BYTES) throw new Error("Request size exceeded");
        chunks.push(bytes);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function reply(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify(value));
}

async function handleRequest(request: IncomingMessage, options: CoworkBridgeOptions): Promise<CoworkVerdict> {
    const body = await readRequest(request);
    if (!isJsonObject(body) || body.schema !== 1 || body.workspace !== options.workspace.id) throw new Error("Workspace identity mismatch");
    const event = parseCoworkEvent(body.event);
    if (!["PreToolUse", "PostToolUse"].includes(event.event)) throw new Error("Unsupported bridge event");
    const mapped = mapCoworkFileEvent(options.workspace, event);
    const target = parseCoworkEvent(mapped).input.file_path as string;
    const before = coworkFileState(target);
    if (!sameCoworkFileState(before, body.fileState)) throw new Error("Native and host file versions differ");
    const verdict = await (options.evaluate ?? evaluateOnHost)(mapped, options.workspace);
    if (!sameCoworkFileState(before, coworkFileState(target))) throw new Error("Host file changed during evaluation");
    return { ...verdict, checks: [...verdict.checks, "cross_runtime_file_snapshot"] };
}

/** No listener is started implicitly. CLI binds loopback only; remote use
 * requires an operator-managed HTTPS proxy and an explicit token policy. */
export function createCoworkBridge(options: CoworkBridgeOptions): Server {
    if (options.token.length < 32) throw new Error("Cowork bridge token must be at least 32 characters");
    let busy = false;
    return createServer({ requestTimeout: BRIDGE_TIMEOUT_MS, headersTimeout: BRIDGE_TIMEOUT_MS }, async (request, response) => {
        if (!authorized(request, options.token)) { reply(response, 401, { error: "Unauthorized" }); return; }
        if (request.method !== "POST" || request.url !== "/hook" || request.headers.origin) { reply(response, 404, { error: "Unsupported route" }); return; }
        if (!request.headers["content-type"]?.startsWith("application/json")) { reply(response, 415, { error: "JSON required" }); return; }
        if (busy) { reply(response, 503, { error: "Host checks busy; no verdict" }); return; }
        busy = true;
        try { reply(response, 200, await handleRequest(request, options)); }
        catch { reply(response, 422, { decision: "deny", checks: [], unmeasured: ["host_bridge"], reason: "Bridge request could not be verified" }); }
        finally { busy = false; }
    });
}
