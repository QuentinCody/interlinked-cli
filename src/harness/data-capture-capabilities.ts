import { appendCapturedData, recordCaptureReceipt } from "../lib/data/capture.js";
import type { HarnessEvent } from "./types.js";

/** Describes fields this implementation can observe, without inventing unavailable internals. */
export function captureProviderCapabilities(cwd: string, event: HarnessEvent): void {
    if (event.dry_run) return;
    const transcript = event.agent_source === "claude" || event.agent_source === "codex";
    const capabilities = { tool_io: "provider-hook", tool_outcome: "when-reported",
        filesystem_effects: "bounded-before-after-observation", agent_identity: "when-reported",
        transcript_messages: transcript ? "supported" : "unsupported-by-current-transcript-capture",
        token_deltas: transcript ? "provider-exposed-transcript-usage" : "unsupported-by-current-transcript-capture",
        reasoning: "provider-exposed-text-only", monetary_cost: "not-priced",
        individual_test_cases: "opt-in-test-reporter", redaction: "existing-producer-policy" };
    const context = { cwd, producer: "harness/data-capture-capabilities", session: event.session_id, provider: event.agent_source, capabilities };
    appendCapturedData(context, "capture-capabilities", [{ schema: "capture-capabilities.v1", ts: event.timestamp,
        provider: event.agent_source, session_id: event.session_id, capabilities }]);
    if (!transcript) for (const source of ["timeline", "costs"]) recordCaptureReceipt(context, { source, status: "unsupported", trigger: "provider transcript capture" });
}
