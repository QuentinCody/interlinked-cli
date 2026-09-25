// Unit F3 (plan §13): the reviewed policy-change ledger. A replacement record
// binds exact base and head policy digests; the reader is a constructing
// parser that skips and reports a malformed row rather than repairing it.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendPolicyChange, E2E_POLICY_CHANGES_PATH, parsePolicyChange, readPolicyChanges, type PolicyChangeRecord } from "./policy-changes.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function scratch(): string { const dir = mkdtempSync(join(tmpdir(), "policy-changes-")); dirs.push(dir); return dir; }
const record = (): PolicyChangeRecord => ({ version: 1, kind: "replacement", projectId: "orders", scenarioId: "order-persists", baseDigest: "a".repeat(64), headDigest: "b".repeat(64), rationale: "requirement R1 retired", recordedAt: "2026-09-25T00:00:00.000Z" });

describe("policy changes — positive", () => {
    it("P1: append writes one JSON line and read gives it back with its optional source; a project-wide record has no scenarioId", () => {
        const root = scratch();
        appendPolicyChange(root, { ...record(), source: { kind: "requirement", path: "REQUIREMENTS.md", sha256: "c".repeat(64), quote: "R1 retired" } });
        const { scenarioId: _omitted, ...projectWide } = record();
        appendPolicyChange(root, projectWide);
        expect(readFileSync(join(root, E2E_POLICY_CHANGES_PATH), "utf8").trim().split("\n")).toHaveLength(2);
        const ledger = readPolicyChanges(root);
        expect(ledger.issues).toEqual([]);
        expect(ledger.records[0]?.source?.quote).toBe("R1 retired");
        expect(ledger.records[1]?.scenarioId).toBeUndefined();
    });
});
describe("policy changes — negative", () => {
    it("N1: a malformed row (bad digest, empty rationale, unknown kind, non-JSON) is skipped and reported; a well-formed sibling still reads; append refuses a malformed record", () => {
        const root = scratch();
        mkdirSync(join(root, ".interlinked"), { recursive: true });
        writeFileSync(join(root, E2E_POLICY_CHANGES_PATH), [JSON.stringify({ ...record(), baseDigest: "short" }), JSON.stringify({ ...record(), rationale: " " }), JSON.stringify({ ...record(), kind: "waiver" }), "{not json", JSON.stringify(record())].join("\n") + "\n");
        const ledger = readPolicyChanges(root);
        expect(ledger.records).toHaveLength(1);
        expect(ledger.issues).toHaveLength(4);
        expect(parsePolicyChange({ ...record(), recordedAt: "yesterday" })).toBeNull();
        expect(() => appendPolicyChange(root, { ...record(), headDigest: "" })).toThrow(/not well-formed/);
        expect(readPolicyChanges(root).records).toHaveLength(1);
    });
});
