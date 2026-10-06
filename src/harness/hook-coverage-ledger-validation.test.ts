import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { HookCoverageLedger, type LedgerState } from "./hook-coverage-ledger.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
    const root = mkdtempSync(join(tmpdir(), "coverage-ledger-validation-"));
    roots.push(root);
    const path = join(root, "coverage.json"), ledger = new HookCoverageLedger(path);
    ledger.observe("reviewed.ts", "v1", "reservation");
    const entry = ledger.observation().pending[0]!;
    expect(ledger.acknowledge({ ...entry, generation: ledger.summary().generation, evidence: "fixture manual review" })).toBe(true);
    ledger.observe("source.ts", "v2", "reservation");
    return { path, state: ledger.snapshot() };
}

const invalid: Array<{ name: string; change: (state: LedgerState) => unknown; reason: string }> = [
    { name: "unknown schema", change: state => ({ ...state, schema: 2 }), reason: "ledger header" },
    { name: "negative generation", change: state => ({ ...state, generation: -1 }), reason: "generation" },
    { name: "fractional generation", change: state => ({ ...state, generation: 0.5 }), reason: "generation" },
    { name: "unsafe generation", change: state => ({ ...state, generation: Number.MAX_SAFE_INTEGER + 1 }), reason: "generation" },
    { name: "string policy generation", change: state => ({ ...state, policyGeneration: "2" }), reason: "generation" },
    { name: "array file map", change: state => ({ ...state, files: [] }), reason: "entries" },
    { name: "missing pending entries", change: state => ({ ...state, pending: undefined }), reason: "entries" },
    { name: "invalid policy acceptance", change: state => ({ ...state, acceptedPolicy: true }), reason: "accepted policy" },
    { name: "missing file identity", change: state => ({ ...state, files: { file: { scope: "policy" } } }), reason: "file identity" },
    { name: "unknown file scope", change: state => ({ ...state, files: { file: { identity: "v1", scope: "other" } } }), reason: "file scope" },
    { name: "missing observation id", change: state => ({ ...state, pending: [{ ...state.pending[0], id: undefined }] }), reason: "pending hook check" },
    { name: "invented writer attribution", change: state => ({ ...state, pending: [{ ...state.pending[0], writer: "agent" }] }), reason: "pending hook check" },
    { name: "object review history", change: state => ({ ...state, reviews: {} }), reason: "hook reviews" },
    { name: "automated evidence in manual history", change: state => ({ ...state, reviews: [{ ...state.reviews[0], kind: "automated_check" }] }), reason: "review receipt" },
    ...["id", "path", "identity", "evidence", "reviewedAt"].map(field => ({
        name: `non-string review ${field}`, change: (state: LedgerState) => ({ ...state, reviews: [{ ...state.reviews[0], [field]: 42 }] }),
        reason: `review ${field}`,
    })),
];

it.each(invalid)("refuses $name without overwriting or silently resetting existing evidence", ({ change, reason }) => {
    const { path, state } = fixture(), bytes = JSON.stringify(change(state));
    writeFileSync(path, bytes);
    expect(() => new HookCoverageLedger(path)).toThrow(reason);
    expect(readFileSync(path, "utf8")).toBe(bytes);
});

it("loads older ledgers without optional histories and binds legacy policy generations conservatively", () => {
    const { path, state } = fixture();
    const { reviews: _reviews, checks: _checks, policyGeneration: _policyGeneration, ...legacy } = state;
    writeFileSync(path, JSON.stringify(legacy));
    const restored = new HookCoverageLedger(path);
    expect(restored.snapshot()).toEqual({ ...legacy, policyGeneration: state.generation, checks: [], reviews: [] });
    restored.observe("source.ts", "v3", "reservation");
    const reopened = new HookCoverageLedger(path);
    expect(reopened.observation().pending).toEqual([expect.objectContaining({ path: "source.ts", identity: "v3" })]);
    expect(reopened.summary().policyGeneration).toBe(state.generation);
});

it.each(["unknown-id", "wrong-identity"])("rejects a manual review for %s even at the current generation", mismatch => {
    const { path } = fixture(), ledger = new HookCoverageLedger(path);
    const entry = ledger.observation().pending[0]!, before = readFileSync(path, "utf8");
    expect(ledger.acknowledge({ ...entry, generation: ledger.summary().generation, evidence: "review",
        ...(mismatch === "unknown-id" ? { id: "missing" } : { identity: "stale" }) })).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(ledger.observation().pending).toEqual([entry]);
});
