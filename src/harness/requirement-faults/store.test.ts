import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FaultOutcome } from "./corpus.js";
import { FAULT_OUTCOME_STORE, mergeOutcomes, parseOutcomeStore, readOutcomeStore, writeOutcomeStore } from "./store.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const outcome = (fault: string, status: FaultOutcome["status"], requirement = "R1"): FaultOutcome =>
    ({ fault, requirement, status, killedBy: status === "killed" ? ["a.test.ts › x"] : [], inconclusive: [] });

describe("mergeOutcomes — positive", () => {
    it("P1: a second run of a corpus replaces only the faults it ran; another corpus's same fault id is kept apart", () => {
        let store = mergeOutcomes({}, "clauses.json", "t1", [outcome("m1", "killed"), outcome("m2", "survived")], true);
        store = mergeOutcomes(store, "e47a.json", "t2", [outcome("m1", "survived")], true);
        store = mergeOutcomes(store, "clauses.json", "t3", [outcome("m2", "killed")], false);
        expect(Object.fromEntries(Object.entries(store).map(([key, row]) => [key, [row.at, row.outcome.status]]))).toEqual({
            "clauses.json::m1": ["t1", "killed"], "clauses.json::m2": ["t3", "killed"], "e47a.json::m1": ["t2", "survived"],
        });
    });

    it("P2: a complete run drops the corpus's faults it no longer contains; a partial run (--ids) never drops", () => {
        const before = mergeOutcomes({}, "c.json", "t1", [outcome("m1", "killed"), outcome("m2", "killed")], true);
        expect(Object.keys(mergeOutcomes(before, "c.json", "t2", [outcome("m1", "killed")], false))).toEqual(["c.json::m1", "c.json::m2"]);
        expect(Object.keys(mergeOutcomes(before, "c.json", "t2", [outcome("m1", "killed")], true))).toEqual(["c.json::m1"]);
    });

    it("P3: the store round-trips through the file the clause view reads", () => {
        const root = mkdtempSync(join(tmpdir(), "rf-store-")); roots.push(root);
        const store = mergeOutcomes({}, "c.json", "2026-10-22T00:00:00.000Z", [{ ...outcome("m1", "inconclusive"), inconclusive: ["a.test.ts › x"], inconclusiveReasons: { "a.test.ts › x": "Error: no" } }], true);
        writeOutcomeStore(root, store);
        expect(readOutcomeStore(root)).toEqual(store);
        expect(JSON.parse(readFileSync(join(root, FAULT_OUTCOME_STORE), "utf8")).version).toBe(1);
    });
});

describe("parseOutcomeStore — negative (no evidence rather than a guess)", () => {
    it("N1: torn JSON, a wrong version and a missing file are no store", () => {
        expect(parseOutcomeStore("{\"version\": 1, \"outcomes\": {")).toBeNull();
        expect(parseOutcomeStore(JSON.stringify({ version: 2, outcomes: {} }))).toBeNull();
        const root = mkdtempSync(join(tmpdir(), "rf-store-")); roots.push(root);
        expect(readOutcomeStore(root)).toBeNull();
    });

    it("N2: an entry with an unknown status or non-string test lists is dropped, the valid ones stay", () => {
        const text = JSON.stringify({ version: 1, outcomes: {
            "c::ok": { at: "t", corpus: "c", outcome: outcome("ok", "survived") },
            "c::bad-status": { at: "t", corpus: "c", outcome: { ...outcome("bad-status", "killed"), status: "maybe" } },
            "c::bad-list": { at: "t", corpus: "c", outcome: { ...outcome("bad-list", "killed"), killedBy: [1] } },
        } });
        expect(Object.keys(parseOutcomeStore(text) ?? {})).toEqual(["c::ok"]);
    });
});
