// Where a test request's obligation stands, from POSITIVE evidence only.
//
// A request file disappears for two reasons: a batch COMPLETED it (`test-request-completion.ts` writes a
// completion pointer named by its id) or another caller RETIRED it into a wider request (`requestTests` appends a
// `superseded.jsonl` row naming the replacement). Inferring either from absence returned passes for runs that never
// covered the caller (review 2026-10-06, three rounds: the unlink-before-audit window, a chain past the hop limit,
// and a drain that kept looking for the retired id). So:
//   pending    — the request file exists;
//   completed  — a completion pointer for that id exists (its freshness is checked by `readTestCompletion`);
//   retired    — an audit row names the replacement; the chain is followed;
//   unresolved — none of the above, or the chain exceeds its limit. A caller must never treat this as a pass.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { hasTestRequest, supersededBy } from "./test-requests.js";

/** Retirement-chain cap: each hop is a write by another caller, so a long chain means a bug, not a busy queue. */
export const MAX_RETIREMENT_HOPS = 64;

export type RequestResolution =
    | { state: "pending" | "completed"; id: string; hops: string[] }
    | { state: "unresolved"; id: string; hops: string[]; reason: string };

function hasCompletionPointer(root: string, id: string): boolean {
    return existsSync(join(root, ".interlinked/test-runs/completions", `${id}.json`));
}

/** The request now carrying `id`'s obligation and its evidenced state; `hops` lists the replacement ids followed. */
export function resolveRequest(root: string, id: string): RequestResolution {
    const hops: string[] = [];
    let current = id;
    for (let hop = 0; hop <= MAX_RETIREMENT_HOPS; hop++) {
        if (hasTestRequest(root, current)) return { state: "pending", id: current, hops };
        if (hasCompletionPointer(root, current)) return { state: "completed", id: current, hops };
        const next = supersededBy(root, current);
        if (next === null) return { state: "unresolved", id: current, hops, reason: "request file gone with no completion record and no retirement record" };
        hops.push(next);
        current = next;
    }
    return { state: "unresolved", id: current, hops, reason: `retirement chain exceeds ${MAX_RETIREMENT_HOPS} hops` };
}
