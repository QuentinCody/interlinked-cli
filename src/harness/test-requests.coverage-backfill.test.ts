import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasTestRequest, pendingRequestsMet, pendingTests, requestTests, unsubscribeTestRequest } from "./test-requests.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(): string {
    const root = mkdtempSync(join(tmpdir(), "test-requests-backfill-"));
    roots.push(root);
    mkdirSync(requestDir(root), { recursive: true });
    return root;
}
function requestDir(root: string): string { return join(root, ".interlinked/test-runs/requests"); }
function plant(root: string, name: string, body: unknown): void { writeFileSync(join(requestDir(root), name), typeof body === "string" ? body : JSON.stringify(body)); }

describe("stored request parsing — positive (must fire)", () => {
    it("P1: a legacy request file with no requirements reads as a plain request", () => {
        // test-contract: boundary — request files written before requirements existed must still be honoured with no coverage obligation
        const root = fixture();
        plant(root, "legacy.json", { paths: ["a.ts"], full: false });
        expect(pendingTests(root)).toEqual({ ids: ["legacy.json"], paths: ["a.ts"], full: false, requirements: {} });
    });

    it("P2: a requirements object without coverage reads as a plain request", () => {
        // test-contract: boundary — an empty requirements object carries no coverage obligation
        const root = fixture();
        plant(root, "empty.json", { paths: [], full: true, requirements: {} });
        expect(pendingTests(root).requirements).toEqual({});
    });

    it("P3: coverage with no reporter list is a coverage obligation with no named reporters", () => {
        // test-contract: public-api — a coverage request with no reporters still demands a coverage run, and any coverage-producing run meets it
        const root = fixture();
        const id = requestTests(root, ["a.ts"], false, { coverage: {} });
        expect(pendingTests(root).requirements).toEqual({ coverage: { reporters: [] } });
        expect(pendingRequestsMet(root, {})).toEqual([]);
        expect(pendingRequestsMet(root, { coverage: {} })).toEqual([`${id}.json`]);
        expect(pendingRequestsMet(root, { coverage: { reporters: ["x"] } })).toEqual([`${id}.json`]);
    });

    it("P4: a stored coverage request without a reporter list parses as an empty coverage obligation", () => {
        // test-contract: boundary — `coverage: {}` on disk is a valid obligation, distinct from no coverage
        const root = fixture();
        plant(root, "cov.json", { paths: ["a.ts"], full: false, requirements: { coverage: {} } });
        expect(pendingTests(root).requirements).toEqual({ coverage: { reporters: [] } });
    });

    it("P5: a request that only names reporters on the covering side still coalesces a coverage-free coverage request", () => {
        // test-contract: invariant — a coverage request with reporters satisfies a covered coverage request with none
        const root = fixture();
        const covering = requestTests(root, ["a.ts"], false, { coverage: { reporters: ["r.mjs"] } });
        expect(requestTests(root, ["a.ts"], false, { coverage: {} })).toBe(covering);
    });

    it("P6: an unsubscribe for an id nobody subscribed to is harmless", () => {
        // test-contract: boundary — releasing an unknown id must not throw or leave a negative count that blocks later retirement
        const root = fixture();
        unsubscribeTestRequest("never-subscribed");
        const narrow = requestTests(root, ["a.ts"], false);
        requestTests(root, [], true);
        expect(hasTestRequest(root, narrow)).toBe(false);
    });

    it("P7: a request file that vanishes between the scan and the read is skipped", () => {
        // test-contract: invariant — a dangling entry (another process retired the file mid-scan) reads as absent, not as an error
        const root = fixture();
        symlinkSync(join(root, "missing-target"), join(requestDir(root), "ghost.json"));
        plant(root, "real.json", { paths: ["a.ts"], full: false, requirements: {} });
        expect(pendingTests(root).ids).toEqual(["real.json"]);
    });

    it("P8: a retirement still happens when its audit line cannot be written", () => {
        // test-contract: bug — an unwritable superseded.jsonl must not strand the retired request or fail the new one
        const root = fixture();
        mkdirSync(join(requestDir(root), "superseded.jsonl"));
        const narrow = requestTests(root, ["a.ts"], false);
        const full = requestTests(root, [], true);
        expect(hasTestRequest(root, narrow)).toBe(false);
        expect(hasTestRequest(root, full)).toBe(true);
    });
});

describe("stored request parsing — negative (must not fire)", () => {
    const malformed: Array<[string, unknown]> = [
        ["N1: a non-object document", []],
        ["N2: a non-boolean full flag", { paths: [], full: "yes", requirements: {} }],
        ["N3: a non-array path list", { paths: "a.ts", full: false, requirements: {} }],
        ["N4: a non-string path member", { paths: [1], full: false, requirements: {} }],
        ["N5: non-object requirements", { paths: [], full: false, requirements: 5 }],
        ["N6: a non-object coverage block", { paths: [], full: false, requirements: { coverage: true } }],
        ["N7: a non-array reporter list", { paths: [], full: false, requirements: { coverage: { reporters: "r" } } }],
        ["N8: a non-string reporter member", { paths: [], full: false, requirements: { coverage: { reporters: [1] } } }],
    ];
    for (const [title, body] of malformed) {
        it(title, () => {
            // test-contract: invariant — a malformed pending request is an error, never silently dropped (dropping would lose an obligation)
            const root = fixture();
            plant(root, "bad.json", body);
            expect(() => pendingTests(root)).toThrow("Malformed pending test request: bad.json");
        });
    }

    it("N9: an unreadable request entry that is not a missing file propagates its error", () => {
        // test-contract: invariant — only ENOENT is tolerated; any other read failure surfaces
        const root = fixture();
        mkdirSync(join(requestDir(root), "dir.json"));
        expect(() => pendingTests(root)).toThrow();
    });
});
