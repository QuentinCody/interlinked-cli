import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isJsonObject } from "../lib/json-types.js";
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
        const rawRows = fixture.ledger("verification-stages.jsonl");
        expect(rawRows.every(isJsonObject)).toBe(true);
        const rows = rawRows.filter(isJsonObject);
        expect(rows).toHaveLength(3);
        const trace = rows[0]?.trace;
        expect(trace).toMatch(/^[0-9a-f-]{36}$/);
        expect(rows[0]).toMatchObject({ check: "pre-tool:managed-push", status: "fallback", owner: "daemon",
            reuse_denied_reason: expect.stringMatching(/^handoff-fallback:/) });
        // A delivered fallback adds correlation only; it does not delegate or claim a passing check.
        expect(JSON.parse(result.stdout).hookSpecificOutput.updatedInput).toEqual({
            command: `INTERLINKED_VERIFICATION_TRACE='${trace}' git push origin main`,
        });
        expect(new Set(rows.map(row => row.trace))).toEqual(new Set([trace]));
        for (const check of ["pre-tool:project-typecheck", "pre-tool:project-tests"]) {
            expect(rows).toContainEqual(expect.objectContaining({ check, stage: "push", session: result.sessionId,
                status: "not-applicable", identity: null, reused: false, peak_rss_bytes: null }));
        }
    });
});
