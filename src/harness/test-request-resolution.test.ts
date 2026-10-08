// Request state from POSITIVE evidence only (review 2026-10-06, three rounds): a request file that is gone is
// `completed` only with a completion pointer, `retired` only with an audit row, and `unresolved` otherwise —
// never a pass inferred from absence.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_RETIREMENT_HOPS, resolveRequest } from "./test-request-resolution.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): { root: string; requests: string; completions: string } {
    const root = mkdtempSync(join(tmpdir(), "request-resolution-"));
    roots.push(root);
    const requests = join(root, ".interlinked/test-runs/requests"), completions = join(root, ".interlinked/test-runs/completions");
    mkdirSync(requests, { recursive: true });
    mkdirSync(completions, { recursive: true });
    return { root, requests, completions };
}
const pending = (dir: string, id: string) => writeFileSync(join(dir, `${id}.json`), JSON.stringify({ paths: ["a.ts"], full: false, requirements: {} }));
const completed = (dir: string, id: string) => writeFileSync(join(dir, `${id}.json`), JSON.stringify({ record: "x.result" }));
const retired = (dir: string, id: string, by: string) => appendFileSync(join(dir, "superseded.jsonl"), `${JSON.stringify({ ts: "t", id, by, full: false, paths: [] })}\n`);

describe("resolveRequest — positive (must fire)", () => {
    it("P1: a request whose file exists is pending", () => {
        const { root, requests } = fixture();
        pending(requests, "a");
        expect(resolveRequest(root, "a")).toEqual({ state: "pending", id: "a", hops: [] });
    });

    it("P2: a gone request with a completion pointer is completed", () => {
        const { root, completions } = fixture();
        completed(completions, "a");
        expect(resolveRequest(root, "a")).toEqual({ state: "completed", id: "a", hops: [] });
    });

    it("P3: a retired request resolves through the audit chain to its replacement's state", () => {
        const { root, requests, completions } = fixture();
        retired(requests, "a", "b");
        retired(requests, "b", "c");
        pending(requests, "c");
        expect(resolveRequest(root, "a")).toEqual({ state: "pending", id: "c", hops: ["b", "c"] });
        rmSync(join(requests, "c.json"));
        completed(completions, "c");
        expect(resolveRequest(root, "a")).toEqual({ state: "completed", id: "c", hops: ["b", "c"] });
    });
});

describe("resolveRequest — negative (must not fire)", () => {
    it("N1: a gone request with no completion and no audit row is unresolved, not completed", () => {
        const { root } = fixture();
        expect(resolveRequest(root, "a")).toEqual({ state: "unresolved", id: "a", hops: [], reason: "request file gone with no completion record and no retirement record" });
    });

    it("N2: a chain longer than the hop limit is unresolved, never an intermediate id", () => {
        const { root, requests } = fixture();
        for (let hop = 0; hop <= MAX_RETIREMENT_HOPS; hop++) retired(requests, `r${hop}`, `r${hop + 1}`);
        pending(requests, `r${MAX_RETIREMENT_HOPS + 1}`);
        const resolution = resolveRequest(root, "r0");
        expect(resolution.state).toBe("unresolved");
        expect(resolution.state === "unresolved" && resolution.reason).toMatch(/retirement chain exceeds/);
    });

    it("N3: a completion pointer for a retired id still wins (that id's own obligation was met)", () => {
        const { root, requests, completions } = fixture();
        retired(requests, "a", "b");
        pending(requests, "b");
        completed(completions, "a");
        expect(resolveRequest(root, "a")).toEqual({ state: "completed", id: "a", hops: [] });
    });
});
