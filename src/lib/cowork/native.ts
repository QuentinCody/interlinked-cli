import { posix } from "node:path";
import { isJsonObject } from "../json-types.js";
import { checkDestructiveCommand } from "../hook-template-chunks/destructive-command-guard.js";
import type { CoworkPolicy } from "./policy.js";

export interface CoworkEvent {
    event: string;
    session: string;
    tool: string;
    callId: string | null;
    cwd: string;
    input: Record<string, unknown>;
    raw: Record<string, unknown>;
}
export interface CoworkVerdict {
    decision: "allow" | "deny" | "ask" | "observe";
    checks: string[];
    unmeasured: string[];
    reason?: string;
    context?: string;
    probeControl?: string;
    updatedInput?: Record<string, unknown> | undefined;
}
export const DEVICE_BASH = "mcp__remote-devices__device_bash";
const PATH_TOOLS = new Set(["Read", "Write", "Edit"]);
const SHELL_TOOLS = new Set(["Bash", DEVICE_BASH]);

export function parseCoworkEvent(raw: unknown, expectedEvent?: string): CoworkEvent {
    if (!isJsonObject(raw) || typeof raw.hook_event_name !== "string" || typeof raw.session_id !== "string" || !raw.session_id) throw new Error("Missing native Cowork event/session identity");
    if (expectedEvent && raw.hook_event_name !== expectedEvent) throw new Error("Native hook event differs from installed hook argument");
    const input = raw.tool_input ?? {};
    if (!isJsonObject(input)) throw new Error("Native tool input must be an object");
    const tool = typeof raw.tool_name === "string" ? raw.tool_name : "";
    if (["PreToolUse", "PostToolUse", "PostToolUseFailure"].includes(raw.hook_event_name) && !tool) throw new Error("Missing native tool name");
    return { event: raw.hook_event_name, session: raw.session_id, tool, callId: typeof raw.tool_use_id === "string" ? raw.tool_use_id : null,
        cwd: typeof raw.cwd === "string" ? raw.cwd : "", input, raw };
}

export function nativePath(event: CoworkEvent): string | null {
    if (!PATH_TOOLS.has(event.tool) || typeof event.input.file_path !== "string") return null;
    if (posix.isAbsolute(event.input.file_path)) return posix.normalize(event.input.file_path);
    if (!posix.isAbsolute(event.cwd)) return null;
    return posix.resolve(event.cwd, event.input.file_path);
}

export function evaluateCoworkInput(event: CoworkEvent, policy: CoworkPolicy): CoworkVerdict {
    if (event.event !== "PreToolUse") return { decision: "observe", checks: [], unmeasured: ["workspace_checks"] };
    const verdict: CoworkVerdict = { decision: "allow", checks: ["explicit_tool_policy"], unmeasured: ["workspace_checks", "native_enforcement"] };
    if (policy.deniedTools.includes(event.tool)) return { ...verdict, decision: "deny", reason: `Tool denied by Cowork policy: ${event.tool}` };
    if (SHELL_TOOLS.has(event.tool)) {
        if (typeof event.input.command !== "string") throw new Error("Shell command is missing");
        const denied = checkDestructiveCommand(event.input.command);
        verdict.checks.push("shared_destructive_command_guard");
        verdict.unmeasured.push("shell_filesystem_effects");
        if (denied) return { ...verdict, decision: "deny", reason: denied.reason };
    } else if (PATH_TOOLS.has(event.tool)) {
        const path = nativePath(event);
        if (!path) throw new Error("File path cannot be resolved in the native workspace");
        verdict.checks.push("explicit_path_policy");
        if (policy.deniedPaths.includes(path)) return { ...verdict, decision: "deny", reason: "Path denied by Cowork policy" };
    } else {
        verdict.unmeasured.push(`tool_semantics:${event.tool}`);
    }
    return verdict;
}

/** Unsupported lifecycle control never turns a warning into a Stop loop. */
export function encodeCoworkVerdict(event: string, verdict: CoworkVerdict): Record<string, unknown> | null {
    if (event === "PreToolUse") return encodePreToolVerdict(verdict);
    const feedback = verdict.context ?? (verdict.unmeasured.length ? `[interlinked:cowork] NOT CHECKED: ${verdict.unmeasured.join(", ")}` : undefined);
    if (event === "PostToolUse" && feedback) return { hookSpecificOutput: { hookEventName: event, additionalContext: feedback } };
    return null;
}

function encodePreToolVerdict(verdict: CoworkVerdict): Record<string, unknown> | null {
    const specific: Record<string, unknown> = { hookEventName: "PreToolUse" };
    if (verdict.context) specific.additionalContext = verdict.context;
    if (verdict.decision === "deny" || verdict.decision === "ask") {
        specific.permissionDecision = verdict.decision;
        specific.permissionDecisionReason = verdict.reason ?? "Cowork policy requires review";
    } else if (verdict.updatedInput) specific.updatedInput = verdict.updatedInput;
    return Object.keys(specific).length > 1 ? { hookSpecificOutput: specific } : null;
}
