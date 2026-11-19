import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { isJsonObject, type JsonObject } from "./lib/json-types.js";
import type { RunnerAdapter, AdapterOutput } from "./harness/adapters/types.js";
import type { HookControl, HookTranslation } from "./harness/adapters/hook-contract.js";
import { hookProfileDigest } from "./harness/adapters/hook-contract.js";
import { eventCapability } from "./harness/adapters/provider-capabilities.js";
import { type DeliveryChannel, recordVisibleFallback } from "./harness/packets/fallback-ledger.js";
import type { HarnessDecision } from "./harness/types.js";
import type { UnifiedHookEvent } from "./harness/unified-event.js";

function object(value: unknown): JsonObject { return isJsonObject(value) ? value : {}; }
/** A simulated event (`interlinked harness test`) persists nothing; only the raw payload carries the flag. */
function rawDryRun(event: UnifiedHookEvent): boolean { return isJsonObject(event.raw) && event.raw.dry_run === true; }

/** What this native event does with the encoded warnings, from the runner's capability table. */
export function deliveryChannel(adapter: RunnerAdapter, event: UnifiedHookEvent, decision: HarnessDecision): DeliveryChannel {
    const cap = eventCapability(adapter.capabilities, event.runner_native_event);
    return { modelVisible: cap !== null && cap.install && cap.model_context, limit: cap?.context_limit, prefix: decision.additional_context ? decision.additional_context.length + 1 : 0 };
}
function jsonBody(output: AdapterOutput): JsonObject {
    try { return object(JSON.parse(output.stdout ?? "{}")); } catch { return {}; }
}
function permissionControl(body: JsonObject, specific: JsonObject, denied: boolean): HookControl[] {
    if ([body.decision, body.permission, body.permissionDecision, specific.permissionDecision].some(value => value === "ask" || value === "force_ask")) return ["ask"];
    return denied || body.decision === "block" ? ["deny"] : [];
}
function stopControl(body: JsonObject, specific: JsonObject, denied: boolean): HookControl[] {
    if (denied || body.decision === "block" || body.decision === "continue") return ["continue"];
    if (body.followup_message || body.additionalContext || specific.additionalContext) return ["continue"];
    return [];
}
function denialControl(output: AdapterOutput, event: UnifiedHookEvent, body: JsonObject): HookControl[] {
    const specific = object(body.hookSpecificOutput);
    const permission = object(specific.decision);
    const denied = output.exit_code === 2 || [body.decision, body.permission, body.permissionDecision, body.behavior, specific.permissionDecision, permission.behavior].includes("deny");
    if (["pre-tool", "permission-request", "user-prompt", "config-change", "pre-compact", "worktree-create"].includes(event.phase)) return permissionControl(body, specific, denied);
    if (event.phase === "post-tool-batch") return body.decision === "block" || body.continue === false || denied ? ["cancel"] : [];
    if (["stop", "subagent-stop"].includes(event.phase)) return stopControl(body, specific, denied);
    return body.decision === "block" || typeof body.additionalContext === "string" || typeof specific.additionalContext === "string" ? ["context"] : [];
}

function hasAdvisoryContext(decision: HarnessDecision): boolean {
    return decision.decision === "allow" && Boolean(decision.additional_context || decision.warnings?.length);
}

/** Records representable output, not proof that a native process consumed it. */
export function measureHookTranslation(output: AdapterOutput, decision: HarnessDecision, event: UnifiedHookEvent): HookTranslation {
    const requested: HookControl[] = [];
    const body = jsonBody(output);
    const encoded: HookControl[] = [];
    if (hasAdvisoryContext(decision)) {
        requested.push("context");
        encoded.push(...denialControl(output, event, body));
    }
    if (decision.decision !== "allow") { requested.push(decision.decision === "ask" ? "ask" : "deny"); encoded.push(...(output.translation?.encoded ?? denialControl(output, event, body))); }
    if (decision.updated_input) {
        requested.push("rewrite_input");
        if (output.translation) encoded.push(...output.translation.encoded.filter(control => !encoded.includes(control)));
        const specific = object(body.hookSpecificOutput);
        if (body.modifiedArgs || body.updated_input || specific.updatedInput || specific.tool_input) encoded.push("rewrite_input");
    }
    let status: HookTranslation["status"] = "encoded";
    if (requested.some(control => !encoded.includes(control))) status = encoded.length ? "degraded" : "unsupported";
    return { status, requested, encoded, ...(status === "encoded" ? {} : { reason: "The native response represents a different control or cannot represent the requested intervention." }) };
}

export function encodeHookResult(args: { adapter: RunnerAdapter; event: UnifiedHookEvent; decision: HarnessDecision; dataDir: string; fellBack: boolean }): AdapterOutput & { fell_back: boolean } {
    const output = args.adapter.encodeDecision(args.decision, args.event);
    // Released instruction text the daemon proposed counts as received only when THIS native event's encoded
    // output carries it to the model — the daemon cannot know the native event (packets/fallback-ledger.ts).
    try {
        if (!rawDryRun(args.event)) recordVisibleFallback(args.dataDir, args.event, args.decision.warnings ?? [], output.stdout, "daemon", deliveryChannel(args.adapter, args.event, args.decision));
    // interlinked-ignore: empty_catch — a lost receipt means one more proposal next call, never a changed decision
    } catch { /* A receipt failure must not change the already encoded decision. */ }
    const translation = measureHookTranslation(output, args.decision, args.event);
    try {
        mkdirSync(args.dataDir, { recursive: true });
        appendFileSync(join(args.dataDir, "hook-translations.jsonl"), `${JSON.stringify({ schema: 1, event_id: args.event.event_id, session_id: args.event.session_id, provider: args.adapter.id, native_event: args.event.runner_native_event, runtime_version: args.event.runner_version ?? "unmeasured", profile_digest: hookProfileDigest(args.adapter.capabilities), translation, enforcement: "unmeasured" })}\n`, { mode: 0o600 });
    // interlinked-ignore: empty_catch — a lost diagnostic row must never change the already encoded decision
    } catch { /* Diagnostic loss must not change the already encoded decision. */ }
    return { stdout: output.stdout, stderr: output.stderr, exit_code: output.exit_code, fell_back: args.fellBack };
}

/** Retain a lifecycle boundary even when the loop guard skips daemon evaluation. */
export function recordSuppressedStop(dataDir: string | null, provider: string | undefined, nativeEvent: string): void {
    if (!dataDir) return;
    try {
        mkdirSync(dataDir, { recursive: true });
        appendFileSync(join(dataDir, "hook-reentry.jsonl"), `${JSON.stringify({ schema: 1, timestamp: new Date().toISOString(), provider: provider ?? "unknown", native_event: nativeEvent, outcome: "suppressed-reentry", daemon_evaluated: false })}\n`, { mode: 0o600 });
    // interlinked-ignore: empty_catch — a lost diagnostic row must never restart a stopped turn
    } catch { /* Diagnostic failure must not restart a stopped turn. */ }
}
