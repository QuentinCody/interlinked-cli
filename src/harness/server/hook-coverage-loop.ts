import { isJsonObject } from "../../lib/json-types.js";
import { createEventLoop, type EventLoopDeps } from "../server-event-loop.js";
import { toLegacyHarnessEvent } from "../legacy-client.js";
import { appendHookCoverageDecision, type CoverageBoundary } from "./hook-coverage.js";
import { controlHookCoverage, isHookCoverageRequest } from "../hook-coverage-control.js";

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
            return appendHookCoverageDecision(deps.ctx, rawBoundary(value), decision);
        },
        async evaluateUnifiedViaRuntime(event) {
            const decision = await loop.evaluateUnifiedViaRuntime(event);
            const legacy = toLegacyHarnessEvent(event);
            return appendHookCoverageDecision(deps.ctx, { hook_event: legacy.hook_event, session_id: legacy.session_id ?? "" }, decision);
        },
    };
}
function rawBoundary(value: unknown): CoverageBoundary {
    if (!isJsonObject(value)) return { hook_event: "unknown", session_id: "" };
    return {
        hook_event: typeof value.hook_event === "string" ? value.hook_event : "unknown",
        session_id: typeof value.session_id === "string" ? value.session_id : "",
    };
}
function coverageQuery(ctx: EventLoopDeps["ctx"], value: unknown): import("../types.js").HarnessDecision | undefined {
    if (!isJsonObject(value) || value.hook_event !== "HookCoverage") return undefined;
    if (!isHookCoverageRequest(value.request)) return { decision: "block", reason: "Invalid hook coverage operation" };
    return { decision: "allow", additional_context: JSON.stringify(controlHookCoverage(ctx.hookCoverage, value.request)) };
}
