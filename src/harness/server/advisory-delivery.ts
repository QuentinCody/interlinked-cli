import { resolve } from "node:path";
import type { JsonObject } from "../../lib/json-types.js";
import type { HarnessDecision } from "../types.js";
import type { ServerRuntime } from "./runtime-context.js";

export interface FeedbackEvent {
    hook_event: string;
    session_id: string;
    subagent_id?: string | undefined;
    tool_input?: JsonObject | undefined;
}
type DeliveryState = Map<string, Set<string>>;
const states = new WeakMap<object, DeliveryState>();
const MAX_SCOPES = 512;
const MAX_MESSAGES = 256;

function stateFor(owner: object): DeliveryState {
    let state = states.get(owner);
    if (!state) { state = new Map(); states.set(owner, state); }
    return state;
}

function fresh(owner: object, scope: string, lines: string[], normalize: (line: string) => string, retain: boolean): string[] {
    const state = stateFor(owner);
    const previous = state.get(scope) ?? new Set<string>();
    const keys = lines.map(normalize);
    const output = lines.filter((_line, index) => !previous.has(keys[index]!));
    const next = retain ? new Set([...previous, ...keys]) : new Set(keys);
    while (next.size > MAX_MESSAGES) next.delete(next.values().next().value!);
    if (state.size >= MAX_SCOPES) state.delete(state.keys().next().value!);
    state.set(scope, next);
    return output;
}

function sessionKey(event: FeedbackEvent): string {
    return `${event.session_id}\0${event.subagent_id ?? ""}`;
}

/** Pending counts are operator detail, not new model instructions. Recovery
 * clears the snapshot so a later gap is announced again. */
export function novelCoverageLines(owner: object, event: FeedbackEvent, lines: string[]): string[] {
    if (!event.session_id) return lines;
    return fresh(owner, `coverage\0${sessionKey(event)}`, lines,
        line => line.replace(/\d+ protected\/reserved file version\(s\)/, "N protected/reserved file version(s)"), false);
}

/** Presentation only, called after raw decisions have been captured. Blocks,
 * security warnings, and all nonselected warning families remain untouched. */
export function deliverNovelAdvisories(ctx: Pick<ServerRuntime, "cwd" | "rules">, event: FeedbackEvent, decision: HarnessDecision): HarnessDecision {
    if (!event.session_id) return decision;
    const warnings = decision.warnings ?? [];
    const policy = JSON.stringify(ctx.rules.quality_checks);
    const prefix = `${sessionKey(event)}\0${ctx.cwd}\0${policy}`;
    const content = warnings.filter(line => line.startsWith("[interlinked:content-quality]"));
    const tests = warnings.filter(line => line.startsWith("[interlinked:test-evidence]"));
    const delivered = new Set<string>();
    if (event.hook_event === "PreToolUse") {
        const file = event.tool_input?.file_path ?? event.tool_input?.path;
        const target = typeof file === "string" ? resolve(ctx.cwd, file) : "unknown";
        for (const line of fresh(ctx, `${prefix}\0content\0${target}`, content,
            line => line.replace(/\bline \d+\b/g, "line N").replace(/\bL\d+\b/g, "LN"), false)) delivered.add(line);
    } else for (const line of content) delivered.add(line);
    for (const line of fresh(ctx, `${prefix}\0test-evidence`, tests, line => line, true)) delivered.add(line);
    return { ...decision, warnings: warnings.filter(line =>
        !content.includes(line) && !tests.includes(line) || delivered.has(line)) };
}
