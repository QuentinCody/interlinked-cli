import { createHash } from "node:crypto";
import type { RunnerCapabilities } from "./types.js";

/** Independent native abilities; declaring one never implies another. */
export type HookControl =
    | "deny" | "ask" | "defer" | "rewrite_input" | "replace_result"
    | "context" | "continue" | "cancel" | "wake" | "replace_operation";

export interface HookRuntimeIdentity {
    provider: string;
    host: "cli" | "ide" | "cloud" | "sdk" | "protocol" | "unknown";
    version?: string;
    mode: "interactive" | "headless" | "unknown";
}

export interface HookTranslation {
    /** Encoded is not a claim that the native runtime enforced the result. */
    status: "encoded" | "degraded" | "unsupported";
    requested: HookControl[];
    encoded: HookControl[];
    reason?: string;
}

export interface HookOutcome {
    policy: "unmeasured" | "allow" | "deny" | "ask" | "defer" | "substituted";
    execution: "unknown" | "not_started" | "running" | "succeeded" | "failed" | "cancelled";
    /** A successful synthetic result must never count as executed work. */
    tool_body_executed: boolean | "unknown";
}

export interface HookCapabilityReceipt {
    schema_version: "1";
    runtime: HookRuntimeIdentity;
    profile_digest: string;
    native_event: string;
    declaration: "known" | "unknown";
    subscription: "selected" | "parse_only" | "unknown";
    controls: readonly HookControl[];
    controls_evidence: "explicit" | "unmeasured";
    emission: "observed" | "unmeasured";
    enforcement: "unmeasured";
}

/** Stable across property/event ordering; changes with policy-relevant fields. */
export function hookProfileDigest(capabilities: RunnerCapabilities): string {
    const events = capabilities.events.map((event) => ({
        name: event.name,
        phase: event.phase,
        install: event.install,
        control: event.control,
        controls: event.controls ? [...event.controls].sort() : null,
        model_context: event.model_context,
        background: event.background ?? false,
        missing_runtime: event.missing_runtime,
    })).sort((a, b) => {
        if (a.name === b.name) return 0;
        return a.name < b.name ? -1 : 1;
    });
    const value = {
        events,
        project_hook_path: capabilities.project_hook_path,
        hook_trust: capabilities.hook_trust,
        status_line: capabilities.status_line,
    };
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function describeHookCapability(
    capabilities: RunnerCapabilities,
    runtime: HookRuntimeIdentity,
    event: { name: string; observed?: boolean },
): HookCapabilityReceipt {
    const entry = capabilities.events.find((candidate) => candidate.name === event.name);
    let subscription: HookCapabilityReceipt["subscription"] = "unknown";
    if (entry) subscription = entry.install ? "selected" : "parse_only";
    return {
        schema_version: "1",
        runtime,
        profile_digest: hookProfileDigest(capabilities),
        native_event: event.name,
        declaration: entry ? "known" : "unknown",
        subscription,
        controls: entry?.controls ?? [],
        controls_evidence: entry?.controls ? "explicit" : "unmeasured",
        emission: event.observed ? "observed" : "unmeasured",
        enforcement: "unmeasured",
    };
}
