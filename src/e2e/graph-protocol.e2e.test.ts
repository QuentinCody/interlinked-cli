import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFixture, type E2eFixture, type HookCall } from "./fixture.js";

describe.each(["entry", "generated"] as const)("%s graph protocol", (runtime) => {
    let fixture: E2eFixture;
    beforeAll(async () => { fixture = await createFixture({ rules: { graph_prediction: { enabled: true, mode: "soft_gate" }, per_edit_coverage: { enabled: false } } }); });
    afterAll(async () => { await fixture?.close(); });
    async function call(input: HookCall) {
        const result = await fixture.hook({ ...input, runtime });
        fixture.assertServed(result);
        expect(result.code).toBe(0);
        return result.stdout + result.stderr;
    }
    const edit = (file_path: string) => ({ file_path, old_string: "SENTINEL_OLD", new_string: "SENTINEL_NEW" });

    it("challenges, accepts a prediction, reveals the comparison and persists reconciliation", async () => {
        const source = fixture.graphSource("happy");
        const sessionId = `${fixture.sessionPrefix}-happy`;
        expect(await call({ sessionId, tool: "Edit", input: edit(source) })).toContain(".interlinked/predictions/incoming/");
        const content = `graph_prediction:\n  file: ${source}\n  deps:\n    imports:\n      - node:fs\n    imported_by:\n      - src/a.ts\n  calls:\n    callers:\n      - run ← main\n  impact:\n    risk: medium\n    domains:\n      - X\n      - Y\n    direct: 1\n    transitive: 2\n    affects:\n      - src/a.ts\n`;
        const file_path = `${fixture.dataDir}/predictions/incoming/${sessionId}/happy.yaml`;
        expect(await call({ sessionId, tool: "Write", input: { file_path, content } })).not.toContain('"deny"');
        const reveal = await call({ sessionId, tool: "Edit", input: edit(source) });
        expect(reveal).not.toContain('"deny"');
        expect(reveal).toContain("Comparison for");
        expect(reveal).toContain("weighted_avg");
        expect(fixture.ledger("graph-predictions.jsonl")).toEqual(expect.arrayContaining([expect.objectContaining({ session_id: sessionId })]));
        expect(fixture.ledger("graph-reconciliations.jsonl")).toEqual(expect.arrayContaining([
            expect.objectContaining({ session_id: sessionId, oracle_summary: expect.anything(), prediction_summary: expect.anything() }),
        ]));
    });

    it.each([false, true])("allows missing or stale sidecars (stale=%s)", async (stale) => {
        const source = stale ? fixture.graphSource("stale", false) : fixture.file("src/missing.ts", "export const SENTINEL_OLD = 1;\n");
        expect(await call({ tool: "Edit", input: edit(source) })).not.toContain('"deny"');
    });

    it("rejects malformed predictions with a specific reason", async () => {
        const source = fixture.graphSource("malformed");
        const sessionId = `${fixture.sessionPrefix}-malformed`;
        await call({ sessionId, tool: "Edit", input: edit(source) });
        const result = await call({ sessionId, tool: "Write", input: {
            file_path: `${fixture.dataDir}/predictions/incoming/${sessionId}/bad.yaml`,
            content: `graph_prediction:\n  file: ${source}\n  this is { broken yaml`,
        } });
        expect(result).toContain('"deny"');
        expect(result).toMatch(/parse|malformed/i);
    });

    it("challenges a fresh target inside a multi-file patch", async () => {
        const source = fixture.graphSource("batch");
        const other = fixture.file("src/other.ts", "export const SENTINEL_OLD = 1;\n");
        const command = ["*** Begin Patch", ...[other, source].flatMap((file) => [`*** Update File: ${file}`, "@@", "-export const SENTINEL_OLD = 1;", "+export const SENTINEL_NEW = 1;"]), "*** End Patch"].join("\n");
        const result = await call({ tool: "apply_patch", input: { command } });
        expect(result).toContain('"deny"');
        expect(result).toContain("batch.ts");
    });
});
