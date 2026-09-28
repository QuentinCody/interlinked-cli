import { relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { guardProposal, guardReceiptPath } from "../harness/guard-prediction.js";
import { createFixture, type E2eFixture } from "./fixture.js";

describe("guard intent across native hook processes", () => {
    let fixture: E2eFixture;
    const before = "export function probe(ready: boolean): number { if (ready) return 1; return 2; }\n";
    const after = "export function probe(ready: boolean): number { if (ready) console.log(ready); return 1; return 2; }\n";
    beforeAll(async () => { fixture = await createFixture({ rules: { per_edit_coverage: { enabled: false } } }); });
    afterAll(async () => { await fixture?.close(); });
    it.each([false, true])("requires reconciliation, daemon cold=%s", async cold => {
        const name = cold ? "cold" : "warm";
        const file = `src/${name}.ts`;
        const file_path = fixture.file(file, before);
        fixture.file(`src/${name}.test.ts`, "// Companion fixture\n");
        const sessionId = `${fixture.sessionPrefix}-${name}`;
        const input = { file_path, old_string: before, new_string: after };
        const reveal = await fixture.hook({ cold, sessionId, tool: "Edit", input });
        if (!cold) fixture.assertServed(reveal);
        else expect(reveal.fellBack).toBe(true);
        expect(reveal.stdout + reveal.stderr).toContain("Unpredicted or unreconciled if-guard change");
        const proposal = guardProposal(file, before, after);
        const path = relative(fixture.cwd, guardReceiptPath(fixture.cwd, sessionId, proposal.id));
        fixture.file(path, JSON.stringify({ version: 1, session: sessionId, ...proposal, nonce: "review-1",
            reconcile: proposal.id, rationale: "This fixture deliberately moves the return outside the branch.",
            changes: [{ owner: "probe", statement: "return 1 ;", before: [{ condition: "ready", branch: "then" }], after: [] }] }));
        const accepted = await fixture.hook({ cold, sessionId, tool: "Edit", input });
        if (!cold) fixture.assertServed(accepted);
        expect(accepted.stdout + accepted.stderr).not.toContain("Unpredicted or unreconciled");
        expect(accepted.stdout).not.toContain('"deny"');
        const ledger = fixture.ledger("predictions/guard-events.jsonl");
        expect(ledger).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: "reveal", session: sessionId }),
            expect.objectContaining({ kind: "reconciled", session: sessionId }),
        ]));
    });
    it("accepts scope-preserving braces without a prediction", async () => {
        const file_path = fixture.file("src/preserve.ts", before);
        const result = await fixture.hook({ tool: "Edit", input: { file_path, old_string: "if (ready) return 1;", new_string: "if (ready) { return 1; }" } });
        fixture.assertServed(result);
        expect(result.stdout).not.toContain('"deny"');
        expect(result.stdout + result.stderr).not.toContain("guard-prediction");
    });
    it("keeps native dry-run reveals out of the ledger", async () => {
        const sessionId = `${fixture.sessionPrefix}-dry-run`;
        const file_path = fixture.file("src/dry.ts", before);
        const result = await fixture.hook({ cold: true, sessionId, tool: "Edit", input: { file_path, old_string: before, new_string: after }, payload: { dry_run: true } });
        expect(result.fellBack).toBe(true);
        expect(result.stdout + result.stderr).toContain("guard-prediction");
        expect(fixture.ledger("predictions/guard-events.jsonl")).not.toContainEqual(expect.objectContaining({ session: sessionId }));
    });
});
