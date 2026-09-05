/** Only structurally checked contradictions can prompt follow-up at Stop.
 * Prose count/range bindings and unclassified legacy snapshots are advisory. */
export function isProvenSpecDrift(kind: string | undefined): boolean {
    return kind === "declared_fact_drift" || kind === "xref_missing_anchor" || kind === "xref_missing_file";
}

/** Older session snapshots can retain inferred prose findings as obligations.
 * Keep that evidence intact, but do not turn it back into an edit instruction. */
export function isAdvisorySpecCompletion(key: string): boolean {
    return key.startsWith("spec:count_claim_drift:") || key.startsWith("spec:range_claim_drift:");
}
