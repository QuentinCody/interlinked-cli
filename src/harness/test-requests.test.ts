import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { requestTests, pendingTests, completeTestRequests } from "./test-requests.js";

it("unions nearby edits without removing requests that arrived during a run", () => {
    const root = mkdtempSync(join(tmpdir(), "test-requests-"));
    try {
        requestTests(root, ["a.ts"], false); requestTests(root, ["b.ts", "a.ts"], false);
        const executing = pendingTests(root);
        expect(executing.paths).toEqual(["a.ts", "b.ts"]);
        requestTests(root, ["new.test.ts"], true);
        completeTestRequests(root, executing.ids);
        const pending = pendingTests(root);
        expect(pending.paths).toEqual(["new.test.ts"]);
        expect(pending.full).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
