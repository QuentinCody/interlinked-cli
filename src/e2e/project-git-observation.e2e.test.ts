import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFixture, type E2eFixture } from "./fixture.js";

describe("project Git check evidence through the built daemon", () => {
    let fixture: E2eFixture;
    beforeAll(async () => { fixture = await createFixture(); });
    afterAll(async () => { await fixture?.close(); });

    // test-contract: regression — no configured compiler/test runner is not a successful execution;
    // an unrecognized repository keeps the legacy path and records only the evidence it actually has.
    it("records unconfigured checks as not applicable without a passing or delegated verdict", async () => {
        const result = await fixture.hook({ tool: "Bash", input: { command: "git push origin main" } });
        fixture.assertServed(result);
        expect(result.code).toBe(0);
        expect(result.stdout).not.toContain("updatedInput");
        const rows = fixture.ledger("verification-stages.jsonl");
        expect(rows).toHaveLength(2);
        for (const check of ["pre-tool:project-typecheck", "pre-tool:project-tests"]) {
            expect(rows).toContainEqual(expect.objectContaining({ check, stage: "push", session: result.sessionId,
                status: "not-applicable", identity: null, reused: false, peak_rss_bytes: null }));
        }
    });
});
