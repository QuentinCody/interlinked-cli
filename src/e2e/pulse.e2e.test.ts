import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFixture, type E2eFixture } from "./fixture.js";

describe("complexity pulse across real hook processes", () => {
    let fixture: E2eFixture;
    beforeAll(async () => { fixture = await createFixture({ rules: { per_edit_coverage: { enabled: false } } }); });
    afterAll(async () => { await fixture?.close(); });
    it("reports the +2 delta only when this session has a matching pre-edit snapshot", async () => {
        const before = "export function probe(a: number): number {\n    let r = 0;\n    if (a === 1) r = 1;\n    if (a === 2) r = 2;\n    return r;\n}\n";
        const file_path = fixture.file("src/pulse.ts", before);
        const old_string = "    if (a === 2) r = 2;";
        const new_string = `${old_string}\n    if (a === 3) r = 3;\n    if (a === 4) r = 4;`;
        const sessionId = `${fixture.sessionPrefix}-pulse`;
        const input = { file_path, old_string, new_string };
        const pre = await fixture.hook({ sessionId, tool: "Edit", input });
        fixture.assertServed(pre);
        expect(pre.stdout).not.toContain('"deny"');
        fixture.file("src/pulse.ts", before.replace(old_string, new_string));
        const post = await fixture.hook({ sessionId, event: "PostToolUse", tool: "Edit", input, payload: { tool_response: "success" } });
        fixture.assertServed(post);
        const text = post.stdout + post.stderr;
        expect(text).toContain("[interlinked:cyclomatic]");
        expect(text).toContain("(Δ+2)");
        const cold = await fixture.hook({ sessionId: `${sessionId}-cold`, event: "PostToolUse", tool: "Edit", input, payload: { tool_response: "success" } });
        fixture.assertServed(cold);
        const absolute = cold.stdout + cold.stderr;
        expect(absolute).toContain("[interlinked:cyclomatic]");
        expect(absolute).not.toContain("Δ");
    });
});
