import { resolve } from "node:path";
import type { JsonObject } from "../../lib/json-types.js";
import { ADVISORY_CHECK_IDS } from "../advisory-check-ids.js";
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
function deliverExistingAdvisories(ctx: Pick<ServerRuntime, "cwd" | "rules">, event: FeedbackEvent, decision: HarnessDecision, channel: string): HarnessDecision {
    if (!event.session_id) return decision;
    const warnings = decision.warnings ?? [];
    const policy = JSON.stringify(ctx.rules.quality_checks);
    const prefix = `${channel}\0${sessionKey(event)}\0${ctx.cwd}\0${policy}`;
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

function warningCheckId(warning: string): string | undefined {
    return /^\[interlinked:([^\]]+)\]/.exec(warning)?.[1]
        ?? /^\[(?:proven|heuristic)\] ([a-z_]+):/.exec(warning)?.[1];
}

/** Deep-audit policy governs ordinary hook presentation too. Raw observations
 * have already been retained by the event loop; hiding advice is not a pass. */
export function deliverNovelAdvisories(ctx: Pick<ServerRuntime, "cwd" | "rules">, event: FeedbackEvent, raw: HarnessDecision, channel: "synchronous" | "late" = "synchronous"): HarnessDecision {
    const decision = deliverExistingAdvisories(ctx, event, raw, channel);
    if (!event.session_id || decision.decision !== "allow") return decision;
    const errors = new Set((decision.check_results ?? []).filter(row => row.severity === "error").map(row => row.name));
    const warnings = decision.warnings ?? [];
    const deferred = warnings.filter(warning => {
        const id = warningCheckId(warning);
        return id !== undefined && ADVISORY_CHECK_IDS.has(id) && !errors.has(id);
    });
    const ordinary = warnings.filter(warning => !deferred.includes(warning));
    const predictions = ordinary.filter(warning => warning.startsWith("[interlinked:guard-prediction]"));
    const scope = `${channel}\0${sessionKey(event)}\0${ctx.cwd}`;
    const novelPredictions = new Set(fresh(ctx, `${scope}\0guard-advice`, predictions,
        line => line.replace(/\d+ (?:unmatched|guard-scope)/g, "N guard-scope"), true));
    const delivered = ordinary.filter(warning => !predictions.includes(warning) || novelPredictions.has(warning));
    if (deferred.length) delivered.push(...fresh(ctx, `${scope}\0deep-audit`, [
        "[interlinked:advisory-review] Style and design observations are retained for review; run `interlinked verify --all-checks` when useful. They do not require edits or establish defects.",
    ], line => line, true));
    return { ...decision, warnings: delivered };
}
