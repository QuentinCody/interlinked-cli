import { digest, summarizeCoworkReceipts } from "./receipts.js";

function listingStates(listing: string): Map<string, string> {
    const states = new Map<string, string>();
    for (const line of listing.split(/\r?\n/)) {
        const match = /^(PRESENT|ABSENT)\s+(interlinked-probe-[a-z-]+\.txt)$/.exec(line);
        const state = match?.[1], name = match?.[2];
        if (!state || !name) continue;
        if (states.has(name)) throw new Error("Ambiguous duplicate probe file state");
        states.set(name, state);
    }
    return states;
}

/** An externally supplied listing is evidence, not a trusted attestation.
 * Refuse ambiguous/reused campaigns instead of inferring from missing logs. */
export function analyzeCoworkConformance(receipts: string, listing: string) {
    const summary = summarizeCoworkReceipts(receipts), states = listingStates(listing);
    const sessions = new Set(receipts.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line).sessionHash));
    const positive = states.get("interlinked-probe-allow.txt") === "PRESENT" && sessions.size === 1 && !sessions.has(undefined);
    const observed = (control: string) => positive && summary.probeControls[control] === 1;
    const effect = (name: string) => states.get(`interlinked-probe-${name}.txt`);
    return { ...summary, receiptsSha256: digest(receipts), effectsSha256: digest(listing), evidence: "operator_supplied_listing",
        conclusions: {
            deny: observed("deny") && effect("deny") === "ABSENT" ? "prevention_observed" : "unmeasured",
            rewrite: observed("rewrite_input") && effect("rewrite-before") === "ABSENT" && effect("rewrite-after") === "PRESENT" ? "rewritten_effect_observed" : "unmeasured",
            ask: observed("ask") && effect("ask") === "PRESENT" ? "effect_observed_approval_requires_ui_evidence" : "unmeasured",
            crash: observed("crash") && effect("crash") === "PRESENT" ? "fail_open_observed" : "unmeasured",
            timeout: observed("timeout") && effect("timeout") === "PRESENT" ? "fail_open_observed" : "unmeasured",
        }, limitations: ["Listing provenance, clean initial directory, exact plugin version, and native invocation must be independently verified. No conclusion transfers to another runtime or update."] };
}
