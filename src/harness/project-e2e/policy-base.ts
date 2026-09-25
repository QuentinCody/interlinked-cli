// ===========================================
// The trusted base policy and the reviewed replacement decision (Unit F3, plan §13)
// ===========================================
// `loadBasePolicy` exports the base revision (never the working tree) and
// reads the policy it carried: configured, absent (bootstrap, PE-38) or
// unavailable (the revision does not resolve, PE-37 — never a HEAD fallback).
// `recordPolicyReplacement` writes the §13 record binding the base digest to
// the CURRENT head digest, so the review covers exactly one transition.

import { loadE2ePolicy, type E2ePolicy } from "./policy.js";
import { appendPolicyChange, type PolicyChangeRecord } from "./policy-changes.js";
import { exportTarget } from "./target.js";

export type BasePolicy =
    | { status: "configured"; revision: string; commit: string; policy: E2ePolicy; digest: string }
    | { status: "absent"; revision: string; commit: string }
    | { status: "invalid"; revision: string; commit: string; reason: string }
    | { status: "unavailable"; revision: string; reason: string };
export interface ReplacementOptions { root: string; base: string; projectId: string; scenarioId?: string; rationale: string; atMs: number; /** The head policy's digest; defaults to the working-tree policy. */ headDigest?: string; source?: PolicyChangeRecord["source"]; }

/** The policy at `revision`, read from a disposable export of that commit. */
export function loadBasePolicy(root: string, revision: string): BasePolicy {
    const exported = exportTarget(root, { mode: "revision", revision });
    if (!exported.ok) return { status: "unavailable", revision, reason: exported.reason };
    const commit = exported.identity.commit ?? "unknown";
    try {
        const loaded = loadE2ePolicy(exported.directory);
        if (loaded.status === "unconfigured") return { status: "absent", revision, commit };
        if (loaded.status === "invalid") return { status: "invalid", revision, commit, reason: loaded.reason };
        return { status: "configured", revision, commit, policy: loaded.policy, digest: loaded.digest };
    } finally { exported.cleanup(); }
}
/** The §13 reviewed change: recorded against the exact base and head digests; the base must resolve and carry a policy. */
export function recordPolicyReplacement(options: ReplacementOptions): PolicyChangeRecord {
    if (!options.rationale.trim()) throw new Error("a replacement needs a rationale");
    const base = loadBasePolicy(options.root, options.base);
    if (base.status !== "configured") throw new Error(base.status === "absent" ? `base ${options.base} carries no policy; nothing to replace` : base.status === "invalid" ? `base ${options.base} policy invalid: ${base.reason}` : base.reason);
    const head = loadE2ePolicy(options.root);
    const headDigest = options.headDigest ?? (head.status === "configured" ? head.digest : null);
    if (headDigest === null) throw new Error("the head policy is not configured; a replacement binds a parsed head policy");
    const record: PolicyChangeRecord = { version: 1, kind: "replacement", projectId: options.projectId, baseDigest: base.digest, headDigest, rationale: options.rationale, recordedAt: new Date(options.atMs).toISOString() };
    if (options.scenarioId !== undefined) record.scenarioId = options.scenarioId;
    if (options.source !== undefined) record.source = options.source;
    return appendPolicyChange(options.root, record);
}
