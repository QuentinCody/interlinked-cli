import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/** Resolves when the worker exits 0; rejects with its exit code otherwise. */
function exited(worker: ChildProcess): Promise<void> {
    return new Promise((done, fail) => { worker.once("exit", code => (code === 0 ? done() : fail(new Error(`worker exited ${code}`)))); });
}
import { completeTestRequests, hasTestRequest, pendingTests, requestTests, subscribeTestRequest, unsubscribeTestRequest } from "./test-requests.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): string {
    const root = mkdtempSync(join(tmpdir(), "test-requests-"));
    roots.push(root);
    return root;
}
function superseded(root: string): Array<{ id: string; by: string; full: boolean; paths: string[] }> {
    const path = join(root, ".interlinked/test-runs/requests/superseded.jsonl");
    // SAFETY: the audit file is written only by requestTests, one JSON object per line.
    return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line) as { id: string; by: string; full: boolean; paths: string[] }) : [];
}

describe("supersession preserves obligations", () => {
    // test-contract: invariant — a full-suite request (which may carry no paths) is never retired by a selected request; the selected one keeps its own file because it adds a path
    it("keeps a full request with empty paths when a selected request arrives", () => {
        const root = fixture();
        const full = requestTests(root, [], true);
        const selected = requestTests(root, ["a.ts"], false);
        expect(selected).not.toBe(full);
        expect(hasTestRequest(root, full)).toBe(true);
        expect(hasTestRequest(root, selected)).toBe(true);
        expect(pendingTests(root)).toMatchObject({ paths: ["a.ts"], full: true });
        expect(pendingTests(root).ids.sort()).toEqual([`${full}.json`, `${selected}.json`].sort());
        expect(superseded(root)).toEqual([]);
        // A request that adds nothing new coalesces onto the pending request already carrying its path.
        expect(requestTests(root, ["a.ts"], false)).toBe(selected);
    });

    // test-contract: invariant — request files are immutable and no requested path is ever dropped: a request that adds a path to covering work is stored as its own file, never merged into the in-flight one
    it("stores a request that adds a path as its own immutable file instead of growing the covering request", () => {
        const root = fixture();
        const wide = requestTests(root, ["a.ts", "b.ts"], false);
        expect(requestTests(root, ["b.ts"], false)).toBe(wide);
        const full = requestTests(root, ["sample.txt"], true);
        const added = requestTests(root, ["fixture.json"], false);
        expect(added).not.toBe(full);
        expect(readFileSync(join(root, ".interlinked/test-runs/requests", `${full}.json`), "utf8")).toBe(JSON.stringify({ paths: ["a.ts", "b.ts", "sample.txt"], full: true }));
        expect(pendingTests(root).paths).toEqual(["a.ts", "b.ts", "fixture.json", "sample.txt"]);
    });

    // test-contract: invariant — concurrent writers in separate processes never lose a path: every union survives whichever retirement order the races produce
    it("keeps every path when several processes request and retire concurrently", () => {
        const root = fixture();
        const script = `import { requestTests } from ${JSON.stringify(pathToFileURL(resolve("src/harness/test-requests.ts")).href)};
const [root, index] = process.argv.slice(-2); // under --eval the first user arg is argv[1], so take the last two
for (let round = 0; round < 20; round++) requestTests(root, [\`p\${index}-\${round}.ts\`, "shared.ts"], round % 7 === 6);`;
        const indexes = [0, 1, 2];
        const workers = indexes.map(index => spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script, root, String(index)], { stdio: "inherit" }));
        return Promise.all(workers.map(exited)).then(() => {
            const rounds = Array.from({ length: 20 }, (_, round) => round);
            const expected = indexes.flatMap(index => rounds.map(round => `p${index}-${round}.ts`)).concat("shared.ts").sort();
            expect(pendingTests(root).paths).toEqual(expected);
            expect(pendingTests(root).full).toBe(true);
        });
    }, 60_000);

    // test-contract: invariant — several callers can share one coalesced id; protection lasts until the LAST subscriber leaves
    it("keeps a shared request protected until every local subscriber has left", () => {
        const root = fixture();
        const shared = requestTests(root, ["a.ts"], false);
        subscribeTestRequest(shared);
        subscribeTestRequest(shared);
        unsubscribeTestRequest(shared);
        const wider = requestTests(root, ["a.ts", "b.ts"], false);
        expect(hasTestRequest(root, shared)).toBe(true);
        unsubscribeTestRequest(shared);
        const widest = requestTests(root, ["a.ts", "b.ts", "c.ts"], false);
        expect(hasTestRequest(root, shared)).toBe(false);
        expect(hasTestRequest(root, wider)).toBe(false);
        expect(pendingTests(root)).toEqual({ ids: [`${widest}.json`], paths: ["a.ts", "b.ts", "c.ts"], full: false });
    });

    // test-contract: public-api — a selected request that another pending selected request already covers returns that request's id
    it("coalesces a covered selected request onto the covering one", () => {
        const root = fixture();
        const wide = requestTests(root, ["a.ts", "b.ts"], false);
        expect(requestTests(root, ["b.ts"], false)).toBe(wide);
        expect(pendingTests(root).ids).toEqual([`${wide}.json`]);
    });

    // test-contract: public-api — a wider request retires the narrower pending ones nobody in this process awaits, and records each retirement
    it("retires covered requests without a local subscriber and records the old obligation", () => {
        const root = fixture();
        const narrow = requestTests(root, ["a.ts"], false);
        const other = requestTests(root, ["c.ts"], false);
        const full = requestTests(root, [], true);
        expect(hasTestRequest(root, narrow)).toBe(false);
        expect(hasTestRequest(root, other)).toBe(false);
        // The retired requests' paths ride on the full request so their freshness obligations survive.
        expect(pendingTests(root)).toEqual({ ids: [`${full}.json`], paths: ["a.ts", "c.ts"], full: true });
        // Retirement walks the queue in file-name (uuid) order, so the two rows may come in either order.
        const rows = superseded(root).sort((left, right) => left.paths.join().localeCompare(right.paths.join()));
        expect(rows).toEqual([
            { ts: expect.any(String), id: narrow, by: full, full: false, paths: ["a.ts"] },
            { ts: expect.any(String), id: other, by: full, full: false, paths: ["c.ts"] },
        ]);
    });

    // test-contract: invariant — a request a caller in this process still awaits is never retired out from under it
    it("keeps a covered request that has a local subscriber", () => {
        const root = fixture();
        const awaited = requestTests(root, ["a.ts"], false);
        subscribeTestRequest(awaited);
        try {
            const full = requestTests(root, [], true);
            expect(hasTestRequest(root, awaited)).toBe(true);
            expect(pendingTests(root).ids.sort()).toEqual([`${awaited}.json`, `${full}.json`].sort());
        } finally { unsubscribeTestRequest(awaited); }
    });

    // test-contract: invariant — a selected request never retires a pending full request (the reverse of the first case)
    it("does not retire a full request when a wider selected request arrives", () => {
        const root = fixture();
        const full = requestTests(root, ["x.ts"], true);
        const selected = requestTests(root, ["x.ts", "y.ts"], false);
        expect(selected).not.toBe(full);
        expect(hasTestRequest(root, full)).toBe(true);
        expect(hasTestRequest(root, selected)).toBe(true);
        expect(superseded(root)).toEqual([]);
    });
});

it("unions nearby edits without removing requests that arrived during a run", () => {
    const root = mkdtempSync(join(tmpdir(), "test-requests-"));
    try {
        requestTests(root, ["a.ts"], false); requestTests(root, ["b.ts", "a.ts"], false);
        const executing = pendingTests(root);
        expect(executing.paths).toEqual(["a.ts", "b.ts"]);
        requestTests(root, ["new.test.ts"], true);
        completeTestRequests(root, executing.ids);
        const pending = pendingTests(root);
        // The full request that arrived mid-run survives completion of the executing batch; the batch's paths (retired
        // onto it, since no local caller awaited them) stay watched for freshness rather than being dropped.
        expect(pending.paths).toEqual(["a.ts", "b.ts", "new.test.ts"]);
        expect(pending.full).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
