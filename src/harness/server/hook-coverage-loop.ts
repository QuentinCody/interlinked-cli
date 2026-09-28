import { isJsonObject } from "../../lib/json-types.js";
import { createEventLoop, type EventLoopDeps } from "../server-event-loop.js";
import { toLegacyHarnessEvent } from "../legacy-client.js";
import { appendHookCoverageDecision, type CoverageBoundary } from "./hook-coverage.js";
import { controlHookCoverage, isHookCoverageRequest } from "../hook-coverage-control.js";
import { deliverNovelAdvisories, type FeedbackEvent } from "./advisory-delivery.js";

/** Apply coverage at the transport boundary, once for either raw or framed calls. */
export function createCoverageEventLoop(deps: EventLoopDeps): ReturnType<typeof createEventLoop> {
    const loop = createEventLoop(deps);
    return {
        writeProtocolStatus: loop.writeProtocolStatus,
        async evaluateEventLine(line, protocol) {
            let value: unknown;
            try { value = JSON.parse(line); }
            catch { return loop.evaluateEventLine(line, protocol); }
            const query = coverageQuery(deps.ctx, value);
            if (query) return query;
            const decision = await loop.evaluateEventLine(line, protocol);
            const boundary = rawBoundary(value);
            return deliverNovelAdvisories(deps.ctx, boundary, appendHookCoverageDecision(deps.ctx, boundary, decision));
        },
        async evaluateUnifiedViaRuntime(event) {
            const decision = await loop.evaluateUnifiedViaRuntime(event);
            const legacy = toLegacyHarnessEvent(event);
            return deliverNovelAdvisories(deps.ctx, legacy, appendHookCoverageDecision(deps.ctx, legacy, decision));
        },
    };
}
function rawBoundary(value: unknown): FeedbackEvent & CoverageBoundary {
    if (!isJsonObject(value)) return { hook_event: "unknown", session_id: "" };
    return {
        hook_event: typeof value.hook_event === "string" ? value.hook_event : "unknown",
        session_id: typeof value.session_id === "string" ? value.session_id : "",
        ...(typeof value.subagent_id === "string" ? { subagent_id: value.subagent_id } : {}),
        ...(isJsonObject(value.tool_input) ? { tool_input: value.tool_input } : {}),
    };
}
function coverageQuery(ctx: EventLoopDeps["ctx"], value: unknown): import("../types.js").HarnessDecision | undefined {
    if (!isJsonObject(value) || value.hook_event !== "HookCoverage") return undefined;
    if (!isHookCoverageRequest(value.request)) return { decision: "block", reason: "Invalid hook coverage operation" };
    return { decision: "allow", additional_context: JSON.stringify(controlHookCoverage(ctx.hookCoverage, value.request)) };
}
